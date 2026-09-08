# Native interfaces

Node.js 24 built-ins run the helpers. Raw amounts are canonical decimal strings; transaction fields are RPC hex quantities. No floating point amount arithmetic.

`assets/route-example.json` is the complete `circuit.route.v1` schema. Replace all synthetic identities/state/context together. Unknown fields are rejected. Wallet=recipient, EOA sender, one to four unique pools, no repeated intermediate currency except a terminating cycle. Input is at most `2^127−1`; deadline is after parent timestamp and at most one day later. Gas is explicit.

`buildRoute(route)` returns `circuit.built.v1`: normalized route, transaction, PoolIds, settlement currencies, token/owner pairs, HOOK LAB call request and digests. `validateBuilt` reconstructs everything; self-rehashed call changes fail.

`enumerateRoutes({currency_in,currency_out,pools,max_hops,max_routes})` returns hop arrays. Pools contain `pool_key` and `hook_data`; at most 64 pools, four hops and 64 paths. Only the supplied registry is searched. No liquidity/prices are inferred.

`collectPreflight(built,{rpc,expected_code_hashes?})` records existing state and approvals. `validatePreflight(built,report)` asynchronously replays its transcript. See `preflight.md`.

`collectCostEstimate(built,{rpc,conversion?,nowSeconds?})` returns `circuit.cost-collection.v1`, with `cost_evidence` either `circuit.cost.v1` or null. `validateCostEvidence(built,cost)` checks binding and arithmetic. Conversion shape:

```json
{"currency":"0xEXACT_INPUT_TOKEN","numerator_input_raw":"1","denominator_native_wei":"1000000000","block":{"number":123,"hash":"0xEXACT_32_BYTE_HASH"}}
```

These are placeholders, not identities or a suggested rate. Native input uses wei directly and rejects a conversion.

`simulateFork(built.call_request,{rpcUrl,anvilPath})` returns `hook-lab.fork.v1`. Writes target a fresh local Anvil child only. No balance/code/storage/approval overrides are made on the measured fork. Contract senders and missing permissions remain unsupported.

`runCandidate(built,{rpc,rpcUrl,anvilPath,expected_code_hashes?,conversion?})` in `circuit.mjs` composes preflight, costs, fork and accounting into `circuit.run.v1`. Blocked/incomplete preflight stops before forking. Cost failure leaves costs unknown. RPC URL values are omitted.

`assessExecution(built,fork_report,{cost_evidence?,as_of?})` returns `circuit.assessment.v1`. `compareExecutions([{built,fork_report,cost_evidence?,as_of?}])` returns `circuit.comparison.v1`; at most 64 cases / 32 MiB. Compatible state, assets, wallet/context/time and conversions are required.

CLI `assess` input is `{built,fork_report,cost_evidence?,as_of?}`; `compare` input is the entries array. `--as-of` overrides historical review time consistently. `sweep` input is:

```json
{"schema_version":"circuit.sweep.v1","route":{"...":"complete route.v1 object"},"sizes":[{"amount_in":"1000","minimum_out":"1001"},{"amount_in":"2000","minimum_out":"2001"}]}
```

Supply a complete route in place of the placeholder. One to eight rows override both amounts. Each size gets a fresh fork of the same parent. The output directory must be new; individual runs are saved as they finish. Failed/missing cases remain in `sweep.json`.

CLI `validate` supports built candidates, fork evidence, cost evidence and preflight evidence. Cost/preflight require `--built`. It checks consistency, not source authenticity or current opportunity validity. No flag bypasses preflight or allows live writes.
