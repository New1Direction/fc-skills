---
name: watchtower
description: Capture every RPC-reported included transaction on Robinhood Chain, reconcile receipts, recover missed blocks, and operate durable research workers. Use for chain-wide monitoring, coverage audits, research dispatch, restart/reorg recovery and source latency comparisons. Includes a Node.js service; internal tracing and live trading are outside native coverage.
---

# WATCHTOWER

Operate chain-wide transaction intake on Robinhood Chain 4663. Preserve every reported included transaction from an explicit first block before research filters. Include successful/reverted transactions, creation, zero-value activity, and unknown or Nitro-specific types. Separate capture completeness from semantic interpretation.

## Route the work

- Read [sources.md](references/sources.md) for Nitro sources, feed boundaries and speed qualification.
- Read [operations.md](references/operations.md) for continuous processes, limits and recovery.
- Read [integration.md](references/integration.md) for data contracts, worker policies and FYNCH/Ape consumers.
- Read [validation.md](references/validation.md) for runnable demonstrations and evidence.

Use Node.js24 and built-ins for normal commands. Optional isolated-EVM validation needs a separately installed trusted Anvil binary. Run commands from this skill folder.

## Establish coverage

Inspect existing ingestion ownership. Reuse retained FYNCH full blocks/receipts when available rather than starting duplicate production collection. PULSE supplies node/source operations and existing log transport; its address-filtered logs alone do not cover every transaction.

Copy [watchtower.example.json](assets/watchtower.example.json), configure source environment-variable names, choose one primary and optional comparison source, and set an explicit from_block. The example leaves it unset deliberately. Preserve the stored start on restart; earlier history remains outside this run.

```sh
node scripts/watchtower.mjs probe --config /path/to/config.json
node scripts/watchtower.mjs capture --config /path/to/config.json --db /path/to/watchtower.sqlite --duration 60
node scripts/watchtower.mjs report --db /path/to/watchtower.sqlite
```

A successful probe establishes only the reported capabilities. Correct chain ID alone does not authenticate history, establish synchronization or demonstrate production capacity.

Use notifications to wake full-block collection and HTTP to recover missing heights. Retain fresh tail blocks while recovery proceeds, but advance contiguous coverage only through linked complete blocks. Collect and validate every receipt independently of raw intake. Missing receipts must remain visible.

## Keep research outside intake

Run capture --duration 0 and workers --duration 0 as separate processes sharing the database. Built-in workers classify every transaction and enrich statuses/topics from receipts. Exact configured address/topic rules produce reviewable research dispatch records; they do not automatically execute other skills or Ape.

```sh
node scripts/watchtower.mjs workers --config /path/to/config.json --db /path/to/watchtower.sqlite --duration 60
node scripts/watchtower.mjs outbox --db /path/to/watchtower.sqlite --after 0 --limit 100
node scripts/watchtower.mjs events --db /path/to/watchtower.sqlite --after 0 --limit 100
node scripts/watchtower.mjs latency --db /path/to/watchtower.sqlite
```

Bind downstream results to block hash, transaction identity and policy version. Persist consumer cursors after durable processing and handle invalidations. Keep unsupported hooks, unresolved beneficiaries, unknown price units and untraced calls explicit. Dispatch compatible evidence to installed skills or verified application adapters.

## Measure speed and limits

Report source freshness, full-block arrival, durable capture, receipt completion and worker completion separately. Compare identical objects/stages under the same run and monotonic clock. Keep live, backfill and replay separate; include missing observations and backlog beside percentiles.

Use PULSE for appropriate raw-feed observation/race work. WATCHTOWER reads executed RPC blocks and does not decode or verify sequencer signatures. A synced feed-connected local Nitro node is the intended low-latency source. Never equate block timestamps with measured network latency or sequencer observations with unsequenced private transactions.

Native completeness covers retained RPC-reported block arrays and reconciled receipts. It does not prove receipt tries, consensus finality, rejected submissions or all history since genesis. Nested calls/native internal transfers/revert reasons remain UNTRACED without a verified trace adapter.

Bound requests, concurrency, response sizes, queues, retries and storage. Resource limits must pause/stop visibly without skipping gaps or silently pruning evidence. Native monitoring is read-only. Only the isolated EVM harness sends fixture transactions to its own local process.

Installation and local tests are separate from live deployment. Establish a running host, verified sources, representative sustained load, complete retained intervals and tested recovery before claiming production readiness or superior speed.
