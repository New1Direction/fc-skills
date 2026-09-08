# Exact-case evidence consistency

`await qualifyEvidence(bundle)` in `scripts/qualify.mjs` checks one supplied direct
two-asset swap case. It performs no network calls. It replays the identity and
simulation collectors over retained raw RPC responses, invokes the fork report's
consistency validator, and checks the relationships between those reports.

**This is a local evidence consistency checker.** Digests are not signatures.
Self-consistent fabricated evidence can pass. The checker cannot authenticate the
RPC provider, collector process, source reviewer, source artifact or wallet owner.
An agent must inspect those origins separately and preserve whether evidence is
synthetic, supplied, or independently collected when presenting a result.

## Input

```json
{
  "schema_version": "hook-lab.qualification.v1",
  "manifest": "<deployment.v1 object>",
  "identity": "<identity.v1 report>",
  "call_request": "<call.v1 object>",
  "simulation": "<simulation.v1 report>",
  "fork": "<fork.v1 report; omit when unavailable>",
  "source_review": {
    "status": "verified",
    "deployment_manifest_digest": "sha256:<64 lowercase hex>",
    "call_request_digest": "0x<64 hex>",
    "source_commit": "<40 hex commit>",
    "compiler": "<exact compiler/build identification>",
    "artifact_sha256": "<64 hex>",
    "review_refs": ["git:<retained review reference>"],
    "calldata_review_refs": ["git:<exact calldata/caller mapping review>"],
    "access_scope": "permissionless",
    "reviewed_contracts": [
      {
        "address": "0x<40 hex>",
        "expected_code_hash": "0x<64 hex keccak runtime hash>",
        "source_commit": "<40 hex commit>",
        "compiler": "<compiler/build identification>",
        "artifact_sha256": "<64 hex>",
        "review_refs": ["git:<retained review reference>"]
      }
    ]
  },
  "costs": {"status": "unknown"}
}
```

Placeholders above describe the shape and are not runnable evidence. Generate
`deployment_manifest_digest` with `identityHash(validateManifest(manifest))` and
`call_request_digest` with `digestValue(validateCallRequest(call_request))`.
The call context's `identity_digest` is the identity collector's observation
digest, distinct from either of these digests.

Source review `status: verified` is the submitter's claim, **not a verification
performed by this checker**. When no review exists, supply
`{"status":"unverified"}`; do not manufacture the other fields. Review references
must use `https://`, `git:`, or `sha256:`. Keep private credentials out of URLs.
`reviewed_contracts` must cover every declared contract, implementation and beacon
exactly once, with the same expected runtime hash. Nested implementations and
mutable dependencies still need explicit discovery and review; an omitted real
dependency cannot be inferred from a supplied graph.

`access_scope` accepts `permissionless`, `wallet_specific`, and `unknown`. A
historical transaction from an allowlisted owner does not establish a
permissionless route. A wallet-specific case remains separately labeled and
cannot receive the positive exact-case status. Even permissionless access is a
review assertion bound to this case, not an automatically established contract
property or a promise about another wallet.

## Positive-case requirements

- Chain 4663, the same exact block number/hash, manifest, identity observation
  digest, transaction sender/target/calldata/value/gas and route identifier.
- A source review bound to that manifest and exact call request; full declared
  contract/implementation/beacon review coverage; supplied permissionless scope.
- Identity RPC replay matches the complete retained report. All expected code and
  configuration checks match, the source block is rechecked, and no identity
  failures remain. The actual transaction target is a declared router with code.
- Pinned wallet `eth_call` succeeds with the actual requested wallet context.
  Unavailable optional debug tracers are retained; contradictory or malformed
  call-trace evidence blocks qualification. Calls and trace results do not stand
  in for wallet balance deltas.
- The fork request matches exactly. The local child is based on the same block
  hash and executes in its next local block. No balance/state override or sender
  substitution is allowed. Only the actual requested sender is impersonated.
- Actual fork pre/post balances cover both PoolKey currencies at the sender and
  native gas money. Fork prebalances match the pinned RPC observations. Every
  requested balance expectation is tested and passes. All observed nonnative
  tokens are covered by the manifest.
- The two pool currency deltas have opposing nonzero signs. For a native currency,
  the expectation applies to the raw native balance change including local gas;
  local gas is added back only to derive the swap's direction and amount.
- The successful local receipt retains a canonical-manager V4 `Swap` event for
  the exact `pool_id`, with a valid event shape. A successful call to the same
  router that touches a different pool does not qualify this pool.

Same-asset arbitrage round trips, a different recipient, liquidity operations,
and broader route/intermediate-token reconciliation are outside the positive
case supported by this checker. Retain them for a verified external adapter or
Ape's route-level analysis. This is not an interpolation rule over trade sizes.

## Output and failure evidence

The report exposes source, identity, call, and fork stages separately. Statuses:

| Status | Meaning |
| --- | --- |
| `EXACT_CASE_EVIDENCE_CONSISTENT` | All checks pass for this supplied case only |
| `WALLET_SPECIFIC_EVIDENCE_ONLY` | Source review says access depends on the wallet |
| `EXECUTION_REJECTED` | Consistent retained evidence includes call/fork rejection |
| `INCONSISTENT_EVIDENCE` | A digest, raw response, relationship or required invariant disagrees |
| `INSUFFICIENT_EVIDENCE` | Required qualification evidence is unavailable or unqualified |

`INCONSISTENT_EVIDENCE` takes priority over other statuses; a retained execution
rejection takes priority over wallet-specific classification. Every output has
`qualified_for_execution: false`, `evidence_authenticity: UNESTABLISHED`, and
`net_profit: null`, including the positive consistency status. A caller must not
interpret this report as an instruction or authorization for a live executor.

Failure evidence is retained and recomputed. A successful next-block fork cannot
erase a pinned `eth_call` revert. Missing raw responses, rehashed fabricated
summary fields, removed failure markers and fabricated balance deltas cannot be
used to bypass consistency checks. This does not prevent fabrication of an
entire self-consistent source transcript; authentic provenance is a separate
question.

Code, proxy, configuration or block hash drift against the manifest invalidates
identity qualification. The report qualifies observations at its named block;
it does not inspect subsequent blocks. Recollect and rerun for a new block,
wallet, router, amount, calldata or configuration before any operational use.

## Cost claims

`costs.status` is `unknown`, `partial`, or `complete`. Optional `items` have:

```json
{
  "kind": "local_execution_gas",
  "asset": "0x0000000000000000000000000000000000000000",
  "amount_raw": "21000",
  "evidence_refs": ["sha256:<retained cost evidence digest>"]
}
```

Kinds are `local_execution_gas`, `l1_data_fee`, and `other`. A local gas item must
be unique, native-denominated, and exactly equal the fork receipt's gas used
times effective gas price. A `complete` claim needs nonempty `items` and
`coverage_refs`. Other cost items and completeness remain supplied assertions;
they are not automatically authenticated, summed across assets, or converted to
a numeraire. Local Anvil execution does not reproduce Nitro-specific L1 data fees
or guarantee Robinhood execution gas. The output therefore always reports
`live_chain_cost_completeness: UNESTABLISHED` and `net_profit: null`.

## Bounds and tests

Input is finite plain JSON, at most 16 MiB, depth 64 and 300,000 visited values.
Identity replay permits 50 calls, simulation replay 100 entries, and the fork
validator applies its own 1 MiB/256-observation bounds. No network collection,
unbounded retry, transaction submission, file access or dynamic code loading is
performed by qualification.

Run `node --test scripts/test_qualify.mjs`. The test fixture fabricates RPC and
fork transcripts and is explicitly synthetic. Mutation checks cover changed
wallets/blocks/code/calldata, unavailable raw evidence, corrupted and recomputed
digests, overridden/fabricated balances, dropped failures, wrong pool events,
missing source dependencies, privileged wallet claims and unsupported profit
claims. A native-input fixture verifies the separation of gas from swap deltas.
