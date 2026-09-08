# Live collector contract

`scripts/collector.mjs` is a Node 24 ES module using native `fetch`, native `WebSocket`, cryptographic hashing, and other built-ins. It needs no npm package. It runs actual asynchronous network connections; synthetic fixtures are confined to tests.

```js
import { collect } from './collector.mjs';

const result = await collect(config, {
  emit: async observation => journal.append(observation),
  signal: abortController.signal,
  // Optional clock(): {mono_ns: bigint|string, wall_iso: ISO string}.
});
```

`emit` must resolve only after durable persistence. The collector serializes emissions across sources, awaits complete block bundle persistence, and only then emits its checkpoint. The collector does not itself own a file, journal format, process signal handler, RPC credential store, or trading wallet. The coordinator supplies those operational boundaries.

## Configuration

```json
{
  "chain_id": 4663,
  "run_id": "capture-20260908",
  "clock_id": "process-unique-id",
  "sources": [
    {"name": "provider-a", "http_env": "RH_HTTP_A", "ws_env": "RH_WS_A"},
    {"name": "provider-b", "http_env": "RH_HTTP_B", "ws_env": "RH_WS_B", "feed_env": "RH_FEED_B"}
  ],
  "addresses": ["0x8366a39cc670b4001a1121b8f6a443a643e40951"],
  "max_backfill_blocks": 200,
  "reorg_depth": 32,
  "request_timeout_ms": 10000,
  "reconnect_ms": 1000,
  "max_reconnects": 10,
  "queue_limit": 1000,
  "max_message_bytes": 2097152,
  "max_logs_per_block": 10000,
  "duration_seconds": 60
}
```

This address is a deployment identifier to verify independently before use, not an automatic assertion that a configured endpoint exposes that deployment or that any particular pool exists. The collector captures address-scoped logs without interpreting PoolIds or trades.

- `chain_id` must be integer 4663. HTTP and WebSocket chain IDs are each queried and checked; the HTTP check is repeated before reconnection.
- `run_id`, `clock_id`, and source names use 1–64 ASCII letters, digits, dots, underscores or hyphens. Source names must be unique. There can be 1–8 sources.
- Endpoint configuration contains **environment variable names**, never URL literals. The URL values resolve privately inside the collector. HTTP supports `https:` and `http:`; sockets support `wss:` and `ws:`. Plain transports are useful for local tests; operators choose appropriate protected transport for their endpoints.
- `addresses` contains 1–100 exact 20-byte addresses. An empty catch-all subscription is rejected. Duplicate addresses are normalized and removed. The native collector does not filter by pool ID or event topic; it retains all matching contract logs within its bounds.
- Optional `from_block` is a nonnegative safe integer. Without it or a resume checkpoint, recovery starts at the earlier of the current HTTP tip and the earliest notification block accepted after subscription verification. This preserves blocks first received while subscription acknowledgments were pending. The normal backfill cap still applies; there is no historical coverage claim before this start.
- `duration_seconds` defaults to 60. Positive values up to 86,400 stop at that duration. **Zero runs until the supplied AbortSignal is aborted**, such as the coordinator's SIGTERM handler. Per-request, queue, gap and reconnect bounds remain active in indefinite service mode.
- Backfill is capped at 1–10,000 blocks per detected recovery gap; default 200. Exceeding that bound fails the source closed rather than silently skipping history.
- Reorg history is 1–2,048 blocks, default 32. It is an operational rollback horizon, not a finality guarantee.
- Request/initialization timeout is 10–120,000 ms. Reconnect delay is 1–60,000 ms. Reconnect attempts are capped at 0–100. A zero reconnect limit permits only the initial connection. Recovery races also retry only within this configured attempt bound.
- Queues are capped by both record count and queued raw bytes. The byte cap is `min(4 * max_message_bytes, 64 MiB)` per socket, plus at most one currently processed message. `max_message_bytes` is 256 bytes–16 MiB; default 2 MiB. HTTP responses are streamed and bounded before JSON parsing. Block log count defaults to 10,000.
- Raw feed bytes are base64 encoded, which expands record size. The journal's per-record bound should allow at least `ceil(max_message_bytes * 4 / 3) + 4096`; block-complete bundles also include bounded retained logs and metadata.

## Observation envelope

Every emitted observation contains:

```json
{
  "schema_version": "pulse.observation.v1",
  "chain_id": 4663,
  "run_id": "capture-20260908",
  "clock_id": "process-unique-id",
  "source": "provider-a",
  "stage": "head",
  "event_id": "head:4663:0x...",
  "observed_mono_ns": "123456789",
  "observed_at": "2026-09-08T14:00:00.000Z",
  "delivery": "live",
  "payload": {},
  "block_number": 100,
  "block_hash": "0x..."
}
```

Log envelopes additionally include `transaction_hash`, `log_index`, and `transaction_index`. Hashes are normalized to lowercase. Block and log numbers are safe integers; raw payloads retain JSON-RPC hex quantities. `observed_mono_ns` is captured in the WebSocket message callback **before queue processing or journal persistence**. It measures process receipt, not provider generation time, network transmission time, finality, or durable-state readiness. Wall time is informative and may move independently of monotonic time. Compare monotonic observations only within a matching process clock identity.

Event IDs are source-independent:

- Head: `head:4663:<block_hash>`.
- Log: `log:4663:<block_hash>:<transaction_hash>:<decimal_log_index>`.
- Removed log: the same identity with `log_removed:` prefix; it must not compete as an ordinary canonical arrival.
- Feed: `feed:4663:<sha256 of received raw envelope bytes>`.
- Health: a unique run/source sequence ID.

Repeated deliveries remain observations. A separate evaluator chooses the first qualified source arrival per event. All HTTP records use `delivery: "backfill"`, including blocks recovered immediately after a live head, and must never win a live-arrival race. HTTP receipt stamps in a complete block are captured after consistency checks and represent recovery completion, not the first network response byte. `replay` is reserved for a separate replay producer; this live collector does not relabel imported observations as live.

## Subscription gate and reconnect behavior

On each WebSocket session, the collector requests `eth_chainId`, `eth_subscribe(newHeads)`, and `eth_subscribe(logs,{address:[...]})`. All three responses must succeed, chain ID must match, and subscription IDs must be distinct before observations can be classified and emitted as verified-session arrivals. Notifications received while acknowledgments are pending remain in a bounded buffer with their actual payload, size and original receipt timestamps. Only after the gate succeeds are those messages checked against accepted subscription IDs and emitted. Both message count and combined raw byte limits cover this buffer. A rejected chain/subscription session never promotes its buffered messages into live observations.

An unknown subscription, malformed event, rejected subscription, oversized message, queue overflow, or transport failure closes that session. Bounded reconnection retains the last persisted recovery cursor. Messages from an obsolete socket generation cannot create new arrival observations. HTTP recovery and live message processing have separate bounded workers, so slow backfill does not intentionally block receipt timestamp capture.

HTTP tip checks run at most once per ordinary idle interval of `max(reconnect_ms,1000)` ms, and can be awakened by a live head. Head-number jumps produce an explicit notification-gap hint. Missing live messages do not become fictitious live deliveries when later recovered over HTTP. There is no application-level WebSocket heartbeat or independent liveness SLA in this v1; a silent connection can coexist with ongoing HTTP recovery, and consumers must enforce their own freshness gate.

An HTTP tip lower than the last completed block or last accepted live head produces `rpc_lag_detected`. The prior durable cursor is preserved; the source is degraded rather than silently treating a negative recovery range as healthy. Small propagation delays get bounded retries using the configured reconnect delay/limit. An unresolved delay fails closed with `HTTP_TIP_LAG_EXCEEDED`. `rpc_lag_resolved` is emitted only after HTTP catches up and durable block recovery reaches the last accepted live head. Consumers must invalidate freshness during lag and must not re-enable a quote merely because the socket is still connected.

## Canonical block recovery and checkpoints

Every block is recovered separately:

1. Fetch `eth_getBlockByNumber(number,false)`.
2. Fetch `eth_getLogs` with identical `fromBlock` and `toBlock`, and the configured address filter.
3. Validate every log's block number and block hash, transaction identity, address, topics, data and indices. Exact duplicate block-wide log slots are removed; conflicting slots fail closed.
4. Re-fetch the block header and require the same hash and parent hash. Require continuity with the retained completed parent when one exists.
5. Persist the backfill head and log observations.
6. Persist a `health` observation with the following bundle:

```json
{
  "kind": "block_complete",
  "block": {
    "number": 100,
    "hash": "0x...",
    "parent_hash": "0x...",
    "timestamp": 1788876000,
    "logs": [],
    "coverage": "provider_reported_complete",
    "observed_at": "2026-09-08T14:00:00.000Z"
  }
}
```

`timestamp` is the block's Unix timestamp in whole seconds. `observed_at` is the collector's recovery-completion wall time. Empty logs mean the queried provider returned none for the exact address/block scope; they are not independent proof of no logs.

7. Only after `emit(block_complete)` resolves, emit and await:

```json
{
  "kind": "checkpoint",
  "next_block": 101,
  "recent_blocks": [
    {"number": 100, "hash": "0x...", "parent_hash": "0x..."}
  ]
}
```

The checkpoint tracks this source's address-filtered canonical block recovery, not complete chain indexing. Pool state can consume the completed bundle; low-latency standalone log arrivals are separate provisional inputs. The consumer must preserve the address-filter configuration and dataset identity alongside checkpoints. Reusing a checkpoint with a different filter or provider scope without a new baseline would manufacture coverage.

Resume by setting `config.resume[source.name]` to `{next_block,recent_blocks}` recovered from the last durable checkpoint. The collector validates contiguous retained parent links and the cursor, then rechecks the latest retained block against the provider before progressing. Retain only durable checkpoint observations; the returned summary is not a substitute for journal durability.

If retained canonical history differs, the collector searches backward within the retained horizon for a common ancestor, emits `reorg_detected` with the orphaned suffix, rewinds, and recovers replacements. A fork beyond available retained history fails the source closed. A block changing during collection cannot produce a completed bundle or checkpoint for that attempt. Repeated recovery races are bounded. This verifies internal consistency against the configured provider; it does not prove provider honesty or L1 finality.

## Raw Nitro relay capture

When `feed_env` is configured, a separate socket retains bounded raw relay envelopes as base64. Each feed payload carries `provisional: true`, `chain_binding: "configured_unverified"`, and an explicit warning that feed sequence numbers are **not** L2 block numbers. This version does not decode Nitro messages, reconstruct transactions, derive logs, verify feed signatures, or establish a feed-to-executed-block relationship.

The top-level chain ID is the requested configured research scope; `configured_unverified` makes clear that the raw feed bytes have not independently proved it. A matching raw-envelope digest may compare two raw deliveries, but cannot be equated to a matching executed-block/log identity. Feed connection failures are reported independently; they do not turn an otherwise functioning JSON-RPC source into fabricated feed coverage.

Known endpoint URLs, query credentials, user information and likely path-key segments are scrubbed from emitted string fields. Feed text is scrubbed before base64 encoding, and `credentials_redacted` indicates whether retained bytes changed. Its event digest still refers to the original received envelope. Raw binary data is not semantically decoded to discover arbitrary embedded secrets; never configure a feed that transports credentials as domain content. Errors use fixed codes and do not retain provider error text, close reasons or endpoint URLs.

## Health kinds and coordinator response

| Kind | Meaning / required consumer treatment |
| --- | --- |
| `http_chain_verified` | HTTP endpoint returned chain 4663. |
| `subscriptions_ready` | HTTP setup and WS chain/subscription checks passed for this generation. This alone does not establish a completed pool state. |
| `pre_ready_notifications_buffered` | Pre-acknowledgment messages retained under count/byte bounds; original receipt timestamps preserved after chain/subscription verification. |
| `source_disconnected` | Main socket failed or closed; invalidate live freshness, then await bounded reconnection and recovery. `reason: WS_QUEUE_LIMIT` identifies a queue overflow. |
| `source_failed_closed` | Source exhausted its bounds or failed evidence checks; stop using it as a healthy source. |
| `gap_detected` | HTTP recovery gap or missing WS head notifications; inspect `scope`, range and recovery fields. Invalidate completeness-dependent state until recovery. |
| `live_reorg_hint` | A conflicting live head hash was observed; invalidate affected state until canonical reconciliation. |
| `removed_log_hint` | Provider reported a removed log; invalidate affected state until reconciliation. |
| `reorg_detected` | HTTP-verified divergence within retained history; remove orphaned suffix and rebuild from the stated ancestor. |
| `recovery_retry` | Header or parent changed during recovery; no bundle/checkpoint was accepted for that failed attempt. |
| `rpc_lag_detected` | HTTP tip regressed or trails an accepted live head; preserve checkpoint but invalidate freshness during bounded retries. |
| `rpc_lag_resolved` | HTTP caught up and completed recovery through the accepted live head; consumers still apply ordinary state/coverage freshness gates. |
| `block_complete` | Header-bound provider log bundle persisted; eligible for separate deterministic state processing. |
| `checkpoint` | Persisted recovery position after block bundle durability. |
| `feed_connected`, `feed_disconnected`, `feed_failed_closed` | Raw relay channel status; always provisional. |
| `source_stopped` | Clean stop at configured duration or external abort; not a permanent healthy-source assertion. |

Final summary:

```json
{
  "chain_id": 4663,
  "run_id": "capture-20260908",
  "fatal": false,
  "any_source_failed": false,
  "sources": [
    {
      "source": "provider-a",
      "status": "stopped",
      "reason": null,
      "live_heads": 10,
      "live_logs": 20,
      "feed_messages": 0,
      "recovered_blocks": 10,
      "reconnects": 0,
      "resume": {"next_block": 110, "recent_blocks": []}
    }
  ]
}
```

`fatal` means all configured main sources failed closed. `any_source_failed` reports degraded operation. A source may return `status: "failed_closed"` with a fixed error code. Journal persistence failure rejects the collection with `JOURNAL_EMIT_FAILED`; no subsequent checkpoint is emitted. The CLI should exit nonzero on fatal collection or journal failure, and may use stricter policy for any degraded source. Endpoint failures alone do not prove a provider is globally unavailable.

## Validation and current limits

Run `node --test scripts/test_collector.mjs`. Tests cover actual native WebSocket handshake and HTTP JSON-RPC against local servers, injected socket reconnect races, gap recovery, reorg rewind, durable ordering, wrong chains, subscription failure, queue/message bounds, secret redaction, raw feed treatment, and clean abortion of indefinite service mode.

These tests validate the implementation and controlled transports. They do not establish live Robinhood provider latency, feed correctness, completeness, profitable trading, or production reliability. Live endpoint observations require a separately retained run. Provider log omissions that remain internally consistent cannot be discovered from one provider's response alone. RPC source independence, confirmations/finality policy, quote freshness, V4 state reconstruction, unsupported hooks, journal retention, cost accounting, and trade execution are separate responsibilities.
