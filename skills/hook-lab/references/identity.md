# Deployment identity and compatibility

Use `scripts/identity.mjs` to compare independently prepared deployment expectations with one Robinhood Chain block. Identity matching is one prerequisite for adapter qualification. It does not establish pool initialization, trading permissions, liquidity, safety, or profitable execution.

## API

```js
import { validateManifest, inspectDeployment, compareIdentity } from './scripts/identity.mjs';
const normalized = validateManifest(manifest); // throws for malformed expectations
const inspection = await inspectDeployment(normalized, {rpc});
const comparison = compareIdentity(priorInspection, inspection);
```

`rpc(method, params)` is an injected read-only transport returning the JSON-RPC `result` or throwing. The CLI's transport supplies request deadlines and response size limits. There is no hidden network fallback, wallet signer, transaction submission, or block-number fallback for unsupported EIP-1898 reads.

## Manifest: `hook-lab.deployment.v1`

Top-level fields are exactly `schema_version`, `chain_id`, `block`, `pool`, `contracts`, `checks`, `source_refs`, and `dependency_scope`. Unknown fields are rejected to catch misspelled expectations.

| Field | Required meaning |
|---|---|
| `chain_id` | Integer `4663`. |
| `block` | `{number, hash}` with a safe nonnegative integer and exact 32-byte hash. |
| `pool` | `{pool_id,currency0,currency1,fee,tick_spacing,hooks}`. Addresses are 20-byte hex; currencies are strictly sorted. Pool ID must equal Keccak-256 of the five ABI-encoded PoolKey words. |
| `contracts` | 1–20 entries identifying exact runtime code and declared proxy behavior. |
| `checks` | Configuration calls with exact expected return bytes. Array may be empty only if the reviewed deployment has no configuration checks to assert. |
| `source_refs` | 1–50 supplied references, such as pinned source/build URLs or artifact digests. These are retained expectations; this module does not fetch or authenticate their contents. |
| `dependency_scope` | `reviewed` or `unknown`. Unknown scope always leaves identity unqualified. “Reviewed” is the manifest author's assertion, not an automated completeness proof. |

A contract entry has `role`, `address`, `expected_code_hash`, and `proxy_kind`. Allowed roles are `manager`, `hook`, `router`, `token`, and `dependency`. The manager must be exactly `0x8366a39cc670b4001a1121b8f6a443a643e40951`. A nonzero PoolKey hook requires exactly its hook record; both nonnative currencies require token records. Native currency uses the zero address and must not be represented as a deployed token. Addresses cannot repeat. Router entries are optional for identity-only inspection; route qualification must require and bind the router actually used.

`expected_code_hash` is a 32-byte Ethereum Keccak-256 hash of the complete deployed runtime bytes. Obtain it from an independently verified build/deployment record; hashing the same untrusted RPC response does not create independent verification. Empty runtime never qualifies even if the expected hash matches empty bytes.

Proxy fields:

| `proxy_kind` | Fields and behavior |
|---|---|
| `none` | No proxy expectation fields. Means the reviewer declared no supported proxy mechanism; it does not prove absence of arbitrary `delegatecall` or mutable dependencies. An obvious standard EIP-1167 runtime is rejected as undeclared. |
| `eip1967` | Reads implementation, admin and beacon slots. Qualification requires `expected_admin` (zero allowed) and `implementation:{address,expected_code_hash}`. Beacon mode additionally requires `beacon:{address,expected_code_hash}`. Both implementation and beacon slots populated is unqualified. |
| `eip1167` | Recognizes only the exact standard 45-byte runtime and checks its embedded target against `implementation:{address,expected_code_hash}`. Other clone variants remain unqualified. |
| `unknown` | Runtime is retained, but identity remains unqualified. |

In beacon mode, `implementation()` is called with `from` set to the proxy address, then the resolved implementation runtime is checked. Matching beacon and implementation hashes covers one declared layer. Review and explicitly include nested delegates, implementation dependencies, upgrade authorities, or mutable lookup registries elsewhere in the contract graph and checks. Empty EIP-1967 slots alone cannot prove that a contract is non-upgradeable; the module does not infer `proxy_kind:none` from storage.

Each check is `{id,to,data,expected_result,from?,value?}`. IDs are unique; `to` must belong to the reviewed contract graph or a declared implementation/beacon. Hex bytes must be even-length; native value is a canonical hex uint256 quantity. Preserve the correct caller when a getter depends on `msg.sender`. Use checks for reviewed settings such as paused state, fee parameters and routing dependencies. Liquidity and price observations belong in a separate execution context and must not masquerade as immutable identity.

V4 validation covers uint24 fees (static ≤1,000,000 or the exact dynamic sentinel `0x800000`), tick spacing 1–32767, and each return-delta flag's associated callback bit. A zero hook cannot select dynamic fees; a nonzero static-fee hook must have callback flags. These structural rules say nothing about the correctness of the callback implementation.

## Evidence and outcomes

Inspection checks the RPC chain ID, binds the requested block number to its hash, and pins all code, storage and call reads with `{blockHash,requireCanonical:true}`. It re-reads the canonical header after collection. Each RPC request and result is retained with an index and deterministic SHA-256 digest. Provider exception messages are omitted because they may contain credential-bearing URLs; only a safe error classification is retained.

Work is bounded to 50 total RPC calls. Manifest validation uses a conservative worst-case budget, including beacon and implementation reads and the final header check; reduce the manifest or split investigations if it exceeds that bound. A split investigation must not claim that one partial manifest covers the entire deployment.

Successful output has schema `hook-lab.identity.v1`, status `IDENTITY_MATCH_AT_BLOCK`, `qualified_for_identity:true`, and **`qualified_for_execution:false`**. A mismatch, incomplete scope, provider failure, malformed response or reorg produces `IDENTITY_UNQUALIFIED` with machine-readable `problems`. Malformed input expectations throw before collection.

`manifest_digest` includes block-specific expectations. `identity_digest` binds the observed pool, runtime/dependency graph, and configuration results; it excludes block height to allow cross-block comparison. `evidence_digest` binds raw requests/results. `inspection_digest` binds the block, status and these digests. All use `sha256:` followed by 64 lowercase hex digits. Digests detect accidental modification; they are not signatures or provider authenticity proofs. Verify a supplied inspection by replaying its exact transcript against an independently supplied manifest before using it to qualify a route.

## Compatibility monitoring

`compareIdentity(prior,current)` returns `COMPATIBLE_OBSERVATIONS_AT_BLOCK`, `INVALIDATED`, or `INSUFFICIENT_EVIDENCE`. Updated expected hashes cannot hide a change in observed implementation, code, admin, beacon, configuration, or the checked graph. Tampered digests and unqualified inspections produce insufficient evidence.

Same-height different hashes, backwards time/heights, and mismatched adjacent-parent links invalidate comparisons. Matching observations several blocks apart report `continuity:UNPROVEN`; matching endpoints do not prove unchanged intermediate state. `blocks_elapsed` and `seconds_elapsed` describe spacing between observations, not wall-clock freshness. Consumers must supply their own current-time and maximum-age policy, verify the current canonical block, and recollect after relevant configuration changes. Matching identity never automatically enables execution.

Sources checked 2026-09-08: [ERC-1967 proxy slots](https://eips.ethereum.org/EIPS/eip-1967), [ERC-1167 minimal proxy](https://eips.ethereum.org/EIPS/eip-1167), [Uniswap V4 PoolKey](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolKey.sol), and [Uniswap V4 hook permissions](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol). Pin exact upstream revisions when qualifying a production deployment.
