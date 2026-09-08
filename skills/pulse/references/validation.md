# Validation and deployment status

Build checked 2026-09-08 with Node24.19.0. The complete bundled suite passes **150 tests**:

- 30 collector tests: real native WebSocket and HTTP connections to local protocol servers, startup subscription races, reconnect gaps, shallow and excessive reorgs, HTTP regression/lag, byte and queue limits, persistence ordering, cancellation, and redaction.
- 32 full-block V4 tests: Keccak vectors, PoolKey and signed ABI checks, exact decimal ratios, identity/hook limits, partial coverage, transactional rejected forks and bounded rollback.
- 21 provisional cache tests: immediate updates, duplicate and conflicting events, removed logs, adjacent head/log conflicts in both arrival orders, source binding and explicit execution ineligibility.
- 34 race tests: comparable clocks, missing events, duplicate/conflicting evidence, tail quantiles, internal health exclusion and bounded local HTTP probes.
- 14 node-operation tests: generated private configuration, independently supplied asset digests, mainnet/genesis matching, tampering, injection, sync/freshness and peer disagreement.
- 18 journal/API/runtime tests: corruption and torn tails, single writer, restart scopes, replay cursors, fatal failure propagation, invalid derived-state separation and immediate state records.
- 1 complete service integration: two actual native WS/HTTP sources, real V4 fixture decoding, immediate and reconciled views, journal replay, race input, local API and checkpoint restart.

Independent review also compared 120 canonical-state results across41 forks with fresh replay, and reran concrete rejected-fork and provisional-parent-conflict reproductions. A separate user-task pass exercised race, node planning, health, and missing-credential CLI behavior. Its inputs and node assets were synthetic.

A bounded public Robinhood HTTP eth_chainId probe timed out; a direct public sequencer-feed connection failed before opening in this execution environment. Neither result is a production endpoint benchmark. There are no real source lead measurements, authenticated production captures, synced Nitro nodes, image boot tests, FYNCH/Ape deployment changes, simulations or executed trades in this release. Deployment templates and configured live code are provided; hosting and credentials remain deployment inputs.

Run `node --test scripts/test_*.mjs` from this skill to repeat local validation. Tests make only local loopback network connections and use temporary files. Runtime code uses no external npm dependencies.
