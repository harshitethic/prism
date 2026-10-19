import { rpc, encodeMuxedAccountToAddress, type xdr } from "@stellar/stellar-sdk";
import { prisma, getCursor, setCursor } from "./db.js";
import { decodeInvocation, extractStorageChanges, extractEvents } from "./decode.js";

const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const PAGE_LIMIT = 50;

const server = new rpc.Server(RPC_URL, { timeout: 10_000 });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sourceAccountOf(envelope: xdr.TransactionEnvelope): string {
  try {
    const tx =
      envelope.switch().name === "envelopeTypeTxFeeBump"
        ? envelope.feeBump().tx().innerTx().v1().tx()
        : envelope.v1().tx();
    return encodeMuxedAccountToAddress(tx.sourceAccount());
  } catch {
    return "";
  }
}

async function processTransaction(tx: rpc.Api.TransactionInfo): Promise<void> {
  const createdAt = new Date(tx.createdAt * 1000);
  const invocation = decodeInvocation(tx.envelopeXdr);

  if (invocation) {
    // skipDuplicates makes reprocessing a page after a crash-before-cursor-advance safe.
    await prisma.invocation.createMany({
      data: [
        {
          txHash: tx.txHash,
          ledger: tx.ledger,
          createdAt,
          contractId: invocation.contractId,
          functionName: invocation.functionName,
          args: invocation.args as object,
          successful: tx.status === "SUCCESS",
          sourceAccount: sourceAccountOf(tx.envelopeXdr),
        },
      ],
      skipDuplicates: true,
    });
  }

  const changes = extractStorageChanges(tx.resultMetaXdr);
  if (changes.length > 0) {
    await prisma.storageChange.createMany({
      skipDuplicates: true,
      data: changes.map((c) => ({
        contractId: c.contractId,
        durability: c.durability,
        keyDisplay: c.keyDisplay,
        valueDisplay: c.valueDisplay,
        changeType: c.changeType,
        ledger: tx.ledger,
        txHash: tx.txHash,
        createdAt,
      })),
    });
  }

  const events = extractEvents(tx.resultMetaXdr, tx.txHash);
  if (events.length > 0) {
    await prisma.contractEventRecord.createMany({
      skipDuplicates: true,
      data: events.map((e) => ({
        eventId: e.eventId,
        contractId: e.contractId,
        type: e.type,
        topic: e.topic,
        value: e.value,
        txHash: tx.txHash,
        ledger: tx.ledger,
        createdAt,
      })),
    });
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Process one page of transactions starting after `cursor`. Returns the new cursor. */
async function pollOnce(cursor: number, latestLedger: number): Promise<number> {
  let res;
  try {
    res = await server.getTransactions({ startLedger: cursor + 1, pagination: { limit: PAGE_LIMIT } });
  } catch (err) {
    const message = errorMessage(err);

    // Public RPC is typically a load-balanced pool — a node can briefly lag
    // behind the one that answered our getLatestLedger() call, making it
    // report our very next ledger as "in the future". Transient: don't
    // advance the cursor, just retry on the next poll.
    const oldestMatch = message.match(/oldest ledger:\s*(\d+)/i);
    const latestMatch = message.match(/latest ledger:\s*(\d+)/i);
    if (oldestMatch && Number(oldestMatch[1]) > cursor + 1) {
      console.warn(
        `[indexer] ledger ${cursor + 1} is before the RPC node's retention window (oldest: ${oldestMatch[1]}) — ` +
          `skipping ahead to ${latestLedger}. Some history in the gap was missed.`
      );
      return latestLedger;
    }
    if (latestMatch && Number(latestMatch[1]) < cursor + 1) {
      return cursor;
    }
    throw err;
  }

  for (const tx of res.transactions) {
    try {
      await processTransaction(tx);
    } catch (err) {
      console.error(`[indexer] failed to process tx ${tx.txHash} at ledger ${tx.ledger}:`, err);
    }
  }

  if (res.transactions.length === 0) return latestLedger;
  return Math.max(...res.transactions.map((t) => t.ledger));
}

async function main(): Promise<void> {
  const latest = await server.getLatestLedger();
  let cursor = await getCursor(latest.sequence);
  console.log(`[indexer] starting at ledger ${cursor} (network is at ${latest.sequence})`);

  for (;;) {
    let caughtUp = true;
    try {
      const latestNow = await server.getLatestLedger();
      if (cursor < latestNow.sequence) {
        const newCursor = await pollOnce(cursor, latestNow.sequence);
        if (newCursor !== cursor) {
          cursor = newCursor;
          await setCursor(cursor);
          console.log(`[indexer] processed through ledger ${cursor}`);
        }
        caughtUp = cursor >= latestNow.sequence;
      }
    } catch (err) {
      console.error("[indexer] poll error:", err);
    }
    if (caughtUp) await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("[indexer] fatal error:", err);
  process.exit(1);
});
