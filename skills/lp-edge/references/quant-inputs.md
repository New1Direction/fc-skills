# Quant inputs and interpretation

## Contents

- Native evidence bridge
- Normalized position interval
- Costs and fee hurdle
- Fixed range scenarios
- Arithmetic sources

Python 3 standard library only. All monetary amounts, liquidity, square-root prices, fee-growth counters, and NFT IDs are canonical unsigned decimal **strings** in raw token units. Ticks, decimals, block numbers, and Unix UTC seconds are JSON integers. Floats, nonfinite values, duplicate JSON keys, inputs above 5 MB, and overwriting reports are rejected by the normalized analyzers. Native evidence accepts the collector's larger bounded format. Outputs serialize exact rational marks as `{numerator: "…", denominator: "…"}`. Divide raw quote values by `10**decimals[quote_token]` for display. Never replace null with zero.

Native scope is canonical Uniswap V3 with standard tokens, independently established contract identities, unchanged token units, and normal uint128 accounting. V4 hooks/dynamic fees, token taxes/rebases, liquidity mining claims, NFT wrappers, migrations, and strategy vault shares require other verified adapters.

## Native evidence bridge

```
python3 scripts/analyze_evidence.py CASE/evidence.json --output CASE/accounting.json
python3 scripts/analyze_evidence.py CASE/evidence.json --assumptions CASE/assumptions.json --output CASE/accounting-qualified.json
```

The bridge calls `collect_v3.verify_evidence`, rederives retained RPC results, and uses those snapshots directly. Requires one or two snapshots collected with a position-manager NFT `token_id`. One snapshot reports principal, stored debt, pending fee accrual, and the adapter's wallet simulations. Two snapshots additionally attempt interval accounting. Any IncreaseLiquidity, DecreaseLiquidity, Collect, or NFT Transfer in the retained interval prevents unchanged-position interval analysis. Split such histories at transaction-level checkpoints through a verified external replay.

Successful transcript reconciliation proves internal consistency. It does not authenticate provider honesty, deployment trust, or complete event history. No-event RPC results **do not** certify continuity. The default interval leaves earned fees and net results null. Fees can be qualified only after independent completeness and counter-bound review; a certificate must not contradict retained events or unavailable native log coverage.

Optional assumptions:

```
{"schema":"lp-edge.evidence-assumptions.v1","quote_token":1,
 "continuity":{"complete":true,"from_block":101,"to_block":200,
  "events":[],"evidence_ids":["case:independent-history-and-counter-review"],
  "fee_growth_wrap_bound_confirmed":true},
 "costs":null,"incentives":null}
```

`quote_token` defaults to 1 without this file. Continuity covers **start block + 1 through end block, inclusive**, because state snapshots are post-block. Review retained event completeness for NFT IncreaseLiquidity, DecreaseLiquidity, Collect, and Transfer; stable endpoints cannot exclude an intervening change and reversal. `fee_growth_wrap_bound_confirmed` affirms accumulated inside growth has advanced by less than `2**256` since each unchanged NFT checkpoint, so endpoint modular arithmetic is unambiguous. It is an evidence-backed economic/coverage assumption, not established by a Boolean alone. Supply actual retained references. No private keys or trade authorization belong in this file.

## Normalized position interval

```
python3 scripts/analyze_position.py assets/synthetic-position.json --output CASE/position.json
python3 scripts/analyze_position.py assets/synthetic-position-missing-costs.json --output CASE/missing-costs.json
```

Schema `lp-edge.position-input.v1`:

- `source_kind`: `observed`, `synthetic`, or `unknown`; unknown suppresses qualified interval fees/net results. Sources are declared, not authenticated by this helper.
- `provenance`: 1–100 retained evidence reference strings.
- `identity`: `{chain_id,pool,token0,token1,decimals0,decimals1,quote_token}`. Chain/address strings compare literally; upstream canonicalization required. Native bridge uses `eip155:N` and lower-case EVM addresses. Quote token is integer 0 or 1; it is never presumed USD.
- `snapshots`: exactly two objects in collector snapshot shape, **plus `chain_id` on each**. Each needs `block:{number,hash,timestamp}`, pool, range, and NFT position below.
- `continuity`: as above; incomplete coverage leaves snapshot accounting available, interval fees/net null. Positive fixed NFT liquidity, owner, checkpoints, stored debt, ticks, token identity, factory, and fee settings must match between snapshots.
- `costs`: null or the cost object below.
- `incentives`: null or separate items `{token_id,amount_raw,evidence_ids,net_realizable_quote_raw?,quote_token?,realization_evidence_ids?}`. Optional realizable quote needs matching quote token and actual retained realization evidence. Incentives are displayed separately and excluded from all main LP/fee/net metrics; a reward's face amount is not assumed liquid value.

Required pool fields:
`address,factory,token0,token1,fee,tick_spacing,sqrt_price_x96,tick,liquidity,fee_growth_global0_x128,fee_growth_global1_x128`.

Required range fields:
`tick_lower,tick_upper,lower,upper`; each boundary has `liquidity_gross,fee_growth_outside0_x128,fee_growth_outside1_x128,initialized`. Continuous positive NFT liquidity requires both boundaries initialized and gross liquidity at least the NFT's liquidity. Active pool liquidity must also cover it.

Required NFT fields:
`token_id,owner,token0,token1,fee,tick_lower,tick_upper,liquidity,fee_growth_inside0_last_x128,fee_growth_inside1_last_x128,tokens_owed0,tokens_owed1`.

For each token, inside growth follows canonical below/above-tick modular subtraction. Pending accrual equals `floor(liquidity * ((insideNow - insideLast) mod 2**256) / 2**128)`. With unchanged checkpoints and no position interactions, interval earned fees equal **pending(end) − pending(start)**. This preserves fractional carry from before the start; simply flooring liquidity times interval growth can differ by one raw unit. More general checkpoint/collect histories require replay. Accrual or total debt above uint128 is rejected, not silently wrapped.

`tokensOwed` is stored debt and may contain principal from an earlier decrease. It is **not** all earned fees. Principal uses burn-style round-down amounts. The hold comparator retains the same starting withdrawable token amounts; starting stored debt and pending pre-interval fees are excluded symmetrically. Endpoint valuation separates principal inventory changes, earned fees, and the price change of the starting token basket. It does not infer attribution to meme demand versus stock/quote-asset USD repricing.

## Costs and fee hurdle

`costs` is null or:

```
{"complete":true,"quote_token":1,"evidence_ids":["case:cost-model"],
 "entry":"1000000","rebalance":"0","collect":"200000",
 "withdrawal":"300000","conversion":"500000"}
```

All five categories are LP **incremental costs relative to holding** for the comparison horizon: entry (gas and any acquisition costs), rebalancing, collecting, withdrawal, and eventual conversion (gas, trading fees, price impact and slippage where applicable). Avoid double-counting. An explicit zero means supported absence; missing category/null/incomplete means unknown total. Evidence should identify executed, simulated, or modeled costs and their price/time basis; these inputs do not establish execution.

Net marked LP value = ending principal + earned or scenario fees − complete incremental costs. Fee hurdle to match hold = `max(0, hold_end − LP_principal_end + complete_costs)`. The hurdle is null when costs are incomplete. Exact equality matches hold; strictly more fees are required to beat it. Costs/fees are valued in the chosen token; no external price oracle or stablecoin peg is invented.

Pool fee-growth counters already represent LP fee accounting after canonical protocol deductions. Do not subtract an advertised protocol fraction again from measured fee growth. Other fee models are unsupported. Pool marginal spot marks **are not** executable sale proceeds, fair-value oracles, wallet balance deltas, or a positive-return forecast.

## Fixed range scenarios

```
python3 scripts/analyze_ranges.py assets/synthetic-ranges.json --output CASE/ranges.json
```

Schema `lp-edge.ranges-input.v1`:

- `source_kind,provenance,identity` as above; a source label describes the input, not independently verified truth.
- `tick_spacing`: positive integer; every range boundary must align.
- `predeclared_at`: declaration Unix seconds, no later than first sample; `declaration_evidence_ids` retain the actual declaration. The helper validates chronology only. Do not fabricate historical declaration times. Historical ranges selected after viewing the outcomes remain retrospective exploration; they cannot establish a predeclared strategy result.
- `knowledge_cutoff`: Unix seconds; every feature availability must be at or before this cutoff.
- `samples`: 2–10,000 increasing `{timestamp,available_at,sqrt_price_x96,tick,evidence_ids}` points. Availability must be no earlier than event time. Retain source, exact pool, token metadata, coverage and migration checks upstream. Tick follows actual `slot0`, including its exact-boundary downward-crossing convention.
- `ranges`: 1–50 `{id,tick_lower,tick_upper,liquidity,costs,scenario_fees}` objects. Fixed positive liquidity; ranges can require different capital. No budget optimization or automatic profitability ranking.
- `scenario_fees`: null or `{source_kind,amount0_raw,amount1_raw,basis,evidence_ids,assumptions}`. These are explicitly supplied position-and-horizon fee scenarios. Unknown source leaves modeled fees/net null. Never substitute daily volume times nominal fee times TVL share; that omits active liquidity competition, tick crossings, and position feedback.
- Optional `stress_prices`: up to 50 distinct `{id,sqrt_price_x96}` terminal prices. Stress reports inventory/hold/hurdle only; no invented path, elapsed time, or fees.

Entry amounts round **up**, matching the required mint token budget; terminal principal rounds **down**, matching decrease accounting. Hold starts with the same entry budget. Raw rounding costs remain in the comparator. Returned active sample counts/fractions are sampled occupancy, **not time in range**. Exact time in range stays null; a maximum sample gap exposes sparse coverage. Neither endpoints nor candles reconstruct fee growth for hypothetical uninitialized ticks. No historical fee replay, reinvestment, rebalance execution, or pool-capacity feedback is claimed.

These three normalized fixtures are synthetic. `synthetic-position.json` has positive earned fees and a price move beyond the range that still underperforms holding. The missing-cost version demonstrates null net results. `synthetic-ranges.json` includes a supplied positive fee scenario and a second range with unknown fees. They demonstrate accounting, not market performance. The separately bundled published-position37 case has its own evidence limitations in the validation reference.

## Arithmetic sources

- [Uniswap V3 TickMath](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol): integer tick conversion constants/rounding; `lp_math.py` adaptation retains GPL-2.0-or-later attribution.
- [SqrtPriceMath](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SqrtPriceMath.sol): liquidity amount rounding.
- [Tick](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/Tick.sol): modular inside fee-growth accounting.
- [NonfungiblePositionManager](https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol): NFT checkpoints, collection, and stored principal/fee debt.

Run `python3 scripts/test_quant.py` for exact arithmetic, rounding, boundary, missing-evidence, provenance, and schema failure cases. Additional bridge checks use the adapter's offline fixture; retained public historical-case reconciliation is a separate evidence level from live RPC/fork execution.
