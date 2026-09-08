# Flow evidence contract v1

Run `python3 scripts/flows.py --input examples/flows.json --output /tmp/undertow-flows.json`, or import `analyze_flows(payload)` from `scripts/flows.py`. Python standard library only. The example is synthetic: its token and pool identities and amounts are invented. A documented manager address in a fixture does not establish that the example pools exist.

The module analyzes retained, normalized swap observations supplied by another collector. It does **not** connect to FYNCH, verify traces or signatures, calculate a V4 PoolId, collect chain logs, find prices, identify people, or execute trades. `verified` fields represent the upstream adapter's explicit assertions and evidence references, not verification performed by this module.

## Identity and time

- Top-level `chain_id`: integer `4663`. All swap records repeat it. Other chains fail validation.
- `knowledge_cutoff`: nonnegative Unix timestamp in whole seconds, the latest permitted knowledge time.
- `window`: `{ "start": integer, "end": integer }`, a nonempty half-open `[start,end)` interval ending at or before the cutoff.
- Optional `baseline`: the same shape, ending at or before `window.start`. Missing baseline means new-buyer comparisons are unknown.
- Optional `rotation_horizon_seconds`: positive integer, default `3600`, maximum 30 days. This is an explicit research linking interval, not a calibrated trading parameter.
- Optional `dataset_label`: nonempty source label retained verbatim in the report; default `Unclassified supplied evidence`. Mark synthetic examples explicitly. A label does not verify provenance.
- Observation, metadata, coverage and valuation `known_at` values must reflect actual first availability to the analysis system. Do not substitute the event timestamp for ingestion time on a historical import.
- Events, assets, pools, coverage and valuations unknown by the cutoff cannot contribute. If the cutoff is later than `window.end`, the report says `retrospective_as_of_cutoff`; such a report is not evidence of an alert available at window end.
- Changing an older observation after learning new facts requires retaining the earlier version separately; this module does not supply a versioned observation store or prove ingestion timestamps.

## Asset and pool registry

`assets` is an object keyed by a full `0x` 20-byte address. Each value contains:

| Field | Type and meaning |
| --- | --- |
| `decimals` | Integer 0–255; verified externally for exact unit conversion. |
| `kind` | `meme`, `stock`, `cash`, or `other`; supplied classification, not inferred from ticker. |
| `standard_token` | Boolean; true only when the adapter has verified the normalized swap effect assumptions. Rebasing, transfer-tax and otherwise unsupported effects require false. |
| `known_at` | Unix seconds. |
| `evidence` | Nonempty retained reference establishing metadata and classification. |

`pools` is a list. Identity is the exact `(manager, pool_id)` on chain 4663. Each entry contains full address `manager`, 32-byte hex `pool_id`, sorted distinct address `currency0` and `currency1`, address `hooks`, integer `fee` (0–1,000,000, or `8388608` for V4's dynamic-fee flag), integer `tick_spacing` (1–32767), `known_at`, `evidence`, and `adapter_status` (`verified` or `unsupported`). A `verified` adapter also requires `normalization_evidence`.

Both currencies must be in `assets`. Currency identity, decimals, PoolKey, manager deployment and the computed pool ID must be verified upstream. A hook address, including the zero address, is not by itself sufficient to establish normalized wallet effects. Unsupported hooks remain visible in the topology; swaps touching an unsupported adapter are quarantined.

All assets and pools known by the cutoff remain in the report, including candidates with zero observations. This is the **supplied registry universe**, not a claim to cover all Robinhood Chain pools. Expanding that universe after the fact is a retrospective change.

## Coverage

`coverage` is a list of `{manager,pool_id,start,end,known_at,status,evidence}`. Status is `complete`, `partial`, or `unknown`. A complete interval cannot be known before its end. For each comparison window, exact matching interval entries are required for **every registered pool involving the asset**. This conservative v1 does not stitch shards together; the collector must reconcile and attest the whole interval first.

`reported_complete` means all these source assertions say complete and the analyzer has no quarantined transaction involving that asset in that interval. It is not independently proven completeness. Missing records, missing coverage, incomplete attribution, unsupported adapters and filtered records cannot be treated as zero activity or a zero-size historical cohort.

## Normalized swap records

`swaps` is a list with these required fields:

| Field | Required interpretation |
| --- | --- |
| `event_type` | Exactly `swap`. Do not insert ERC-20 Transfer records as additional trades. |
| `chain_id`, `manager`, `pool_id` | Exact registered identities. |
| `block_number`, `block_hash` | Nonnegative integer height and full 32-byte canonical block hash. |
| `tx_hash`, `transaction_index`, `log_index` | Full transaction hash and nonnegative integer indices. |
| `timestamp`, `known_at` | Block time and actual first-observed time; known time cannot precede event time. |
| `canonical` | Boolean assertion from upstream chain reconciliation. False records are excluded. Conflicting canonical hashes at the same height fail. |
| `transaction_complete` | Boolean upstream assertion that all economic swap legs needed to net the attributed wallet's transaction are retained and reconciled by `known_at`, including routing legs. False quarantines the entire transaction. |
| `amount0_raw`, `amount1_raw` | Signed decimal integer **strings**, opposite nonzero signs, absolute magnitude below 2²⁵⁶. Positive is a normalized amount received by the attributed wallet, negative is spent. These are not copied blindly from the V4 Swap event's pool-oriented deltas. |
| `attribution` | Object described below. |
| `suspected_activity` | Boolean externally supported filter flag. True excludes the transaction; it does not prove automation, manipulation or a common owner. |
| `evidence` | Nonempty retained source/normalization reference. |

Attribution has `method`, `wallet` and, for verified methods, `evidence`. Allowed methods:

- `verified_trace` or `verified_wallet_effects`: require the exact full wallet address and retained attribution evidence. These are the only included methods. Upstream verification must bind the economic beneficiary and effects to this event/transaction; an arbitrary transaction origin or sender label is insufficient.
- `router_sender` or `unknown`: may have a candidate address or null, but are excluded. **Uniswap V4's event sender is commonly a router and cannot be counted as a buyer.**

Event identity is `(chain_id,block_hash,tx_hash,log_index)`. Byte-equivalent JSON values with different object key order are deduplicated. Conflicting duplicates fail closed rather than selecting the more convenient record. Duplicate conflicts are checked before time filtering so contradictory supplied evidence cannot silently pass. Hex identity comparisons are case-insensitive, but different raw event encodings under the same identity conservatively count as a conflict.

Canonical block `log_index` values are block-wide: a `(block_hash,log_index)` slot cannot belong to two different transactions. Canonical transaction index slots and block timestamps must also agree.

If any in-scope leg has unknown attribution, suspected activity, an incomplete transaction, unknown-at-cutoff registry identity, or unsupported effects, **all retained records for that transaction are quarantined**, even for other attributed wallets. This conservative rule prevents a dropped routing leg from manufacturing net demand. `excluded_records_by_reason` shows direct exclusions and total quarantined records; those counters overlap and must not be summed as mutually exclusive categories.

The analyzer trusts `transaction_complete` and cannot detect an omitted leg it was never supplied. The upstream collector must verify this assertion using complete transaction evidence and wallet attribution. A partial trace plus a pool event is insufficient.

## Aggregation and cohort interpretation

Included legs are netted by `(window,wallet,tx_hash,asset)` before net participation counts. An asset bought and then fully spent in the same transaction has zero net participation, although its gross buy and sell swap counts remain visible. Amounts never net across different wallets or transactions for participation purposes.

Each asset row reports gross buy/sell swap counts, positive/negative wallet-transaction counts, unique net buying/selling wallet addresses, zero-net transaction counts, positive/negative/net raw quantities, and the net quantity in original token units. A wallet can appear on both buyer and seller lists. `wallet_transaction_deltas` provides the underlying net amounts, transaction and block hash, and contributing pool identities. These are swap-observation deltas, **not complete wallet balances**.

`quote_cashflows` preserves each stock or cash asset in its own original units. It never adds NVDA units, other stock tokens, and USDG units into an invented dollar total. Nor does `cash` classification imply a stablecoin is presently worth one USD.

`newly_observed_buyers_vs_baseline` compares current net buyers against **all baseline participants with a nonzero wallet-transaction net delta**. It is populated only when both windows have `reported_complete` coverage. It means newly observed within this supplied baseline and pool universe; it does not mean a new person, first-ever buyer, new wallet, independently controlled participant, or new capital entering the chain.

## Cross-family sequences and optional comparable notionals

A meme endpoint has a stock family only when every contributing direct meme pool in its wallet-transaction group has the same stock quote. Mixed direct quote families are ambiguous and yield no rotation endpoint. Intermediate stock/cash routing legs may net out elsewhere in the transaction.

For a wallet with an unambiguous single meme endpoint per transaction, each buy can link to the latest unmatched earlier sale from a different stock family inside the configured time horizon. Chain height and transaction index establish order, not input list order. The endpoints must be in different transactions; same-transaction swaps are routing, not this v1's rotation signal. Each sale can be used at most once. Multiple eligible meme endpoints in a transaction are omitted rather than allocating flows arbitrarily.

The link is a **same-wallet ordering heuristic**, not proof that sale proceeds funded the buy. No conclusion about common ownership across wallet addresses is inferred.

Without valuations, links contain no monetary size. Optional `valuations` entries contain `{wallet,tx_hash,asset,asset_amount_raw,numeraire,cashflow_raw,known_at,basis,evidence}`:

- `basis` must be `verified_tx_net_cashflow`; `numeraire` is a registered `cash` asset address, never a ticker or bare `USD` label.
- `asset_amount_raw` is the positive absolute amount of the entire meme endpoint. `cashflow_raw` is the signed net numeraire amount. Both must exactly reconcile to the analyzer's supplied normalized transaction deltas and have opposite signs.
- The transaction can have only one nonzero meme endpoint. Otherwise a shared cashflow cannot be allocated without additional evidence and the valuation fails.
- Its only nonzero net asset endpoints must be that meme and the stated cash numeraire. All included swaps attributed to that wallet in the transaction must form one connected directed simple path between them, with intermediate quantities netting to zero. Unrelated stock sales, disconnected trades, cycles, split routes and branching fail this narrow valuation check. Even an unrelated roundtrip that ends with zero stock inventory could otherwise pollute meme proceeds. Complex executions require a separately verified scoped allocation adapter.
- `known_at` must be no earlier than the transaction time and no later than the cutoff; future valuations do not contribute.
- Only sale and buy valuations in the **same numeraire address** produce `comparable_notional`, the minimum of sale receipts and purchase spending. This is a conservative comparable amount from supplied transaction cashflows, **not proven transferred proceeds, realized profit, USD value, or execution capacity**.

This v1 deliberately does not translate unrelated stock quote units with an assumed market price. Add a separately verified and time-scoped valuation adapter before broadening that capability.

## Topology and limitations

`shared_quote_topology` groups registered meme pools by a stock or cash quote. It reports member asset identities and pool counts, including unsupported adapters. It contains no reserve, TVL, covariance, position-size, or holdings inference. `measured_exit_capacity` stays null: V4's shared manager balance is not a pool reserve, and a relationship map cannot establish executable liquidity.

The report contains no alpha score or implied recommendation. Participation and rotation can motivate further investigation with retained transaction evidence, but neither establishes future returns. Execution simulation, whole-wallet accounting, chain canonicality verification, source completeness, profitability evaluation, and prospective outcome tracking remain separate work.
