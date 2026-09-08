# Pinned Universal Router adapter

The compiler uses Universal Router 2.1.1 source commit `999d561c3ad58fb5cab91b602911f3c75591a9c7` and its V4 periphery gitlink `3231810e39b8c4d569b9d66907fa4ef8cd2cec22`. Exact primary URLs and Git blob identities are in `source-manifest.json`.

Outer call: `execute(bytes,bytes[],uint256)`, one V4 command `0x10`. Input: ABI encoding of `bytes actions, bytes[] params`. Actions: explicit `SETTLE` (`0x0b`), `SWAP_EXACT_IN` (`0x07`), then `TAKE_ALL` (`0x0f`) for every unique route currency. No allow-revert flag or arbitrary command is emitted.

Swap tuple: `(address currencyIn, PathKey[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum)`. PathKey: `(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)`. The required price array is empty, as permitted by the pinned source. Only the aggregate minimum applies. A 2.0.0 encoder omitting the array is incompatible.

SETTLE prepays input using the original caller through Permit2 for ERC-20, or exact value for ETH. Credit exists before swaps, avoiding the positive-net-credit failure caused by settling full debt after a profitable cycle. TAKE_ALL returns output credit to the original caller and enforces its minimum; other currencies are taken with zero minimum. Positive partial-fill credits are refunded. Negative debt fails rather than silently pulling extra assets.

For a cycle, final credit includes any unspent input. Label it settled return, not pure swap output. A gross-gain constraint needs a minimum above prepaid input; gas is separate.

## Robinhood candidate

The pinned [Uniswap deployment record](https://github.com/Uniswap/contracts/blob/37936185dee7decf681360ec799c124e0e034672/deployments/json/4663.json) identifies router `0x06afba43fd06227fa663b0daecf536f6eaa6bf99`, manager `0x8366a39cc670b4001a1121b8f6a443a643e40951` and Permit2 `0x000000000022d473030f116ddee9f6b43ac78ba3`.

The rendered [deployment page](https://developers.uniswap.org/docs/protocols/v4/deployments) still lists predecessor `0x8876789976decbfcbbbe364623c63652db8c0904`. Pinned history explains redeployment of the same 2.1.1 creation code with the production Across SpokePool immutable. Inspect current evidence rather than automatically allowlisting either address.

`assets/robinhood-deployment-candidate.json` retains deployment transaction, constructor metadata, source pins and predecessor. Bundled UR creation code agrees with the published hash. No live runtime match was established: a public `eth_chainId` probe timed out after 12 seconds (`public-rpc-probe.json`). The local PoolManager smoke artifact is canonical but differs from the earlier Robinhood manager creation hash; it is not an exact live-core replica.

`poolManager()` is public. PERMIT2 and WETH9 are internal immutables without getters. An independently chosen Permit2 allowance does not prove router correspondence. Source/build/runtime and constructor evidence remain necessary.

## Hooks

Exact PoolKeys and hookData pass through unchanged. A nonzero hook is not approved by compilation. HOOK LAB's pinned Pons V2 analysis can supply registration, configuration and source-derived fee evidence. Fees already affect measured deltas and must not be subtracted again. No Pons mainnet route or arbitrary-hook safety qualification is bundled.

Fixed fees up to 1,000,000 and dynamic fee flag `0x800000` are syntactically accepted. Runtime hook flags, registration and liquidity can still revert. The complete-call simulator avoids treating independently quoted hops as one executable transaction.
