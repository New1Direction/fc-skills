# FYNCH and MSK integration

## Source contract

This skill consumes documented retained inputs. It does not assume that FYNCH has a particular public endpoint, that every pool is indexed, or that an export's wallet label is verified. Inspect the actual available REST/MCP schema, source code, or supplied export before mapping it. Reuse FYNCH's retained raw evidence and observation pipeline when available; do not deploy a parallel indexer as part of analysis.

Preserve these fields through mapping:

| Evidence | Required relationship |
| --- | --- |
| Network and assets | Chain4663; exact contract and decimals; USDG value separate from USD |
| V4 identity | Manager + pool ID + complete PoolKey; retain the initialization source |
| Events | Block number/hash, transaction hash/index, log index, removal/reorg state |
| Availability | Event time and actual ingestion/known-at time; explicit decision cutoff |
| Pool state prices | Amount/ratio orientation; endpoint block; state mark rather than executable quote |
| Stock reference | Raw equity versus adjusted token unit; historical multiplier evidence; source time and status |
| Participation | Beneficiary evidence; router/unknown exclusion; original signed raw amounts |
| Coverage | Exact pool universe, windows, completed ranges, missing ranges, collection limits |

Retain a mapping record next to the input: actual FYNCH schema/version, source export hash, export retrieval time, field correspondence, normalization code/version, excluded rows and reasons, and reconciliation totals. Preserve raw row IDs so a researcher can trace every metric to its inputs. A mapping record is provenance, not independent certification.

Native V4 evidence has no wallet beneficiary inference. It can supply event identities and pool marks, but flow inputs require separately verified attribution. Do not fill `wallet` with the Swap sender to make a dataset pass. Do not convert arbitrary V4 hooks into a supported canonical execution route merely because their events decode.

## Joining analyses

Use one as-of cutoff for a combined run. Attribution windows may be shorter than the covered flow window, but must be wholly contained. Match the exact meme, quote, manager, and pool ID before discussing participation alongside price performance. When these conditions do not hold, report independent findings or explicitly choose a new common scope; do not quietly join different universes.

The combined report preserves each module's qualification and supplied evidence limits. It does not automatically turn relative gain plus wallet counts into an investment signal. Always retain candidates that could not be evaluated.

## Handoffs

- **FYNCH:** send observed facts, measurement units, timestamps, gaps, and source links for research views.
- **Ignition:** pass the original retained candidate universe and a prospective selection policy; reuse its journal when outcome tracking is requested. Undertow itself does not establish a profitable strategy.
- **Autopsy:** investigate supply/funding explanations suggested by suspicious participation; do not upgrade a flow association to common control.
- **Arbitrage Ape:** exact chain, token contracts, PoolKeys, block references, direction, intended input size and existing evidence. Require its own current route-access, hook, cost, and execution checks.
- **LP research:** shared quote links may motivate a scenario. They do not measure V4 per-pool reserves or position exit capacity.

The initial release includes standalone research and collection helpers. A live authenticated FYNCH connection and production UI changes are separate integrations and must not be claimed from this package alone.

## Inspected FYNCH source checkpoint

Read-only source inspection on 2026-09-08 found FYNCH main at `7db4f6791993b55f856ac52a6f6c901aae34e25b`. This is a repository checkpoint, not confirmation of the running production revision or later local branches.

- [`FYNCH_DEX_POOL_INVENTORY.md`](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/docs/FYNCH_DEX_POOL_INVENTORY.md) documents pool/swaps routes under `/api/data` and `/v1`, dataset `robinhood.uniswap.swaps`, and `fynch_get_pool_swaps`. Inspect the connected service's response and access requirements before calling it.
- [`dex-pool-intelligence.mjs`](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/server/dex-pool-intelligence.mjs) contains pool recognition and analytics over the existing collector. Canonical signed protocol deltas are not sufficient to populate Undertow's wallet-perspective flow amounts or beneficiary evidence.
- [`FYNCH_STOCK_TOKEN_DISLOCATION.md`](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/docs/FYNCH_STOCK_TOKEN_DISLOCATION.md) documents retained reference selection and unresolved multiplier handling at that checkpoint. Do not silently treat a selected indicative quote as a block-pinned adjusted oracle.

This inspection confirmed integration surfaces and important limits. It did not yield a frozen real NVDA observation bundle or verify a live authenticated data connection. The included end-to-end example is synthetic and must be labeled accordingly.
