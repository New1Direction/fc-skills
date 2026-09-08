---
name: hook-lab
description: Investigate exact Robinhood Chain Uniswap V4 hook deployments and wallet call paths. Use for unsupported pools, hook fees and restrictions, deployment identity, wallet-specific simulations, adapter evidence, and code/configuration drift. Includes a Pons V2 source-derived fee adapter, bounded read-only collectors, and isolated Anvil fork balance measurements. Produces integration evidence; never signs or submits live trades.
---

# HOOK LAB

Turn an unsupported Robinhood pool into a precisely scoped integration candidate, or explain the missing evidence. Focus on chain **4663** and the canonical V4 PoolManager. Treat every deployment, router, wallet, amount and observation block as a distinct execution case.

## Start with the requested decision

Retrieve the exact PoolKey, hook and router addresses, block/hash, actual wallet call and retained evidence. Reuse available FYNCH, Ape or PULSE records; do not ask for known information. If only a token is supplied, resolve its exact deployment and graduation state first. Never select a pool by ticker or assume a hook catalog establishes a deployment.

| Decision | Workflow |
| --- | --- |
| What is this contract/pool? | `identity` and [identity.md](references/identity.md): exact PoolKey, code hashes, proxy dependencies, config reads and block identity. |
| What does Pons V2 charge? | `pons-discover` / `pons-fees` and [pons-v2.md](references/pons-v2.md): source-derived snapshots and integer fee accounting. |
| Does this exact wallet call revert? | `call` and [simulation.md](references/simulation.md): read-only call and optional trace evidence. |
| What balances change? | `fork` and [fork.md](references/fork.md): isolated Anvil child, actual requested wallet context, pre/post balances and receipt. |
| How much evidence supports this case? | `qualify` and [qualification.md](references/qualification.md): binding and consistency of retained evidence. |
| Did this deployment change? | `compare` and identity reference: observed code/dependency/configuration changes. |

Read the relevant reference before preparing its strict JSON input. Missing evidence stays missing. Read [integration.md](references/integration.md) before exporting to another tool. Node.js24+ runs the built-in helpers without npm dependencies. Fork collection additionally requires a trusted Anvil binary installed separately.

## Commands

Run from this skill directory. Set `HOOKLAB_RPC_URL` privately to an available archive RPC; its value is not retained in reports.

```sh
node scripts/hook-lab.mjs identity --input deployment.json --rpc-env HOOKLAB_RPC_URL --out output/identity.json
node scripts/hook-lab.mjs pons-discover --input token-at-block.json --rpc-env HOOKLAB_RPC_URL --out output/pons-pool.json
node scripts/hook-lab.mjs pons-fees --input fee-case.json --out output/fees.json
node scripts/hook-lab.mjs call --input call.json --rpc-env HOOKLAB_RPC_URL --out output/call.json
node scripts/hook-lab.mjs fork --input call.json --rpc-env HOOKLAB_RPC_URL --anvil /absolute/path/to/anvil --out output/fork.json
node scripts/hook-lab.mjs qualify --input evidence-bundle.json --out output/qualification.json
node scripts/hook-lab.mjs compare --prior prior-identity.json --current current-identity.json --out output/compatibility.json
node scripts/hook-lab.mjs pons-fees --input assets/pons-fees.synthetic.json --out output/synthetic-fees.json
node --test scripts/test_*.mjs
```

Pin a block **and its hash**, and retain failures as well as successes. If a provider cannot serve historical state or requested traces, report that missing capability; do not silently change blocks or substitute a quote.

## Evidence discipline

1. Independently establish expected bytecode/configuration, including relevant implementation, beacon, admin and mutable dependencies. Observing a hash and declaring that same hash trusted is circular. Address flags describe callbacks, not behavior or security. `proxy_kind:none` does not prove immutability. Reconstructing a PoolKey does not prove initialization.
2. Review pinned source and build/runtime correspondence, fee timing/currency/rounding, custom accounting, dynamic fees, caller/origin restrictions, hookData, approvals and recipient semantics. Include token behavior and factory generation. Unknown families require their own adapters; never apply Pons arithmetic by resemblance.
3. Preserve the complete call path. A quoter or ordinary-swap probe does not establish support in another router/vault. Traces and event amounts are not wallet balances. V4 settles net deltas within an unlock; intermediate legs can lack ERC-20 transfers. Anvil executes in a local child block, not the exact historical transaction environment or a proven Nitro equivalent.
4. Bind identity, supplied source-review claims, exact call and fork evidence. A digest detects changes but an attacker can rewrite a whole bundle; retain provenance separately. Native positive qualification covers an exact direct two-asset swap, not same-asset arbitrage or a range of amounts.
5. Recheck relevant code/configuration/state before proposed use. Matching separated observations does not establish continuous freshness. Apply an explicit consumer age/finality policy; do not invent a universal expiry.

Local fork impersonation is confined to the requested `from` inside the tool's own Anvil process. Do not substitute a privileged origin, seed balances/allowances/code/storage, or count an operator-only function as ordinary access. Synthetic development setups stay labeled synthetic. No native command signs or sends to the source chain.

## Deliver the result

Lead with what is established for the exact case and the next missing item. Include chain/block/hash, PoolKey/route, wallet/amount/calldata identity, code/config/source references, fee currency/arithmetic, call/fork outcomes, wallet changes and known gas units/missing costs. Preserve failures and competing explanations. Keep net profit unknown without reconciled proceeds and complete costs in a common numeraire; historical evidence is not a return forecast.

Separate source-derived behavior, deployment identity, exact-call success, local-fork balance evidence and consumer execution support. [integration.md](references/integration.md) explains Ape/FYNCH boundaries. [hook-catalog.md](references/hook-catalog.md) turns the user-supplied catalog into a repeatable research process.

## Initial coverage

The Pons candidate records published addresses and a pinned source commit. Its executable fee adapter is **not a full pool traversal quoter**, runtime/source verification or a proven live route. The lab can collect missing observations with an archive endpoint and a concrete wallet call. Do not claim Pons mainnet execution qualified from offline tests. See [validation.md](references/validation.md) for performed checks and remaining limitations.
