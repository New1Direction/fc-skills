---
name: lp-edge
description: Evaluate concentrated-liquidity positions through fee accounting, inventory changes, performance versus holding, range scenarios, operating costs, and wallet-call evidence. Use for LP profitability research, Uniswap V3 position analysis, liquidity-range comparisons, and fee-versus-inventory-risk decisions. Native tooling targets canonical Uniswap V3 EVM pools; V4 hooks and other implementations require verified external adapters. Does not sign or submit transactions.
---

# LP Edge

Answer whether a specific pool, range, and position size earns enough in collectible fees to compensate for its inventory exposure and operating costs. Lead with the supported conclusion, its horizon, and the most consequential missing evidence. Treat insufficient evidence and fees failing to cover costs as useful outcomes.

## Choose the analysis

- **Existing position:** Read [references/adapter.md](references/adapter.md), collect a pinned snapshot where RPC access permits, and account for principal, newly accrued fees, and stored owed balances separately. Read [references/quant-inputs.md](references/quant-inputs.md) for calculations and normalized inputs.
- **Historical position interval:** Retain starting and ending snapshots plus complete position-event coverage. Compare against holding the same starting assets. Do not infer an unchanged position from matching endpoint liquidity alone.
- **Proposed range or size:** Freeze ranges, size, horizon, costs, and decision-time information before comparing outcomes. Use the range helper for inventory scenarios and sampled price history. Supply fee assumptions explicitly; it does not reconstruct hypothetical fills or fees from candles.
- **V4, Robinhood Chain deployments, taxed/rebasing tokens, or other venues:** Follow [references/research-method.md](references/research-method.md). Verify the actual implementation, contracts, token mechanics, hook and fee rules, and wallet access before adapting. Never substitute a V3 calculation for V4 execution evidence.

## Establish the case

Resolve chain ID, pool address, token order and decimals, implementation, fee configuration, position ID or proposed ticks, capital, quote asset, horizon, and permitted actions from available context. Ask only for an essential missing identifier or material choice after doing available useful work.

Retain block numbers and hashes, event order, observation time, data availability time, provider identity, raw responses, and coverage. Authenticate deployment identities from primary sources. A configured bytecode fingerprint binds the inspected code; a matching fingerprint supplied by the same untrusted collector does not independently establish canonical behavior. Keep synthetic examples, published illustrative observations, live RPC observations, simulations, and executed results distinct.

Use the bundled scripts from this skill directory and new case output paths. Run each script's `--help` and read the applicable reference for exact inputs. Do not fabricate chain fields to force an incomplete source into a complete schema.

```bash
python3 scripts/collect_v3.py --config request.json --rpc-env LP_EDGE_RPC_URL --out evidence.json
python3 scripts/collect_v3.py --verify evidence.json
python3 scripts/analyze_evidence.py evidence.json --output accounting.json
python3 scripts/analyze_position.py interval-input.json --output interval-report.json
python3 scripts/analyze_ranges.py range-input.json --output range-report.json
```

Use the evidence bridge for one or two collected NFT snapshots. It keeps interval continuity unqualified by default; read the quant reference before adding independent continuity evidence or cost assumptions. The published example check is `python3 scripts/check_published_case.py --output published-check.json`.

## Make the economic comparison

Read [references/research-method.md](references/research-method.md) for fee attribution, external valuations, adverse selection, and fair range comparison.

1. Separate deposited principal, remaining principal, removed but uncollected principal, newly earned fees, prior owed balances, and incentives. `tokensOwed` may include removed principal. A collect return is not automatically trading-fee income.
2. Compare terminal LP assets with the same starting token quantities held outside the pool, valued using the same endpoint prices and unit. Report inventory divergence separately from fees and costs. Pool spot valuation is a mark, not executable liquidation value.
3. Include entry conversion and approvals where applicable, mint, rebalancing swaps and gas, collection, withdrawal, and final conversion costs. Preserve each cost's basis, timestamp, denomination, and completeness. Missing costs mean net return is unknown. Make the hold comparator's cost convention explicit.
4. Show the fee hurdle needed to beat holding and explicit adverse-price, lower-fee, higher-cost, and out-of-range scenarios. Do not count annualized historical fees as a forecast or an established edge.
5. For stock-token/memecoin pairs, report token quantities and returns in the selected quote asset. Report USD returns only with timestamp-aligned independent USD valuations. Inspect trading-hour, redemption, transfer, and issuer constraints for the actual stock token.

## Verify practical access

Inspect the actual sender's token balances and allowances, NFT ownership or operator authority, pool state, token restrictions, and recipient. Distinguish a quote, successful `eth_call`, atomic stateful fork simulation, measured wallet balance deltas, and executed receipt. Separate call success from gas estimation and complete transaction cost. Standalone calls do not simulate sequential state changes.

Use native read-only checks when supported, otherwise report the exact unavailable check. Preserve reverts and unmet prerequisites. Do not treat an arbitrary impersonated address as the user's wallet. This skill supplies research; it never signs or broadcasts transactions or grants approvals.

## Present a decision brief

Use a compact table when comparing positions or ranges. Include:

- Exact pool, chain, range, capital or liquidity units, horizon, source basis, and as-of block.
- Principal and earned fees in each token; classification of stored owed balances.
- LP versus holding before and after known costs; fee hurdle and missing costs.
- Range exposure and sampling resolution; inventory concentration and scenario sensitivity.
- Wallet checks completed, failures, and what the evidence establishes.
- A bounded next action: collect missing evidence, reject on stated economics, or investigate a specific candidate further.

Do not rank incomplete cases above complete ones by filling unknowns with zeros. Label thresholds and fee forecasts as user assumptions or uncalibrated research choices. A positive historical interval or modeled scenario does not establish future profitability.

Optionally use available Ignition or Second Wind discovery, Autopsy supply findings, and Exit Doctor liquidation analysis within those skills' supported venues. None is required to run LP Edge. See [references/validation.md](references/validation.md) for precisely what this version has been checked against.
