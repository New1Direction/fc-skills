# Exact-state preflight

`collectPreflight(built, {rpc, expected_code_hashes?})` accepts a validated compiled route and an injected read-only RPC function. `validatePreflight(built, report)` asynchronously replays the retained transcript without a network connection. Runtime requires Node.js 24 or newer. The report schema is `circuit.preflight.v1`.

Every state read uses EIP-1898 `{blockHash, requireCanonical: true}`. The collector checks chain 4663 and the exact block number, hash, and timestamp before observations and checks the same canonical header afterward. It separately observes `eth_blockNumber` and reports head lag; it never relabels pinned observations as current. Unsupported hash-pinned methods yield `INCOMPLETE`; there is no `latest` fallback. Each RPC call is limited to 12 seconds, the collection to 90 seconds, calls to 64, each response to 256 KiB, and the returned report to 1 MiB. Large, non-JSON, or malformed responses fail closed.

Observed participants include the router, PoolManager, supplied Permit2, wallet, every path currency, and every nonzero hook. Required contracts must have code. The first adapter requires an ordinary EOA with empty code; contract wallets and delegated EOA code are unsupported. The router's `poolManager()` getter must match the exact supplied manager. Token balances are read for every wallet/router pair in the compiled request. The wallet's native balance is compared with transaction value, while gas affordability remains unmeasured.

For an ERC-20 input, the collector reads both token `allowance(wallet, Permit2)` and Permit2 `allowance(wallet, token, router)`. The latter must return exactly `(uint160 amount, uint48 expiration, uint48 nonce)`. Both amounts must cover the exact prepaid input and expiration must reach the route deadline. Empty, oversized, negative, or otherwise nonstandard ABI results are never treated as an approval. Native input skips these approvals. This is observation only: the collector never creates approvals or permits.

`expected_code_hashes` may contain at most 16 exact route-participant addresses mapped to runtime Keccak-256 hashes. Mismatches block the candidate. Caller-supplied hashes do not prove source correspondence. Universal Router's Permit2 immutable is internal and has no getter, so observing the supplied Permit2 contract and allowances does not prove that the router uses it. `source_mapping` stays `UNVERIFIED` and `permit2_correspondence` stays `UNVERIFIED_INTERNAL_IMMUTABLE`; full deployment identity needs a separately verified source/build/runtime adapter.

The source facts are pinned to [Universal Router 2.1.1 PaymentsImmutables](https://github.com/Uniswap/universal-router/blob/999d561c3ad58fb5cab91b602911f3c75591a9c7/contracts/modules/PaymentsImmutables.sol) and [V4 periphery ImmutableState](https://github.com/Uniswap/v4-periphery/blob/3231810e39b8c4d569b9d66907fa4ef8cd2cec22/src/base/ImmutableState.sol), which exposes `poolManager`. Consult the router source lock for the complete dependency revision. No mutable default address is assumed by preflight.

Statuses:

- `PREFLIGHT_OBSERVED`: the required bounded reads completed without a detected prerequisite failure. It does not mean the route will execute or make money.
- `PREFLIGHT_BLOCKED`: a measured prerequisite failed, such as an allowance, wallet balance, manager identity, expected code hash, or canonical block check.
- `INCOMPLETE`: missing, unsupported, malformed, oversized, or timed-out evidence prevents a complete assessment. This takes precedence when there is also a measured failure.

Always retain the exact route and preflight report together. The digest and transcript replay detect inconsistent evidence, altered conclusions, and dropped observations; they cannot authenticate a provider or establish future state. Pool liquidity, hook-specific behavior, complete Permit2 correspondence, and whole-call success require separate evidence. Use the exact wallet call in an isolated fork for execution measurements; preflight alone never establishes permissionless access, executable size, or profit.
