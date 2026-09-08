---
name: fee-migration-watch
description: Detect observed shifts in swap activity and LP fee generation between pools for the same exact token pair, including fee-tier changes. Use for pool migration research and venue discovery on Robinhood Chain. Requires normalized evidence; does not infer capital migration or execute trades.
---

# Fee Migration Watch

Find where fee-generating flow is moving and whether an LP has a defensible reason to investigate another pool.

Read [the evidence contract](references/evidence.md) before collecting or calculating. It defines the supported scope and exact input schema. Keep data gaps and modeled inputs visible.

## Scope the comparison
Resolve chain and exact token contracts, V3 factory/pool or V4 manager/PoolKey, fee configuration and observation interval. Compare same-pair pools first. Different quote assets require explicit independent common-unit valuations and belong to a separate comparison; a ticker match is insufficient.

Use a stable pool cohort over adjacent windows. State when the cohort or discovery coverage changes. Keep newly discovered pools visible but do not manufacture a prior zero. Report volume per second alongside shares: a rising share can coincide with falling absolute activity.

## Attribute fees correctly
Use per-swap actual fee semantics or authenticated fee growth. Separate gross swap charges, protocol allocation, creator/hook charges, LP allocation and incentives. Dynamic fee displays are not the realized interval rate. Do not deduct protocol allocation twice from already net LP fee growth.
For a proposed position, account for its active liquidity share along the price path. Pool fees divided by headline TVL are not position income.

## Establish the observation
Compare volume share, LP-fee share, absolute rates, time in range and competing liquidity at visited ticks. Raw L is not comparable across pairs, ranges or token scales. Use equal-capital position scenarios or a precisely defined common price band for cross-pool competition.
Classify observed flow shift separately from evidence of capital migration. The latter needs ordered LP remove/add events with defensible wallet attribution; co-occurrence is a hypothesis. Arbitrage, routers and automated market makers can create legitimate activity.

## Deliver a manager brief
Show prior/current windows, pool contributions, source coverage, fee rules and affected position exposures. State whether activity moved, fees moved, capital movement is evidenced, and whether total opportunity shrank. Recommend investigation or further measurement, not an automatic rebalance. Account for withdrawal, conversion, entry and future fee uncertainty before any economic comparison.
Pass exact newly active pools to Ape's ordinary discovery/admission workflow; this report does not grant execution support.

## Deterministic retained-summary helper

Run from this skill folder with Python 3.10+ and the standard library:

```sh
python3 scripts/analyze.py examples/synthetic.json
python3 -m unittest discover -s tests -v
```

Supply a normalized input using the linked contract for actual research. The helper is offline and cannot authenticate caller assertions. Outputs retain evidence kind, source references and limitations. Full live collection and any stateful replay require verified external adapters. Report exact unit, window, source, coverage, calculation, alternative explanations and the most useful next check.
