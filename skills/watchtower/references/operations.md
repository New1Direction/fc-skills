# Operation and recovery

Use one local database shared by separate capture and worker processes. It is bounded durable intake storage; retain FYNCH's existing canonical retention owner. Plan export/retention ownership before unattended deployment. Native storage never silently deletes old evidence.

## Configure and run

Copy assets/watchtower.example.json. Keep credentials in the named environment variables. Remove intentionally unavailable comparison sources/optional ws_env properties. Probe actual capabilities. A configured WebSocket URL does not prove an established connection.

Set from_block to the first required block; preserve it on restart. New stores require an explicit first block. Preserve chain ID, storage budget and reorg depth stored in an existing database. Duration 0 runs until stopped; finite runs return retained coverage and degradation reasons.

Run capture and workers as separate processes using the same --db path. The editable [capture service](../assets/watchtower-capture.service) and [worker service](../assets/watchtower-workers.service) assume an operator-created user, verified Node24 installation, source environment file and prepared configuration. Installing this skill does not provision or enable a host.

## Budgets and persistence

max_requests_per_second bounds shared RPC scheduling; block_concurrency bounds full-block fetches; receipt_concurrency bounds receipt work; max_blocks_per_round bounds recovery; max_pending_receipt_blocks bounds enrichment backlog; max_response_bytes bounds provider responses; max_db_bytes bounds local retained storage. Tune against actual source limits and measured throughput.

SQLite uses WAL/full synchronous commits. Raw blocks/receipts are stored once; events reference them. Incremental progress serves the capture hot path. Full audits occur on explicit reporting and exceptional repairs. Disk accounting includes database/WAL/shared-memory files. A long-lived reader may prevent checkpoint reclamation; capacity may then stop intake even after the latest mutation committed. Reopen preserves actual durable progress.

## Recovery

Fresh full blocks are retained during bounded historical recovery without concealing missing intervals. Receipt completion has its own cursor and survives restart. HTTP polling remains available when optional WebSocket notification fails.

Primary hash replacement invalidates descendants and derived results; orphan raw records remain for audit. Deep reorganizations exceeding configured recovery stop for explicit repair. Re-adoption creates new durable worker events. Queue saturation leaves the source event cursor unchanged. Retry/lease budgets bound failing jobs.

Storage exhaustion stops visibly. Resume through reviewed capacity migration or durable export to the retention owner. Never delete the database to manufacture healthy coverage. Native automatic segment rotation/export acknowledgement is not implemented.

## Observe

report shows retained block/receipt coverage, worker state, storage and source observation age. Completeness through the retained head is separate from a current source. Compare last reported primary head, its timestamp/sync state, and contiguous block/receipt heads. The endpoint may be responsive but behind.

events/outbox support sequence cursors. Persist consumer progress only after durable processing and apply invalidation records to prior results. No external notifications or transactions are sent.

latency reads retained observations into memory. For a large store, export a bounded representative sample and call latencyReport on that sample; keep full reports outside the capture loop.
