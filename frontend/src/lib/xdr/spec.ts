import { xdr } from "@stellar/stellar-sdk";
import { XdrReader } from "@stellar/js-xdr";

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

export function specTypeToString(type: xdr.ScSpecTypeDef): string {
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
