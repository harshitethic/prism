// Public XDR entry point. Keep existing imports stable while implementations
// live in smaller, single-responsibility modules under ./xdr/.
export { coerceArgInput } from "./xdr/coerce";
export { decodeScVal, scValToDisplay, decodeXdr, decodeScValXdr } from "./xdr/scval";
export { parseContractSpec, parseContractTypes, parseContractEvents } from "./xdr/spec";
export type {
  ParsedFunctionSpec,
  EventParamSpec,
  ParsedEventSpec,
  ParsedTypeDef,
} from "./xdr/spec";
export { decodeInvocation, getResourceUsage } from "./xdr/invocation";
export { identifyXdr, decodeAnyXdr, base64FromQueryParam } from "./xdr/identify";
export type { XdrTypeName, XdrField, XdrDecodeResult } from "./xdr/identify";
export { decodeTransactionFailure } from "./xdr/failure";
export type { TransactionFailure } from "./xdr/failure";
