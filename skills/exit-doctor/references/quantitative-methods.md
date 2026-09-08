# Quantitative methods

## Scope and units

Use a standard constant-product pool, one input token X, one output token Y, and the canonical V2 30-bps swap fee. Let x and y be pre-trade reserves in raw units and q be the raw X input. This model assumes ordinary transfer semantics, actual input reaching the pair, and no hook, extra tax, rebase, or external settlement.

Compute the output with the same order and flooring as the V2 library:

`Q(q) = floor((997*q*y) / (1000*x + 997*q))`

Enforce the applicable uint256 arithmetic and uint112 reserve bounds. A router can quote an amount whose actual swap would violate post-trade reserve bounds or produce zero output. Preserve that observation while marking the swap model infeasible and leaving net proceeds null. Reject zero reserves, zero input, and invalid encodings. Keep q, x, y, and Q as integers; do not convert them through floating point.

After a standard sale, reserves become `(x+q, y-Q(q))`. The full input enters the reserve; the LP fee remains in the pool. Updating the input reserve by only 99.7% of q gives incorrect subsequent-trade results.

The canonical implementation is the primary mechanism reference, not a deployment allowlist:
[Uniswap V2 library](https://github.com/Uniswap/v2-periphery/blob/master/contracts/libraries/UniswapV2Library.sol), [V2 pair](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol).

## Price benchmarks

The reserve spot benchmark in raw Y per raw X is `p0 = y/x`. Display price in Y tokens per X token is `p0 * 10^(decimals_X-decimals_Y)`. Average execution price is `(Q/q) * 10^(decimals_X-decimals_Y)`.

Keep these measures separate:

- **Fee-adjusted curve impact:** compare Q with the infinitesimal output after the pool fee, `(997/1000)*q*y/x`. This reflects curve movement and integer rounding relative to that benchmark.
- **Total execution shortfall versus reserve spot:** compare Q with `q*y/x`. It includes the embedded pool fee, curve movement, and rounding. It is not an additional debit to subtract from Q.
- **Slippage tolerance:** a user-selected minimum-output constraint against the quoted Q. It does not measure price impact and is not a prediction of how much extra slippage will occur.
- **Additional costs:** charges outside the quoted output. Record their units, source, assumptions, and completeness.

Use exact fractions for threshold comparisons before display rounding. Near the smallest token units, rounding can dominate a percentage; show raw quantities and avoid universal impact thresholds.

The reserve ratio is an endogenous pool benchmark, not an independent fair value. If comparing against a USD feed, exchange price, another pool, or underlying stock price, retain exact asset identity, venue, timestamp, unit conversion, and basis uncertainty. Do not call reserve spot “fair value.”

## Proceeds, costs, and PnL

`estimated net output = quoted output - additional costs expressed in output-token raw units`

A net estimate requires an explicit complete additional-cost estimate for that size. No cost file, missing entry, unknown charge, or unresolved conversion leaves net output null. Show quoted proceeds and the known cost components separately; missing data must never become zero.

The 30-bps fee is embedded in Q. Do not subtract it again. Provider quotes may also embed route or platform charges; reconcile them rather than assuming every quoted fee is incremental. Reject a cost input that includes the modeled pool fee as an additional cost.

Gas starts in native-asset units. For an estimate, distinguish gas units from native currency: estimated gas units times the chosen gas-price assumption gives wei on conventional EVM networks. Account for chain-specific additional fees, including L1 data charges where applicable. Convert to Y using an identified native/Y rate and decimals, and conservatively round the deduction. A live gas price is not automatically a historical gas price. Never subtract gas units or wei directly from ERC-20 amounts.

Quotes do not establish acquisition cost or realized PnL. Profit calculation needs reconciled cost basis, complete transaction costs, and observed proceeds under a consistent valuation method. A token transfer, airdrop, or prior market-price snapshot is not a known purchase price.

## Size selection

Compare a finite user-specified size grid against the same initial state. Report which tested sizes satisfy the selected impact/cost constraint. A largest passing tested size is not a mathematically optimized maximum and does not recommend how much of the user's capital to allocate.

For a single pure V2 curve, continuous curve impact has useful monotonic structure, but integer rounding can affect tiny sizes. Routing switches, hooks, taxes, and discontinuous fees can break naive global search assumptions. Do not extrapolate this model to arbitrary venue behavior.

## Calibration and falsification

Validate the arithmetic against router quotes at the same state. Require token orientation, fee mechanism, and raw-unit agreement. A mismatch is a diagnostic outcome, not a reason to average the numbers or widen tolerances until they match.

Where full execution is available on an isolated fork, compare the recipient's actual token balance delta with the quote and account for residuals. Router return arrays alone are not independent balance measurements. Retain unsuccessful cases and exact supported coverage; a collection of successful simulations is not a general sellability claim.

Record the validation environment: synthetic model, mocked RPC, local EVM, historical fork, or live read-only provider. These provide different evidence. Do not describe one as another.
