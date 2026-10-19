import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import type { ParsedTypeDef } from "./spec";

/** Split a generic's argument list on top-level commas, respecting nesting. */
function splitTypeArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "<") depth++;
    if (char === ">") depth--;
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** Match a generic spec type like "Vec<Symbol>" or "Map<Symbol, U32>". */
function parseGeneric(specType: string): { name: string; args: string[] } | null {
  const match = /^([A-Za-z]+)<(.+)>$/.exec(specType.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: splitTypeArgs(match[2]) };
}

/** Feed a JSON element back through the string-based coercion. */
function elementInput(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Coerce a plain-text form input into an ScVal for a given spec type name
 * (as produced by parseContractSpec, e.g. "U32", "Address", "Vec<Symbol>").
 *
 * Scalars convert exactly. Compound types are decomposed and their elements
 * coerced against the declared element types, because inferring from JSON
 * alone gets them wrong in ways the contract rejects: ["a"] as Vec<Symbol>
 * infers scvString, and [1] as Vec<i128> infers scvU64.
 *
 * A contract's own structs, unions and enums are coerced from its parsed type
 * definitions when those are supplied. Without them — or for a name the
 * contract doesn't define — the fallback is best-effort JSON inference: good
 * enough for a preview tool, not a substitute for a typed SDK binding.
 */
export function coerceArgInput(
  raw: string,
  specType: string,
  types: ParsedTypeDef[] = []
): xdr.ScVal {
  const t = specType.toLowerCase();
  if (t === "bool") return nativeToScVal(raw.trim().toLowerCase() === "true");
  if (t === "u32") return nativeToScVal(Number(raw), { type: "u32" });
  if (t === "i32") return nativeToScVal(Number(raw), { type: "i32" });
  if (t === "u64") return nativeToScVal(BigInt(raw), { type: "u64" });
  if (t === "i64") return nativeToScVal(BigInt(raw), { type: "i64" });
  if (t === "u128") return nativeToScVal(BigInt(raw), { type: "u128" });
  if (t === "i128") return nativeToScVal(BigInt(raw), { type: "i128" });
  if (t === "symbol") return nativeToScVal(raw, { type: "symbol" });
  if (t === "string") return nativeToScVal(raw, { type: "string" });
  if (t === "address") return nativeToScVal(raw, { type: "address" });
  if (t === "bytes") return nativeToScVal(Buffer.from(raw.replace(/^0x/, ""), "hex"), { type: "bytes" });
  if (t === "void") return xdr.ScVal.scvVoid();

  const generic = parseGeneric(specType);

  // An absent Option is void; anything else is the inner type.
  if (generic?.name === "option" && generic.args.length === 1) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "null") return xdr.ScVal.scvVoid();
    return coerceArgInput(raw, generic.args[0], types);
  }

  if (generic?.name === "vec" && generic.args.length === 1) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`${specType} expects a JSON array, e.g. ["a", "b"].`);
    }
    return xdr.ScVal.scvVec(
      parsed.map((item) => coerceArgInput(elementInput(item), generic.args[0], types))
    );
  }

  if (generic?.name === "map" && generic.args.length === 2) {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${specType} expects a JSON object, e.g. {"key": 1}.`);
    }
    const [keyType, valueType] = generic.args;
    // Soroban requires map keys in canonical order; handing nativeToScVal a
    // Map of already-typed ScVals lets the SDK do that sorting for us.
    const entries = new Map<xdr.ScVal, xdr.ScVal>();
    for (const [key, value] of Object.entries(parsed)) {
      entries.set(
        coerceArgInput(key, keyType, types),
        coerceArgInput(elementInput(value), valueType, types)
      );
    }
    return nativeToScVal(entries);
  }

  const udt = types.find((def) => def.name === specType.trim());
  if (udt) return coerceUdtInput(raw, udt, types);

  try {
    return nativeToScVal(JSON.parse(raw));
  } catch {
    return nativeToScVal(raw);
  }
}

/** Soroban encodes a Rust tuple struct as a Vec, not a Map keyed by "0", "1", ... */
function isTupleStruct(fields: { name: string }[]): boolean {
  return fields.length > 0 && fields.every((field) => /^\d+$/.test(field.name));
}

/**
 * Coerce an input against one of the contract's own type definitions.
 *
 * The encodings are Soroban's, not ours: a named struct is a map keyed by
 * field-name symbols, a tuple struct is a vec, a union variant is a vec led by
 * the variant's name symbol, and a u32 enum is just its discriminant.
 */
function coerceUdtInput(raw: string, def: ParsedTypeDef, types: ParsedTypeDef[]): xdr.ScVal {
  if (def.kind === "enum") {
    const trimmed = raw.trim();
    const byName = def.cases.find((c) => c.name === trimmed);
    if (byName) return nativeToScVal(byName.value, { type: "u32" });

    const asNumber = Number(trimmed);
    if (def.cases.some((c) => c.value === asNumber)) {
      return nativeToScVal(asNumber, { type: "u32" });
    }
    throw new Error(
      `${def.name} has no case ${trimmed || "(empty)"}. Expected one of: ${def.cases
        .map((c) => c.name)
        .join(", ")}.`
    );
  }

  if (def.kind === "error") {
    throw new Error(`${def.name} is an error type and can't be passed as an argument.`);
  }

  if (def.kind === "union") {
    // Either a bare variant name for a payload-free case, or {"Variant": [...]}.
    const trimmed = raw.trim();
    const bare = def.cases.find((c) => c.name === trimmed);
    if (bare) {
      if (bare.types.length > 0) {
        throw new Error(
          `${def.name}::${bare.name} takes ${bare.types.length} value(s). Pass {"${bare.name}": [...]}.`
        );
      }
      return xdr.ScVal.scvVec([nativeToScVal(bare.name, { type: "symbol" })]);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `${def.name} expects a variant name or {"Variant": [...]}. Cases: ${def.cases
          .map((c) => c.name)
          .join(", ")}.`
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${def.name} expects an object like {"Variant": [...]}.`);
    }

    const [[name, payload] = [], ...rest] = Object.entries(parsed as Record<string, unknown>);
    if (!name || rest.length > 0) {
      throw new Error(`${def.name} expects exactly one variant, e.g. {"Variant": [...]}.`);
    }
    const unionCase = def.cases.find((c) => c.name === name);
    if (!unionCase) {
      throw new Error(
        `${def.name} has no case ${name}. Cases: ${def.cases.map((c) => c.name).join(", ")}.`
      );
    }

    const values = Array.isArray(payload) ? payload : [payload];
    if (values.length !== unionCase.types.length) {
      throw new Error(
        `${def.name}::${name} takes ${unionCase.types.length} value(s), got ${values.length}.`
      );
    }
    return xdr.ScVal.scvVec([
      nativeToScVal(name, { type: "symbol" }),
      ...unionCase.types.map((type, i) => coerceArgInput(elementInput(values[i]), type, types)),
    ]);
  }

  // struct
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${def.name} expects a JSON object with fields: ${def.fields
        .map((f) => `${f.name}: ${f.type}`)
        .join(", ")}.`
    );
  }

  if (isTupleStruct(def.fields)) {
    if (!Array.isArray(parsed) || parsed.length !== def.fields.length) {
      throw new Error(`${def.name} expects a JSON array of ${def.fields.length} value(s).`);
    }
    return xdr.ScVal.scvVec(
      def.fields.map((field, i) => coerceArgInput(elementInput(parsed[i]), field.type, types))
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${def.name} expects a JSON object with fields: ${def.fields
        .map((f) => `${f.name}: ${f.type}`)
        .join(", ")}.`
    );
  }

  const payload = parsed as Record<string, unknown>;
  const missing = def.fields.filter((field) => !(field.name in payload)).map((f) => f.name);
  if (missing.length > 0) {
    throw new Error(`${def.name} is missing field(s): ${missing.join(", ")}.`);
  }

  // Handing nativeToScVal a Map of typed ScVals leaves the canonical key
  // ordering Soroban requires to the SDK.
  const entries = new Map<xdr.ScVal, xdr.ScVal>();
  for (const field of def.fields) {
    entries.set(
      nativeToScVal(field.name, { type: "symbol" }),
      coerceArgInput(elementInput(payload[field.name]), field.type, types)
    );
  }
  return nativeToScVal(entries);
}
