# Versioned interfaces

All interface discriminators use `schemaVersion`. Decimal amounts and prices are strings; timestamps use ISO8601 with explicit timezone. IDs and addresses are exact identities, not ticker aliases.

## CatalystConfig@1

Required: `schemaVersion`, `startDate` (`YYYY-MM-DD`), `issuers: [{cik}]`. For live collection add `userAgent` with application name and real contact email.

Optional collection settings: `forms`, `maxRequests`, `maxFilings`, `maxHistoricalFiles`, `maxBodyBytes`, `maxStorageBytes`, `requestsPerSecond`, `timeoutSeconds`, `pollSeconds`. Defaults and limits are visible in `scripts/catalyst.py` and in the offline demo config.

`bindings[]` requires `issuerCik`, exact `securityTitle`, `chainId:4663`, `tokenAddress`, `verifiedAt` and `evidence`. A duplicate issuer/security-title binding is rejected as ambiguous. The code validates shape and timing; the caller establishes the real issuer/security/token relationship from retained primary evidence. An evidence string is not cryptographic verification.

`pools[]` requires `chainId:4663`, exact 32-byte V4 `poolId`, `token0`, `token1`, `verifiedAt` and `evidence`. Both currencies use addresses, including the zero address where a verified V4 pool uses native ETH. A stock binding associates only to pools whose exact pair contains its token address. This native registry format targets Robinhood V4; other pool identities need an explicit adapter.

## CatalystEvents@1

Top-level: `generatedAt`, `events[]`, latest-run `coverage`, `limitations`.

Each event has:

| Field | Meaning |
|---|---|
| `id` | `sec:<accession>` stable event identity |
| `accession`, `form`, `filingDate` | Original source metadata; amendments stay separate |
| `issuerCik`, `discoveryCik` | XML issuer when parsed; queried source CIK separately |
| `acceptedAt`, `acceptedAtRaw` | Source acceptance normalized only if timezone is explicit; raw retained |
| `firstObservedAt` | Earliest locally retained discovery response for this accession |
| `collectedAt` | Primary document HTTP body receipt time |
| `detailsAvailableAt` | Local parsing completed, immediately before storing the resulting detail record |
| `source`, `rawSha256` | Retained primary document URL and SHA-256 |
| `status`, `error` | `PENDING`, `ERROR` or `COLLECTED`; failed details are not silently dropped |
| `metadata`, `parsed` | Full source row; structured ownership result or null for narrative/unsupported parsing |
| `discoveryEvidence[]` | Retained submissions URLs, observed times and raw hashes |
| `associations[]`, `warnings[]` | Exact supplied mappings and interpretation/coverage qualifications |

`associations[]` contains `chainId`, `stockTokenAddress`, `securityTitle`, `associationScope` (`REPORTED_SECURITY` or `ISSUER_LEVEL_ONLY`), `poolIds`, `mappingKnownAt`, `mappingTiming`, `evidence`, and `pools[]` with token pair, mapping timing and evidence. A mapping's availability and each pool mapping's availability are separate. `mappingTiming` describes availability at initial discovery; the analyzer additionally checks actual detail-ready time.

An export can contain older events from prior configs in the same database. Its `coverage` describes the latest run only; it must not be promoted to a complete historical coverage statement for every exported event. Discovery evidence and each retained `runs.config` establish that historical scope.

## CatalystForm4@1

Parser output includes `documentType`, `isAmendment`, `dateOfOriginalSubmission`, `periodOfReport`, `issuer`, `owners`, `aff10b5One`, `aff10b5OneScope`, `rows`, `footnotes`, `footnoteReferences`, `warnings`, `rawXml`, `rawSha256`.

Each `rows[]` entry retains a stable table/type/index `rowId`, `table` (`nonDerivative`/`derivative`), `recordType` (`transaction`/`holding`), `securityTitle`, `transactionDate`, `deemedExecutionDate`, `code`, `classification`, `acquiredDisposed`, `shares`, `price`, `reportedNotional`, `postshares`, `directIndirect`, `indirectNature`, derivative underlying/exercise fields, footnote associations, warnings and raw XML. Holdings do not acquire a fictitious transaction code. Unknown/invalid optional numeric/date values remain null with warnings. Unrecognized XML fields remain in raw XML.

`reportedNotionalMeaning` is `REPORTED_VALUES_PRODUCT_NOT_CASH_EXECUTED`; `reportedNotionalFootnoted` preserves additional qualification. A weighted-average price or noncash transaction must not become a claim of observed exact cash spend. Do not aggregate separate reporters' jointly reported rows into independent purchases. `aff10b5One` is a document-level declaration, never automatic row-level plan attribution.

## CatalystObservations@1 and CatalystResponse@1

Input `observations[]` requires:

```json
{
  "chainId": 4663,
  "poolId": "0x<64 hex digits>",
  "blockNumber": 100,
  "blockHash": "0x<64 hex digits>",
  "blockTimestamp": "2026-09-08T14:00:01Z",
  "observedAt": "2026-09-08T14:00:01.200Z",
  "canonical": true,
  "baseTokenAddress": "0x<40 hex digits>",
  "quoteTokenAddress": "0x<40 hex digits>",
  "price": "2.1",
  "priceBasis": "RAW_STOCK_TOKENS_PER_RAW_MEME_TOKEN",
  "source": "retained adapter observation reference"
}
```

Normalize to one exact end-of-block state per pool/block. Two different canonical hashes, prices or units for that identity are refused. Observations may have other fields, which are retained in selected evidence. `coverage[]` entries require `poolId`, `from`, `to`, `canonicalComplete:true`, and `source` to qualify a covered response interval. This is supplied adapter evidence, not a native RPC verification.

The response anchor is the later of initial discovery and `detailsAvailableAt`. Missing detail-availability time withholds a qualified result. The baseline must already have been locally observed by the anchor and be at most 300 seconds old by default. The outcome must occur at or after the target horizon (60 seconds default), and both its block time and local observation time must fall within the following 30-second tolerance. A later replayed observation cannot establish low-latency availability.

Canonical interval coverage must span the selected baseline and outcome. Both must use the same exact pair orientation and `priceBasis`. Retrospective pool mappings, missing baselines/outcomes, clock conflicts or missing coverage produce `INSUFFICIENT_DATA` and null `localPriceChangePct` with reasons.

Qualified output uses `OBSERVED_LOCAL_PRICE_CHANGE`, with complete baseline/outcome evidence, `anchorAt`, `anchorBasis`, `firstObservedAt`, `discoveryToDetailsSeconds`, `localPriceChangePct`, quote address and units. Formula: `(outcome / baseline - 1) × 100`. No fees, hedge costs, executable routing or causal controls are included; this is not a trade P&L calculation.
