# Runtime, persistence and operations

PULSE bundles Node24 built-ins only. `scripts/pulse.mjs` is the command entry point; the collector, race, pool engine and node operator also expose importable functions. `runtime.mjs` joins adapters, maintains one selected source's provisional pool state, and runs a loopback-only read API.

## Run configuration

Copy `assets/pulse.example.json` outside the skill into the target server's configuration directory. Keep available sources only. Each source names HTTP/WS environment variables; an optional feed variable may point at a compatible uncompressed Nitro relay. A direct official feed may require the supported Nitro relay for compatible decoding. Source names are stable benchmark identifiers, not endpoint URLs. All RPC collection verifies mainnet4663. Never put authenticated URLs in checked-in JSON or reports.

`duration_seconds: 0` runs until SIGINT/SIGTERM or a fatal resource condition. Other durations are bounded. Reconnection count, message size, queue depth, historical recovery, and spool bytes are independently bounded. When a configured bound is exceeded, investigate the reported gap or failure and configure a deliberate recovery window. Raising a bound does not establish history completeness.

Default collection records the configured contract addresses, including unknown pool IDs. This lets researchers discover Initialize events in retained evidence; state evaluation only includes the supplied registry. Use archive-capable providers where the requested history requires them.

The selected `primary_source` alone updates the pool engine. Secondary sources remain independent observations for comparison. A faster source is not automatically promoted: first compare correctness, coverage, tail latency and recovery, then change source configuration using a new journal scope.

## Journal and restart

The append-only JSONL spool wraps each observation as `pulse.journal.v1` with a monotonically increasing local sequence. Source arrivals use a separate process monotonic clock captured by the collector. Ordinary records are written sequentially; checkpoint and run records synchronize the file before acknowledgment. A completed checkpoint therefore follows all previously written observations. Clean shutdown synchronizes remaining writes.

Only one process may write a journal. The adjacent exclusive lock stores its PID. After an unclean process death, check whether that PID still owns a running collector before removing the stale lock. The runtime never removes another process's lock automatically.

Restart reads complete records, rejects corrupt complete lines, and truncates only an unfinished final line. It replays the original configuration scope and recovers per-source checkpoints. A different address set, source set, selected primary or pool registry needs a separate journal. Every restart gets a new run/clock identity; comparisons never assume monotonic timestamps survive a restart.

The spool stops at its configured byte limit, default256MiB. Archive/export it and start a new segment before filling it. Keep the previous segment for replay; supply `from_block` deliberately when starting a new segment. There is no silent retention deletion, infinite spool, automatic multi-segment rotation or remote data upload.

Collection checkpoints advance when raw provider block bundles are retained. Derived-state acceptance has its own `state_status` and `last_state_block`. A rejected block yields a `state_rejected` health record, never a state-ready label. Preserve the raw evidence and repair/replay the decoder or chain context before using derived state; the collector may continue retaining data while state remains unavailable.

## Local read API

The service prints its bound port to stderr after startup. Set `api_port` explicitly for a stable consumer address; default0 chooses an ephemeral port. It always binds127.0.0.1 and permits GET only.

| Route | Response |
| --- | --- |
| `/health` | Runtime state, source health, last complete block and its observation age, spool usage |
| `/v1/pools` | Health plus reconciled registry state and immediate provisional live state |
| `/v1/events?after=123&limit=100` | Recent journal records after the given local cursor |

The in-memory event window is capped by both2048 records and16MiB. An expired cursor returns HTTP410; replay the retained journal before resuming. Cursor order is persistence order, not sequencer order. Consumers must preserve canonical block/log identities and continuity themselves. This API is intentionally private; add an authenticated application gateway only when a concrete remote consumer needs it.

`export --journal INPUT --out OUTPUT` writes unwrapped observations as JSONL without modifying the source. `race` accepts a journal wrapper, not that export format. Benchmark analysis is capped at 100,000 retained observations in memory.

## Linux service

`assets/pulse.service` is a systemd deployment template for a dedicated `pulse` user, code under`/opt/msk/skills/pulse`, configuration under`/etc/pulse`, and writable spool under`/var/lib/pulse`. Adjust the Node binary path for the host. Create those paths and user, install Node24+, supply endpoint credentials through a mode0600 environment file, and supply a real pool registry (or remove the optional registry argument for collection only). Set a stable API port in collector configuration.

The unit restarts failed runs within a bounded service restart policy. Resource limits and disk alerts should be set using actual host measurements. Installing the unit or starting paid infrastructure is a deployment action; generated files alone do not establish a running service.
