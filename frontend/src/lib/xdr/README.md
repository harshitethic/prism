# XDR utilities

The public import path remains @/lib/xdr (or ./xdr from its parent).
The xdr.ts entry point is a compatibility facade: callers should not need
to change imports when implementations move between modules.

| Module | Responsibility |
| --- | --- |
| coerce.ts | Type-aware user argument coercion, generic and UDT values |
| scval.ts | ScVal decoding and display-safe conversion |
| spec.ts | WASM contract-spec functions, user-defined types, events and type names |
| invocation.ts | Soroban invocation and resource extraction from transactions |
| identify.ts | Unknown XDR identification and structured field summaries |
| failure.ts | Transaction failure and per-operation result interpretation |

Dependency direction is deliberate: coercion imports only type definitions from
spec.ts; the identification layer uses the spec, ScVal and invocation helpers;
the failure parser shares its base64 normalizer with identification. Modules
never import from the public xdr.ts compatibility facade, avoiding circular
imports.

This is a behavior-preserving extraction, not an opportunity to change how
Stellar/XDR blobs are interpreted. New behavior belongs in separate, focused
follow-up changes with regression tests. Run the XDR Vitest suite, all frontend
tests and TypeScript checking when updating these modules.
