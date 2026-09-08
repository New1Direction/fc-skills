---
name: range-replay
description: Design and validate fair historical comparisons of concentrated, laddered and wider LP allocations at equal capital with point-in-time rules and realistic costs. Use for LP strategy research and FYNCH Labs. Native helper audits supplied replay results; complete V3/V4 swap replay requires a verified adapter.
---

# Range Replay

Compare LP range policies without hindsight, hidden capital differences or invented fee income.

Read [the evidence contract](references/evidence.md) before collecting or calculating. It defines the supported scope and exact input schema. Keep data gaps and modeled inputs visible.

## Freeze the experiment before outcomes
Specify exact pool contracts, tokens, quote unit, entry observation time, decision availability cutoff, ticks, total starting budget, idle-asset handling, horizon and allowed rebalance actions. Translate Spot/Bid Ask/Curve UI labels into explicit ranges and capital weights; names are not mathematical policies.
Keep candidate policies and train/validation/holdout intervals fixed. Include market closures and quote-asset moves for stock pairs. Compare equal total capital including idle tokens, approvals and entry conversion. Equal raw L is not equal capital.

## Choose and label the evidence level
1. Inventory scenario: endpoint quantities under a price scenario; fees are assumptions.
2. Marginal unchanged-path fee estimate: hypothetical liquidity is small and the observed path is held fixed.
3. Stateful counterfactual replay: ordered swaps, tick/bitmap state, liquidity changes, exact fee/hook rules and changed pool state are simulated.
Only level 3 supports a claim of full replay, and even it cannot assume other traders would submit unchanged future orders after a large policy change. State this behavioral limitation.
Candles cannot reconstruct exact tick crossings, intrablock ordering, dynamic fees or earned position fees. Do not upscale a marginal estimate into large-capital capacity.

## Compare execution-aware outcomes
Require correct token order/decimals and integer contract rounding. Account for LP/protocol/hook fee allocation, entry/exit swaps, slippage, approvals, gas, failed actions, rebalances, transferred NFTs and idle capital. Use the same fee and valuation conventions for hold and LP.
Show terminal equity, LP-versus-hold, fees, inventory divergence, costs, range exposure, capital concentration, capacity and observed worst path drawdown when the trace supports it. Do not rank missing-cost results as net winners.
Check no-fee scenarios, boundary crossings, monotone crashes/rallies, sideways periods, fee changes, competition, liquidity withdrawal and adverse exit size.
Use LP Edge math only for verified supported implementations. V4 needs exact PoolKey, hook and execution context; no silent V3 substitution.

## Deliver
Present a comparison table with evidence level and excluded cases, not a single “optimal” range. Demonstrate sensitivity to assumptions and holdout results. A winning past range is not a live trade instruction.

## Deterministic retained-summary helper

Run from this skill folder with Python 3.10+ and the standard library:

```sh
python3 scripts/analyze.py examples/synthetic.json
python3 -m unittest discover -s tests -v
```

Supply a normalized input using the linked contract for actual research. The helper is offline and cannot authenticate caller assertions. Outputs retain evidence kind, source references and limitations. Full live collection and any stateful replay require verified external adapters. Report exact unit, window, source, coverage, calculation, alternative explanations and the most useful next check.
