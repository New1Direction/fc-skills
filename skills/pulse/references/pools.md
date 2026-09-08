# V4 pool-state engine

## Boundary

`scripts/pools.mjs` exports a deterministic, bounded `PoolEngine`. It performs no network calls, signatures, transaction submissions, route simulation, pricing-service calls, or wallet attribution. Give it ordered block bundles from the runtime's selected canonical source. Source authentication, chain-ID response checks, runtime bytecode verification, receipt matching, completeness claims and reconnect recovery belong to the upstream collector. A supplied manager address or registry is not a deployment proof.

Supported chain: Robinhood mainnet **4663**. Supported manager: **0x8366a39cc670b4001a1121b8f6a443a643e40951**. This address is listed in [Uniswap's official deployments](https://developers.uniswap.org/docs/protocols/v4/deployments), checked 2026-09-08. Do not replace it with a pool address: V4 is a singleton, and each pool is keyed by its `PoolId`.

The core event layouts follow [IPoolManager](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol). Pool IDs follow [PoolId](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolId.sol). Hook-key constraints follow [Hooks](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol). Keccak uses a small original JavaScript implementation of the public permutation in `scripts/keccak.mjs`, with known digest vectors in the tests; Node's `sha3-256` is not Ethereum Keccak.

## Registry

```js
import {PoolEngine} from './pools.mjs';
const engine = new PoolEngine({
  chain_id: 4663,
  manager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  pools: [{
    pool_id, currency0, currency1, fee, tick_spacing, hooks,
    decimals0, decimals1,
    identity_evidence: {
      kind: 'initialize_log',
      source: 'Independent retained receipt/source reference',
      log: retainedInitializeRpcLog
    }
  }],
  routes: [{id: 'configured-route', pool_ids: [pool_id]}]
}, {max_history: 128, max_logs_per_block: 10000});
```

Currency addresses must be sorted and the declared PoolId must equal `keccak256(abi.encode(currency0,currency1,fee,tickSpacing,hooks))`. The engine accepts integer token decimals from 0 through 36, and native ETH requires 18. Decimals are retained metadata, explicitly labeled `SUPPLIED_NOT_RPC_VERIFIED`; the engine does not call token contracts. Use separately verified, block-appropriate decimals upstream.

The optional `identity_evidence` must contain a matching canonical Initialize log with a nonempty source reference. Its status is `RETAINED_INITIALIZE_MATCH`; an Initialize seen during block application produces `OBSERVED_INITIALIZE_MATCH`. Neither status is a cryptographic verification of the source. A pool with no matching Initialize evidence stays `REGISTRY_UNPROVEN`, even if Swap events arrive. The engine rejects future initialization evidence being used to qualify an earlier swap and conflicting initialization identities. Removed-branch initialization evidence is discarded on a known-parent rollback.

A nonzero static-fee hook needs an action flag in its low 14 address bits. A dynamic-fee pool requires a nonzero hook. Each return-delta permission must include its corresponding action permission. Passing these constraints only means that the key is structurally valid; every nonzero hook remains unqualified for economic interpretation.

Limits: 10,000 configured pools and routes by default, at most 64 distinct pools in one configured route, 10,000 logs per block and 128 retained undo records. Constructor options can lower those bounds or explicitly increase them within fixed implementation caps. The engine never discovers additional pools or routes automatically.

## Block input and return value

```js
const change = engine.applyBlock({
  number: blockNumber,
  hash: blockHash,
  parent_hash: parentHash,
  timestamp: blockTimestamp,
  observed_at: localObservedAt,
  coverage: 'provider_reported_complete',
  logs: rpcLogs
});
```

Block numbers/timestamps accept safe nonnegative integers, canonical decimal/hex strings or BigInt; output uses decimal strings. Block hashes and Ethereum log fields have strict sizes. `observed_at` accepts an ISO time string or numeric timestamp. The runtime owns timestamp provenance and must distinguish live arrival from backfill delivery.

Each input log uses JSON-RPC names: `address`, `topics`, `data`, `blockNumber`, `blockHash`, `transactionHash`, `transactionIndex`, `logIndex`, and explicit `removed: false`. Logs must appear in increasing block-global log-index order with nondecreasing transaction index. Every log must match its enclosing block. Duplicate logs, conflicting transaction identities, removed logs, invalid data widths and out-of-order input are rejected; they are not silently sorted or deduplicated. Exact repeat delivery of an already applied block is idempotent.

Successful return shape:

```js
{
  status: 'APPLIED',
  block, head, epoch,
  continuity: 'CONTIGUOUS', // or FIRST_OBSERVED_BLOCK / REORG_ROLLED_BACK
  affected_pool_ids: [],
  dirty_route_ids: [],
  invalidated_route_ids: [],
  events: [],
  states: [],
  reason: null
}
```

Ordinary blocks dirty only pools with supported events and their configured dependent routes. An unrelated pool does not dirty every route. `states` contains defensive copies for affected pools; `snapshot()` returns the complete bounded current view. The snapshot head is the last accepted complete block. A pool's `as_of_block` identifies its last relevant observation; it is not refreshed by an empty block and should not be mislabeled a new observation.

All signatures use BigInt ABI decoding with canonical sign extension. Initialize, Swap and ModifyLiquidity lengths, indexed fields and address encodings are strict. Swap square-root price, liquidity, tick and fee bounds are checked. This is not a replay of the pool's full swap math and does not claim to verify exact tick/price correspondence.

## State interpretation

`Swap` updates the observed core `sqrt_price_x96`, `active_liquidity_raw`, `tick` and `last_swap_fee_pips`. Prices are exact reduced rational pairs:

- `currency1_per_currency0`: `(sqrtPriceX96² × 10^decimals0) / (2^192 × 10^decimals1)`.
- `currency0_per_currency1`: the exact inverse.

Never convert these through JavaScript Number before doing financial arithmetic. The fractions are core spot marks after an observed swap, not wallet execution prices, quotes, USD values or profit estimates. `last_swap_fee_pips` is the fee in that observed event, not a promise about the next execution's all-in costs.

Any nonzero `ModifyLiquidity` delta invalidates observed active liquidity until another complete-block Swap updates it. The engine does not infer whether a range modification changed the currently active liquidity; it does not have the full tick/position state. A zero-delta liquidity update preserves observed active liquidity. After Initialize, active liquidity starts at zero; this does not establish tradability.

Qualification labels:

| Label | Meaning |
|---|---|
| `UNOBSERVED` | No core price observation yet. |
| `IDENTITY_UNQUALIFIED` | Core values exist, but no matching Initialize evidence. |
| `CORE_STATE_OBSERVED` | Core price/liquidity observed with identity evidence, no hook, and no outstanding invalidation. |
| `CORE_MARK_ONLY_LIQUIDITY_UNKNOWN` | Price remains an observation; active liquidity was invalidated. |
| `CORE_MARK_ONLY_HOOK_UNQUALIFIED` | A nonzero hook prevents general economic interpretation. |
| `STATE_INVALIDATED` | Cached values remain historical evidence and must not be served as current state. |

`CORE_STATE_OBSERVED` still relies on supplied decimals and upstream provider evidence. It is not execution qualification. `pool_inventory`, `trader` and `executable_proceeds` remain null. V4 active liquidity is a mathematical parameter, not reserves or TVL. The singleton's ERC-20 balances combine multiple pools and other obligations. Swap sender is the immediate manager caller, frequently a router; ModifyLiquidity sender is not necessarily the beneficial owner. [V4 swap hooks](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/swap-hooks) and [delta accounting](https://developers.uniswap.org/docs/protocols/v4/guides/unlock-callback-and-deltas) explain those distinctions.

## Gaps, disconnects and forks

Call `engine.invalidate(reason)` when the selected primary disconnects, recovery discovers a gap, or upstream evidence becomes unreliable. It increments `epoch`, invalidates all routes, sets every pool to `STATE_INVALIDATED` and keeps old values only as historical evidence. Health APIs must expose the invalidation and never present old cached fields as current.

An incoming forward gap returns `GAP` and does not advance the head. A partial block returns `PARTIAL`, invalidates current states and does not advance the head; a complete retry can then repair that block. Other malformed/conflicting blocks return `REJECTED` or `CONFLICT` and invalidate current states.

For a new block whose parent is in retained history, the engine removes the superseded branch, restores pool values from bounded undo records and applies the replacement block. Its continuity is `REORG_ROLLED_BACK`; all previous route candidates are invalidated through an epoch change, including candidates whose pool values happen to be unchanged. Downstream candidates must bind to block hash and epoch and be discarded when either is invalidated.

If the parent is unavailable in bounded history, return `REORG_UNRESOLVED` and rebuild a new engine from a trusted anchor and ordered replay. Do not silently accept the highest block number from competing providers or combine branches. The upstream runtime selects and recovers one canonical block stream; provider races are measurement evidence, not a rule for merging chains.

Invalidated pool values recover when complete, consistent Swap/Initialize observations reanchor them, or when the service reconstructs the engine through a valid earlier replay. This module does not implement a pinned-StateView RPC reanchor method. A connected socket or a new empty block alone does not requalify invalidated pool values.

## Test evidence

Run `node --test scripts/test_pools.mjs`. Fixtures are synthetic and exercise exact decimals, signed widths, hook constraints, initialization provenance, ModifyLiquidity, affected-route updates, duplicate/conflicting logs, gaps, disconnections, partial retries, fork rollback and bounded-history failure. These tests do not demonstrate live Robinhood latency, complete market coverage or profitable execution.


## Immediate provisional view

`scripts/live_pools.mjs` exports `LivePoolCache(registry, options={})`, separate from the reconciled `PoolEngine` above. Call `applyObservation(obs)` on a selected primary's live collector observations **before waiting for journal I/O or HTTP block reconciliation**. This makes newly received Swap state available for candidate reevaluation immediately. The runtime must still invalidate provisional updates if journaling fails or the primary becomes unreliable.

The input is the existing `pulse.observation.v1` envelope with `chain_id: 4663`, `source`, `stage: 'head' | 'log'`, `delivery: 'live'`, `event_id`, `observed_at`, and raw JSON-RPC `payload`. Envelope block/log identity fields, when present, must match the payload. Backfill/replay delivery and unsupported stages are ignored. The cache binds to its first valid live head/log source and ignores observations from any other source. Reconstruct it explicitly when changing the selected primary; provider races must never merge branches into this view.

Returns use `OBSERVED`, `HEAD`, `DUPLICATE`, `IGNORED`, or `INVALIDATED`, with `updated`, matching `event_id`, `affected_pool_ids`, `dirty_route_ids`, `invalidated_route_ids`, `events`, `states`, `head`, and `epoch`. Only `OBSERVED` indicates an immediate pool-state update suitable for a matching provisional `state_ready` timing event. Do not emit that timing event from an unrelated head or after substituting a backfilled state.

**Every provisional result and pool keeps `qualification: PROVISIONAL_UNRECONCILED`, `canonicality: UNKNOWN`, `coverage: UNKNOWN`, and `execution_eligible: false`.** The provisional cache cannot establish the last log in a block, complete route state, final wallet deltas, executable liquidity, profit or even that the observed branch will remain canonical. Its purpose is to schedule reevaluation quickly; the independently reconciled view and execution checks must decide what can actually be acted upon.

Raw ABI decoding and exact fraction math are shared with `PoolEngine`. Nonzero hooks remain `UNKNOWN_HOOK_UNQUALIFIED`. Nonzero ModifyLiquidity invalidates active liquidity until a subsequent Swap. Swap sender remains an immediate caller rather than a trader. Registry decimals remain supplied metadata.

Heads and logs are tracked separately: a head for block N+1 may arrive before the log notification for block N without that alone being considered a reorg. Distinct live logs must still arrive in block/log order. Duplicate identities are idempotent; conflicting block-global log slots, transaction indices, removed logs, out-of-order logs, head gaps, parent mismatches and same-height fork hints invalidate the provisional cache. It stores at most 32 blocks of slot fingerprints and at most 10,000 slots per block; these limits can be lowered with options. It does not retain unbounded raw history.

Call `cache.invalidate(reason)` on primary disconnection or recovery uncertainty. Old numeric values remain historical, `provisional_status` becomes `INVALIDATED`, `requires_reanchor` becomes true, potentially orphaned initialization identity is discarded, and all routes are invalidated. A subsequent valid live Swap can supply a new provisional observation, never a reconciled or execution-eligible one. `snapshot()` returns defensive copies for the API.

Run `node --test scripts/test_live_pools.mjs`. Tests cover immediate update behavior, both head/log arrival orders, duplicates, conflicting/reordered logs, source isolation, ignored replay, forks, disconnects, removed logs, hook uncertainty, liquidity changes and bounded memory. Synthetic timing behavior is not a live Robinhood latency measurement.
