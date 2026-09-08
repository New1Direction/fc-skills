# Sources and latency qualification

Use an official-feed-connected local Nitro node as the primary candidate and an independently operated RPC for comparison. Benchmark the actual host/providers. WATCHTOWER reads executed full blocks/receipts; raw sequencer decoding stays with Nitro/PULSE.

Robinhood documents `wss://feed.mainnet.chain.robinhood.com`, Nitro `v3.11.2-3599aca`, L1 execution/beacon prerequisites and local NVMe storage. Recheck current assets/version before deployment. Existing PULSE node tooling can prepare the configuration. Keep RPC access private. [Full-node guide](https://docs.robinhood.com/chain/run-a-full-node/), [connections](https://docs.robinhood.com/chain/connecting/).

Current Nitro feed messages use `signatureV2` and optional block hash/metadata. The nested message-header block number describes L1. Sequence-to-L2 numbering depends on Nitro genesis offset; Robinhood's inspected config sets `GenesisBlockNum:0`. Keep separate fields and cross-check executed hashes. A user-payload decoder also misses generated transactions such as Nitro's start-block internal transaction unless it reproduces execution. [Message structure](https://github.com/OffchainLabs/nitro/blob/v3.11.2/broadcaster/message/message.go), [block processor](https://github.com/OffchainLabs/nitro/blob/v3.11.2/arbos/block_processor.go), [feed format](https://docs.arbitrum.io/run-arbitrum-node/sequencer/read-sequencer-feed), [Robinhood config](https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-chain-info.json).

Subscriptions can disconnect, omit intermediate heads and emit replacement hashes at the same height. Use notifications as wake-ups and reconcile full blocks through HTTP. A comparison source is not automatically promoted into the primary history. [Subscription behavior](https://geth.ethereum.org/docs/interacting-with-geth/rpc/pubsub), [relay recovery](https://docs.arbitrum.io/run-arbitrum-node/run-feed-relay).

Sequencing, execution, L1 posting and Ethereum finality are distinct. Native coverage is RPC-derived inclusion; finality remains unverified. Private/rejected submissions never included in a block are outside this universe. [Robinhood finality](https://docs.robinhood.com/chain/transaction-finality/).

Receipts do not expose all nested calls, internal native transfers or revert reasons. A verified trace adapter needs separate completeness accounting and resource budgets. [Call tracing](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers).

Robinhood's Data Streams page describes Chainlink market/oracle data, not the transaction feed. Stock REST prices have separate caching and multiplier semantics. [Data Streams](https://docs.robinhood.com/chain/data-streams/), [stock APIs](https://docs.robinhood.com/chain/stock-token-apis/).

## Speed acceptance

Compare exact block hashes and stages under the same process run/monotonic clock. Report p50/p95/p99 relative arrival, matched samples, missing observations, durable-capture delay, contiguous coverage and backlog together. An event missing from every source is absent from the observed comparison universe. Block timestamps are not wire-arrival measurements.

Qualify production using representative retained blocks/logs, sustained live load and injected disconnection/recovery. Record CPU, memory, disk growth, RPC counts, source errors and distance from current source head. Synthetic rates exclude network delay, Nitro execution and real payload distribution; they establish no fastest-provider or mainnet-capacity claim.
