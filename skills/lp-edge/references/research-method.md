# Research method

## Contents

- Accounting and fees
- Comparing ranges and position size
- Evidence and wallet access
- Other venues and stock-token pairs
- Primary references

## Accounting and fees

Maintain a token-unit ledger. Principal depends on liquidity, square-root price, and tick bounds. Valuation is separate. Use integer contract-compatible rounding for amounts and exact rational ratios and marked values.

For a canonical V3 NFT, calculate fee growth inside from global growth and both boundary ticks, using the pool's stored tick for crossing direction and modulo-256 subtraction. Apply the position checkpoint and liquidity. Stored owed balances can combine fees and removed principal: classify only with position history. Zero remaining liquidity can still have amounts owed.

Inside growth represents LP accrual after the pool's protocol-fee allocation. Do not deduct the protocol share twice. A volume model needs direction, active liquidity, fee and protocol allocation at every step. Advertised fee times total volume is not position income. Incentives are separate; their realizable value needs price and liquidation evidence.

An interval return needs opening capital and subsequent contributions or withdrawals. The native fixed-position comparison uses an unchanged-liquidity interval. For active management, use an event ledger and an explicitly defined time-weighted or money-weighted calculation externally. Endpoint balances alone are insufficient. NFT transfers change whose performance the interval represents.

Separate asset price return, inventory divergence versus holding, fees, and costs. Impermanent loss and loss-versus-rebalancing use different benchmarks; do not add them. Avoid charging estimated adverse-selection loss separately when already captured by the realized path and benchmark. Stress tests can show fee sensitivity without counting the same loss twice.

## Comparing ranges and position size

Predeclare ranges, total budget, unused-token treatment, information cutoff, holding horizon, rebalance rules, fees and costs. Equal liquidity is not equal capital across ranges. Compare at a common starting budget including idle inventory and entry conversions. When native inputs specify liquidity per range, report different capital requirements explicitly.

Sparse snapshots establish sampled states, not exact time in range, fee share, all crossings, or within-block ordering. The range helper is an inventory scenario tool, not a swap replay engine. Supplied fees are explicit assumptions or externally substantiated observations.

A genuine counterfactual backtest needs ordered swaps, initialized tick states and changes, fee changes, positions, and contract-specific rounding. Replay changed liquidity and resulting execution: a large LP changes depth, fills, fee share and possibly arbitrage behavior. Integrating observed fee growth with hypothetical liquidity is at most a marginal unchanged-path estimate. Require independent position reconciliation and out-of-sample evaluation before calling an extension verified.

Evaluate low-activity, volatile, trending, and liquidity-withdrawal periods. Preserve failed and unresolved cases. Avoid choosing pools or ranges using future winners, metadata or liquidity. Report capacity, pool share and capital requirements rather than treating largest modeled size as optimal.

## Evidence and wallet access

Use canonical block-hash-pinned state where supported. Re-check the block number's hash after reads. Raw-response hashes prove retention integrity, not provider honesty. Compare critical states with an independent provider for consequential decisions where available.

Verify no-position-change intervals with complete manager events and actual contract semantics. Matching endpoint liquidity can conceal withdrawal and reinsertion. Direct core positions and custom managers require their own accounting. Provider-returned empty logs do not independently authenticate completeness.

For execution research, specify sender, recipient, calldata, chain, code identities, block, deadline and minima. A permissive research call is not a reviewed transaction. Creating, decreasing, collecting and withdrawing have different prerequisites. Establish an atomic exit with the actual decrease-and-collect sequence in one call or stateful fork. Establish realizable value with recipient deltas and final conversion including transfer behavior. Simulated return arrays do not establish those deltas.

## Other venues and stock-token pairs

Verify factory, manager, implementation, token behavior and access controls on the actual chain. Chain branding and pool UI labels do not establish canonical V3 support.

V4 requires PoolKey, PoolManager, position manager, hook addresses and permissions, dynamic LP fees, protocol fees, separate hook charges, custom accounting and settlement behavior. Read the actual hook and transaction path. Static fee display is inadequate. Use a verified external adapter and disclose its verification level.

For stock tokens, verify issuer and wrapper, redemption eligibility, market closures, oracle freshness and transfer rules. Quote-asset repricing can conceal a loss in another unit. Stablecoin USD comparisons likewise need observed valuation; a ticker is not a dollar guarantee.

## Primary references

Verify deployment-specific information at use time. These explain mechanics and do not authenticate arbitrary pools or prove returns.

- [Uniswap V3 TickMath](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol): integer tick bounds and ratios.
- [Uniswap V3 Tick](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/Tick.sol): inside growth.
- [Uniswap V3 Position](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/Position.sol): checkpoint accrual.
- [Uniswap V3 NFT manager](https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol): decrease and collect.
- [Uniswap fees](https://developers.uniswap.org/docs/get-started/concepts/fees): fee beneficiaries.
- [Uniswap V4 dynamic fees](https://developers.uniswap.org/docs/protocols/v4/concepts/dynamic-fees): update mechanisms.
- [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898): block-hash state queries.
