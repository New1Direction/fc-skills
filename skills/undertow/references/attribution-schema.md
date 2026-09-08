# Price-mark attribution schema

## Contents

- Inputs and identity
- Snapshot sources and timing
- Reference semantics
- Arithmetic and outputs
- Limits and example

## Inputs and identity

Run `python3 scripts/attribution.py --input examples/attribution.json --output /path/to/report.json`.
Python callers can use `analyze_attribution(payload) -> dict`. The CLI exits 2 for
`INSUFFICIENT_DATA`; a partial reference report is a valid report and exits 0.
Use Python's standard library only. No network, signing, or transaction methods
exist in this module.

Required top-level fields:

| Field | Type and meaning |
| --- | --- |
| `schema_version` | Exactly `undertow.attribution.v1`. |
| `chain_id` | Integer `4663`; strings, booleans, floats, and other chains are rejected. |
| `evidence_mode` | `synthetic` or `retained`; copied into the report. Neither means independently authenticated. |
| `as_of` | ISO-8601 timestamp with timezone; the report's knowledge cutoff, not the wall clock. |
| `policy.max_age_seconds` | Integer 0–604800; maximum source age at each historical snapshot. Explicit research policy, not a calibrated trading threshold. |
| `policy.max_alignment_seconds` | Integer 0–86400; maximum timestamp spread among contemporaneous sources. |
| `asset_continuity` | `verified`, `unverified`, or `broken`; supplied assessment of token and unit continuity through the interval. `broken` suppresses returns; `unverified` leaves marks unqualified. |
| `assets.meme` | `address` and integer `decimals` (0–36). |
| `assets.quote` | Same fields, plus `kind: stock_token` and an exact stable `underlying_id`. Symbols are insufficient identifiers. |
| `pool` | Full identity below. |
| `snapshots` | Exactly two snapshots, ordered by increasing block number and time, with distinct block hashes. |

Both assets must be distinct nonzero ERC-20 addresses. Native-currency pools need
a separately verified normalization adapter. Prices and multipliers use positive
plain decimal strings, never floats or exponent notation. Raw values use positive
base-10 integer strings. No missing value is converted to zero or one.

`pool` requires:

- `protocol: uniswap_v4`, `manager` (address), and `pool_id` (32-byte hex).
- `token0` and `token1`, sorted by address and exactly matching the declared assets.
- `fee` (integer static fee 0–1000000, or exactly 8388608 for dynamic fees),
  `tick_spacing` (integer 1–32767), and `hook` (address, zero permitted).
- `identity_status: verified | unverified` and `identity_evidence_ref`.
- `hook_status: zero_hook | verified | unknown`; zero_hook requires the zero
  address, verified requires `hook_evidence_ref`, unknown leaves marks unqualified.

These are supplied identity and hook attestations. This module does **not**
recompute the pool-key Keccak hash, inspect bytecode, inspect hook behavior,
authenticate providers, or verify canonical chain membership. Use the skill's
verified collector where supported and retain its evidence separately. A
nonempty reference string proves only that a reference was supplied.

## Snapshot sources and timing

Every snapshot requires `timestamp` (block time), `observed_at` (capture envelope),
`block_number`, `block_hash`, `canonical: true`, `pool_mark`, and `quote_usd`.
Reference decomposition additionally requires `token_paused: false` at that
block. False or unknown canonicality invalidates all attribution.

Each source object requires:

- `timestamp`, no later than its snapshot and within `max_age_seconds`.
- `observed_at`, no earlier than its source time, no later than the snapshot's
  capture envelope, and no later than `as_of`.
- `source_id`, `evidence_ref`, and `quality: verified | unverified`.

The module records these fields as supplied provenance. `quality: unverified`
leaves resulting marks unqualified. A verified value is still a caller assertion.
Use actual ingestion times. Backfilled evidence can support retrospective analysis
when allowed by `as_of`; it does not prove the evidence or an alert existed at the
historical block time.

`pool_mark` requires exact `manager`, `pool_id`, `token0`, `token1`, `block_number`,
and `block_hash` bindings to the declared pool and snapshot. Its timestamp must
equal the block timestamp. Choose exactly one price representation:

1. `kind: sqrt_price_x96` and `sqrt_price_x96` (uint160 decimal string inside
   canonical TickMath bounds).
2. `kind: raw_ratio`, `token0_raw`, `token1_raw` (uint256 decimal strings).
   Their ratio is the **retained state-price ratio of raw token1 units to raw
   token0 units**. They are not PoolManager balances, aggregate reserves, swap
   amounts, or liquidity. A provider must establish the normalization provenance.

The representation is checked for shape, not independently derived from raw
chain bytes here. Extra unused fields must never be treated as verified inputs.

`quote_usd` requires source fields and:

| Field | Required meaning |
| --- | --- |
| `quote_token` | Exact declared quote token address. |
| `currency` | `USD`. An observation in USDG requires an evidenced USDG-to-USD conversion before input. |
| `unit` | `USD_per_quote_token`, in whole token units. |
| `basis` | `local_market`. An equity or oracle reference cannot substitute for a local market observation. |
| `venue` | Source market/route identifier. |
| `bid`, `ask` | Positive USD-per-token decimal strings with bid ≤ ask. Midpoint is used as an accounting mark. |

Both local sources must fall within the alignment policy. Their bid/ask values
need not be executable at the user's size. This module does not establish venue
depth, route costs, spread capture, or independence of the provider's sources.

## Reference semantics

A snapshot may supply `reference`. Both snapshots need valid references to
decompose local premium from stock-reference movement. If either is unavailable,
stale, temporally inconsistent, restricted, or malformed, `reference_attribution`
is null; valid local two-factor arithmetic remains available.

Common reference fields:

- Source fields described above; reference and local marks must align.
- Exact `quote_token`, matching `underlying_id`, and `currency: USD`.
- `asset_status: active`, `session: regular | extended | overnight`,
  `tradability: tradable`, and `halted: false`.
- Positive `bid`, `ask` with bid ≤ ask.

The session/halt/tradability assertions must be established from retained,
timestamped evidence by the collector. The module does not infer market sessions
from a calendar or reinterpret a closing-only restriction as normal tradability.
Closed or unknown sessions, unknown pause status, and missing halt status suppress
the reference decomposition, even if a cached last price is available.

For Robinhood REST raw equity prices:

- `basis: raw_equity`, `unit: USD_per_share`.
- `multiplier` object with `basis: block_state`, `value` (shares per token),
  exact snapshot `block_number` and `block_hash`, `observed_at`, `source_id`,
  `evidence_ref`, and `quality`.
- A multiplier block-state source uses the snapshot block time; it does not
  require a separate `timestamp` field. Its observation must respect the same
  capture envelope and knowledge cutoff.
- Retain a historical multiplier read at **each** snapshot. Latest `/assets`
  `currentMultiplier` is not a historical multiplier record. Multiplying old
  prices by the latest multiplier can fabricate returns around corporate actions.

For an already adjusted onchain oracle:

- `basis: adjusted_oracle`, `unit: USD_per_quote_token`, `round_valid: true`.
- Exact snapshot `block_number` and `block_hash` for the retained oracle read.
- `timestamp` means the oracle answer's update timestamp, not RPC retrieval time.
- Omit `multiplier`, `currentMultiplier`, and `current_multiplier`; their presence
  is rejected to prevent double adjustment. Read-only upstream validation must
  establish the round, feed/token mapping, decimals, and update validity.
- Underlying and multiplier factors remain null because an adjusted feed alone
  does not establish those two components independently.

Mixed raw-equity and adjusted-oracle endpoints can establish adjusted reference
movement when their mapping and semantics are verified; they cannot establish a
separate underlying/multiplier decomposition with only one raw endpoint.

Official Robinhood semantics: REST `/prices` quotes are underlying-equity prices;
the onchain feed already includes the shares-per-token multiplier. [Stock Token
APIs](https://docs.robinhood.com/chain/stock-token-apis/). This reference informs the
adapter contract; it does not authenticate an input file or promise stock
redemption access.

## Arithmetic and outputs

Let `R` be whole quote tokens per meme, `Q` the local USD quote-token midpoint,
`S` raw equity USD midpoint, `M` shares per token, `F = S × M` the adjusted stock
reference, and `P = Q / F` the local premium ratio. For an adjusted oracle, take
`F` directly. Subscripts 0 and 1 denote the two snapshots.

For a pool-state raw ratio:

`token1_per_token0 = (token1_raw / token0_raw) × 10^(decimals0 − decimals1)`.

For sqrtPriceX96, replace the raw ratio with `sqrt_price_x96² / 2^192`.
Invert whole-token ratio when the meme is token1. The accounting identities are:

`meme_USD_factor = (R1/R0) × (Q1/Q0)`

`meme_USD_factor = (R1/R0) × (P1/P0) × (F1/F0)`

When both reference snapshots are raw equity:

`F1/F0 = (S1/S0) × (M1/M0)`.

Report every factor and `(factor − 1) × 100` as Decimal strings. Factors are
multiplicative accounting identities, **not additive percentage-point
contributions, statistical beta, causal effects, or evidence of demand**. Decimal
arithmetic uses 80 significant digits; repeating fractions can leave a tiny
reported reconciliation residual. Do not turn this rounding residual into a
trading opportunity.

Local premium bounds are `local_bid / reference_ask` through
`local_ask / reference_bid`. They describe arithmetic mark uncertainty, not an
executable arbitrage interval. Fees, size, route mechanics, inventory, eligibility,
and time-to-redeem are absent.

Report status:

| Status | Meaning |
| --- | --- |
| `INSUFFICIENT_DATA` | Invalid local identity/timing/price data. Both attribution objects are null. |
| `PARTIAL_REFERENCE` | Local two-factor arithmetic exists; reference factors are unavailable and null. Consult `issues`. |
| `COMPLETE_MARK_ATTRIBUTION` | Both snapshot references passed the supplied-data checks and the three-factor identity is present. This is not independent verification or profitability qualification. |

`mark_quality` is `UNQUALIFIED` when hook, continuity, identity, or source quality
is unverified; otherwise `SUPPLIED_CHECKS_PASSED`. `qualifies_as_signal` is always
false and `executable_proceeds` always null. `input_sha256` fingerprints normalized
JSON for reproducibility; it does not prove origin or authenticity. Source errors
appear in `issues`, and source quality limits in `qualification_issues`.

## Limits and example

`examples/attribution.json` contains synthetic addresses, pool ID, prices, block
hashes, and evidence. Its PoolManager address is illustrative deployment context;
the file is not evidence of a real NVDA market or profitable opportunity. It
illustrates a 30% meme USD mark increase, 20% local quote-token mark increase,
8⅓% relative increase, and a separately changing local premium.

Use this report with retained normalized swap/flow analysis to investigate
participation. Positive relative performance alone does not establish independent
buyers, net capital inflow, sellability, or future returns. Two marks do not
establish interval coverage, complete paths, or executable exit capacity.
