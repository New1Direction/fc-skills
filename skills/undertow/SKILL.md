---
name: undertow
description: Explain Robinhood Chain stock-paired memecoin returns, investigate observed capital rotation and participation, and map shared quote-token liquidity relationships. Use for separating meme-relative performance from stock-token moves, local premiums, and corporate-action effects on chain 4663. Includes bounded read-only V4 evidence collection and current stock-reference capture; wallet-flow analysis requires retained attributed observations. Produces research, never signs or submits trades.
---

# Undertow

Investigate the relationship between a meme, its stock-token quote asset, and the wider pool family on Robinhood Chain (chain ID **4663**). Explain what moved, what was actually observed, and what remains unmeasured. Start with a verified NVDA pool family and USDG comparisons when the user has not selected another stock ecosystem.

## Choose the task

- **Explain returns:** Read [attribution-schema.md](references/attribution-schema.md). Use `scripts/attribution.py` to separate the meme/quote factor, local quote premium factor, and adjusted stock-reference factor. Missing stock-reference evidence can leave a valid two-factor local decomposition; missing local prices cannot.
- **Investigate participation or rotation:** Read [flow-schema.md](references/flow-schema.md). Use `scripts/flows.py` to aggregate supplied wallet-attributed swaps, cancel intermediate route churn, compare observed cohorts when coverage permits, and map shared quote relationships.
- **Collect or check raw V4 evidence:** Read [v4-evidence.md](references/v4-evidence.md). Use `scripts/v4_evidence.py` with an explicit pool/manager trust manifest. Retain raw responses, verify receipt inclusion and block identities, and recheck canonical hashes. A coherent transcript remains provider evidence, not a cryptographic proof of complete chain history.
- **Capture current stock references:** Read [stock-reference.md](references/stock-reference.md). Use `scripts/stock_reference.py`; captured REST data is a candidate requiring block-specific reconciliation before historical attribution.
- **Use FYNCH observations or hand off research:** Read [integration.md](references/integration.md). Preserve the actual export schema, source identity, coverage, and mapping. Do not invent FYNCH endpoints or describe a supplied export as a live integration.
- **Produce a combined report:** Use `scripts/research.py` after preparing the documented inputs. It retains input hashes, component qualification, and the actual run time. Read [reporting.md](references/reporting.md) for interpretation and [validation.md](references/validation.md) for verified scope.

## Run the included examples

Run from this skill directory; example addresses and values are synthetic.

```sh
python3 scripts/attribution.py --input examples/attribution.json --output /tmp/undertow-attribution.json
python3 scripts/flows.py --input examples/flows.json --output /tmp/undertow-flows.json
python3 scripts/research.py --attribution examples/attribution.json --flows examples/flows.json --out /tmp/undertow-report.json --markdown /tmp/undertow-report.md
python3 -m unittest discover -s scripts -p 'test_*.py'
```

Use the user's requested durable output location for actual reports. Temporary paths above are demonstrations only. Present findings in ordinary language with links to the relevant transactions, blocks, and source artifacts.

## Apply the accounting correctly

Write the identity before drawing conclusions:

`meme USD mark = quote units per meme × local USD mark per quote token`

With a valid stock reference:

`meme USD mark = meme/quote × (local quote USD / adjusted reference USD) × adjusted reference USD`

Calculate multiplicative factors. A meme rising 30% in USD while its quote rises 20% gained approximately 8.33% against that quote. Do not subtract percentage returns or label the residual alpha. Its cause still requires transaction evidence. A quote-asset shock with a frozen meme/quote ratio is a conditional arithmetic scenario, not an estimated causal exposure.

Resolve tokens by chain and contract, not ticker. Keep human units, raw ERC-20 units, stock shares, and USD/USDG distinct. Use Decimal or integer arithmetic. Robinhood REST equity prices require the point-in-time shares-per-token multiplier; already-adjusted oracle values must not be multiplied again. Require aligned observation times and evidence available by the analysis cutoff. A later import can support retrospective research but cannot prove the signal was observable then. Preserve halts, closed sessions, advisory oracle pauses, and missing reference timestamps as limitations; do not carry a stale stock close forward as a fresh executable price.

## Respect the V4 evidence boundary

Identify a pool by chain, PoolManager, and pool ID with its complete PoolKey. Check currency ordering, token decimals, fee configuration, tick spacing, and hook identity against source evidence. Standard V2 reserve formulas and V3 position adapters do not establish V4 support.

Treat a V4 Swap event's sender as its immediate caller. It may be a router, smart account, bundler, or intermediary. Count a wallet only when transaction/receipt/trace or account-specific evidence actually supports attribution. `tx.from` alone does not establish a beneficiary or human. Pool swap deltas are not complete wallet balance changes, especially with hooks, taxes, transfer fees, or separate transfers.

Use pool state ratios as marks only. Unknown hooks can change execution and accounting; retain their events but withhold unsupported flow/execution conclusions. PoolManager's ERC-20 balance belongs to the singleton and cannot be assigned to one pool. A shared quote token establishes a structural relationship, not covariance, redeemable backing, or a guaranteed contagion path.

## Separate observation from inference

Aggregate same-wallet, same-transaction asset deltas before interpreting routed turnover as directional participation. Retain unknown attribution and suspected activity counts. Transfers are not swaps, pool inflows are not fresh chain capital, and liquidity adds are not buys. Repeated wallet activity does not identify independent people.

An ordered sell followed by a buy from the same attributed wallet can support a rotation hypothesis. It does not prove that the exact sale proceeds funded the buy. Compare amounts only with explicit compatible units and scoped valuation evidence. Never count the same proceeds across several candidate rotations.

A wallet is newly observed only within a stated covered history. Incomplete baseline data cannot establish a new buyer. Keep the full supplied candidate universe, including missing prices, unsupported pools, inactive candidates, and rejected observations. Describe ordering as an observed metric comparison; no threshold or score in this skill establishes predictive edge.

## Finish with a decision-useful result

Lead with the strongest supported finding and its coverage. Report relative performance, quote movement, local premium when available, observed net participation, shared quote relationships, and the conditions that could change the conclusion. Distinguish measured quantities, supplied attestations, hypotheses, and unknowns. Supply enough source identity for someone else to reproduce the calculation.

For a prospective idea, state the proposed observation rule, rejection conditions, execution evidence still needed, and how all outcomes will be retained. Actual fills and complete costs are required to claim realized profitability. Use Ignition's journal if available; do not describe this skill as a backtester or continuously running monitor. Pass exact supported route candidates to Arbitrage Ape or a verified V4 quote adapter; do not route V4 analysis through Exit Doctor's V2 or LP Edge's V3 code.
