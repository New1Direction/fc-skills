# Accounting and limits

For each complete snapshot, NAV = reporting-currency cash + sum(position quantity × mark) − sum(liability values). Open inventory, debt and accrued costs belong in NAV. External contributions are not income. The input must already include all transaction costs and failed-transaction gas in cash/positions/liabilities; the separately reported attempt fee total is explanatory and never deducted twice.

For the declared interval `(start,end]`:

`net external flow = deposits − withdrawals`

`cashflow-adjusted absolute PnL = closing NAV − opening NAV − net external flow`

This includes changes in marked open inventory. It is not realized trading profit; realized/unrealized decomposition requires a complete cost-basis ledger and is explicitly unavailable natively.

Exact time-weighted return links market subperiods between external flows. At each flow, before/after snapshots must isolate exactly the transfer amount. For adjacent snapshots outside a flow transition, multiply the growth index by `NAV_next / NAV_previous`. Across the verified funding transition, leave the growth index unchanged. Return = final growth index − 1. Negative equity or a zero denominator makes this method unavailable. A terminal zero NAV can represent a 100% loss; a zero intermediate NAV followed by recapitalization cannot be linked by this implementation.

Observed drawdown at a retained snapshot = `1 − growth_index / highest_prior_growth_index`. The maximum of those observations is a snapshot-observed drawdown, not a continuously measured drawdown. Sparse sampling can miss losses and peaks. Missing brackets or invalid intermediate marks withhold this drawdown and TWR; valid boundary valuations and complete funding can still support absolute PnL.

The GIPS Standards Handbook explains external-flow valuations and geometric linking for time-weighted returns. This helper applies the documented exact-bracketing formula; it does not claim GIPS compliance, independent assurance or fund-level reporting certification. Source checked 2026-09-08: [CFA Institute / GIPS, Handbook for Asset Owners](https://www.gipsstandards.org/standards/gips-standards-for-asset-owners/gips-standards-handbook-for-asset-owners/).

The synthetic fixture begins at 1,000, receives 1,000, withdraws 400 and ends at 1,582. PnL is **−18**, despite a 582 increase in raw NAV. Three units of failed/successful attempt fees are already in cash; subtracting them again would incorrectly produce −21. Its observed fractional drawdown is about 0.01198999 and exact TWR about −0.00948553. These are synthetic mechanics checks, not live strategy results.

Compare reports only after aligning exact scope boundaries, currency, fee convention, valuation semantics, complete external flows and snapshot sampling. Different wallet scope can change results. No native leaderboard ranking, annualization, Sharpe calculation or assertion of statistical significance is made. A wallet's profit cannot be assigned causally to a linked agent merely because decisions were retained.
