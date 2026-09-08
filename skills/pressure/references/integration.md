# Existing FYNCH integration

Inspected on 2026-09-08 at FYNCH commit `7db4f6791993b55f856ac52a6f6c901aae34e25b`. These are observations about that source revision, not a claim that a production service is deployed, healthy, or continuously collecting. Later branches may differ.

## Reuse the existing evidence

PRESSURE should consume retained FYNCH observations and the existing collection infrastructure when available. Its added value is supply-change reconciliation, bounded destination analysis, comparison with size-specific route evidence, and outcome evaluation. Do not create another always-on indexer merely to duplicate retained records.

| Existing surface | Actual evidence and useful fields | PRESSURE treatment |
| --- | --- | --- |
| `GET /api/core/float/:canonicalAssetAddress` | `version: fynch-float/v0`, `reader.chainId`, `blockNumber`, `observedAt`, `assetAddress`, `asset.decimals`, `totalSupplyRaw`, `classifiedSupplyRaw`, `unknownSupplyRaw`, `categories`, `discovery`, `warnings`, `cache` | Import as a bounded custody observation. It is not an event ledger or a depth measurement. |
| `GET /api/core/float/:canonicalAssetAddress/history` | Saved `snapshots` and a `delta` with block endpoints and direct-category changes | Compare only aligned observations with their original collection scope. Two snapshots alone do not establish mint/burn events, intervening flow, or continuous coverage. |
| `GET /api/data/stock-token-dislocation/:asset`, `GET /v1/stock-token-dislocation/:asset`, MCP `fynch_get_stock_token_dislocation` | Canonical/underlying identity, selected and alternative references, onchain spot/depth context, market state, quality, timestamps, warnings | Preserve each reference and its units, source time, and conflict state. Retain absent values as absent. |
| `GET /api/data/launches/:token/opening-supply-path` | Bounded early-inventory graph; direct transfers separately from market-mediated relationships | Reuse event provenance and cluster evidence when applicable. It is a launch evidence surface, not a canonical stock issuance index. |

These endpoints are documented in [Float](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/docs/FYNCH_FLOAT.md), [Stock Token Dislocation](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/docs/FYNCH_STOCK_TOKEN_DISLOCATION.md), and [Opening Supply Path](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/docs/FYNCH_OPENING_SUPPLY_PATH.md). The table is an integration map; it does not assert an automatic PRESSURE HTTP importer exists.

## Float projection details

Each `categories[]` row has `type`, `balanceRaw`, and `addresses[]`; each address row carries `address`, `balanceRaw`, `protocol`, `label`, `confidence`, and `evidence[]`. `UNKNOWN` distinguishes observed balances of unknown type from unattributed residual supply. Copy raw decimal strings without a JavaScript `Number` conversion.

The snapshot exposes `estimatedFreeFloatRaw` as observed EOA/large-wallet balances and `availableMarketInventoryRaw` as recognized DEX custody. Neither is the amount a wallet can sell. In the inspected code, `marketState.status` is `NOT_QUERIED`. Preserve `discovery.holderUniverse`, including `fromBlock`, `throughBlock`, queried counts, and `truncated`, plus `poolDiscovery` status and coverage. A missing balance or failed holder scan must not become zero.

The default holder discovery is bounded to 5,000 recent blocks and 48 addresses. Float's `pressure.status` is a threshold-based custody heuristic; never substitute it for PRESSURE's observed route changes or interpret `TIGHT` as a forecast. The original snapshot has a block number but no block hash. Adding today's hash at that number does not retroactively prove the original reads used that canonical block. Preserve this provenance gap or recollect independently pinned evidence. See [float.mjs](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/server/float.mjs).

## Custody labels and singleton accounting

The reviewed registry includes the V4 manager `0x8366a39cc670b4001a1121b8f6a443a643e40951` and the Robinhood L2 ERC-20 Gateway `0xfd9b17206278C16DdaacF6AC8f05dBf97EdCb31e`. The manager's balance is shared custody across pools. A transfer to it alone establishes neither a pool deposit nor a swap nor tradable per-pool stock inventory. Attribute an action to a pool only with independently decoded, exact pool/event or execution evidence.

Registry entries include effective block ranges and source labels. Preserve those declarations and independently retain when the evidence became known; an old effective block is not evidence that a historical analyst knew the label then. Do not infer authorized-participant status, lending custody, or locked supply from a large balance. See [float-registry.mjs](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/server/float-registry.mjs).

## Integration gaps and operational boundary

At the inspected revision, Dislocation V1 documents no configured Robinhood-reference collector or numeric oracle observation adapter. A non-unit corporate-action multiplier remains an explicit review requirement. PRESSURE can normalize supported retained observations, but must not claim these FYNCH adapters are already connected.

Float's reader accepts `process.env.ROBINHOOD_RPC_URL` and otherwise uses the Core Directory default. The inspected files do not publish a verified archive endpoint; a bounded repository code search for `ARCHIVE_RPC` found no matches. This is not proof that no operational endpoint exists. No credentials or environment files were inspected. Supply collection must record the actual endpoint capability result and preserve incomplete intervals on limits/timeouts.

HOOK LAB evidence can support an exact wallet, route, size, and pinned deployment. Its source-derived Pons calculations alone do not establish a live qualified route. Use PULSE for collection freshness and recovery, Undertow for compatible price semantics, and HOOK LAB for call-path evidence. Changes to FYNCH/Ape services or live executor permissions remain separate integration work.
