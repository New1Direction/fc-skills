# Robinhood V4 evidence adapter

## Scope and trust

Use `scripts/v4_evidence.py` to collect a bounded, reproducible evidence bundle for known Robinhood Chain V4 pool IDs. The native implementation supports mainnet chain **4663**, its canonical Uniswap V4 PoolManager, the canonical `Initialize` and `Swap` event formats, and stable standard-token decimal metadata. It does not discover the whole market, interpret custom hooks, attribute router calls to wallets, query LP inventory, simulate exits, or submit transactions.

Official sources checked 2026-09-08:

- [Robinhood connection documentation](https://docs.robinhood.com/chain/connecting/): chain 4663, ETH gas, provider configuration; use an archive-capable provider for historical state.
- [Robinhood wallet network configuration](https://docs.robinhood.com/chain/add-network-to-wallet/): public mainnet RPC `https://rpc.mainnet.chain.robinhood.com/` and testnet chain 46630. Mainnet and testnet are not interchangeable.
- [Uniswap V4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments): canonical Robinhood manager `0x8366a39cc670b4001a1121b8f6a443a643e40951`. The adapter requires this exact address. An address listing is not a deployed bytecode verification.
- [Canonical event interface](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol): fields, indexed topics, integer widths and pool key identity.
- [PoolManager swap implementation](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol): the core swap event is emitted before `afterSwap` hook accounting. Its values need not equal final wallet deltas.
- [V4 delta semantics](https://developers.uniswap.org/docs/protocols/v4/guides/unlock-callback-and-deltas): a negative delta is owed to the manager; a positive delta is owed to the caller. Do not apply V3's swap amount signs to V4.
- [Canonical hook address constraints](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol): dynamic fees require a nonzero hook; nonzero static-fee hooks need an action flag; each return-delta flag requires its associated action flag. Key validity does not establish implementation safety.
- [Swap hooks](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/swap-hooks): `sender` is the immediate `PoolManager.swap` caller, often a router.

The adapter's `PROVIDER_CONSISTENT` status means the retained RPC responses agree internally and match the separate configured request. It does **not** establish cryptographic authenticity, exhaustive logs, honest provider behavior, L1 finality, verified source reproduction, or profitability. A provider can return a coherent false transcript. A supplied deployment-source string cannot verify itself. Review the trust manifest independently, retain its provenance separately, and compare another provider or your own node when those stronger claims matter.

## Prepare the request

Copy `examples/v4-request.json` into a working request. Null values deliberately fail validation; the template contains no invented pool IDs, initialization transactions or production bytecode fingerprints. Fill these from the verified deployment and retained pool registry:

- `from_block` and `to_block`: inclusive numeric block range, maximum 200 blocks.
- `manager.expected_code_sha256`: lowercase 64-character SHA-256 of the **deployed runtime bytecode bytes**, excluding the textual `0x` prefix. Obtain the reference bytecode independently from the RPC under evaluation (reviewed deployment artifact with correct immutables, verified explorer data, or a separately authenticated node at the intended block). Do not hash the same unchecked RPC result and call it an independent check. `manager.code_source` records that provenance.
- `pool_id`, sorted `currency0`/`currency1`, their decimals, `fee`, `tick_spacing`, `hooks`: exact V4 key and currency metadata. The adapter recomputes `keccak256(abi.encode(currency0,currency1,fee,tickSpacing,hooks))` and requires the expected ID.
- `base_currency`: which of the two currencies is being evaluated as the meme or base asset. The other becomes the quote asset.
- `initialize_transaction` and `initialize_log_index`: an exact historical `Initialize` receipt log at or before the range's first block. The complete key must match. Initialization discovery is an upstream task.

Maximum 20 pools, 2,000 returned swaps, 2,500 RPC calls, 10 seconds per network request and 180 seconds network wall budget. Native ETH is currency address zero and requires 18 decimals. ERC-20 decimals are independently read at both interval endpoints through hash-pinned `eth_call`; stable metadata between endpoints is an explicit assumption. No loop expands bounds or retries indefinitely.

## Run

Keep authenticated endpoint credentials in the named environment variable; endpoint URLs are excluded from retained transcripts and network-error text. Do not put an API key in the request JSON.

```bash
python3 scripts/v4_evidence.py collect --request /absolute/request.json --rpc-env RH_RPC_URL --out /absolute/v4-bundle.json
python3 scripts/v4_evidence.py verify --request /absolute/independent-request.json --bundle /absolute/v4-bundle.json --out /absolute/v4-verified.json
```

Set `RH_RPC_URL` through the environment's normal credential mechanism before the collect command. The verify manifest must come from your separate reviewed configuration, not from copying an untrusted bundle's `request` member. The verifier regenerates every normalized field using the raw transcript and checks the exact JSON representation, including types. It rejects changed normalized reports, unconsumed calls, missing calls and parameter mismatch. Hashes identify retained bytes and detect changes; they are not signatures.

Collection obtains contiguous headers for the requested interval, hash-pins runtime code and decimals reads using EIP-1898 with `requireCanonical: true`, validates initialization receipts, queries exact pool IDs in at most 10-block shards, binds returned logs to successful transaction receipts and headers, and rereads every observation/initialization block identity. It catches a queried swap omitted from an already fetched receipt's matching event set. It cannot detect an entire transaction omitted by a dishonest or incomplete provider.

If any RPC, code, receipt, metadata, range or reorg check fails, the CLI returns nonzero and retains a `undertow.v4-failed-collection.v1` file with raw calls gathered so far, `status: FAILED`, and no normalized report. Do not feed failed bundles into analytics. EIP-1898 rejection is a collection failure; there is no silent block-number fallback.

Python API:

```python
from v4_evidence import collect, verify, HTTPRPC
bundle = collect(request, HTTPRPC(endpoint))
report = verify(bundle, independent_request)
```

`decode_swap(log, pool)` is a low-level ABI decoder. Calling it alone does not verify initialization, metadata, receipts, chain identity or runtime code. Production interpretation requires `verify()` on a completed bundle.

## Interpret the rows

- `amount0_raw`/`amount1_raw` are signed core swap deltas serialized as decimal strings, not floating point amounts or wallet cash flows. `BUY_BASE` requires positive base delta and negative quote delta; `SELL_BASE` requires the reverse. Zero or nonstandard signs remain explicit.
- `sender` is the immediate caller and `trader` remains null. A receipt's transaction origin is also not sufficient to resolve smart accounts, routers, relays or ultimate economic ownership. Build wallet-flow evidence separately before counting buyers or capital rotation.
- `quote_per_base_mark` derives from `(sqrtPriceX96 ** 2 / 2 ** 192) * 10 ** (decimals0 - decimals1)` when base is currency0, inverted when base is currency1. It is a core spot mark **after that specific swap**. It is not a window-end price unless independent time/coverage conditions establish that, and it is not an executable quote or wallet value. The adapter validates field widths and protocol price/tick bounds but does not replay the swap math or validate exact tick-price consistency.
- `active_liquidity_raw` is V4's current in-range liquidity parameter, not token inventory, TVL, withdrawable liquidity or exit capacity. `pool_inventory` is always null. ERC-20 balances at the singleton combine activity from many pools and cannot be assigned to one pool.
- Every nonzero hook remains `UNKNOWN_HOOK_UNQUALIFIED`; its core event is retained but no claim is made about actual execution costs, taxes, fee exemptions, wallet amounts or redeemability. Hook flags alone do not verify implementation semantics.
- `fee_pips` is the core event's fee, not a complete user fee calculation. Hook fees, routing costs, taxes, gas, and price impact require additional evidence.
- `coverage.independently_complete` is false even when every bounded shard returns successfully. An empty result means the provider returned no matching logs in that scope, not proof of inactivity.

Do not silently convert raw V4 rows into the higher-level capital-flow analyzer input. That input requires provenance for economic actors and wallet amounts which core event collection does not supply. Retain the bundle alongside any separately verified provider/FYNCH conversion and document the adapter mapping.

## Validation evidence

Offline tests use explicitly synthetic headers, receipts, manager runtime bytes and pool keys. Run `python3 -m unittest discover -s scripts -p test_v4_evidence.py -v`. They exercise canonical signed widths, decimal inversion, block changes, receipt inconsistency, known receipt omissions, unknown hooks, tamper detection, request separation, chain identity and collection bounds. They do not establish live deployment correctness.

Live read-only smoke attempt on 2026-09-08: an `eth_chainId` POST to the documented public mainnet RPC timed out after 15 seconds in this environment. No live block, pool, runtime code or swap was verified, and no funds moved. Complete a successful read-only collection and independent verification against a reachable archive provider before claiming live Robinhood adapter validation.
