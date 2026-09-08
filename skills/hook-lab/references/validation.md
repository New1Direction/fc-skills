# Release validation

This reference records build evidence, not a deployment attestation. All mainnet address/source facts were checked or attributed on 2026-09-08. Runtime/source correspondence remains unverified for the bundled Pons candidate.

## Repeatable offline checks

```sh
node --test scripts/test_*.mjs
node scripts/hook-lab.mjs pons-fees --input assets/pons-fees.synthetic.json --out output/synthetic-fees.json
```

The synthetic Pons case supplies 1,999,999 raw output units before a 100-bps hook fee and 50-bps creator tax. Separate floors produce 19,999 and 9,999 units: total 29,998 and adjusted output 1,970,001. Combining rates before flooring would produce a different answer. This is a fixture calculation, not an observed token price, quote or trade.

The release passes **224 deterministic tests** across seven test files. The deterministic suites cover deployment identity and upgrades, exact caller/block binding, strict ABI decoding, fees and signed boundaries, incomplete providers, reorgs, transcript integrity, local-fork evidence and qualification failures. They use controlled evidence; passing them is not evidence of live profitability or exhaustive contract safety.

## Optional actual local EVM check

Install trusted versions of Anvil and the solc JavaScript compiler separately. The build used Anvil 1.7.1 (Foundry commit 4072e48705af9d93e3c0f6e29e93b5e9a40caed8) and solc 0.8.36. Neither dependency is bundled with the skill.

```sh
node scripts/evm-smoke.mjs --anvil /absolute/path/to/anvil --solc /absolute/path/to/solc/index.js --output output/evm-smoke.json
```

The harness compiles original synthetic token/router contracts from `assets/Smoke.sol`, creates its own loopback source chain and disposable fork, and checks wallet/router balances and revert behavior. Its setup mints synthetic tokens and makes local approvals. The fork collector itself does not seed balances or allowances. This exercises actual EVM collection and source isolation; the synthetic contracts are not Pons, canonical V4 or a Nitro simulation. Keep this optional check distinct from dependency-free unit tests.

The actual build run passed on 2026-09-08. Retained raw evidence is in `assets/evm-smoke.synthetic.json`: wallet −100/+97, router +100/−97, gas reconciled, minimum-output reverts, alternate-wallet allowance isolation, unchanged source balances/nonce/block, and zero source RPC writes. Both tracers were observed. This evidence stays explicitly synthetic.

An independent skill-use test ran the fee CLI, validated a call request and correctly kept Ape support unqualified. Initial in-progress reference gaps were resolved before release. Authentic consumer calldata must still be obtained for a real case; this release does not supply a production router calldata builder.

## Live coverage

A bounded public Robinhood RPC `eth_chainId` request to the documented public endpoint timed out after 12 seconds with no data. The hook research also encountered a 403 on the explorer contract API. These are environment/provider observations, not evidence that the chain or hook is unavailable.

No live Pons PoolKey, verified deployed runtime/build correspondence, funded user-wallet route, or current mainnet simulation was established. Supply an available archive endpoint and exact case, independently verified code/source/dependencies/configuration, actual router calldata and expected raw wallet changes. Retain those results before reviewing consumer support. Ordinary Anvil execution does not establish Nitro-specific precompile behavior, L1 data fees, live latency, inclusion or profit.
