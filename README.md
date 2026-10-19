# Prism

Prism is a Soroban-native block explorer for the Stellar network. While existing explorers like stellar.expert cover classic Stellar operations, they have limited or no support for Soroban-specific data contract storage, invocation history, emitted events, and WASM bytecode. Prism exposes all of this in a clean, fast, open-source interface.

---

## Why Prism

The Stellar Development Foundation identified explorer support for Soroban as a critical missing piece of infrastructure:

> *"Soroban needs explorers that can retrieve data about smart contracts."*

When a developer deploys a Soroban contract, they need to inspect its storage state, trace invocation history, debug failed transactions, and monitor emitted events. None of this is possible with current explorers. Prism is built to fill that gap as a community-owned, open-source tool.

---

## Features

### Contract Explorer
- View deployed contract WASM bytecode and metadata
- Inspect live contract storage (persistent, temporary, and instance storage)
- Browse full invocation history with inputs and outputs
- View all emitted contract events with filtering

### Transaction Explorer
- Detailed transaction breakdown with Soroban-specific operation decoding
- Transaction simulation and dry-run from the UI
- Fee and resource usage breakdown (CPU instructions, memory, ledger reads/writes)
- Failed transaction debugging with error messages

### Ledger & Network
- Real-time ledger streaming
- Network statistics (TPS, ledger close time, active contracts)
- Search by transaction hash, contract ID, account address, or ledger sequence

### Developer Tools
- In-browser contract invocation (call any contract function directly from Prism)
- ABI/interface display for verified contracts
- XDR decoder for raw transaction data at `/xdr` — paste any base64 blob and Prism identifies the type (transaction envelope, result, meta, ledger entry/key, contract spec entry, or ScVal) before decoding it

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Browser (Next.js)                 │
│   Contract View  │  Tx Explorer  │  Dev Tools       │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│                  Prism API (Next.js API routes)      │
└──────────────────┬───────────────────┬──────────────┘
                   │                   │
         ┌─────────┴──────────┐        │ (optional)
         │                    │        │
┌────────▼──────┐   ┌─────────▼────────┐  ┌──▼──────────────┐
│ Stellar Horizon│   │  Soroban RPC     │  │  Postgres        │
│ (classic ops) │   │  (contract data) │  │  (indexed data)  │
└───────────────┘   └────────┬─────────┘  └──▲──────────────┘
                              │                │
                    ┌─────────▼────────────────┴──┐
                    │  indexer/ (forward-only)     │
                    │  polls Soroban RPC, persists │
                    │  storage/invocations/events  │
                    └───────────────────────────────┘
```

The repository is three parts: `frontend/` (the explorer itself), `indexer/` (an optional service described below), and `contracts/` — Soroban contracts that exist to be looked at. `contracts/showcase` deliberately uses every feature the explorer renders (all three storage durabilities, typed events, the full range of ScVal shapes in its ABI, and a function that always fails), so each panel can be verified against a contract you control instead of hunting for a mainnet one that happens to exercise it. See [contracts/README.md](./contracts/README.md) for the deploy recipe.

The frontend works standalone against public RPC/Horizon endpoints — no database required. That gets you live chain state but is bounded by the RPC node's retention window (~24h) for events/history, and there's no way to enumerate a contract's storage keys via RPC at all (no such method exists). Running the optional `indexer/` service alongside it removes both limits for data observed since the indexer started: full invocation/event history and genuine storage-key enumeration, not just point lookups. It's forward-only by design — no historical backfill from before it started running.

---

## Self-Hosting

Standalone (frontend only, no database):

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Full stack, including the indexer for full storage enumeration and unbounded history:

Copy the local database configuration first, then choose an appropriate password:

```bash
cp .env.example .env
# For non-local development, replace PRISM_DB_PASSWORD in .env
# with a strong URL-safe value, e.g. using: openssl rand -hex 24
docker compose up
```

The example `PRISM_DB_PASSWORD=prism` is **only for trusted local development**.
Compose requires this variable and shares it with Postgres, the indexer and
frontend. Because it is also placed in a database connection URL, use
URL-safe characters (such as random hex) rather than unescaped reserved URL
characters. Keep `.env` private; it is ignored by Git.

Postgres now binds to `127.0.0.1:5432` on the **host**, not every network
interface; other containers still reach it using the service name
`postgres:5432`. Do not expose the example credentials over a network.
For an existing database volume, changing `POSTGRES_PASSWORD` alone does
not rotate its already-created database password; rotate it inside Postgres
before changing the environment value.

This runs Postgres, the indexer (`indexer/`), and the frontend together — see [Architecture](#architecture) above for what running the indexer actually buys you.

---

## Roadmap

- [x] Ledger overview and real-time streaming
- [x] Transaction explorer with Soroban decoding
- [x] Contract storage inspector
- [x] Contract invocation history and event log
- [x] In-browser contract invocation tool
- [x] XDR decoder
- [x] Docker Compose for self-hosting
- [x] Optional indexer for full storage enumeration and unbounded history
- [x] Showcase contract for end-to-end verification of every explorer panel
- [ ] Mainnet deployment at prism.network

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get started. Frontend, RPC integration, indexer, and Soroban contract contributions are all needed.

## License

MIT — see [LICENSE](./LICENSE).
