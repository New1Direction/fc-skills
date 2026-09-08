# RPC Race: first-arrival comparison

## Contents

- Interface and inputs
- Event matching and exclusions
- Reading the report
- Optional pipeline durations
- Bounded HTTP probes
- Validation and limits

## Interface and inputs

Use Node 24 with built-in modules only:

```js
import { analyzeRace, probeEndpoints } from './scripts/race.mjs';

const report = analyzeRace(observations, {
  sources: ['primary', 'backup', 'feed'],
  min_matches: 20,
  include_pipeline: false
});
```

`observations` is an array of at most 100000 normalized envelopes. `sources` is
an optional list of expected source names; observed non-health source names are
also included. Internal health/checkpoint source names are not inferred as RPC
providers. Extract the expected provider list from retained run configuration
when calling this API so providers with no events remain represented.
Use at most 64 sources. A configured source with zero observations remains
visible in source totals and every comparison group's denominator. `min_matches`
must be an integer from 1 to 100000 and defaults to 20. It is a configurable
minimum, **not** a statistical guarantee that p95 or p99 is stable.

Each envelope follows `pulse.observation.v1`:

| Field | Requirement |
| --- | --- |
| `schema_version` | Exactly `pulse.observation.v1`. |
| `chain_id` | Numeric `4663`. Missing, string, and other chain values are invalid. If `payload.chain_id` exists it must also be numeric 4663. |
| `run_id`, `clock_id`, `source` | Nonempty bounded strings. `clock_id` identifies one actual shared monotonic clock domain, not an endpoint or a timezone. Generate a new ID on process/clock restart. |
| `stage` | `head`, `log`, `feed`, `state_ready`, `candidate`, `simulation`, or `health`. |
| `event_id` | Stable event identifier within this stage, run, and clock domain. Preserve feed namespaces; do not reinterpret a feed sequence ID as a transaction hash. |
| `observed_mono_ns` | Nonnegative base-10 integer string. All latency arithmetic uses BigInt nanoseconds. |
| `observed_at` | Valid ISO-8601 wall timestamp with timezone. Impossible calendar dates, naive times, and malformed values are rejected. |
| `delivery` | `live`, `backfill`, or `replay`. Only live records are eligible for arrival comparison. |
| `payload` | Finite JSON object containing stable semantic event content. Do not place provider name, local timings, or retrieval metadata here. |
| `block_number`, `log_index` | Optional nonnegative safe JSON integer or base-10 integer string. |
| `block_hash`, `transaction_hash` | Optional full 32-byte hex hash; case is normalized. |
| `region` | Optional **collector** region. `payload.collector_region` is accepted if top-level region is absent. This is not the provider's advertised location. |

A `head` observation requires `block_number` and `block_hash`. A `log` requires
both plus `transaction_hash` and `log_index`. Feed identity remains opaque and
stage-scoped. Every optional identity field participates in matching: one source
omitting it while another supplies it is not an exact match.

The analyzer validates supplied envelopes; it does not authenticate providers,
prove that two records really used the same physical clock, or reconstruct
missing chain events. Monotonic timestamp strings avoid JavaScript's floating
point precision loss. Wall timestamps do not replace monotonic clocks.

## Event matching and exclusions

Partition by `(run_id, clock_id, stage)`. Never pool latency measurements across
runs, restarts, stages, or clock domains. Source-total counts may sum across
groups; their latency distributions never do.

Within a partition:

1. Group observations by exact `event_id`.
2. Require equal normalized chain identity fields and equal canonical JSON
   payloads. JSON object key ordering does not matter; values do.
3. If any live record conflicts, quarantine the entire event across sources.
   Preserve its event ID and conflict counts in the report's observed union.
4. Deduplicate each source to its earliest live monotonic arrival. Count duplicate
   rows. A conflicting duplicate invalidates the event even when it arrived later.
5. Compare timing only when at least two sources observed an uncontested event.
   Single-source events remain in coverage counts, never as artificial zero-delay
   competitive samples.

Exclude backfill/replay from both timing and the live union. A later historical
recovery cannot win a live race or repair a live miss. Exclude all health records,
and `payload.kind` values `checkpoint`, `block_complete`, or
`coverage_checkpoint`. Health/coverage data belongs to continuity analysis.

If explicit collector regions differ inside one run/clock domain, quarantine
that entire context. If a source's monotonic timestamp goes backward while its
wall timestamps advance, quarantine the context as
`MONOTONIC_REGRESSION_OR_WALL_CLOCK_STEP`. This can mean a reused clock ID, bad
data, or a clock adjustment; the analyzer does not choose a convenient
interpretation. An undocumented clock reset with insufficient evidence may be
undetectable, so correct collector clock identities remain essential.

Two block hashes at the same height are separate events if their event IDs
differ. Their inclusion is an observed-stream fact, not proof that both are
canonical. Race alone does not perform reorg or chain-completeness adjudication.

## Reading the report

Top-level status is `INVALID_INPUT`, `NO_COMPARABLE_DATA`,
`INSUFFICIENT_MATCHES`, or `SUFFICIENT_MATCHES`. Group status passes only if
there are at least two reported sources and **every** source has the configured
minimum competitive samples in that group. Missing/offline sources prevent an
unqualified success status. Individual distributions retain their own sample
status. Invalid rows and quarantined clock domains are separately visible.

Every group exposes:

- `observed_union_events`: all validly shaped live event IDs observed by any
  source in this context, including conflicted IDs.
- `comparable_union_events`: that union after conflicting events are removed.
- `competitive_events`: comparable IDs observed by at least two sources.
- Conflicting event IDs, conflicting rows, and duplicate rows.

Each source exposes observed, usable, missing, conflicted, singleton, and
competitive counts. `observed_union_coverage_pct` is the source's seen count
divided by the observed live union, truncated to six decimal places. It is
**not** chain coverage, uptime, packet loss, or independently established source
reliability. Events missed by every source are absent from this denominator.

For every competitive event observed by a source:

`relative_earliest_delay_ns = source_first_arrival − earliest_observed_arrival`.

Return p50, p95, p99, min, and max using nearest-rank quantiles and decimal
nanosecond strings. Quantiles remain null when the sample count is below the
configured minimum. Tied earliest arrivals are counted separately; source name
ordering never breaks ties.

For every pair A/B, match only uncontested events present at both sources:

`a_minus_b_delay_ns = arrival_A − arrival_B`.

Negative means A arrived earlier. Report A-earlier, B-earlier, and ties, alongside
A-only, B-only, neither-seen, and excluded-conflict counts. Pairwise delays exclude
missing events, so they describe survivors. A source that sees 2 out of 10 events
first can report excellent matched latency while missing the other 8. The report
deliberately supplies no overall fastest-source rank or synthetic loss penalty.

Source observations, advertised plans, rate limits, and chains can change. A
single run is evidence about that run, request mix, collector location, and
conditions. Do not turn it into a perpetual speed claim or a trading-profit
estimate.

## Optional pipeline durations

Set `include_pipeline: true` only for retained observations whose event and
processing context were explicitly established. Each participating payload needs:

```json
{
  "pipeline_identity": {
    "event_id": "same-event-id-as-envelope",
    "origin_stage": "head",
    "context_verified": true,
    "block_hash": "0x...full block hash...",
    "transaction_hash": null
  }
}
```

`origin_stage` is `head`, `log`, or `feed`; the other ordered stages are
`state_ready`, `candidate`, and `simulation`. The entire pipeline identity must
match across stages. Block/transaction hashes must agree with each envelope;
use explicit null when the envelope has no block or transaction hash. Context
verification is a supplied assertion, not a new verification performed here.

Pipeline groups additionally require the same source, event, run, and clock.
Conflicting stage duplicates invalidate that pipeline group. Negative stage
durations invalidate it instead of being clamped, absolute-valued, or reordered.
Only available adjacent-stage durations are reported; missing stages do not
become zero. No feed-to-log association is invented. The analyzer does not infer
causality from timestamps or prove a simulation used the corresponding state.

## Bounded HTTP probes

`probeEndpoints(config)` is a separate read-only request/response diagnostic:

```json
{
  "sources": [
    {"name": "primary", "http_env": "PULSE_PRIMARY_HTTP"},
    {"name": "backup", "http_env": "PULSE_BACKUP_HTTP"}
  ],
  "timeout_ms": 3000,
  "rounds": 1,
  "max_response_bytes": 1048576,
  "probe_logs": false
}
```

Resolve endpoint values privately from the named environment variables. Return
source names, environment variable names, sanitized error codes, HTTP/RPC numeric
status codes, and timing only. Never return endpoint values, request URLs,
provider error text, or response bodies. Missing environment variables remain
visible as unavailable sources.

Limits: 1–8 sources, 1–5 rounds, timeout 100–10000 ms per request, response limit
1024–4194304 bytes. Sources run concurrently; calls for each source are sequential.
Redirects are disabled. Only these hardcoded read methods are called:

1. `eth_chainId`, stopping immediately unless the chain is 4663.
2. `eth_blockNumber`.
3. `eth_getBlockByNumber` for that exact number, with transaction hashes only.
4. Optionally `eth_getLogs` at the returned exact block hash.

To enable the fourth method, set `probe_logs: true` and provide
`log_filter: {address, topics}` with one full contract address and up to four
hash/null topic slots. Unscoped log probing is rejected. An empty response is
provider evidence only, not independent completeness. A provider may reject
block-hash filters; that limitation remains visible rather than silently widening
the query.

Each call reports RTT separately in nanosecond and exact millisecond strings.
The returned head reports its block number/hash, stated block timestamp, wall
observation time, and their signed difference. A future head timestamp is flagged.
`propagation_latency_ns` remains null. **A fast HTTP response can return a stale
head; a block timestamp is not a measurement of its arrival delay.** Probes do
not measure WebSocket, sequencer feed, feed-to-RPC, or execution performance.

Direct CLI use:

```bash
node scripts/race.mjs --input /path/to/observations.json --output /path/to/race.json
node scripts/race.mjs --input /path/to/observations.json --options /path/to/options.json --output /path/to/race.json
node scripts/race.mjs --probe-config /path/to/probe-config.json --output /path/to/probe.json
```

Direct CLI observation input is a JSON array. Use the skill's common CLI for
collector journal formats if it provides a JSONL wrapper. Invalid configuration
exits 2; insufficient samples remain a valid research report, not a command crash.

## Validation and limits

Run `node --test scripts/test_race.mjs`. Tests cover sparse fast sources, zero-event
sources, survivorship, exact identity/payload conflicts, restarts, regions,
backfill/replay, malformed time, BigInt precision, ties, negative pipeline durations,
and bounded local HTTP probes with secret-redaction assertions. The local server
tests establish implementation behavior; they do not benchmark a live provider.

This module signs nothing, submits no transactions, promises no execution edge,
and schedules no ongoing monitor. A retained event comparison can support a
provider choice only when its event coverage, clocks, source plan, region, and
sample window are understood.
