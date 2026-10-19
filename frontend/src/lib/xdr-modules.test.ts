import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import * as publicXdr from "./xdr";
import * as coercion from "./xdr/coerce";
import * as scval from "./xdr/scval";
import * as spec from "./xdr/spec";
import * as invocation from "./xdr/invocation";
import * as identify from "./xdr/identify";
import * as failure from "./xdr/failure";

/**
 * The public entry point is an API compatibility boundary. These checks
 * intentionally exercise imports from both sides of the module extraction.
 * A caller should never need to know which file owns an implementation.
 */
describe("XDR public module compatibility", () => {
  it("exports the original coercion and ScVal functions unchanged", () => {
    expect(publicXdr.coerceArgInput).toBe(coercion.coerceArgInput);
    expect(publicXdr.decodeScVal).toBe(scval.decodeScVal);
    expect(publicXdr.scValToDisplay).toBe(scval.scValToDisplay);
    expect(publicXdr.decodeXdr).toBe(scval.decodeXdr);
    expect(publicXdr.decodeScValXdr).toBe(scval.decodeScValXdr);
  });

  it("exports contract specification and transaction helpers unchanged", () => {
    expect(publicXdr.parseContractSpec).toBe(spec.parseContractSpec);
    expect(publicXdr.parseContractTypes).toBe(spec.parseContractTypes);
    expect(publicXdr.parseContractEvents).toBe(spec.parseContractEvents);
    expect(publicXdr.decodeInvocation).toBe(invocation.decodeInvocation);
    expect(publicXdr.getResourceUsage).toBe(invocation.getResourceUsage);
  });

  it("exports XDR identification and failure decoding unchanged", () => {
    expect(publicXdr.identifyXdr).toBe(identify.identifyXdr);
    expect(publicXdr.decodeAnyXdr).toBe(identify.decodeAnyXdr);
    expect(publicXdr.base64FromQueryParam).toBe(identify.base64FromQueryParam);
    expect(publicXdr.decodeTransactionFailure).toBe(failure.decodeTransactionFailure);
  });

  it("produces identical coercion and display results from either import", () => {
    const viaPublic = publicXdr.coerceArgInput("42", "U32");
    const viaDirect = coercion.coerceArgInput("42", "U32");
    expect(viaPublic.toXDR("base64")).toBe(viaDirect.toXDR("base64"));
    const val = xdr.ScVal.scvSymbol("prism");
    expect(publicXdr.decodeScVal(val)).toBe(scval.decodeScVal(val));
    expect(publicXdr.scValToDisplay(val)).toBe("prism");
  });

  it("identifies the same invalid and valid base64 from either import", () => {
    const encoded = xdr.ScVal.scvU32(99).toXDR("base64");
    expect(publicXdr.identifyXdr(encoded)).toBe(identify.identifyXdr(encoded));
    expect(publicXdr.decodeAnyXdr(encoded)).toEqual(identify.decodeAnyXdr(encoded));
    expect(publicXdr.decodeAnyXdr("invalid XDR")).toBeNull();
    expect(publicXdr.decodeTransactionFailure("invalid XDR")).toBeNull();
  });
});
