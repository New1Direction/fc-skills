# Hook catalog research

The user supplied [awesome-uniswap-hooks](https://github.com/fewwwww/awesome-uniswap-hooks). This release inspected snapshot [8a85636ba836c06280b365ff8aecc3fe55f2d263](https://github.com/fewwwww/awesome-uniswap-hooks/tree/8a85636ba836c06280b365ff8aecc3fe55f2d263) on 2026-09-08. It is a discovery index, not a deployment registry, audit, license grant or compatibility guarantee. No catalog source code is bundled here.

| Resource found through the index | Research use |
| --- | --- |
| [Uniswap v4-core](https://github.com/Uniswap/v4-core) and [v4-periphery](https://github.com/Uniswap/v4-periphery) | Resolve exact interfaces and accounting used by the deployment. |
| [Routing API hook allowlist](https://github.com/Uniswap/routing-api/blob/main/lib/util/hooksAddressesAllowlist.ts) | Discover chain/address candidates, then verify their deployment and caller scope. Listing does not enable Ape's vault. |
| [OpenZeppelin hook library](https://github.com/OpenZeppelin/uniswap-hooks) | Inspect reusable patterns and version-specific assumptions. |
| [Uniswap Foundation template](https://github.com/uniswapfoundation/v4-template) | Establish a separate development harness after pinning dependencies. |
| [HookMineAndSinker](https://github.com/devtooligan/HookMineAndSinker) | Study address-bit mining; matching flags alone says nothing about behavior. |

For a proposed family, record source URL/commit, license, core/periphery versions, compiler/build settings, chain addresses and deployment receipts, proxy/dependency graph, code hashes, config reads, supported entrypoint, hookData, fee currency/timing/rounding, custom deltas, token assumptions and counterexamples. Reject stale pre-release interfaces rather than silently adapting semantics.

Prefer a concrete Robinhood integration blocker over a broad catalog. Pons V2 is the first selected family because FYNCH resolves its launch lifecycle while graduated fee semantics still need explicit modeling. Other entries remain research candidates until deployment-specific evidence exists. Do not auto-install or execute repository scripts merely because they appear in the index.
