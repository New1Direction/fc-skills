# Collection and application operations

## Collector

`collect --symbol SYMBOL --token EXACT_CONTRACT --out CAPTURE.json [--report-out REPORT.json]` reads the fixed official `https://api.robinhood.com/rhj/` API, in sequence:

1. `assets` before price capture.
2. `prices/{symbol}`.
3. `assets` again, requiring stable identity/status/multiplier/pending metadata.
4. `corporate-actions`, retaining only exact contract/symbol matches in the normalized action list.

At most four requests, no retries or polling loop, 12-second per-request timeout, 4 MB retained bytes per response; redirects are refused. A transport or HTTP failure stops subsequent requests. The capture records raw successful and HTTP-error bodies, response timing, selected cache headers and SHA-256. A transport failure has no fabricated response body. `REFERENCE_UNAVAILABLE` preserves partial evidence and CLI exits2; successful reference capture exits0 even when corporate actions are unavailable. Read that component's status separately.

Raw actions are contextual records. A processed action does not establish a cash payment to this wallet, complete corporate-action history or a match to a particular onchain event. The metadata-before/after bracket detects observable drift; cached equal responses do not prove an atomic chain snapshot. The API supplies no metadata updated-at field, so the multiplier's source time is explicitly local receipt. Server price `generatedAt` is kept separately. Current API capture does not establish historical multipliers or an open market session; trading capability flags are not a session calendar.

`scripts/collector.py` exports `collect(symbol, token, fetcher=None)` for deterministic fixture testing, `normalize(capture)` to reconstruct its normalized input from raw reference responses, and `normalize_actions(capture)` for corporate-action rows. Never trust a mutable `normalized_input` without rerunning normalization when importing someone else's capture. Hashes prove content consistency, not that a remote publisher supplied it.

Scheduling belongs in an existing worker supervisor. Respect cache windows, retained response status and `Retry-After`; do not run multiple token collectors at high frequency and exceed aggregate provider limits. Avoid adding a second application indexer. Persist reference observations alongside the canonical onchain store, and invalidate associated block evidence on reorgs. Do not label a local smoke test as deployed continuous monitoring.

## Native coverage and integration

The native collector obtains current stock-token metadata, raw reference prices and reported corporate actions. It does not obtain pool discovery, all transactions, oracle reads, wallet balances, route quotes, FX feeds, market calendars, gas estimates or simulations. WATCHTOWER can provide retained block events; FYNCH and HOOK LAB can supply supported exact-price or wallet-call evidence through explicit adapters. Missing evidence remains missing.

For a production panel, display source time, freshness and evidence kind beside each separate value. A stock reference, onchain mark and quoted/simulated exit can disagree for legitimate reasons including stale references, spread, size, fees, market closures and corporate actions. Do not collapse them into a synthetic “fair value oracle.”

## Primary sources checked 2026-09-08

- [Robinhood stock-token APIs](https://docs.robinhood.com/chain/stock-token-apis/): endpoint schemas, explicit USD raw equity bid/ask, exact per-chain deployments and pending metadata. Prices are cached15seconds and corporate actions1hour; the documented overall API limit is60requests/second. Collector defaults intentionally stay far below that ceiling.
- [Building with stock tokens](https://docs.robinhood.com/chain/building-with-stock-tokens/): 18-decimal ERC-20 raw amounts, shares-per-token multiplier and already-adjusted Chainlink price semantics. The published reference and current metadata do not establish permission to redeem with the issuer.

The bounded collection design adapts MSK Undertow's before/after metadata pattern; code here is self-contained and adds partial-error retention and corporate-action capture. Recheck official documentation when endpoint schemas or token contracts change. A `schema` error is an unsupported response, not permission to guess new units.
