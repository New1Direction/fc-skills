---
name: circuit
description: Build exact Robinhood Chain V4 routes, enumerate bounded paths and same-asset circuits, and measure complete wallet calls on isolated forks. Use for route construction, sampled trade-size comparisons, settlement/refunds, Permit2 preflight and gas-adjusted execution research. Native adapter targets the pinned Universal Router 2.1.1 ABI; live deployment correspondence remains separate evidence. Does not sign or submit live trades.
---

# CIRCUIT

Turn exact pool identities into unsigned route candidates and inspect their complete execution. Use actual wallet balances to assess the result. Preserve unsupported, reverted, stale and missing cases.

## Native scope

- Chain 4663, pinned Universal Router **2.1.1** V4 exact-input ABI.
- One to four hops; sorted exact PoolKeys; native ETH or standard ERC-20 route currencies.
- Ordinary EOA as payer and recipient. Existing token-to-Permit2 and Permit2-to-router approvals are required for ERC-20 input.
- Open paths and same-asset cycles across distinct pools. Prepay once, swap the whole path, then return all positive route-currency credits.
- Read-only preflight, Nitro NodeInterface fee estimation where supported, and complete balance measurement in a disposable Anvil fork.
- Bounded graph enumeration and up to eight independently simulated sizes from the same parent block.

Compilation supports a source ABI. It does not establish that a supplied live router or hook matches that source. The bundled Robinhood address is a **published candidate**, with runtime correspondence unverified. Nonzero hooks pass through exactly and require HOOK LAB investigation plus wallet-call evidence. No generic hook safety or profitable-route qualification is inferred.

## Workflow

1. Establish the exact chain, parent block number/hash/timestamp, actual EOA, router, PoolManager, Permit2 and PoolKeys. Reuse WATCHTOWER/PULSE registry evidence and HOOK LAB source/configuration evidence; do not infer pools from symbols. Read [adapter and sources](references/adapter.md).
2. Choose explicit raw input and minimum return amounts and a deadline after the parent timestamp. In a cycle, final credit includes any unspent input; a gross gain floor requires `minimum_out >= amount_in + required_gross_gain`. Gas is separate. The compiler does not choose financial risk limits.
3. Compile, validate and inspect the unsigned call. Run preflight before simulation. Observe runtime hashes, manager wiring, balance, both approval layers and expiration. Expected code hashes detect drift; supplied hashes do not prove source correspondence. Read [preflight](references/preflight.md).
4. Simulate the exact call on a disposable fork from that parent. Retain sender, recipient, value, gas, calldata, route-token balances at wallet/router, native balances, receipt and source recheck. Never seed funding, approvals, code or storage in a measured live-wallet fork. Contract wallets and vaults need a separate entry adapter.
5. Evaluate balances and retained chain fees. Add local Anvil gas back to native wallet change before subtracting the source estimate. Token deltas already include pool/hook charges. ERC-20 net estimates need an explicit block-bound native-to-input conversion assumption. Open paths keep unlike units separate. Read [accounting](references/accounting.md).
6. Compare only supplied samples with compatible wallet, state, assets, context, time and conversion. Keep failed and excluded cases. A best sampled estimate is neither an optimal size nor a future execution guarantee.

## Commands

Run from this skill directory with Node.js 24+. Use new output paths; commands never overwrite artifacts. Runtime helpers use built-in Node modules. Fork execution needs a trusted local Anvil binary. The optional actual-EVM smoke also needs solc; neither dependency is bundled.

```sh
node scripts/circuit.mjs demo --out /tmp/circuit-demo-new
node scripts/circuit.mjs build --in assets/route-example.json --out /tmp/circuit-built-new.json
node scripts/circuit.mjs validate --in /tmp/circuit-built-new.json --out /tmp/circuit-validation-new.json
```

Example identities, block and amounts are synthetic. Replace them with retained evidence before live reads. Set `CIRCUIT_RPC_URL` through normal environment secret configuration; do not paste credentials into outputs.

```sh
node scripts/circuit.mjs preflight --in built.json --rpc-env CIRCUIT_RPC_URL --out preflight.json
node scripts/circuit.mjs simulate --in built.json --rpc-env CIRCUIT_RPC_URL --anvil /trusted/anvil --out run.json
node scripts/circuit.mjs sweep --in sizes.json --rpc-env CIRCUIT_RPC_URL --anvil /trusted/anvil --out /tmp/circuit-sweep-new
```

`simulate` retains preflight, available NodeInterface cost evidence, fork report and accounting. A blocked/incomplete preflight prevents forking. Missing fees stay unknown while valid local observations can still be recorded. `sweep` retains every size and a comparison.

Read [interfaces](references/interfaces.md) for schemas and APIs. `--help` lists all commands. [EVM validation](references/evm-validation.md) explains the actual protocol smoke. Run offline checks with `node --test scripts/test_*.mjs`.

## Reporting requirements

Lead with the actual outcome: compiled candidate, blocked preflight, incomplete source, fork revert, or successful local simulation. Include exact route/amount identity, balance changes, refunds/residuals, known and unknown costs, source/runtime evidence and comparison exclusions.

Keep published deployment records, observed code hashes, source/build correspondence, read-only call success, local-fork balances, source fee estimates and live execution distinct. Reports deliberately retain `UNVERIFIED_DEPLOYMENT`; no caller flag promotes it.

Anvil runs the next local block from the pinned parent. It does not recreate historical intrablock prestate, Nitro precompiles, data fees, future ordering or inclusion. NodeInterface support is probed. Digests detect internal changes and binding errors; they are not provider authentication or audits.

Only route currencies and native balances at the wallet/router are enumerated. External hook calls, unrelated assets, rebasing/transfer-tax semantics and dishonest balance methods need broader investigation. No keys, signing, permits, live submission, flash borrowing, cross-chain legs or automatic execution permission are included.

Read [application integration](references/integration.md) for worker/app handoffs. Preserve raw evidence before generating a shortlist. Production FYNCH/Ape deployment is separate work.
