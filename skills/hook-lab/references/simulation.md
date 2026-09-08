# Pinned read-only call collection

`scripts/simulation.mjs` exports `validateCallRequest(request)`, `digestValue(value)` and `simulateCall(request, { rpc })`. The injected transport implements `async rpc(method, params)` and returns the JSON-RPC result, throwing an error for JSON-RPC failures. Use the supplied bounded HTTP transport; a custom transport must enforce network timeouts and response limits before parsing.

The collector only invokes `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, `eth_getBalance`, `eth_call` and `debug_traceCall`. It never signs, sends, impersonates, seeds balances, changes storage or submits state overrides. It checks chain 4663 and the requested block hash, then rechecks that header after collection. State reads use EIP-1898 `{blockHash, requireCanonical: true}`. Unsupported hash-pinned reads are explicit failures, with no silent fallback to latest. Trace calls use the exact block number between the two header checks because tracer implementations differ in hash-tag support.

## Request

```json
{
  "schema_version": "hook-lab.call.v1",
  "chain_id": 4663,
  "block": {"number": 100, "hash": "0x000000000000000000000000000000000000000000000000000000000000000a"},
  "transaction": {
    "from": "0x0000000000000000000000000000000000000001",
    "to": "0x0000000000000000000000000000000000000002",
    "data": "0x12345678",
    "value": "0x0",
    "gas": "0x186a0"
  },
  "balance_tokens": [
    {"address": "0x0000000000000000000000000000000000000003", "owner": "0x0000000000000000000000000000000000000001"}
  ],
  "context": {
    "identity_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "route_id": "example/only",
    "source_mapping": "unverified",
    "wallet_context": "synthetic"
  },
  "expectations": [
    {"token": "0x0000000000000000000000000000000000000003", "owner": "0x0000000000000000000000000000000000000001", "minimum_delta": "-10", "maximum_delta": "20"}
  ]
}
```

This is a synthetic shape example, not an executable Robinhood deployment. Preserve the actual transaction caller, target, calldata, value and gas. Extra request or transaction fields are rejected. `context` records claims supplied by the caller; it does not establish source verification or actual wallet eligibility. The identity digest may be `sha256:` plus 64 lowercase hex characters, matching the identity module, or a 32-byte `0x` digest. `digestValue` returns Keccak of JSON with recursively sorted object keys, UTF-8 encoded.

The request supports up to 16 unique ERC20 address/owner pairs and 32 unique bounded integer delta expectations. Raw token amounts are decimal integer strings. ERC20 addresses and owners must be nonzero. The zero address is allowed only as the native-currency sentinel in expectations for the transaction sender or another explicitly tracked owner. Native deltas collected by a local fork include gas payments; the read-only collector does not infer or remove gas expenses. Keep native settlement and execution costs separate in later accounting.

## Evidence and limits

Successful collection emits `hook-lab.simulation.v1`, bound to the exact request digest, block, transaction and context. It retains the target runtime code hash, call output or a classified failure, token `balanceOf` observations before the call, sender native balance, call tracer output, and prestate tracer differences. The RPC transcript retains bounded raw results plus byte counts and SHA-256 hashes of their JSON encodings. `evidence_digest` is Keccak of the complete output excluding the `evidence_digest` field itself. A digest detects changes to retained evidence; it does not authenticate the RPC provider.

Each RPC response is capped at 1 MiB, 10,000 JSON values and 48 levels of nesting. Over-limit responses become explicit unavailable evidence. Call calldata is capped at 64 KiB and requested execution gas at 100 million. Tracers request a five-second provider timeout. The transport must also impose its own network deadline. Provider exception messages are discarded because they can include endpoint credentials; controlled error categories, numeric codes and bounded hexadecimal revert data are retained.

| Result | Meaning |
|---|---|
| `CALL_SUCCEEDED_AT_BLOCK` | The exact `eth_call` returned successfully at the requested canonical block; other evidence may be unavailable. |
| `CALL_REVERTED_AT_BLOCK` | The call reverted, with explicit EVM-revert evidence. |
| `INCOMPLETE` | Required chain, code or call evidence is unavailable or inconsistent. |
| `BLOCK_INVALIDATED` | Either block-header check failed or disagreed with the requested hash. |

Inspect `issues` and each trace status even after a successful call. Unsupported tracers do not erase the successful call, but they remain evidence gaps. A mismatch between call output and the matching call trace marks the overall result incomplete. A trace from another wallet or with different calldata is invalid and cannot establish caller eligibility.

`wallet_deltas.status` always remains `UNKNOWN`; delta rows are null. Requested expectations remain `UNVERIFIED`. A token's return value can be nonstandard or dishonest, and a proxy can use arbitrary storage, so neither raw storage differences nor transfer logs are converted into token balances. Use the separately isolated local-fork collector for before/after balances and receipts. Even a complete fork result qualifies only its exact evidence scope after identity, family, caller, amount, settlement and cost checks.

A call at block N uses the state after that block. It does not reconstruct the pre-state of an arbitrary transaction inside block N. Historical transaction replay requires the correct parent state and preceding transactions; this collector makes no such claim.
