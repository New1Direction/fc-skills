# Validation and release boundaries

## Executed verification

Release work on 2026-09-08 ran all bundled Python standard-library suites:

| Area | Tests | Main invariants |
| --- | ---: | --- |
| Price attribution | 36 | Multiplicative identities; split/multiplier cancellation; source units; orientation; timestamps; partial references |
| Wallet flows | 40 | Routing cancellation; unknown beneficiary quarantine; scoped cohorts; block-wide log identity; conservative rotation allocation |
| Raw V4 evidence | 36 | PoolKey Keccak; signed ABI; hook flag validity; receipt/header binding; reorgs; independent request; transcript tampering |
| Stock references | 17 | Exact deployments; decimals; ordered capture; pending changes; freshness at completion; normalized-content tampering |
| Combined reports | 10 | Shared identities, units, cutoff/windows and block histories; retained failed candidates; synthetic labels; input hashes |

Total: **139 offline tests**. These exercise meaningful accounting and integrity failures. They do not establish provider authenticity, deployment correctness, profitable signals, or fillability.

Independent protocol and quantitative reviews reproduced and led to fixes for final-capture quote staleness, malformed pending multiplier states, impossible V4 hook configurations, duplicate block-global log indices, unrelated transaction cashflows assigned to a meme, and inconsistent block histories joined across reports. The corrected probes reject those cases.

Included attribution, flow, and combined-report CLIs were executed on the bundled synthetic inputs. An independent agent used a separate synthetic case, correctly identified a green USD chart with negative quote-relative performance, withheld a new-buyer claim with missing baseline coverage, and kept rotation notional distinct from profit. Its output-directory issue was fixed; all referenced guidance is present. Raw V4 collection/replay was exercised against synthetic RPC responses. Synthetic runtime bytes, transactions, addresses and market values are fixtures, not live data.

## Live verification boundary

The documented Robinhood public RPC request timed out after 15 seconds. Read-only requests to official stock `/assets` and `/prices/NVDA` endpoints also timed out from this environment. Consequently no live chain block, pool, code fingerprint, stock reference, or executable route was independently validated in this release.

Read-only FYNCH repository inspection confirmed retained-data integration surfaces at the checkpoint in `integration.md`; no frozen real NVDA evidence bundle was available from that inspection. No live authenticated FYNCH connection, production UI integration, continuous indexer, or automated trading loop is bundled.

Before describing the native adapter as live-validated, obtain an independently reviewed deployment fingerprint and pool trust manifest, collect a real bounded bundle from a reachable provider, verify it against that separate manifest, reconcile decoded events and units independently, and retain discrepancies and actual retrieval times. Broaden support only through explicit verified adapters.

## Useful scope today

- Deterministic attribution of supplied, properly scoped Robinhood stock/meme observations.
- Descriptive participation and rotation research from supplied wallet-attributed swaps with explicit coverage.
- Structural shared-quote mapping without invented reserves, covariance, or exit capacity.
- Bounded read-only native V4 collection/verification code and official REST reference capture code for a reachable environment.
- Reproducible JSON/Markdown reporting, integration contracts, examples, and offline validation.

No profitability claim is established. Prospective evaluation, actual execution outcomes, and broader provider adapters remain separate work.
