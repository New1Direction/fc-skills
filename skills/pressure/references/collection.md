# Pinned supply collection

`scripts/collect.mjs` exports `collectSupply(request, {rpc})`,
`validateCollectRequest(request)`, `validateCollection(report)` and
`collectionDigest(value)`. The injected async RPC function accepts `(method,
params)` and returns the JSON-RPC result. The CLI supplies the bundled bounded,
read-only transport. No signing key or transaction submission method is used.

## Request

```json
{
  "schema_version": "pressure.collect.v1",
  "chain_id": 4663,
  "token": {
    "address": "EXACT_TOKEN_ADDRESS",
    "decimals": 18,
    "expected_code_hash": "EXPECTED_RUNTIME_KECCAK256"
  },
  "start": {"number": 100, "hash": "EXACT_START_BLOCK_HASH"},
  "end": {"number": 101, "hash": "EXACT_END_BLOCK_HASH"},
  "tracked_addresses": [],
  "attributions": []
}
```

Placeholders must be replaced; this example is not a live target. Optional
`evidence_mode: "synthetic"` marks local test evidence. Default `rpc_observed`
means the supplied RPC was observed, not that its claims were independently
authenticated. Use exactly identified token addresses, block hashes, decimals
and source-reviewed expected code hashes; never resolve a ticker silently.

Attributions use `{address, category, label, valid_from_block, valid_to_block,
evidence_refs}`. The supported categories are `issuer`, `venue`, `custody`,
`treasury`, `locker`, `burn` and `unknown`. Block validity is finite and inclusive.
These are supplied labels with source references, not identities discovered or
verified by this collector. A mint recipient is not automatically an authorized
participant, and a transfer to a venue is not proof of a sale or liquidity add.

## What is retained

1. Chain ID and every header from start through end, including transaction-hash
   lists. Header numbers, parent links, endpoint hash pins and nondecreasing
   timestamps must agree.
2. Runtime code, `totalSupply()`, `decimals()`, `uiMultiplier()` and all requested
   `balanceOf(address)` values at both endpoint hashes, using EIP-1898
   `{blockHash, requireCanonical: true}`. There is no substitution with latest
   state, numeric-block fallback or default multiplier on a failed read.
3. Every receipt for every enumerated transaction in **(start, end]**, including
   unrelated and reverted transactions. Receipt transaction order, block identity,
   status, every log's identity, and contiguous block-wide log indices are checked.
4. Canonical start and end headers and chain ID rechecked after collection. A
   changed header or transaction list invalidates the dataset.

Only the requested token's standard ERC-20 `Transfer(address,address,uint256)`
events produce normalized transfer rows. A companion ERC-8056
`TransferWithScaledUI` event remains in the raw receipt and is not counted again.
Token amounts remain exact decimal integer strings in the ERC-20's raw unit.
`uiMultiplier()` is retained separately in **18-decimal scale**, regardless of
token decimals. Supply reconciliation and multiplier decomposition happen in the
supply analyzer. ERC-721-shaped transfers, malformed ABI words, removed logs,
failed receipts carrying logs and ambiguous zero-to-zero transfers are rejected.

## Bounds and results

The window contains at most **64 receipt blocks** (`end.number - start.number`),
plus its starting snapshot header. It permits at most **256 transaction receipts**,
20 tracked addresses, 100 supplied attributions, 32,768 total receipt logs,
512 RPC calls, a 2 MiB individual retained result and a 16 MiB transcript. The
starting block's receipts are excluded because its post-block state is the
baseline. A same-block window is allowed and contains no intervening receipts.

Budget violations return `INCOMPLETE` with `dataset: null`. They never truncate
rows into a complete result. Reduce the window or tracked-address set and make
separately pinned captures. Do not describe concatenated windows as a continuous
history until boundaries, identities, duplicate rows and coverage reconcile.

Success returns `pressure.collection.v1` with status `COLLECTED_AT_BLOCK`, the
`pressure.dataset.v1` dataset, retained request, raw RPC transcript, issues and a
canonical SHA-256 digest. Other statuses are `INVALID_REQUEST`, `INCOMPLETE`,
`RPC_UNAVAILABLE`, `INVALID_EVIDENCE`, `IDENTITY_MISMATCH` and
`CANONICALITY_FAILED`; none carries a promoted dataset. Error records keep only
a numeric RPC code and a fixed failure category. Provider error prose and RPC
endpoint values are not copied into diagnostic errors.

`validateCollection(report)` checks the digest, replays the exact retained RPC
calls through the collector, requires the same derived dataset and consumes every
transcript entry. Valid replay returns `VALID_RETAINED_COLLECTION`. This catches
accidental changes, modified normalized data, missing calls and inconsistent
retained results. It is not a digital signature or external source authentication.

## Scope of evidence

`coverage.complete` means **all transaction receipts in the provider's enumerated
window were collected and internally checked**. It is stronger than an unbounded
`eth_getLogs` result whose truncation behavior is unknown. It does not prove the
provider supplied a truthful transaction list, every log in a receipt, or valid
receipt-trie inclusion. The collector does not recompute consensus block hashes
or transaction/receipt roots. A provider that consistently fabricates or removes
the final log can evade these local consistency checks. Supply and tracked-wallet
balance reconciliation add independent observations from the same provider;
cross-provider agreement or verified trie proofs would establish more evidence.

Runtime code matching at two endpoints only identifies those code bytes at those
endpoints. It does **not** establish stable proxy implementation, unchanged beacon
or mutable dependency configuration, absence of intermediate upgrades, trusted
token semantics, backing or issuer identity. Record those unknowns and use
HOOK LAB or a source-specific identity adapter when needed. A successful supply
capture does not qualify a hook, route, wallet call, pool inventory or trade.

The collector reads token balances at tracked addresses. A Uniswap V4 singleton
manager's balance aggregates many pools and settlement obligations; it must never
be reported as one pool's tradable inventory. Pool liquidity pressure requires
route-specific, size-specific evidence collected separately.

Primary semantics: [Robinhood stock tokens](https://docs.robinhood.com/chain/building-with-stock-tokens/),
[ERC-20 Transfer](https://eips.ethereum.org/EIPS/eip-20), and
[EIP-1898 block-hash state queries](https://eips.ethereum.org/EIPS/eip-1898).
