---
name: fee-quality-check
description: Analyze concentration, repetition and evidence of connected activity in fee-generating swaps without equating bots with fake volume. Use for LP pool discovery and fee-persistence research. Requires normalized swap and attribution evidence; does not prove intent or predict returns.
---

# Fee Quality Check

Determine how concentrated and repeat-dependent observed fee activity is, and what that implies for confidence in persistence.

Read [the evidence contract](references/evidence.md) before collecting or calculating. It defines the supported scope and exact input schema. Keep data gaps and modeled inputs visible.

## Establish what paid whom
Resolve pool and token identities, interval, log completeness and actual fee allocation. Count each swap once in one comparable notional unit. Distinguish LP income from creator/protocol/hook fees and incentives.
Automated arbitrage can pay real collectible LP fees. Conversely high activity can be subsidized, highly concentrated or adverse-selected. “Organic volume” is not a quantity inferable solely from transaction count.

## Resolve actors conservatively
A router, bundler, exchange deposit address or shared funding service is not necessarily the economic actor. Use attributable evidence with confidence and timestamps; keep unknown actors unknown. Publish cluster-adjusted metrics as sensitivity analyses alongside wallet-level observations. Do not upgrade a weak funding link into proven common ownership.
Record unique transactions and swaps separately. Multi-hop routing can legitimately revisit a token or venue. Round-trip similarity alone does not prove wash trading.

## Measure and explain
Compute observed actor/cluster volume shares, concentration, repeated interactions and documented fee-payment patterns. Report attribution coverage and largest known share as a lower bound when unknown volume exists.
Cross-check concentration with liquidity changes, price paths, adverse inventory change, short-horizon price movement after swaps, fee persistence and subsidy dependence. Unknown reward flows preclude claims about actor profitability.
Compare ordinary users, bots and linked-wallet hypotheses without an opaque quality score. A fee-quality observation is a research flag, not an exclusion policy by itself.

## Validate persistence
Freeze detection criteria and apply to held-out periods. Retain zero-flow and failed-token cases. Compare future fees after competition and inventory costs, not only subsequent volume. Explain competing interpretations.
Handoff to LP Flow Decay for persistence monitoring, Autopsy for ownership evidence and LP Edge for position economics where available. No dependency is required for this skill's own report.

## Deterministic retained-summary helper

Run from this skill folder with Python 3.10+ and the standard library:

```sh
python3 scripts/analyze.py examples/synthetic.json
python3 -m unittest discover -s tests -v
```

Supply a normalized input using the linked contract for actual research. The helper is offline and cannot authenticate caller assertions. Outputs retain evidence kind, source references and limitations. Full live collection and any stateful replay require verified external adapters. Report exact unit, window, source, coverage, calculation, alternative explanations and the most useful next check.
