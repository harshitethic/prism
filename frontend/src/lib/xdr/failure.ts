import { xdr } from "@stellar/stellar-sdk";
import { normalizeBase64 } from "./identify";

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
