# Supply and observed destinations

`scripts/supply.mjs` exports `validateDataset(data)` and `analyzeSupply(data)`. Both are deterministic and read only the supplied object. Invalid representation throws a `TypeError`; valid evidence that fails accounting produces a report containing the mismatch. They never fetch a price, execute a swap, infer a wallet owner, or equate minted supply with available liquidity.

## Window and evidence contract

The schema is `pressure.dataset.v1`, chain ID 4663. Every raw token amount is a canonical, nonnegative uint256 decimal string; every block number, timestamp, transaction index, and log index is a nonnegative safe integer. Addresses are 20-byte `0x` hex strings; block, transaction, and code hashes are 32-byte hex strings. Case is ignored for identity.

Required top-level fields:

| Field | Contents |
|---|---|
| `evidence_mode` | `rpc_observed`, `retained`, or `synthetic`; carried into the report unchanged |
| `token` | `address`, `decimals` (0–36), `expected_code_hash` |
| `window` | `start` and `end`, each `{number, hash, timestamp}` |
| `snapshots` | `start` and `end`, each `{total_supply_raw, multiplier_raw, code_hash, balances:[{address,balance_raw}]}` |
| `headers` | Ordered `{number,hash,parent_hash,timestamp}` rows, including both window endpoints |
| `transfers` | Ordered `{block_number,block_hash,transaction_hash,transaction_index,log_index,from,to,amount_raw}` rows for this exact token |
| `coverage` | `{method,complete,canonical_rechecked,missing_blocks,evidence_refs}`; method is `full_receipts`, `log_query`, or `supplied` |
| `attributions` | `{address,category,label,valid_from_block,valid_to_block,evidence_refs}` rows |

Extra provenance fields are preserved in input and may be consumed by collectors. The supply analyzer does not authenticate them. Decimals come from the observed token configuration; the fixed `uiMultiplier` scale is 10^18. Zero multipliers are unsupported.

Both snapshots describe **end-of-block state**. Transfers are therefore collected over **(start block, end block]**. Including start-block events double counts changes already in the baseline. A same-block snapshot comparison is accepted as `EMPTY_WINDOW`, without a time-window absence claim. The maximum elapsed range is 100,000 blocks; the native collector applies a substantially smaller operational limit.

Complete coverage requires every header from start through end, no reported missing blocks, and a canonicality recheck. The analyzer checks adjacent parent hashes, timestamps, endpoint identities, event block hashes, globally ordered block log indices, and consistent transaction positions. Conflicting or duplicate events are rejected. Both boundary snapshots must cover the same unique tracked addresses. Header and transfer validation do not prove that a provider returned every receipt, every log, or a valid canonical chain.

Use the collector's transcript replay validator before treating a captured dataset as its actual output. A hand-authored `complete:true` is a claim, not evidence authentication. `log_query` and `supplied` reports expose an explicit completeness limitation even when arithmetic matches. Receipt enumeration is also provider reported unless an independent receipt-trie proof exists.

## Raw supply reconciliation

For the supported standard-transfer semantics:

```
expected_end_supply = start_supply + observed_zero_sender_mints - observed_zero_recipient_burns
reconciliation_difference = observed_end_supply - expected_end_supply
```

Zero-amount logs contribute no issuance. Zero-to-zero transfers are rejected because their issuance interpretation is ambiguous. Self-transfers contribute no balance change.

For each tracked address:

```
expected_end_balance = start_balance + observed_incoming - observed_outgoing
```

Incoming/outgoing amounts exclude self-transfers, which are separately reported. Mint and burn subsets are also separated. Differences are retained exactly, without clipping negative expected balances or silently filling gaps. Disjoint measured balances exceeding the reported total supply cause a reconciliation failure.

`supply.observed_minted_raw` and `observed_burned_raw` describe retained events even in a partial window. `supply.net_issuance_raw` remains null unless boundary identity, canonical coverage, raw supply accounting, and every tracked balance reconcile. Raw boundary changes remain visible as `snapshot_supply_change_raw`; an unexplained boundary change is not relabeled as a mint.

Statuses:

| Status | Meaning |
|---|---|
| `RECONCILED_WINDOW` | Supplied boundaries, event totals, tracked balances, and coverage claims agree |
| `PARTIAL_WINDOW` | Arithmetic may agree, but coverage or canonical recheck is incomplete |
| `RECONCILIATION_FAILED` | Supply or tracked balance evidence disagrees |
| `SEMANTICS_UNVERIFIED` | Boundary token code differs from the expected code hash |
| `EMPTY_WINDOW` | Equal start/end block; no elapsed observation interval |

A matching code hash does not resolve proxy implementation storage, mutable dependencies, or unusual token behavior. Review the exact source/deployment semantics and invalidate interpretation when those dependencies change. `RECONCILED_WINDOW` is an accounting result, not verification of stock backing, contract safety, provider honesty, or trading access. Synthetic evidence remains synthetic even when all equations hold.

## Multiplier decomposition

Let `S` be raw supply, `M` the raw display multiplier, and `D = 10^decimals * 10^18`. Display-adjusted supply is `S*M/D`. All outputs are reduced exact `{numerator,denominator}` fractions, preserving very small and negative changes.

The analyzer uses a symmetric attribution of the cross term:

```
raw-supply component = (S1-S0) * (M0+M1) / (2*D)
multiplier component = (M1-M0) * (S0+S1) / (2*D)
total change = raw-supply component + multiplier component
```

This is an accounting decomposition with no assumed event ordering between the boundaries. It is not a causal estimate. A multiplier adjustment changes displayed stock units and does not add raw mint events. Its actual cause requires separate corporate-action evidence.

## Destinations, attribution, and holdings

`direct_mint_destinations` records the actual recipient of each zero-sender mint event, grouped by address and the attribution valid at that event. This is the direct issuance destination.

`mint_recipient_followup` records that recipient wallet's outgoing activity after its first observed mint. A recipient may already hold tokens, receive ordinary transfers, burn tokens, or send more than it just received from issuance. The report intentionally does **not** identify which subsequent units were minted. It supplies event references and opening balances when measured, so an investigator can explain what was actually observed.

An observed transfer to a venue is not proof of a sale, liquidity addition, fee payment, beneficiary identity, or issuer intent. Assigning transfers to an individual V4 pool requires a separate transaction-aware adapter. The canonical Robinhood V4 manager address is always labeled `v4_manager_aggregate_not_pool_inventory` in holdings and destination outputs.

Attribution categories are `issuer`, `venue`, `custody`, `treasury`, `locker`, `burn`, and `unknown`. A label requires an evidence reference and an inclusive block validity interval. Overlapping label intervals for one address are rejected. Expired or not-yet-valid labels become unknown at the relevant observation. A label alone does not establish common ownership or account control.

Boundary balance buckets include each tracked address once. `unmeasured_address_balances_raw` is only total supply minus the sum of those disjoint measured balances. It is **not** circulating supply, free float, sale inventory, or route capacity. Unknown tracked addresses remain in the unknown bucket rather than acquiring a convenient category.

## Included synthetic case

`assets/supply.synthetic.json` contains deliberately fictional evidence using chain ID 4663 and the canonical manager address only to exercise labeling. It is not a capture of real Robinhood transfers.

It begins with 10,000 raw whole tokens, mints 1,000 to an issuer-labeled address, burns 100, and ends with 10,900. The multiplier changes from 1x to 2x, making displayed supply move from 10,000 to 21,800. The exact symmetric components are 1,350 from raw supply change and 10,450 from multiplier change. The issuer sends 600 to the manager, receives 200 from another wallet, sends 300 to custody, and burns 100. The follow-up reports those wallet flows without asserting that the minted units reached a particular pool.

Run the module's meaningful invariant tests:

```sh
node --test scripts/test_supply.mjs
```
