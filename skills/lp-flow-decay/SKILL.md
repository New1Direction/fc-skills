---
name: lp-flow-decay
description: Measure deterioration in fee-generating flow against a pool or LP position's own prior windows. Use for LP monitoring, shrinking fee opportunity and out-of-range diagnosis. Separates evidence-based changes from uncalibrated exit rules; no trade execution.
---

# LP Flow Decay

Determine whether observed fee generation is fading, what explains it, and what information a manager needs before adjusting a position.

Read [the evidence contract](references/evidence.md) before collecting or calculating. It defines the supported scope and exact input schema. Keep data gaps and modeled inputs visible.

## Select an honest baseline
Specify pool, position if any, observation time and horizon. Use adjacent non-overlapping windows and also inspect longer same-session baselines. Separate newly launched, ordinary-session, overnight and market-closed regimes. Freeze baseline and alert thresholds before evaluating outcomes.
Normalize by duration; do not compare a partial current five minutes with a complete earlier interval. Missing collection is not zero volume.

## Diagnose the decline
Compare absolute allocated LP-fee rate, volume rate, actual fee changes, active liquidity competition, time in range and price/inventory changes. Distinguish:
- pool-wide activity decline;
- a position leaving range while pool flow continues;
- fee dilution from competing LPs;
- a fee-tier or route shift;
- price/quote-asset valuation effects;
- a data gap.
Bots are not automatically non-paying flow. A falling ratio caused by increased liquidity differs from vanishing volume.

## Turn a finding into a decision input
Show rates over explicitly named windows and persistence, not an invented probability of reversal. No universal half-life or threshold is assumed. Use user-selected policies or report threshold sensitivity. An alert requests review, not an unqualified sell.
Compare the uncertain fee benefit of staying against alternative deployment and all switching costs. Model inventory separately; do not subtract impermanent loss and adverse-selection measures twice.
For backtesting alerts, preserve detection/availability times, rejected cases, cooldowns and future outcomes. Use held-out periods and same-budget alternatives. Keep live trading unaffected.

## Deliver
Provide a concise status, why the metric changed, current inventory/range state, known costs, gaps, and a bounded next observation. Show normalized pool-level and position-level metrics separately.

## Deterministic retained-summary helper

Run from this skill folder with Python 3.10+ and the standard library:

```sh
python3 scripts/analyze.py examples/synthetic.json
python3 -m unittest discover -s tests -v
```

Supply a normalized input using the linked contract for actual research. The helper is offline and cannot authenticate caller assertions. Outputs retain evidence kind, source references and limitations. Full live collection and any stateful replay require verified external adapters. Report exact unit, window, source, coverage, calculation, alternative explanations and the most useful next check.
