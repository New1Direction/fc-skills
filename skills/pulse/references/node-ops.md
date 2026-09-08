# Robinhood full-node operations

`scripts/node_ops.mjs` generates a reviewable mainnet full-node plan. It does not buy hardware, create a VM, pull a container image, start Docker, submit transactions, or stake. Node 24 and only built-in modules are required for the helpers. Docker Compose is needed separately to run the generated plan.

## Interface

```js
import { renderNodePlan, validateAssets, probeNode } from './scripts/node_ops.mjs';

const plan = renderNodePlan(config);
// plan.files contains compose.json, nitro-config.json, and RUNBOOK.md strings.
// Save those exact strings together only after inspecting plan.manifest.
const assets = await validateAssets(plan);
// Asset validation does not start Docker or alter plan.manifest.

const observation = await probeNode({
  localRpcUrl: 'http://127.0.0.1:8547',
  peerRpcEnv: 'RH_INDEPENDENT_PEER_RPC',
  maxHeadAgeSeconds: 30,
  maxFutureSkewSeconds: 2,
  maxPeerLagBlocks: 20,
  timeoutMs: 5000,
});
```

`assets/node-plan.example.json` documents the renderer input. Its all-zero digests are conspicuous placeholders, not downloaded fingerprints. Replace them with independently established SHA-256 values for the exact official files, and set real absolute paths. Use simple normalized Linux paths; traversal segments, interpolation, shell metacharacters, and symlinked source assets reject. Configuration must remain outside the writable data directory. Unknown config fields reject, so a plan cannot hide public RPC bindings or arbitrary Nitro flags.

The image is restricted to `offchainlabs/nitro-node:v3.11.2-3599aca`, optionally followed by `@sha256:<independently-verified-digest>`. This version appears in Robinhood's guide checked 2026-09-08. A version tag is mutable, while an image digest is immutable; the renderer does not verify the supplied digest against a registry. Revisit the official guide and upgrade notices before a real deployment. Supporting a new version requires a deliberate source-reviewed update to this module.

`validateAssets(plan)` re-renders the plan to reject alterations, reads bounded regular files (maximum 32 MiB each), checks digests, rejects duplicate JSON members, checks both chain IDs and Ethereum parent identity, and checks the documented rollup, inbox, bridge, and sequencer inbox addresses. The custom genesis embeds `serializedChainConfig`, a JSON string; it must exactly match the chain-info configuration. It is not an Ethereum-style `config.chainId` field. Initial ArbOS51 in those genesis files is historical; current guide ArbOS61 must not replace it. Original files are mounted directly; balances and bytecode are never reserialized by this helper.

The result `DIGEST_AND_MAINNET_IDENTITIES_MATCH` means those checks passed against independently supplied fingerprints. It does not authenticate where the fingerprints came from, audit all genesis allocations, verify the image, prove startup success, or protect files from later mutation. Protect assets against editing and recheck immediately before launch. Never take expected hashes directly from an untrusted plan and call that independent verification.

## Generated configuration

Compose JSON is a supported Compose representation and avoids YAML quoting ambiguity. Only the two validated environment names become Compose substitutions. Their values are not read by the renderer or written to files. They map through `--conf.env-prefix=PULSE_NITRO` to Nitro's documented `parent-chain.connection.url` and `parent-chain.blob-client.beacon-url`. Docker administrators can inspect resolved container environment values; keep credentials in your local secret environment and do not commit or print resolved Compose output.

Both L1 execution RPC and beacon consensus endpoints are required for Ethereum mainnet. The beacon service must make the blob data needed for sync available. This module does not certify L1 providers, quotas, retention, or synchronization. An Ethereum testnet endpoint will not meet the plan's requirements.

The persisted data mount is `/home/nitro/.arbitrum`, as required by Robinhood's Nitro image instructions. HTTP and WS bind all container interfaces so Docker routing works, but published host ports 8547/8548 bind only `127.0.0.1`. CORS is empty and WebSocket origins are restricted. Local processes and containers on the same Docker network may still connect: loopback binding is not user authentication. No host networking, privileged mode, Docker socket, or admin/debug/personal API is enabled.

The renderer explicitly disables transaction forwarding with the literal string `"null"`; node sequencing, execution sequencing, batch posting, staking, and block-validator service are disabled. Ordinary full-node execution still verifies state while following the chain. This is not a permissioned validator, dispute agent, or independent assertion-validation service. The `eth` namespace has transaction method names, but this nonsequencer configuration does not forward incoming transactions. The probe itself only permits three read methods.

## Probe interpretation

The probe checks `eth_chainId`, `eth_syncing`, and the latest header, including timestamp policy. If an independently configured peer is supplied, it checks that peer's chain and fresh head, then compares the same block number on both endpoints. Comparing only chain IDs or latest heights would miss forks. Header changes during the comparison reject the observation. All calls are bounded; at most seven RPC calls are currently used, with a hard ceiling of nine, a per-call timeout of at most 10 seconds, and a 1 MiB HTTP response cap. There are no retries or polling loops.

| Status | Meaning |
| --- | --- |
| `RESPONDING_CURRENT_WITHOUT_PEER` | Local chain ID, sync flag, and freshness pass; independent peer agreement is absent. |
| `RESPONDING_CURRENT_PEER_CONSISTENT` | Those checks and a same-block peer hash comparison pass within supplied height policy. |
| `SYNCING` | Node explicitly reports sync in progress. |
| `STALE_HEAD` / `FUTURE_HEAD` | Timestamp is outside the selected policy. Check node progress and the host clock. |
| `BEHIND_PEER` / `PEER_BEHIND_LOCAL` | Same-block hashes agree but head difference exceeds policy. Neither endpoint is assumed authoritative. |
| `PEER_FORK_DISAGREEMENT` | Hashes differ at the same block height. Stop treating their observations as interchangeable. |
| `UNAVAILABLE` | Transport, identity, response, or consistency checks failed. Error content is suppressed to avoid leaking provider URLs or secrets. |

Thresholds are operator policies, not calibrated Robinhood guarantees. `nowMs` is only an explicit replay/testing clock; omit it for live probes. Results always state `l1Health: NOT_PROBED` and `finality: NOT_PROVEN`. A healthy-looking sequencer head can coexist with L1 or data-availability trouble. Monitor Nitro errors, L1 execution and beacon progress, provider quotas, CPU/RAM/disk, and clock outside this bounded probe. This release does not provide sustained uptime monitoring or imply a finality guarantee.

Tests can inject an async `rpc(method, params, {target, timeoutMs})` returning the raw JSON-RPC result; target is `local` or `peer`. This transport boundary supports deterministic failure tests. Injection is not independent live evidence.

## Hardware planning

Robinhood's current guide specifies a modern CPU with at least eight cores and strong single-core performance; 64 GB RAM minimum, 128 GB recommended; locally attached NVMe; and `(2 × current chain size) + 20% buffer`, with several TB of data. These requirements are for a full node, not an archive node. Measure current size and forecast growth and L1 request usage before spending. No hardware or provider purchase is automated.

## Sources checked 2026-09-08

- [Robinhood full-node guide](https://docs.robinhood.com/chain/run-a-full-node/): mainnet asset URLs, image tag, mounts, feed, hardware, L1 and beacon prerequisites, and ArbOS upgrade notes.
- [Official mainnet chain-info](https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-chain-info.json): chain and parent identity and rollup addresses.
- [Official custom genesis](https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-genesis.json): allocations, serialized configuration, and timestamp.
- [Nitro configuration system](https://docs.arbitrum.io/run-arbitrum-node/nitro/configuration-system): JSON file format, config precedence, environment-prefix mapping, and secret handling.
- [Nitro CLI flags](https://docs.arbitrum.io/run-arbitrum-node/nitro/cli-flags-reference): API flags, forwarding disable value, and node modes.
- [Arbitrum full-node guide](https://docs.arbitrum.io/run-arbitrum-node/run-full-node): full-node and watchtower distinction.

Validation performed: deterministic unit/adversarial tests and a real HTTP JSON-RPC test on loopback. No Nitro image was started, no full chain was synced, and no server was provisioned by this module's build.
