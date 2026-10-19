import { describe, expect, it } from "vitest";
import {
  xdr,
  Account,
  Address,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  decodeScVal,
  scValToDisplay,
  decodeXdr,
  decodeScValXdr,
  coerceArgInput,
  parseContractSpec,
  identifyXdr,
  decodeAnyXdr,
  parseContractEvents,
  parseContractTypes,
  decodeTransactionFailure,
  base64FromQueryParam,
  type ParsedTypeDef,
  type ParsedEventSpec,
} from "./xdr";
import { labelEventData, labelEventTopics, matchEventSpec } from "./event-spec";

describe("decodeScVal / scValToDisplay", () => {
  it("decodes a u32", () => {
    expect(decodeScVal(xdr.ScVal.scvU32(42))).toBe(42);
  });

  it("decodes a symbol to a string", () => {
    expect(decodeScVal(xdr.ScVal.scvSymbol("hello"))).toBe("hello");
  });

  it("decodes a u128 to a string (bigints aren't JSON-safe)", () => {
    const decoded = decodeScVal(xdr.ScVal.scvU128(new xdr.UInt128Parts({ hi: xdr.Uint64.fromString("0"), lo: xdr.Uint64.fromString("1000") })));
    expect(decoded).toBe("1000");
  });

  it("renders void as the literal string 'void'", () => {
    expect(scValToDisplay(xdr.ScVal.scvVoid())).toBe("void");
  });

  it("renders a scalar as a plain string, not JSON-quoted", () => {
    expect(scValToDisplay(xdr.ScVal.scvSymbol("admin"))).toBe("admin");
  });

  it("renders a vec as JSON", () => {
    const vec = xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2)]);
    expect(scValToDisplay(vec)).toBe("[1,2]");
  });
});

describe("decodeXdr / decodeScValXdr (base64 round-trip)", () => {
  it("round-trips a symbol through base64 XDR", () => {
    const base64 = xdr.ScVal.scvSymbol("counter").toXDR("base64");
    expect(decodeXdr(base64)).toBe("counter");
    expect(decodeScValXdr(base64)).toBe("counter");
  });

  it("falls back to the raw input on invalid base64 XDR", () => {
    expect(decodeXdr("not valid xdr")).toBe("not valid xdr");
    expect(decodeScValXdr("not valid xdr")).toBeUndefined();
  });
});

describe("coerceArgInput", () => {
  it.each([
    ["", []],
    ["0x", []],
    ["0x00ff", [0, 255]],
    ["00ff", [0, 255]],
    ["0XAAFF", [170, 255]],
    [" 0xAbCd ", [171, 205]],
  ])("coerces valid Bytes hex input %j without data loss", (input, expected) => {
    const value = coerceArgInput(input, "Bytes");
    expect(value.switch().name).toBe("scvBytes");
    expect([...value.bytes()]).toEqual(expected);
  });

  it.each(["zz", "ab_cd", "abc", "0x0g", "0x123", "0x zz", "0x0x12"])(
    "rejects malformed Bytes input %j instead of silently truncating",
    (input) => {
      expect(() => coerceArgInput(input, "Bytes")).toThrow(/Bytes expects an even-length hexadecimal string/);
    }
  );

  it("coerces scalar types to the matching ScVal variant", () => {
    expect(coerceArgInput("42", "U32").switch().name).toBe("scvU32");
    expect(coerceArgInput("42", "I64").switch().name).toBe("scvI64");
    expect(coerceArgInput("hello", "Symbol").switch().name).toBe("scvSymbol");
    expect(coerceArgInput("true", "Bool").switch().name).toBe("scvBool");
    expect(coerceArgInput("true", "Bool").b()).toBe(true);
  });

  it("coerces a valid account address", () => {
    const address = Keypair.random().publicKey();
    const scval = coerceArgInput(address, "Address");
    expect(scval.switch().name).toBe("scvAddress");
    expect(Address.fromScAddress(scval.address()).toString()).toBe(address);
  });

  it("falls back to best-effort JSON parsing for unknown/compound types", () => {
    const scval = coerceArgInput('{"a":1}', "SomeUdtType");
    expect(scval.switch().name).toBe("scvMap");
  });
});

describe("parseContractSpec", () => {
  it("returns an empty array for a WASM binary with no contract spec section", () => {
    // Smallest valid WASM module: magic number + version, no sections.
    const emptyModule = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    expect(parseContractSpec(emptyModule)).toEqual([]);
  });

  it("returns an empty array (not a throw) for invalid input", () => {
    expect(parseContractSpec(Buffer.from("not wasm"))).toEqual([]);
  });
});

function buildEnvelope(source: Keypair) {
  return new TransactionBuilder(new Account(source.publicKey(), "42"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "100" }))
    .addMemo(Memo.text("prism"))
    .setTimeout(30)
    .build();
}

/**
 * A v0 transaction envelope — the pre-Protocol-13 shape, still all over the
 * chain's history. It carries a bare ed25519 key rather than a muxed account,
 * which is the part that used to make the decoder throw.
 */
function buildV0Envelope(source: Keypair) {
  const tx = new xdr.TransactionV0({
    sourceAccountEd25519: StrKey.decodeEd25519PublicKey(source.publicKey()),
    fee: 100,
    // SequenceNumber is a typedef of Int64; only the latter is in the .d.ts.
    seqNum: xdr.Int64.fromString("43"),
    timeBounds: null,
    memo: xdr.Memo.memoText(Buffer.from("prism")),
    operations: [Operation.bumpSequence({ bumpTo: "100" })],
    ext: new xdr.TransactionV0Ext(0),
  });
  return xdr.TransactionEnvelope.envelopeTypeTxV0(
    new xdr.TransactionV0Envelope({ tx, signatures: [] })
  );
}

describe("identifyXdr", () => {
  it("identifies a transaction envelope", () => {
    const envelope = buildEnvelope(Keypair.random()).toXDR();
    expect(identifyXdr(envelope)).toBe("TransactionEnvelope");
  });

  it("identifies a bare ScVal", () => {
    expect(identifyXdr(xdr.ScVal.scvSymbol("counter").toXDR("base64"))).toBe("ScVal");
  });

  it("identifies a ledger key", () => {
    const key = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 7) })
    );
    expect(identifyXdr(key.toXDR("base64"))).toBe("LedgerKey");
  });

  it("tolerates whitespace and newlines from a copy-paste", () => {
    const base64 = xdr.ScVal.scvU32(7).toXDR("base64");
    expect(identifyXdr(` ${base64.slice(0, 4)}\n${base64.slice(4)} `)).toBe("ScVal");
  });

  it("returns null for input that isn't XDR at all", () => {
    expect(identifyXdr("not valid xdr")).toBeNull();
    expect(identifyXdr("")).toBeNull();
  });

  it("rejects a truncated blob rather than matching a prefix", () => {
    const envelope = buildEnvelope(Keypair.random()).toXDR();
    const truncated = Buffer.from(envelope, "base64").subarray(0, 20).toString("base64");
    expect(identifyXdr(truncated)).not.toBe("TransactionEnvelope");
  });
});

describe("decodeAnyXdr", () => {
  it("summarizes a transaction envelope", () => {
    const source = Keypair.random();
    const result = decodeAnyXdr(buildEnvelope(source).toXDR());

    expect(result?.type).toBe("TransactionEnvelope");
    const fields = Object.fromEntries(result!.fields.map((f) => [f.label, f.value]));
    expect(fields["Source account"]).toBe(source.publicKey());
    expect(fields["Fee"]).toBe("100 stroops");
    expect(fields["Sequence"]).toBe("43");
    expect(fields["Memo"]).toBe("text: prism");
    expect(fields["Operations"]).toBe("bumpSequence");
  });

  it("summarizes an ScVal", () => {
    const result = decodeAnyXdr(xdr.ScVal.scvU32(99).toXDR("base64"));

    expect(result?.type).toBe("ScVal");
    const fields = Object.fromEntries(result!.fields.map((f) => [f.label, f.value]));
    expect(fields["ScVal type"]).toBe("scvU32");
    expect(fields["Value"]).toBe("99");
  });

  it("summarizes a contract data ledger key", () => {
    const contract = "CDPUJYCTPGPEGS6MBXYLEWTYSGCPVKUHCURLF2ORT3RAVL5TF5JKIAI5";
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contract).toScAddress(),
        key: xdr.ScVal.scvSymbol("Admin"),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );

    const result = decodeAnyXdr(key.toXDR("base64"));
    expect(result?.type).toBe("LedgerKey");
    const fields = Object.fromEntries(result!.fields.map((f) => [f.label, f.value]));
    expect(fields["Contract"]).toBe(contract);
    expect(fields["Storage key"]).toBe("Admin");
    expect(fields["Durability"]).toBe("persistent");
  });

  it("summarizes a v0 envelope, which carries a bare key instead of a muxed account", () => {
    const source = Keypair.random();
    const result = decodeAnyXdr(buildV0Envelope(source).toXDR("base64"));

    expect(result?.type).toBe("TransactionEnvelope");
    const fields = Object.fromEntries(result!.fields.map((f) => [f.label, f.value]));
    expect(fields["Envelope type"]).toBe("envelopeTypeTxV0");
    expect(fields["Source account"]).toBe(source.publicKey());
    expect(fields["Fee"]).toBe("100 stroops");
    expect(fields["Sequence"]).toBe("43");
    expect(fields["Memo"]).toBe("text: prism");
    expect(fields["Operations"]).toBe("bumpSequence");
  });

  it("returns null for input that isn't XDR", () => {
    expect(decodeAnyXdr("not valid xdr")).toBeNull();
  });
});

/** Unsigned LEB128, the length encoding WASM section headers use. */
function leb128(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

/**
 * Build a minimal WASM module carrying the given spec entries in a
 * "contractspecv0" custom section — the same shape soroban-sdk emits, without
 * needing a Rust toolchain to produce one.
 */
function wasmWithSpec(entries: xdr.ScSpecEntry[]): Buffer {
  const name = Buffer.from("contractspecv0");
  const body = Buffer.concat([
    leb128(name.length),
    name,
    ...entries.map((e) => Buffer.from(e.toXDR())),
  ]);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), // magic + version
    Buffer.from([0x00]), // custom section id
    leb128(body.length),
    body,
  ]);
}

function eventParam(
  name: string,
  type: xdr.ScSpecTypeDef,
  location: "topic" | "data"
): xdr.ScSpecEventParamV0 {
  return new xdr.ScSpecEventParamV0({
    doc: "",
    name,
    type,
    location:
      location === "topic"
        ? xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationTopicList()
        : xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationData(),
  });
}

/** Mirrors the showcase contract's NoteWritten event. */
function noteWrittenEntry(): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryEventV0(
    new xdr.ScSpecEventV0({
      doc: "Two indexed topics plus data.",
      lib: "",
      name: "NoteWritten",
      prefixTopics: ["note_written"],
      params: [
        eventParam("name", xdr.ScSpecTypeDef.scSpecTypeSymbol(), "topic"),
        eventParam("author", xdr.ScSpecTypeDef.scSpecTypeAddress(), "topic"),
        eventParam("revision", xdr.ScSpecTypeDef.scSpecTypeU32(), "data"),
      ],
      dataFormat: xdr.ScSpecEventDataFormat.scSpecEventDataFormatMap(),
    })
  );
}

/**
 * Modelled on the showcase contract's Bumped event — no indexed fields — but
 * declared single-value rather than the default map, to cover that mapping.
 */
function bumpedEntry(): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryEventV0(
    new xdr.ScSpecEventV0({
      doc: "",
      lib: "",
      name: "Bumped",
      prefixTopics: ["bumped"],
      params: [eventParam("counter", xdr.ScSpecTypeDef.scSpecTypeU32(), "data")],
      dataFormat: xdr.ScSpecEventDataFormat.scSpecEventDataFormatSingleValue(),
    })
  );
}

describe("parseContractEvents", () => {
  it("parses a declared event's name, topics, params and data format", () => {
    const [event] = parseContractEvents(wasmWithSpec([noteWrittenEntry()]));

    expect(event.name).toBe("NoteWritten");
    expect(event.prefixTopics).toEqual(["note_written"]);
    expect(event.dataFormat).toBe("map");
    expect(event.doc).toBe("Two indexed topics plus data.");
    expect(event.params).toEqual([
      { name: "name", type: "Symbol", location: "topic" },
      { name: "author", type: "Address", location: "topic" },
      { name: "revision", type: "U32", location: "data" },
    ]);
  });

  it("distinguishes the data formats", () => {
    const [event] = parseContractEvents(wasmWithSpec([bumpedEntry()]));
    expect(event.dataFormat).toBe("single-value");
    expect(event.params.every((p) => p.location === "data")).toBe(true);
  });

  it("omits an absent doc comment rather than reporting an empty string", () => {
    const [event] = parseContractEvents(wasmWithSpec([bumpedEntry()]));
    expect(event.doc).toBeUndefined();
  });

  it("reads events and functions from the same spec section", () => {
    const wasm = wasmWithSpec([noteWrittenEntry(), bumpedEntry()]);
    expect(parseContractEvents(wasm).map((e) => e.name)).toEqual(["NoteWritten", "Bumped"]);
    // Function parsing must ignore the event entries, not choke on them.
    expect(parseContractSpec(wasm)).toEqual([]);
  });

  it("returns an empty array for a contract with no spec section", () => {
    const emptyModule = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    expect(parseContractEvents(emptyModule)).toEqual([]);
    expect(parseContractEvents(Buffer.from("not wasm"))).toEqual([]);
  });
});

describe("matchEventSpec / labelEventTopics", () => {
  const specs: ParsedEventSpec[] = [
    {
      name: "NoteWritten",
      prefixTopics: ["note_written"],
      params: [
        { name: "name", type: "Symbol", location: "topic" },
        { name: "author", type: "Address", location: "topic" },
        { name: "revision", type: "U32", location: "data" },
      ],
      dataFormat: "map",
    },
    {
      name: "Bumped",
      prefixTopics: ["bumped"],
      params: [{ name: "counter", type: "U32", location: "data" }],
      dataFormat: "single-value",
    },
  ];

  it("matches an emitted event to its declaration by prefix topic", () => {
    const match = matchEventSpec(["note_written", "hello", "GABC"], specs);
    expect(match?.name).toBe("NoteWritten");
  });

  it("matches an event that carries only its name topic", () => {
    expect(matchEventSpec(["bumped"], specs)?.name).toBe("Bumped");
  });

  it("returns undefined for an event the contract never declared", () => {
    expect(matchEventSpec(["transfer", "GABC"], specs)).toBeUndefined();
    expect(matchEventSpec([], specs)).toBeUndefined();
  });

  it("rejects a topic count that doesn't match the declaration", () => {
    // Right prefix, wrong arity — a different event, not this one.
    expect(matchEventSpec(["note_written", "hello"], specs)).toBeUndefined();
    expect(matchEventSpec(["note_written", "hello", "GABC", "extra"], specs)).toBeUndefined();
  });

  it("labels the topics that vary, dropping the event's name topic", () => {
    expect(labelEventTopics(["note_written", "hello", "GABC"], specs[0])).toEqual([
      { name: "name", type: "Symbol", value: "hello" },
      { name: "author", type: "Address", value: "GABC" },
    ]);
  });

  it("labels nothing for an event with no indexed fields", () => {
    expect(labelEventTopics(["bumped"], specs[1])).toEqual([]);
  });
});

describe("base64FromQueryParam", () => {
  it("restores pluses that a query string decoded as spaces", () => {
    expect(base64FromQueryParam("AAAAAgAAAAALEDS eRmphqUKYJ")).toBe("AAAAAgAAAAALEDS+eRmphqUKYJ");
  });

  it("leaves a correctly percent-encoded blob untouched", () => {
    const blob = "AAAAAgAAAAALEDS+eRmphqUKYJ/w==";
    expect(base64FromQueryParam(blob)).toBe(blob);
  });

  it("leaves the other base64 characters alone", () => {
    expect(base64FromQueryParam("a/b+c=")).toBe("a/b+c=");
  });
});

describe("labelEventData", () => {
  const mapSpec: ParsedEventSpec = {
    name: "NoteWritten",
    prefixTopics: ["note_written"],
    params: [
      { name: "name", type: "Symbol", location: "topic" },
      { name: "revision", type: "U32", location: "data" },
      { name: "author", type: "Address", location: "data" },
    ],
    dataFormat: "map",
  };

  const vecSpec: ParsedEventSpec = { ...mapSpec, dataFormat: "vec" };

  const singleSpec: ParsedEventSpec = {
    name: "Bumped",
    prefixTopics: ["bumped"],
    params: [{ name: "counter", type: "U32", location: "data" }],
    dataFormat: "single-value",
  };

  it("labels a map payload by field name", () => {
    expect(labelEventData('{"revision":2,"author":"GABC"}', mapSpec)).toEqual([
      { name: "revision", type: "U32", value: "2" },
      { name: "author", type: "Address", value: "GABC" },
    ]);
  });

  it("labels a vec payload positionally, which is the only way to read one", () => {
    expect(labelEventData('[2,"GABC"]', vecSpec)).toEqual([
      { name: "revision", type: "U32", value: "2" },
      { name: "author", type: "Address", value: "GABC" },
    ]);
  });

  it("labels a single-value payload from the display string as-is", () => {
    // scValToDisplay renders scalars bare, not JSON-quoted.
    expect(labelEventData("7", singleSpec)).toEqual([
      { name: "counter", type: "U32", value: "7" },
    ]);
  });

  it("refuses a vec whose length disagrees with the declaration", () => {
    expect(labelEventData("[2]", vecSpec)).toBeNull();
    expect(labelEventData('[2,"GABC",99]', vecSpec)).toBeNull();
  });

  it("refuses a map missing a declared field rather than labelling a gap", () => {
    expect(labelEventData('{"revision":2}', mapSpec)).toBeNull();
  });

  it("refuses a payload of the wrong shape for its format", () => {
    expect(labelEventData('[2,"GABC"]', mapSpec)).toBeNull();
    expect(labelEventData('{"revision":2,"author":"GABC"}', vecSpec)).toBeNull();
  });

  it("returns null for an unparsable payload", () => {
    expect(labelEventData("not json", mapSpec)).toBeNull();
  });

  it("returns null when the event declares no data fields", () => {
    const topicsOnly: ParsedEventSpec = {
      ...mapSpec,
      params: [{ name: "name", type: "Symbol", location: "topic" }],
    };
    expect(labelEventData("{}", topicsOnly)).toBeNull();
  });

  it("renders a nested value as JSON rather than [object Object]", () => {
    const nested: ParsedEventSpec = {
      ...singleSpec,
      dataFormat: "map",
      params: [{ name: "detail", type: "Map<Symbol, U32>", location: "data" }],
    };
    expect(labelEventData('{"detail":{"a":1}}', nested)).toEqual([
      { name: "detail", type: "Map<Symbol, U32>", value: '{"a":1}' },
    ]);
  });
});

describe("coerceArgInput with compound types", () => {
  it("coerces Vec elements to the declared element type", () => {
    const vec = coerceArgInput('["a","b"]', "Vec<Symbol>");
    expect(vec.switch().name).toBe("scvVec");
    // Inferring from JSON alone yields scvString here, which the contract rejects.
    expect(vec.vec()!.map((v) => v.switch().name)).toEqual(["scvSymbol", "scvSymbol"]);
    expect(vec.vec()!.map((v) => v.sym().toString())).toEqual(["a", "b"]);
  });

  it("coerces a Vec of the widest integer type without falling back to u64", () => {
    const vec = coerceArgInput("[1,2]", "Vec<I128>");
    expect(vec.vec()!.map((v) => v.switch().name)).toEqual(["scvI128", "scvI128"]);
  });

  it("handles a nested Vec", () => {
    const vec = coerceArgInput('[["a"],["b"]]', "Vec<Vec<Symbol>>");
    const inner = vec.vec()![0];
    expect(inner.switch().name).toBe("scvVec");
    expect(inner.vec()![0].switch().name).toBe("scvSymbol");
  });

  it("coerces an empty Vec", () => {
    expect(coerceArgInput("[]", "Vec<Symbol>").vec()).toEqual([]);
  });

  it("coerces Map keys and values to their declared types, in canonical order", () => {
    const map = coerceArgInput('{"b":2,"a":1}', "Map<Symbol, U32>");
    expect(map.switch().name).toBe("scvMap");
    const entries = map.map()!;
    expect(entries.map((e) => e.key().sym().toString())).toEqual(["a", "b"]);
    expect(entries.map((e) => e.val().switch().name)).toEqual(["scvU32", "scvU32"]);
  });

  it("treats an empty Option as void and a filled one as its inner type", () => {
    expect(coerceArgInput("", "Option<U32>").switch().name).toBe("scvVoid");
    expect(coerceArgInput("null", "Option<U32>").switch().name).toBe("scvVoid");
    expect(coerceArgInput("5", "Option<U32>").switch().name).toBe("scvU32");
  });

  it("reports what it wanted when the input isn't the right shape", () => {
    expect(() => coerceArgInput('"a"', "Vec<Symbol>")).toThrow(/expects a JSON array/);
    expect(() => coerceArgInput("[1]", "Map<Symbol, U32>")).toThrow(/expects a JSON object/);
  });

  it("still falls back to JSON inference for a contract's own types", () => {
    expect(coerceArgInput('{"a":1}', "SomeUdtType").switch().name).toBe("scvMap");
  });
});

describe("parseContractTypes", () => {
  function structEntry() {
    return xdr.ScSpecEntry.scSpecEntryUdtStructV0(
      new xdr.ScSpecUdtStructV0({
        doc: "A stored note.",
        lib: "",
        name: "Note",
        fields: [
          new xdr.ScSpecUdtStructFieldV0({
            doc: "",
            name: "author",
            type: xdr.ScSpecTypeDef.scSpecTypeAddress(),
          }),
          new xdr.ScSpecUdtStructFieldV0({
            doc: "",
            name: "revision",
            type: xdr.ScSpecTypeDef.scSpecTypeU32(),
          }),
        ],
      })
    );
  }

  function unionEntry() {
    return xdr.ScSpecEntry.scSpecEntryUdtUnionV0(
      new xdr.ScSpecUdtUnionV0({
        doc: "",
        lib: "",
        name: "DataKey",
        cases: [
          xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(
            new xdr.ScSpecUdtUnionCaseVoidV0({ doc: "", name: "Admin" })
          ),
          xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseTupleV0(
            new xdr.ScSpecUdtUnionCaseTupleV0({
              doc: "",
              name: "Note",
              type: [xdr.ScSpecTypeDef.scSpecTypeSymbol()],
            })
          ),
        ],
      })
    );
  }

  function errorEnumEntry() {
    return xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
      new xdr.ScSpecUdtErrorEnumV0({
        doc: "",
        lib: "",
        name: "Error",
        cases: [
          new xdr.ScSpecUdtErrorEnumCaseV0({ doc: "", name: "NotInitialized", value: 2 }),
        ],
      })
    );
  }

  it("parses a struct's fields and types", () => {
    const [def] = parseContractTypes(wasmWithSpec([structEntry()]));
    expect(def).toEqual({
      kind: "struct",
      name: "Note",
      doc: "A stored note.",
      fields: [
        { name: "author", type: "Address" },
        { name: "revision", type: "U32" },
      ],
    });
  });

  it("parses both void and tuple union cases", () => {
    const [def] = parseContractTypes(wasmWithSpec([unionEntry()]));
    expect(def.kind).toBe("union");
    expect(def).toMatchObject({
      name: "DataKey",
      cases: [
        { name: "Admin", types: [] },
        { name: "Note", types: ["Symbol"] },
      ],
    });
  });

  it("parses an error enum's discriminants", () => {
    const [def] = parseContractTypes(wasmWithSpec([errorEnumEntry()]));
    expect(def).toMatchObject({
      kind: "error",
      name: "Error",
      cases: [{ name: "NotInitialized", value: 2 }],
    });
  });

  it("reads type definitions alongside functions and events", () => {
    const wasm = wasmWithSpec([structEntry(), noteWrittenEntry(), unionEntry()]);
    expect(parseContractTypes(wasm).map((t) => t.name)).toEqual(["Note", "DataKey"]);
    // The other parsers must ignore these entries rather than choke on them.
    expect(parseContractEvents(wasm).map((e) => e.name)).toEqual(["NoteWritten"]);
    expect(parseContractSpec(wasm)).toEqual([]);
  });

  it("returns an empty array for a contract with no spec", () => {
    expect(parseContractTypes(Buffer.from("not wasm"))).toEqual([]);
  });
});

describe("coerceArgInput with the contract's own types", () => {
  const types: ParsedTypeDef[] = [
    {
      kind: "struct",
      name: "Note",
      fields: [
        { name: "author", type: "Address" },
        { name: "revision", type: "U32" },
      ],
    },
    {
      kind: "struct",
      name: "Pair",
      fields: [
        { name: "0", type: "Symbol" },
        { name: "1", type: "U32" },
      ],
    },
    {
      kind: "union",
      name: "DataKey",
      cases: [
        { name: "Admin", types: [] },
        { name: "Note", types: ["Symbol"] },
      ],
    },
    {
      kind: "enum",
      name: "Level",
      cases: [
        { name: "Low", value: 1 },
        { name: "High", value: 9 },
      ],
    },
    { kind: "error", name: "Error", cases: [{ name: "NoSuchNote", value: 4 }] },
  ];

  const address = Keypair.random().publicKey();

  it("encodes a named struct as a map of field-name symbols", () => {
    const value = coerceArgInput(`{"author":"${address}","revision":2}`, "Note", types);
    expect(value.switch().name).toBe("scvMap");
    const entries = value.map()!;
    expect(entries.map((e) => e.key().sym().toString())).toEqual(["author", "revision"]);
    // Field types come from the declaration, not from JSON inference.
    expect(entries[0].val().switch().name).toBe("scvAddress");
    expect(entries[1].val().switch().name).toBe("scvU32");
  });

  it("encodes a tuple struct as a vec, not a map keyed by \"0\"", () => {
    const value = coerceArgInput('["a",7]', "Pair", types);
    expect(value.switch().name).toBe("scvVec");
    expect(value.vec()!.map((v) => v.switch().name)).toEqual(["scvSymbol", "scvU32"]);
  });

  it("encodes a payload-free union case from its bare name", () => {
    const value = coerceArgInput("Admin", "DataKey", types);
    expect(value.switch().name).toBe("scvVec");
    expect(value.vec()!).toHaveLength(1);
    expect(value.vec()![0].sym().toString()).toBe("Admin");
  });

  it("encodes a union case with a payload, typing the payload from the declaration", () => {
    const value = coerceArgInput('{"Note":["hello"]}', "DataKey", types);
    const vec = value.vec()!;
    expect(vec[0].sym().toString()).toBe("Note");
    expect(vec[1].switch().name).toBe("scvSymbol");
    expect(vec[1].sym().toString()).toBe("hello");
  });

  it("accepts a single payload value without an array wrapper", () => {
    expect(coerceArgInput('{"Note":"hello"}', "DataKey", types).vec()![1].sym().toString()).toBe(
      "hello"
    );
  });

  it("encodes a u32 enum by case name or discriminant", () => {
    expect(coerceArgInput("High", "Level", types).u32()).toBe(9);
    expect(coerceArgInput("9", "Level", types).u32()).toBe(9);
  });

  it("recurses so a struct can hold the contract's other types", () => {
    const nested: ParsedTypeDef[] = [
      ...types,
      { kind: "struct", name: "Wrapper", fields: [{ name: "level", type: "Level" }] },
    ];
    const value = coerceArgInput('{"level":"Low"}', "Wrapper", nested);
    expect(value.map()![0].val().u32()).toBe(1);
  });

  it("says what it wanted when the input doesn't fit the declaration", () => {
    expect(() => coerceArgInput('{"author":"G"}', "Note", types)).toThrow(/missing field\(s\): revision/);
    expect(() => coerceArgInput("Nope", "Level", types)).toThrow(/no case Nope/);
    expect(() => coerceArgInput('{"Ghost":[]}', "DataKey", types)).toThrow(/no case Ghost/);
    expect(() => coerceArgInput("Note", "DataKey", types)).toThrow(/takes 1 value/);
    expect(() => coerceArgInput('{"Note":["a","b"]}', "DataKey", types)).toThrow(/got 2/);
    expect(() => coerceArgInput('["a",7]', "Note", types)).toThrow(/expects a JSON object/);
  });

  it("refuses an error type as an argument", () => {
    expect(() => coerceArgInput("NoSuchNote", "Error", types)).toThrow(/can't be passed as an argument/);
  });

  it("still falls back to JSON inference when no definitions are supplied", () => {
    expect(coerceArgInput('{"a":1}', "Note").switch().name).toBe("scvMap");
  });
});

describe("decodeTransactionFailure", () => {
  /**
   * Real result XDR from testnet transaction
   * cb60cb714703a8cb6670f17104a9d683fb403b8c02bf4603e3b803cb0cdbc208 — a
   * 22-operation transaction where two manage-sell-offer operations crossed
   * the account's own offers. Using chain data rather than a hand-built
   * fixture keeps the test honest about the shape Horizon really returns.
   */
  const FAILED_RESULT_XDR =
    "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";

  it("reports the transaction-level failure code", () => {
    expect(decodeTransactionFailure(FAILED_RESULT_XDR)?.resultCode).toBe("txFailed");
  });

  it("names each operation's own result code", () => {
    const failure = decodeTransactionFailure(FAILED_RESULT_XDR)!;
    expect(failure.operations).toHaveLength(22);
    expect(failure.operations[0].code).toBe("manageSellOfferSuccess");
  });

  it("distinguishes the operations that actually failed", () => {
    const failure = decodeTransactionFailure(FAILED_RESULT_XDR)!;
    const failed = failure.operations.filter((op) => op.failed);
    // 20 of the 22 operations succeeded and were rolled back with the rest.
    expect(failed).toHaveLength(2);
    expect(failed.map((op) => op.code)).toEqual([
      "manageSellOfferCrossSelf",
      "manageSellOfferCrossSelf",
    ]);
    expect(failed.every((op) => op.index > 0)).toBe(true);
  });

  it("returns null for a successful transaction", () => {
    const success = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString("100"),
      result: xdr.TransactionResultResult.txSuccess([]),
      ext: new xdr.TransactionResultExt(0),
    });
    expect(decodeTransactionFailure(success.toXDR("base64"))).toBeNull();
  });

  it("returns null rather than throwing on input that isn't a result", () => {
    expect(decodeTransactionFailure("not xdr")).toBeNull();
    expect(decodeTransactionFailure("")).toBeNull();
  });
});
