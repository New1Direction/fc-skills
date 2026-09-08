# Reproduce and interpret validation

The release passes **188 deterministic tests**. Normal helpers need Node.js24+ and built-in modules only:

```sh
node --test scripts/test_*.mjs
node scripts/pressure.mjs demo --out /tmp/pressure-demo-new
```

The demo creates independent supply/liquidity teaching reports, a separate synthetic joint research bundle/report with matched asset/block identities, and an append-only synthetic study journal with one missing outcome. It must preserve the missing case rather than report a selected-versus-control advantage from complete winners alone. The input fixtures are teaching examples, not retained market observations.

## Optional actual EVM collection

Use separately installed trusted Anvil and solc binaries/modules. The build used Anvil 1.7.1 and solc 0.8.36; no third-party runtime dependencies are bundled.

```sh
node scripts/evm-smoke.mjs --anvil /absolute/path/to/anvil --solc /absolute/path/to/solc/index.js --output output/evm-smoke.json
```

`assets/StockSmoke.sol` is an original synthetic token fixture. The harness creates its own isolated source node, deploys two tokens, sets initial balances, performs mint/burn/transfers and a multiplier change, then collects through a read-only proxy. The setup's local transactions are explicitly synthetic. No production deployment, private key or live funds are used.

The release run passed on 2026-09-08; raw evidence is retained in `assets/evm-smoke.synthetic.json`. It observed six window receipts and nine logs, counted only three standard transfers for the primary token, and reconciled raw supply **400 + 1000 − 100 = 1300**. Display-adjusted supply became 2600 with the multiplier at 2; no extra mint was inferred. Tracked balances reconciled. Duplicate UI transfers and unrelated-token movements were excluded. An injected omitted receipt log invalidated the evidence, retained collection replay passed, and the collector made zero source RPC write attempts or source-state changes.

This validates the collector/accounting against a real local EVM. The synthetic token is not a Robinhood issuer contract, and chain ID 4663 on a local test node does not make it mainnet. Code identity, underlying backing, venue access, profitable signals and Nitro execution remain separate questions.

An independent usage pass ran the demo, verified and analyzed the retained EVM collection, and correctly preserved the missing selected outcome. It found two usability issues resolved before release: direct handling of the synthetic EVM envelope (validation scope is explicitly the nested collection only), and a coherent generated joint demo alongside the independent input fixtures. Invalid `verify` results now exit nonzero while retaining the failure report. Regression checks cover these changes.

## Live and integration coverage

The bounded current inspection found no configured `ROBINHOOD_RPC_URL`, `HOOKLAB_RPC_URL` or `PRESSURE_RPC_URL`. A public RPC request could not complete because its network approval was cancelled before a decision; a prior HOOK LAB probe timed out. No working archive endpoint or real Pons wallet route was established during this build.

Supply, liquidity and outcome tools can operate on retained evidence immediately. Live collection requires an accessible archive endpoint and independently prepared token/window expectations. Liquidity analysis consumes supplied normalized quote/call/fork evidence; it does not collect new quotes or build production router calldata. FYNCH/Ape source integration surfaces were inspected and documented, but this release does not modify those applications or their live execution permissions.

Use the exact whole skill folder when repeating these checks. Passing tests and internally consistent evidence do not establish provider authenticity, complete float, an economic edge or actual trade execution.
