# Isolated real-protocol EVM validation

The retained run is `assets/validation/evm-smoke.json`: eight passing scenarios, two actual preflight transcripts and complete balance/receipt evidence. The offline suite has 175 passing tests covering ABI construction, graph bounds, preflight, cost binding, accounting and CLI behavior. Separate skill-use exercises reconstructed exact calls, replayed preflight, handled success/revert/refund cases and rejected incompatible or missing-cost comparisons. These checks do not promote the live deployment status.

`scripts/evm-smoke.mjs` deploys the retained upstream UniversalRouter 2.1.1, PoolManager and Permit2 creation artifacts into a fresh local Anvil chain. It executes the exact unsigned calldata returned by `buildRoute` against disposable forks of that local chain. It does not use a substitute router, a mock ABI decoder or a quoted-price model.

Run from the skill directory with Node 24+, an explicit Anvil executable and an explicit solc JavaScript module. The validated runtime was Anvil 1.7.1 and solc 0.8.36. The latter compiles only the original test fixtures; upstream protocol bytecode is retained unchanged.

```sh
node scripts/evm-smoke.mjs \
  --anvil /absolute/path/to/anvil \
  --solc /absolute/path/to/solc/index.js \
  --output /absolute/path/to/new-circuit-evm-report.json
```

The output path must be new. The harness has no source-RPC argument and only starts servers on `127.0.0.1`. It deploys and funds its own source fixture before measurement, then exposes a read-only proxy to the fork collector. Each scenario starts from the same pinned source block. Balance, nonce and block observations after all scenarios must equal the premeasurement source observations; a proxy write attempt fails validation. The collector never receives the fixture setup connection.

The original `assets/contracts/Fixture.sol` supplies standard test ERC20s, a liquidity callback and a synthetic 1% afterSwap fee hook. The hook address is mined through ordinary CREATE2 deployment so the V4 permission flags are correct. No state/code/balance override qualifies any scenario. The funded second wallet deliberately lacks both allowance stages. All source setup transactions and measured fork transactions remain in the report.

## What the scenarios establish

| Scenario | Required result |
| --- | --- |
| Open route | Exact input leaves the wallet; final output arrives at the wallet. |
| Same-asset cycle | Both hops settle and intermediate currency has zero wallet delta; equal-price pools lose tokens to fees and impact. |
| Positive-spread cycle | A deliberately mispriced pool returns positive input-token credit while `minimum_out > amount_in`; prepaid settlement handles the net-credit direction. |
| Minimum output | An impossible aggregate minimum reverts and leaves every token balance unchanged. |
| Missing allowances | A wallet with tokens but no approvals is blocked by preflight and its exact transaction reverts. |
| afterSwap return delta | Output equals the identical unhooked pool's output less one floored 1% deduction; no double subtraction. |
| Native partial fill | Exhausted narrow liquidity consumes less than prepaid native input; unused input returns to the wallet. |
| ERC20 partial fill | Exhausted narrow liquidity consumes less than prepaid token input; unused input returns to the wallet. |

Every scenario requires zero change in the router's observed route-token and native balances. The open-route preflight independently reads real contract code, `poolManager()`, token balances and both Permit2 approval stages at the pinned block. The blocked second-wallet preflight is also retained and replay-validated.

The positive-spread fixture is intentionally constructed. It establishes settlement behavior, not a discovered opportunity or net profitability. Native balance accounting adds local Anvil gas back before measuring the input consumed. Nitro execution and L1 data costs remain outside this local result.

## Artifact provenance and corresponding source

`assets/contracts/source-lock.json` records SHA-256 hashes, exact upstream repositories and commits, compiler settings, source URLs and licenses. The harness verifies each creation bytecode hash and its byte-for-byte correspondence to the retained `*.deployer.sol` source. These are upstream-provided build artifacts; the harness does not claim an independently reproduced protocol build.

The creation libraries come from [Uniswap/contracts at commit 023196a](https://github.com/Uniswap/contracts/tree/023196a13735232e6a7e69c1ea03b2225480b9dc). Complete corresponding source and its build configuration are available without charge at the pinned upstream trees; obtain their exact submodule revisions when rebuilding:

- [UniversalRouter 2.1.1 source](https://github.com/Uniswap/universal-router/tree/999d561c3ad58fb5cab91b602911f3c75591a9c7), with scoped V4 periphery dependency [3231810](https://github.com/Uniswap/v4-periphery/tree/3231810e39b8c4d569b9d66907fa4ef8cd2cec22). The retained deployment artifact used solc 0.8.26, optimizer 4,444, viaIR, Cancun. The included UniversalRouter license is GPL-3.0; source files specify GPL-3.0-or-later.
- [PoolManager source](https://github.com/Uniswap/v4-core/tree/46c6834698c48bc4a463a86d8420f4eb1d7f3b75). The artifact used solc 0.8.26, optimizer 44,444,444, viaIR, Cancun. Its BUSL-1.1 and MIT license files are included. This harness uses it only for isolated testing.
- [Permit2 source](https://github.com/Uniswap/permit2/tree/cc56ad0f3439c502c246fc5cfcc3db92bb8b7219). The artifact used solc 0.8.17, optimizer 1,000,000, viaIR, London. Its MIT license is included.

The deployment-library source files preserve their upstream MIT SPDX notices. Original fixture code is identified separately. Upstream terms continue to govern those components; the MSK package does not replace them.

These local artifacts do not attest to a Robinhood deployment. The retained PoolManager artifact differs from the earlier Robinhood deployment's creation hash, and constructor immutables further change runtime bytecode. A live adapter still needs exact deployed identities, current configuration, real-wallet funds and approvals, canonical chain observations and source-specific cost evidence. A local Anvil child block is not an exact historical intrablock or Nitro replay.
