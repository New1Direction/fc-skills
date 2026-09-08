# Night Desk evidence contract

`scripts/night_desk.py` exports `analyze(input) -> report`. Monetary values are bounded unsigned decimal strings; raw token quantities are uint256 integer strings. Output decimal strings are exact finite calculations where possible; division uses a 400-digit Decimal context. Negative net exit proceeds can result when costs exceed output. Times require explicit time zones.

The complete executable fixture is [example-input.json](../assets/example-input.json). It is synthetic, with arbitrary addresses and a frozen cutoff, and is not evidence about any mainnet asset.

## Envelope

`schema: NightDeskInput@1`, `as_of`, `asset: {chain_id:4663,token,symbol,decimals:18}`. Optional `position: {wallet,amount_raw,route_id}` must describe a strictly positive amount. Omit it for a reference-only view. All supplied evidence must have been observed by `as_of`; no fetching current data to fill past unknowns.

Optional `policy` fields are integer seconds from 1 through 86400: `reference_max_age_seconds` (default60), `onchain_max_age_seconds` (30), `execution_max_age_seconds` (15), `max_evidence_skew_seconds` (30). These are explicit freshness policies, not promises of exchange freshness or profitability.

Evidence components can be omitted independently. A malformed component produces `INVALID` with a reason; absent evidence produces `MISSING`, never zero. Invalid envelope, position or policy rejects the input.

## Common evidence

Every priced component identifies `chain_id` and exact `token`. `source` is a retained source identifier or URL, `source_at` is the source's reported observation/update/generation time, and `observed_at` is when the collector retained it. The helper checks source time ≤ observed time ≤ cutoff. These remain supplied assertions unless backed by retained raw data.

Block-based evidence also carries `block_number`, `block_hash`, `block_timestamp`, `canonical:true`. Its block age is checked independently of recent fetch time. `canonical` is a caller assertion; subscribe to reorg invalidation from the canonical store before publishing a current view. Block timestamps cannot be after retention time.

## Reference

`reference` carries common identity/timing, `bid`, `ask`, `currency:USD`, `halted` (boolean), `market_state:OPEN|CLOSED|UNKNOWN`, and `time_basis:SERVER_GENERATED|MARKET_OBSERVATION|ORACLE_UPDATED`.

- `basis:RAW_EQUITY_USD` means USD per underlying share. `multiplier` requires common identity/timing, a decimal shares-per-whole-raw-token `value`, and `basis:CURRENT_REST_METADATA|BLOCK_STATE`. The latter additionally carries block fields. `pending:{value,effective_at}` is optional; a pending change effective at or before the cutoff invalidates adjustment until reconciled. Price and multiplier source times must fit the skew policy. Stale or misaligned multiplier evidence invalidates adjusted reference calculation.
- `basis:ADJUSTED_TOKEN_USD` means USD per whole raw token, already adjusted. Carry block fields, `time_basis:ORACLE_UPDATED` and `oracle_status:HEALTHY|UNKNOWN|PAUSED`. Do not include any multiplier field. The helper has no native oracle reader or independent oracle/sequencer health verification.

Raw quantity `amount_raw / 10^18` multiplied by adjusted USD price is position reference value. Raw equity price is multiplied by the decimal multiplier once. The adjusted oracle basis is never multiplied again. Neither midpoint nor bid establishes onchain liquidation or issuer redemption value.

## Onchain mark

`onchain` carries common identity/timing and block fields, `unit:USD_PER_RAW_TOKEN` (one whole raw ERC-20 token), `price_usd_per_token`, `venue_id`, and `usd_conversion_basis:DIRECT_USD|RETAINED_FX`.

For `RETAINED_FX`, supply `fx` with the exact quote-token chain/address, source times and `usd_per_token`. The input adapter supplies the normalized USD mark; Night Desk checks finite amounts and freshness but does not reproduce that adapter's venue pricing or verify FX authenticity. Preserve the raw venue-price evidence in the caller's store. `DIRECT_USD` is an explicit assertion of a genuinely USD-denominated mark, not a stablecoin peg default.

The report gives mark value and percentage premiums versus reference bid, ask and midpoint. Misaligned times withhold premiums. Stale or closed reference comparisons remain clearly indicative; a premium is not net arbitrage profit.

## Retained exit evidence

`execution` carries common exact stock identity, timing and block fields plus:

| Field | Meaning |
|---|---|
| `wallet`, `amount_in_raw`, `route_id` | Must exactly match the requested position; supplied onchain mark must also match block number/hash |
| `kind` | `QUOTE` or `WALLET_CALL_SIMULATION` |
| `expires_at` | Explicit last validity time asserted by evidence adapter |
| `success`, `call_evidence_id` | Required for successful simulation; unsuccessful simulation returns no exit amount |
| `output_semantics` | Must be `NET_OF_ROUTE_FEES`; output already incorporates venue/hook/transfer deductions asserted by the adapter |
| `output` | Exact output `chain_id,token,decimals,amount_raw`; decimals 0–36 |
| `output_fx` | Exact output identity, common timing, `usd_per_token`; no stablecoin peg fallback |
| `additional_costs_usd` | `gas,approval,other` decimal USD amounts, plus source/timing. Explicit zero allowed; missing cost gives no net exit value |

Net retained exit USD = output whole-token amount × retained USD rate − additional costs. Count gas/approval costs here only when not already deducted in output. The adapter must document the cost boundary. Costs and FX are retained estimates, not newly fetched independent execution verification. Expired or stale exits preserve `historical_net_exit_usd` but withhold current `net_exit_usd`.

An adapter can import exact wallet-call evidence from HOOK LAB or the application's quote service after validating its schema, route identity and accounting boundary. This skill has no generic adapter that makes arbitrary quotes or unsupported hooks executable. It does not verify balances, allowances or signatures, simulate calldata, sign or submit a transaction.

## Report and composition

`NightDeskReport@1` always carries `asset.chain_id`, `asset.token`, `as_of`, `input_sha256`, `synthetic`, separate `reference`, `onchain`, `execution`, and `policy`. `status:RETAINED_EVIDENCE` means all three components were structurally analyzed; it does not mean fresh, profitable or executable. Examine each component's state. Any missing/invalid component makes the envelope `PARTIAL`.

FYNCH may join by exact address and frozen cutoff with CATALYST and WATCHTOWER evidence. Do not join by symbol alone. Neither source hashes nor a signed report prove authenticity or strategy quality. Keep this valuation worker outside the transaction-capture hot path.
