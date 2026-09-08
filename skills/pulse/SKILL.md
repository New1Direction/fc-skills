---
name: pulse
description: Collect and benchmark Robinhood Chain live onchain data, maintain a provisional Uniswap V4 pool-state cache, and prepare or inspect private Nitro RPC nodes. Use for RPC freshness comparisons, WebSocket ingestion, reconnect and replay recovery, feed observation, or node operations. Includes an executable Node.js service; does not sign transactions or establish profitable trading routes.
---

# PULSE

Operate the four bundled components: RPC Race, Live Collector, Pool State Engine, and Node Operator. Target Robinhood Chain mainnet **4663**. Use Node.js **24 or later**, with built-in modules only. Resolve scripts relative to this skill directory; keep the complete folder together.

Choose the relevant workflow:

- **Collect or recover data:** read [collector.md](references/collector.md) and [runtime.md](references/runtime.md). Configure endpoint environment-variable names and explicit log addresses. Run the executable service; retain its journal and scope. Treat provider-reported completeness as provider evidence. Failures, recovered history and live arrivals have different meanings.
- **Find the fastest usable source:** read [race.md](references/race.md). Run simultaneous sources in one collector process. Compare exact events under the same run and clock, retained gaps and tail latency. Keep transport RTT separate from event freshness. A source with no observations is missing data, not a zero-latency winner.
- **Maintain V4 marks and affected routes:** read [pools.md](references/pools.md). Use exact manager, PoolKeys and supported identity evidence. Supply a registry to collection or replay complete ordered block bundles. Surface hook, identity, continuity and liquidity uncertainty. A dirty route is work to evaluate, not a trade recommendation or executable quote.
- **Prepare or inspect an owned node:** read [node-ops.md](references/node-ops.md). Generate a private Nitro deployment from pinned official assets and an explicit image. Inspect chain identity, sync and head freshness. Existing authorization determines whether to deploy on an available host; a request to build the skill alone does not specify a paid server.

## Commands

Run from this folder:

```sh
node scripts/pulse.mjs --help
node scripts/pulse.mjs collect --config assets/pulse.example.json --out /tmp/pulse/events.jsonl --duration 60
node scripts/pulse.mjs race --journal /tmp/pulse/events.jsonl --sources provider,local-nitro --out /tmp/pulse/race.json
node scripts/pulse.mjs probe --config assets/pulse.example.json
node scripts/pulse.mjs pools --registry assets/pools.synthetic.json --blocks assets/blocks.synthetic.json --out /tmp/pulse/synthetic-state.json
node --test scripts/test_*.mjs
```

The pool replay example is synthetic and labelled in its output. The collector example config names environment variables; it contains no credentials. Remove a source that is not available yet. Use `--registry` with the actual verified pool registry to enable pool state. A feed endpoint is optional. The `pools`, `node-plan`, `node-check`, and `export` commands are documented in their references.

## Interpretation and integration

Keep the persistent runtime running independently of LLM invocations. Expose retained observations to FYNCH and its existing truth store; use PULSE's bounded spool as transport evidence, not a replacement database. Read [integration.md](references/integration.md) before connecting Ape or another consumer.

The sequencer feed contains already accepted, ordered messages with provisional confirmation. Raw feed sequence numbers are not Robinhood L2 block numbers. Feed capture does not execute Nitro, verify signatures, decode every transaction type, or reveal a private pending queue. Use a synced Nitro node for executed state and the supported relay when an uncompressed feed is needed.

Do not infer trader identity from V4 sender or singleton balances, price an arbitrary hook as canonical V4, call recovered history a live observation, or describe a pool mark as an executable wallet result. Route validation, state-consistent simulation, cost accounting, signing and submission remain the responsibility of Ape's execution controls.

Read [validation.md](references/validation.md) for the tested scope and unresolved live checks.

Report what actually ran: synthetic/local integration, live provider collection, deployment rendering, or a synced deployed node. Include observed coverage, source failures, replay scope, and unresolved latency or live-integration checks. No benchmark result is supplied until measured on the actual host.
