// XDR / ScVal decoding utilities for Prism, built on @stellar/stellar-sdk.
import { Address, StrKey, xdr, scValToNative, nativeToScVal } from "@stellar/stellar-sdk";
import { XdrReader } from "@stellar/js-xdr";
import type { ResourceUsage, SorobanInvocation } from "@/types";

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
  if (t === "bytes") {
    const hex = raw.trim().replace(/^0x/i, "");
    // Buffer.from(..., "hex") silently truncates malformed input.
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
      throw new Error("Bytes expects an even-length hexadecimal string (optionally prefixed with 0x).");
    }
    return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
  }
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

function toDisplaySafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(toDisplaySafe);
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([k, v]) => [String(toDisplaySafe(k)), toDisplaySafe(v)])
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toDisplaySafe(v)])
    );
  }
  return value;
}

/** Decode an XDR ScVal into a JSON-safe native JS value (bigints/bytes normalized to strings). */
export function decodeScVal(val: xdr.ScVal): unknown {
  try {
    return toDisplaySafe(scValToNative(val));
  } catch {
    return undefined;
  }
}

/** Decode an XDR ScVal to a compact, human-readable string for display. */
export function scValToDisplay(val: xdr.ScVal): string {
  if (val.switch().name === "scvVoid") return "void";
  const decoded = decodeScVal(val);
  if (decoded === undefined) return "(unrepresentable value)";
  return typeof decoded === "string" ? decoded : JSON.stringify(decoded);
}

/** Decode a base64-encoded ScVal XDR string to a display string. Falls back to the raw base64 on failure. */
export function decodeXdr(xdrBase64: string): string {
  try {
    return scValToDisplay(xdr.ScVal.fromXDR(xdrBase64, "base64"));
  } catch {
    return xdrBase64;
  }
}

/** Decode a base64-encoded ScVal XDR string to a native JS value. */
export function decodeScValXdr(xdrBase64: string): unknown {
  try {
    return decodeScVal(xdr.ScVal.fromXDR(xdrBase64, "base64"));
  } catch {
    return undefined;
  }
}

export interface ParsedFunctionSpec {
  name: string;
  inputs: { name: string; type: string }[];
  outputs: string[];
}

/** One field of a declared event, and whether it rides in the topic list or the data payload. */
export interface EventParamSpec {
  name: string;
  type: string;
  location: "topic" | "data";
}

export interface ParsedEventSpec {
  /** The Rust type name, e.g. "NoteWritten". */
  name: string;
  /** Fixed leading topics every instance of this event carries, e.g. ["note_written"]. */
  prefixTopics: string[];
  params: EventParamSpec[];
  dataFormat: "map" | "vec" | "single-value";
  doc?: string;
}

/**
 * Read every spec entry out of a contract's "contractspecv0" custom section.
 * Returns [] when the section is missing or unparsable — not every contract
 * embeds one (e.g. ones built without the spec-emitting macros).
 */
function readSpecEntries(wasm: Buffer): xdr.ScSpecEntry[] {
  try {
    const mod = new WebAssembly.Module(new Uint8Array(wasm));
    const sections = WebAssembly.Module.customSections(mod, "contractspecv0");
    if (sections.length === 0) return [];

    const entries: xdr.ScSpecEntry[] = [];
    for (const section of sections) {
      const reader = new XdrReader(Buffer.from(section));
      while (!reader.eof) {
        // stellar-sdk's generated .d.ts types read() as taking a Buffer, but
        // at runtime it reads from a stateful js-xdr cursor (XdrReader) — the
        // declaration is stale relative to the implementation.
        entries.push(xdr.ScSpecEntry.read(reader as unknown as Buffer));
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Parse the functions a contract exposes from its embedded spec (ABI).
 * Returns [] when the contract embeds no spec.
 */
export function parseContractSpec(wasm: Buffer): ParsedFunctionSpec[] {
  try {
    return readSpecEntries(wasm)
      .filter((e) => e.switch().name === "scSpecEntryFunctionV0")
      .map((e) => {
        const fn = e.functionV0();
        return {
          name: fn.name().toString(),
          inputs: fn.inputs().map((input) => ({
            name: input.name().toString(),
            type: specTypeToString(input.type()),
          })),
          outputs: fn.outputs().map(specTypeToString),
        };
      });
  } catch {
    return [];
  }
}

const EVENT_DATA_FORMATS: Record<string, ParsedEventSpec["dataFormat"]> = {
  scSpecEventDataFormatMap: "map",
  scSpecEventDataFormatVec: "vec",
  scSpecEventDataFormatSingleValue: "single-value",
};

/** A type a contract defines in its own spec — the names that appear in its signatures. */
export type ParsedTypeDef =
  | { kind: "struct"; name: string; doc?: string; fields: { name: string; type: string }[] }
  | { kind: "union"; name: string; doc?: string; cases: { name: string; types: string[] }[] }
  | { kind: "enum"; name: string; doc?: string; cases: { name: string; value: number }[] }
  | { kind: "error"; name: string; doc?: string; cases: { name: string; value: number }[] };

/**
 * Parse the structs, unions and enums a contract defines.
 *
 * Function signatures refer to these by bare name — a function returning
 * `Result<Note>` says nothing about what a Note contains, and a storage key of
 * type `DataKey` says nothing about its variants. The definitions are in the
 * spec alongside the functions; Prism was reading past them.
 *
 * Soroban represents a Rust tuple struct as a struct whose fields are named
 * "0", "1", ... — reported as-is, since that's what the contract's own ABI
 * says and inventing names would be worse.
 */
export function parseContractTypes(wasm: Buffer): ParsedTypeDef[] {
  const types: ParsedTypeDef[] = [];

  for (const entry of readSpecEntries(wasm)) {
    try {
      switch (entry.switch().name) {
        case "scSpecEntryUdtStructV0": {
          const def = entry.udtStructV0();
          types.push({
            kind: "struct",
            name: def.name().toString(),
            doc: def.doc().toString() || undefined,
            fields: def.fields().map((field) => ({
              name: field.name().toString(),
              type: specTypeToString(field.type()),
            })),
          });
          break;
        }
        case "scSpecEntryUdtUnionV0": {
          const def = entry.udtUnionV0();
          types.push({
            kind: "union",
            name: def.name().toString(),
            doc: def.doc().toString() || undefined,
            cases: def.cases().map((unionCase) =>
              unionCase.switch().name === "scSpecUdtUnionCaseTupleV0"
                ? {
                    name: unionCase.tupleCase().name().toString(),
                    types: unionCase.tupleCase().type().map(specTypeToString),
                  }
                : { name: unionCase.voidCase().name().toString(), types: [] }
            ),
          });
          break;
        }
        case "scSpecEntryUdtEnumV0": {
          const def = entry.udtEnumV0();
          types.push({
            kind: "enum",
            name: def.name().toString(),
            doc: def.doc().toString() || undefined,
            cases: def.cases().map((enumCase) => ({
              name: enumCase.name().toString(),
              value: enumCase.value(),
            })),
          });
          break;
        }
        case "scSpecEntryUdtErrorEnumV0": {
          const def = entry.udtErrorEnumV0();
          types.push({
            kind: "error",
            name: def.name().toString(),
            doc: def.doc().toString() || undefined,
            cases: def.cases().map((errorCase) => ({
              name: errorCase.name().toString(),
              value: errorCase.value(),
            })),
          });
          break;
        }
      }
    } catch {
      // A definition Prism can't read shouldn't cost us the ones it can.
    }
  }

  return types;
}

/**
 * Parse the events a contract declares in its spec.
 *
 * Contracts built with soroban-sdk 25's `#[contractevent]` macro publish their
 * event schemas alongside their functions, which is what lets an explorer name
 * an event and label its fields instead of showing an anonymous list of ScVals.
 * Contracts that publish events as loose tuples declare nothing, so this
 * legitimately returns [] for most contracts in the wild.
 */
export function parseContractEvents(wasm: Buffer): ParsedEventSpec[] {
  try {
    return readSpecEntries(wasm)
      .filter((e) => e.switch().name === "scSpecEntryEventV0")
      .map((e) => {
        const event = e.eventV0();
        const doc = event.doc().toString();
        return {
          name: event.name().toString(),
          prefixTopics: event.prefixTopics().map((t) => t.toString()),
          params: event.params().map((param) => ({
            name: param.name().toString(),
            type: specTypeToString(param.type()),
            location:
              param.location().name === "scSpecEventParamLocationTopicList"
                ? ("topic" as const)
                : ("data" as const),
          })),
          dataFormat: EVENT_DATA_FORMATS[event.dataFormat().name] ?? "map",
          doc: doc || undefined,
        };
      });
  } catch {
    return [];
  }
}

/**
 * The v1 transaction body, unwrapping a fee bump to reach the inner one.
 *
 * Returns null for v0 envelopes: they predate Soroban and have a different
 * shape (a bare ed25519 key rather than a muxed account, and no Soroban
 * resource data), so callers looking for contract activity have nothing to
 * find in one.
 */
function v1Tx(envelope: xdr.TransactionEnvelope): xdr.Transaction | null {
  const kind = envelope.switch().name;
  if (kind === "envelopeTypeTxFeeBump") return envelope.feeBump().tx().innerTx().v1().tx();
  if (kind === "envelopeTypeTx") return envelope.v1().tx();
  return null;
}

/** Decode a transaction envelope's InvokeHostFunction operation (function name + args), if any. */
export function decodeInvocation(envelope: xdr.TransactionEnvelope): SorobanInvocation | null {
  try {
    const tx = v1Tx(envelope);
    if (!tx) return null;
    for (const op of tx.operations()) {
      if (op.body().switch().name !== "invokeHostFunction") continue;
      const hostFn = op.body().invokeHostFunctionOp().hostFunction();
      if (hostFn.switch().name !== "hostFunctionTypeInvokeContract") continue;
      const invoke = hostFn.invokeContract();
      return {
        contractId: Address.fromScAddress(invoke.contractAddress()).toString(),
        functionName: invoke.functionName().toString(),
        args: invoke.args().map(scValToDisplay),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Decode a transaction envelope's Soroban resource footprint (instructions, I/O bytes, resource fee), if any. */
export function getResourceUsage(envelope: xdr.TransactionEnvelope): ResourceUsage | null {
  try {
    const tx = v1Tx(envelope);
    if (!tx) return null;
    const ext = tx.ext();
    if (ext.switch() !== 1) return null;
    const data = ext.sorobanData();
    const resources = data.resources();
    return {
      instructions: resources.instructions(),
      readBytes: resources.diskReadBytes(),
      writeBytes: resources.writeBytes(),
      resourceFeeStroops: data.resourceFee().toString(),
    };
  } catch {
    return null;
  }
}

/**
 * XDR types the decoder will try when handed an unlabelled base64 blob, in the
 * order it tries them. ScVal sits last on purpose: it is by far the most
 * permissive type, so anything that also parses as a richer type should be
 * reported as that type instead.
 */
const CANDIDATE_XDR_TYPES = [
  "TransactionEnvelope",
  "TransactionResult",
  "TransactionMeta",
  "LedgerEntry",
  "LedgerKey",
  "ScSpecEntry",
  "ScVal",
] as const;

export type XdrTypeName = (typeof CANDIDATE_XDR_TYPES)[number];

export interface XdrField {
  label: string;
  value: string;
}

export interface XdrDecodeResult {
  type: XdrTypeName;
  fields: XdrField[];
}

/**
 * Recover a base64 blob from a URL query parameter.
 *
 * Query strings decode "+" as a space, and base64 is full of pluses. Links
 * Prism generates are percent-encoded and round-trip exactly, but a
 * hand-assembled URL won't be — and base64 has no legitimate spaces, so any
 * space in a query parameter was a plus.
 */
export function base64FromQueryParam(raw: string): string {
  return raw.replace(/ /g, "+");
}

/** Strip whitespace/newlines that survive a copy-paste out of a terminal or JSON blob. */
function normalizeBase64(input: string): string {
  return input.replace(/\s+/g, "");
}

/**
 * Identify which XDR type a base64 blob actually is.
 *
 * XDR is not self-describing, so "it parsed" is a weak signal — plenty of blobs
 * parse as several types, producing garbage for all but one. The round-trip
 * check (decode, re-encode, compare bytes) is what makes this trustworthy: a
 * type that consumed every byte and reproduces the input exactly is a real
 * match, not a prefix that happened to parse.
 */
export function identifyXdr(input: string): XdrTypeName | null {
  const base64 = normalizeBase64(input);
  if (!base64) return null;

  for (const name of CANDIDATE_XDR_TYPES) {
    try {
      const type = xdr[name] as unknown as {
        fromXDR(data: string, format: "base64"): { toXDR(format: "base64"): string };
      };
      if (type.fromXDR(base64, "base64").toXDR("base64") === base64) return name;
    } catch {
      // Not this type — keep going.
    }
  }
  return null;
}

function muxedAccountToAddress(account: xdr.MuxedAccount): string {
  try {
    if (account.switch().name === "keyTypeEd25519") {
      return StrKey.encodeEd25519PublicKey(account.ed25519());
    }
    const muxed = account.med25519();
    return `${StrKey.encodeEd25519PublicKey(muxed.ed25519())} (muxed id ${muxed.id().toString()})`;
  } catch {
    return "(unrepresentable account)";
  }
}

function memoToDisplay(memo: xdr.Memo): string {
  const kind = memo.switch().name.replace(/^memo/, "").toLowerCase();
  try {
    switch (kind) {
      case "none":
        return "none";
      case "text":
        return `text: ${memo.text().toString()}`;
      case "id":
        return `id: ${memo.id().toString()}`;
      case "hash":
        return `hash: ${memo.hash().toString("hex")}`;
      case "return":
        return `return: ${memo.retHash().toString("hex")}`;
      default:
        return kind;
    }
  } catch {
    return kind;
  }
}

function transactionEnvelopeFields(envelope: xdr.TransactionEnvelope): XdrField[] {
  const fields: XdrField[] = [{ label: "Envelope type", value: envelope.switch().name }];

  // v0 envelopes carry a bare ed25519 key where v1 carries a muxed account,
  // so the common fields have to be read from whichever shape this is.
  const tx = v1Tx(envelope);
  const v0 = tx ? null : envelope.v0().tx();

  if (tx || v0) {
    const source = tx
      ? muxedAccountToAddress(tx.sourceAccount())
      : StrKey.encodeEd25519PublicKey(v0!.sourceAccountEd25519());
    const body = tx ?? v0!;

    fields.push(
      { label: "Source account", value: source },
      { label: "Fee", value: `${body.fee()} stroops` },
      { label: "Sequence", value: body.seqNum().toString() },
      { label: "Memo", value: memoToDisplay(body.memo()) },
      {
        label: "Operations",
        value: body
          .operations()
          .map((op) => op.body().switch().name)
          .join(", "),
      }
    );
  }

  const invocation = decodeInvocation(envelope);
  if (invocation) {
    fields.push(
      { label: "Contract", value: invocation.contractId },
      { label: "Function", value: invocation.functionName },
      { label: "Arguments", value: invocation.args.length ? invocation.args.join(", ") : "(none)" }
    );
  }

  const resources = getResourceUsage(envelope);
  if (resources) {
    fields.push(
      { label: "Instructions", value: resources.instructions.toLocaleString() },
      { label: "Read / write bytes", value: `${resources.readBytes} / ${resources.writeBytes}` },
      { label: "Resource fee", value: `${resources.resourceFeeStroops} stroops` }
    );
  }

  return fields;
}

export interface TransactionFailure {
  /** The transaction-level code, e.g. "txFailed" or "txBadSeq". */
  resultCode: string;
  /** Per-operation outcomes, in order. */
  operations: { index: number; code: string; failed: boolean }[];
}

/**
 * Decode why a transaction failed from Horizon's result XDR.
 *
 * Returns null for a successful transaction, and for anything that won't
 * parse. Note that a failed transaction's operations are not all failures: the
 * ledger applies them in order and rolls the lot back, so earlier operations
 * commonly report success alongside the one that actually broke — which is why
 * each operation is reported with its own verdict rather than collapsed into a
 * single message.
 */
export function decodeTransactionFailure(resultXdrBase64: string): TransactionFailure | null {
  try {
    const result = xdr.TransactionResult.fromXDR(normalizeBase64(resultXdrBase64), "base64");
    const resultCode = result.result().switch().name;
    if (resultCode === "txSuccess") return null;

    let operations: TransactionFailure["operations"] = [];
    try {
      operations = (result.result().results() ?? []).map((op, index) => {
        // An opInner result nests the operation's own result union; the generic
        // value() accessor reaches it without switching on every op type.
        const code =
          op.switch().name === "opInner"
            ? (op.tr() as unknown as { value(): { switch(): { name: string } } })
                .value()
                .switch()
                .name
            : op.switch().name;
        return { index, code, failed: !/Success$/.test(code) };
      });
    } catch {
      // Codes like txBadSeq carry no per-operation results.
    }

    return { resultCode, operations };
  } catch {
    return null;
  }
}

function transactionResultFields(result: xdr.TransactionResult): XdrField[] {
  const fields: XdrField[] = [
    { label: "Fee charged", value: `${result.feeCharged().toString()} stroops` },
    { label: "Result", value: result.result().switch().name },
  ];

  try {
    const opResults = result.result().results();
    if (opResults?.length) {
      fields.push({
        label: "Operation results",
        value: opResults.map((op) => op.switch().name).join(", "),
      });
    }
  } catch {
    // Result codes like txBadSeq carry no per-operation results.
  }

  return fields;
}

function transactionMetaFields(meta: xdr.TransactionMeta): XdrField[] {
  const fields: XdrField[] = [{ label: "Meta version", value: `v${meta.switch()}` }];

  try {
    const soroban = meta.switch() === 3 ? meta.v3().sorobanMeta() : null;
    if (soroban) {
      fields.push({ label: "Events", value: String(soroban.events().length) });
      fields.push({ label: "Return value", value: scValToDisplay(soroban.returnValue()) });
    }
  } catch {
    // Non-Soroban transactions carry no Soroban meta.
  }

  return fields;
}

function ledgerKeyFields(key: xdr.LedgerKey): XdrField[] {
  const kind = key.switch().name;
  const fields: XdrField[] = [{ label: "Key type", value: kind }];

  try {
    if (kind === "contractData") {
      const data = key.contractData();
      fields.push(
        { label: "Contract", value: Address.fromScAddress(data.contract()).toString() },
        { label: "Durability", value: data.durability().name },
        { label: "Storage key", value: scValToDisplay(data.key()) }
      );
    } else if (kind === "contractCode") {
      fields.push({ label: "WASM hash", value: key.contractCode().hash().toString("hex") });
    } else if (kind === "account") {
      fields.push({
        label: "Account",
        value: StrKey.encodeEd25519PublicKey(key.account().accountId().ed25519()),
      });
    }
  } catch {
    // Fall through to just the key type.
  }

  return fields;
}

function ledgerEntryFields(entry: xdr.LedgerEntry): XdrField[] {
  return [
    { label: "Entry type", value: entry.data().switch().name },
    { label: "Last modified ledger", value: String(entry.lastModifiedLedgerSeq()) },
  ];
}

function specEntryFields(entry: xdr.ScSpecEntry): XdrField[] {
  const kind = entry.switch().name;
  const fields: XdrField[] = [{ label: "Spec entry", value: kind }];
  if (kind === "scSpecEntryFunctionV0") {
    const fn = entry.functionV0();
    fields.push(
      { label: "Function", value: fn.name().toString() },
      {
        label: "Inputs",
        value:
          fn
            .inputs()
            .map((input) => `${input.name().toString()}: ${specTypeToString(input.type())}`)
            .join(", ") || "(none)",
      },
      { label: "Outputs", value: fn.outputs().map(specTypeToString).join(", ") || "(none)" }
    );
  }
  return fields;
}

function scValFields(value: xdr.ScVal): XdrField[] {
  const decoded = decodeScVal(value);
  return [
    { label: "ScVal type", value: value.switch().name },
    {
      label: "Value",
      value: decoded === undefined ? "(unrepresentable value)" : JSON.stringify(decoded, null, 2),
    },
  ];
}

/**
 * Decode an arbitrary base64 XDR blob into a labelled, human-readable summary.
 * Returns null when the input isn't valid XDR of any type Prism understands.
 *
 * This is deliberately a summary of the fields that matter when debugging a
 * Soroban transaction, not an exhaustive dump of every XDR field.
 */
export function decodeAnyXdr(input: string): XdrDecodeResult | null {
  const type = identifyXdr(input);
  if (!type) return null;

  const base64 = normalizeBase64(input);
  try {
    switch (type) {
      case "TransactionEnvelope":
        return { type, fields: transactionEnvelopeFields(xdr.TransactionEnvelope.fromXDR(base64, "base64")) };
      case "TransactionResult":
        return { type, fields: transactionResultFields(xdr.TransactionResult.fromXDR(base64, "base64")) };
      case "TransactionMeta":
        return { type, fields: transactionMetaFields(xdr.TransactionMeta.fromXDR(base64, "base64")) };
      case "LedgerEntry":
        return { type, fields: ledgerEntryFields(xdr.LedgerEntry.fromXDR(base64, "base64")) };
      case "LedgerKey":
        return { type, fields: ledgerKeyFields(xdr.LedgerKey.fromXDR(base64, "base64")) };
      case "ScSpecEntry":
        return { type, fields: specEntryFields(xdr.ScSpecEntry.fromXDR(base64, "base64")) };
      case "ScVal":
        return { type, fields: scValFields(xdr.ScVal.fromXDR(base64, "base64")) };
    }
  } catch {
    // The type round-tripped but a field accessor didn't behave as expected —
    // report the type we're confident about rather than failing outright.
    return { type, fields: [] };
  }
}

function specTypeToString(type: xdr.ScSpecTypeDef): string {
  const kind = type.switch().name;
  switch (kind) {
    case "scSpecTypeVec":
      return `Vec<${specTypeToString(type.vec().elementType())}>`;
    case "scSpecTypeMap":
      return `Map<${specTypeToString(type.map().keyType())}, ${specTypeToString(type.map().valueType())}>`;
    case "scSpecTypeOption":
      return `Option<${specTypeToString(type.option().valueType())}>`;
    case "scSpecTypeResult":
      return `Result<${specTypeToString(type.result().okType())}>`;
    case "scSpecTypeUdt":
      return type.udt().name().toString();
    default:
      return kind.replace(/^scSpecType/, "");
  }
}
