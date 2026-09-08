# FYNCH and Arbitrage Ape adapter contract

PULSE adds a shared observation transport and provisional core-mark cache. It does not edit or deploy FYNCH or Ape. Preserve each application's existing canonical store, account controls and execution gates.

## Observation contract

Each `pulse.observation.v1` record contains:

- `chain_id:4663`, `source`, `run_id`, `clock_id`;
- `stage`: head, log, feed, health or state_ready (race can also analyze explicitly retained candidate/simulation stages);
- `event_id` and applicable block number/hash, transaction hash and global log index;
- `observed_mono_ns` as a decimal string and `observed_at` as UTC ISO text;
- `delivery`: live, backfill or replay;
- the raw or derived `payload` with its evidence scope.

Monotonic timestamps are comparable only inside the same run and clock. Wall-clock differences across machines are not a substitute for synchronization/error bounds. Raw feed message IDs, block IDs and log IDs describe different objects; do not join them by coincident numbers.

## FYNCH consumer

Read the private API or import `collect` with an awaited persistence callback in the existing ingestion process. Retain exact raw log identities and source observations. Reconcile contiguous block hashes and removed/replaced records with FYNCH's current retained-data system. HTTP-recovered logs are explicitly backfill. Independent provider observations are useful corroboration; they do not become separate purchases or duplicate swaps.

PoolEngine produces core protocol marks and route invalidation hints. UNDERTOW can consume the raw evidence after its own identity, receipt and coverage checks. V4 sender remains the immediate caller; a wallet beneficiary requires separate evidence.

## Ape consumer

Apply an event to a verified pool identity, update only affected pools, then reevaluate the explicitly configured `dirty_route_ids`. Before considering a route actionable, require current canonical continuity, supported hooks/token behavior, full route state, wallet-specific simulation and costs. These checks belong in Ape and are not replaced by PULSE statuses.

Live `state_ready` records mean the immediate provisional cache decoded an observed swap or initialization, before its journal write. They retain the originating log identity and a measured `processing_delay_ns`, and always remain `PROVISIONAL_UNRECONCILED`. Separate backfill `state_ready` records mean the full-block engine processed an HTTP-reconciled block. Neither is a wallet simulation; inspect delivery, scope and qualifications. To benchmark Ape's actual local execution path, emit its own candidate/simulation stages with a documented common identity under the same process clock. Do not label arrival-to-mark arithmetic as wallet simulation latency.

The engine intentionally does not maintain tick bitmap/tick liquidity state, execute arbitrary hooks, reconstruct full swap routes or quote trade sizes. Its stored liquidity is the last supported core observation, with invalidation on changes it cannot completely resolve. It never infers token inventory from the V4 singleton balance.

## Build versus production evidence

Local mock-network integration proves transport, persistence and recovery mechanics under controlled events. A successful node plan proves configuration generation/asset checks only. Neither establishes provider availability, production throughput, a synced node, executable arbitrage or profitable trades. Record deployment host, source configuration, sample duration, stage definitions, coverage and failure rates when running real benchmarks.

Primary technical references checked2026-09-08:

- [Robinhood connections](https://docs.robinhood.com/chain/connecting/)
- [Robinhood full-node guide](https://docs.robinhood.com/chain/run-a-full-node/)
- [Nitro feed format](https://docs.arbitrum.io/run-arbitrum-node/sequencer/read-sequencer-feed)
- [Nitro sequencer mechanics](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/sequencer)
- [Node24 WebSocket](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-websocket)
