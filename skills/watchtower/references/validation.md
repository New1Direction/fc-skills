# Validation

Run from the skill directory:

```sh
node --test scripts/test_*.mjs
node scripts/watchtower.mjs demo --out /tmp/watchtower-new-demo
node scripts/watchtower.mjs bench --out /tmp/watchtower-benchmark.json --blocks 100 --transactions 100
```

Demo requires a new output directory. It demonstrates a missing block, delayed receipts, recovery and a replaced block while retaining truthful coverage. Synthetic transaction types include an unknown value; that case tests retention, not actual Nitro execution semantics.

The benchmark creates 10,000 small synthetic transactions in 100 blocks with empty receipt logs. It measures durable capture and built-in classification in the actual local SQLite store, excluding networking, Nitro execution and realistic payload distribution. Its rates cannot establish mainnet throughput or superior provider latency. The workload is bounded and its temporary database is removed afterward.

Optional actual EVM check:

```sh
node scripts/evm-smoke.mjs --anvil /absolute/path/to/anvil --out /tmp/watchtower-new-evm-report.json
```

The harness creates its own isolated loopback Anvil chain, authors five fixture transactions across three blocks, and then captures through an HTTP proxy allowing only read methods. Cases include native transfers, contract creation, an actual reverted transaction and an empty block. It compares raw blocks/receipts to independently fetched source evidence, reopens durable storage, checks all receipt-enriched classifications, and checks the source state stayed unchanged during collection. This is synthetic actual-EVM evidence, not Robinhood mainnet, Nitro-feed or real-speed qualification.

The automated suite exercises omission, source drift, partial receipts, unknown types, concurrency bounds, source errors, real HTTP transport, WebSocket wakeups, catch-up prioritization, bounded reorgs, restored hashes, queue saturation, handler timeouts, late completions, outbox retractions, durable restart and storage budgets. Long-history progress checks confirm the ordinary capture path does not rescan all prior blocks.

Live status: no configured deployment host or working mainnet endpoint was established in this build session. A bounded public RPC request did not execute because network approval was cancelled before a decision was returned. That is not a measured source timeout. Production coverage, latency, storage retention/export, synchronized Nitro operation, trace support and FYNCH/Ape service wiring remain unverified.

Retained release evidence: [actual isolated EVM run](../assets/evm-smoke.synthetic.json) and [synthetic throughput run](../assets/benchmark.synthetic.json). The release suite passes 114 tests. The retained throughput workload completed durable capture in about 296 ms and capture plus built-in workers in about 1,057 ms on the recorded local runtime. These are short synthetic workload timings only.

Independent operator-use validation completed the demo, a concrete exact-address rule configuration, bounded workers, receipt classifications, outbox review and missing-source probe. The probe now exits 2 if its primary is unavailable and records missing endpoint variables explicitly with zero attempted transport requests.
