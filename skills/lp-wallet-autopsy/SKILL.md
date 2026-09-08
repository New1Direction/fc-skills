---
name: lp-wallet-autopsy
description: Reconstruct an LP wallet's full performance, including open positions, outside funding, fees versus withdrawn principal, costs and selection bias. Use to investigate LP challenge results and whether another wallet's strategy was realistically followable. No signing or copying trades.
---

# LP Wallet Autopsy

Explain where a wallet's LP results came from and whether a published performance claim survives complete accounting.

Read [the evidence contract](references/evidence.md) before collecting or calculating. It defines the supported scope and exact input schema. Keep data gaps and modeled inputs visible.

## Define the accounting perimeter
Resolve wallets and relationships without equating shared infrastructure with common control. Define chain, interval, opening equity, all accounts/contracts/position NFTs included and valuation unit. Transfer of a position NFT crosses the ownership boundary; track its value and fee obligations.
Require complete mint/increase/decrease/collect, ownership, swap and external transfer histories plus open positions at both endpoints. Matching endpoint liquidity does not prove continuity.

## Build the token-unit ledger
Separate deposited principal, removed principal awaiting collection, newly earned fees, prior owed fees, collected assets, incentives and idle inventory. tokensOwed and collect events can contain withdrawn principal. A transfer from the pool is not automatically income.
Mark open positions, idle balances and fees consistently at the endpoint. Show executable exit evidence separately; a pool spot mark is not cash realizability. Missing values stay unknown.

Whole-account marked P&L = closing equity + external withdrawals - external contributions - opening equity. Equity includes all in-perimeter assets, so fees retained there must not be added again. Gas paid inside that perimeter is already reflected; subtract only documented costs paid outside it, once. Explain asset appreciation versus inventory divergence and compare with holding the starting assets using aligned prices. For intervals with external flows, define any TWR/MWR methodology explicitly; the helper does not calculate return percentages.

## Audit headline results
Define a trade/position episode before calculating win rate. Combine ladder legs and partial exits appropriately; count ties separately and keep open losers visible. Report average win/loss, largest loss, capital employed, duration, drawdown where a complete equity path exists, and unknown outcomes. Never infer a full challenge return from closed-position P&L.
Check additional capital, transfers, token allocations, privileged fees and selective reporting. Referral links are incentives, not proof of fraud.

## Study followability
Retain the wallet decision's first observable time, follower latency, changed liquidity, feasible size, fees and exit. Do not backdate follower entry or copy confidential intent. Scout Network and Autopsy are optional aids where available; this workflow is self-contained.

## Deterministic retained-summary helper

Run from this skill folder with Python 3.10+ and the standard library:

```sh
python3 scripts/analyze.py examples/synthetic.json
python3 -m unittest discover -s tests -v
```

Supply a normalized input using the linked contract for actual research. The helper is offline and cannot authenticate caller assertions. Outputs retain evidence kind, source references and limitations. Full live collection and any stateful replay require verified external adapters. Report exact unit, window, source, coverage, calculation, alternative explanations and the most useful next check.
