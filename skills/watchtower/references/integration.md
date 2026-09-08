# Data and worker integration

## Retained records

The store binds every full raw transaction to block hash, block number and transaction index. It retains successful/reverted receipts, unknown types, original calldata, raw topics and orphan records. Missing optional transaction values stay unknown. Receipt matching checks each transaction once, block/index identity, status, global log order and removed-log state. This is consistency against provider-reported blocks, not receipt-trie verification; a provider can omit evidence consistently.

`progress()` provides incremental selected-branch counts/contiguous heads. `coverage()` audits retained history and exposes gaps, disconnected blocks, incomplete receipts and source scope. `isCanonical(hash)` means primary-selected current branch membership; it does not establish consensus finality or connection through a missing predecessor. Raw blocks and receipt sets are stored once. `readEvents(after,limit)` materializes block/receipt data from durable references and includes invalidations.

`observe(stage,eventId,meta,payload)` retains earliest duplicate arrivals within source/run/clock identity. Native stages include head, block, block_durable, receipts, receipts_durable and source_health. Delivery is live, backfill or replay. Do not compare stages with different object identities or clocks. A full-block response is an application observation; it is not the original sequencer network timestamp.

## Worker policy

All blocks receive transaction-classification jobs regardless of rules. Receipt jobs enrich success/revert states and raw event observations. The default empty rules list preserves chain-wide capture/classification without specialized research dispatch.

A policy has a version and bounded max_queue, max_attempts, lease_ms, timeout_ms and max_result_bytes. lease_ms must exceed timeout_ms. Changing a policy requires a new version; old decisions stay attributable. New versions replay retained events with separate job identities.

An exact rule chooses one supported skill and one token_address or contract_address. A log rule requires matching log_address and topic0; topic1 can bind an indexed identity. A pool_id requires its exact topic1. A transaction_to rule requires a matching contract target. One illustrative rule for a synthetic address is:

```json
{
  "id": "synthetic-stock-transfers",
  "skill": "pressure",
  "target": {"chain_id": 4663, "token_address": "0x1111111111111111111111111111111111111111"},
  "match": {
    "log_address": "0x1111111111111111111111111111111111111111",
    "topic0": "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  }
}
```

Replace the example with independently resolved deployments. A familiar event signature is a dispatch hint, not proof of token semantics, beneficiary identity or an actual mint. PRESSURE/HOOK LAB/etc. perform their own evidence checks. Receipt logs alone do not attribute V4 singleton custody to a specific pool.

Jobs are bounded and durable, identified by block hash, policy and canonical event generation. Lease timeout, attempts, failures and source-event cursor survive restart. A late handler cannot overwrite a replaced lease or orphaned generation. Research handlers are injected functions; native tools never run arbitrary shell commands or send transactions. Extensions remain attached to PENDING_CONSUMER_REVIEW dispatch intents and cannot convert them into native trading qualifications.

## Consumers and invalidation

Use `events`, `outbox` and `classifications` CLI commands or the exported functions. Persist a consumer cursor after durable processing. The outbox emits explicit `evidence_invalidated` tombstones containing `body.invalidated_job_id`; default reads include these even though their canonical flag is false. Retract prior materialized results and preserve their historical record. Re-adopted block hashes receive a fresh event generation.

FYNCH should remain the owner of application watchlists, retained analytics and user-visible changes. Ape retains its route/execution permissions. Wire WATCHTOWER as the all-transaction extension of that ingestion path or consume an existing compatible store; do not create a competing production source of truth. Implement durable handoff acknowledgement and account-scoped presentation in the application before production adoption. This release provides research-worker records, not an automatically connected FYNCH/Ape adapter or outcome-price collector.

Retained source boundaries inspected: [FYNCH stream ingestion](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/docs/FYNCH_STREAM_INGESTION.md), [Ape market stream](https://github.com/New1Direction/arbitrage-ape/blob/1bade97a833b18d015c3a41ca8f47a464bdf5432/src/market-stream.ts), [MSK PULSE](https://github.com/New1Direction/MSK/blob/642d87127638967c38bd6b3c1dd1138fc030c093/skills/pulse/SKILL.md).
