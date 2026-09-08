# Native retained-observation traction analysis

`scripts/analyze_traction.py` is a bounded, offline Python standard-library engine. It compares two equal-duration windows of normalized swaps that a caller has already retained. It does not collect, decode or independently authenticate transactions. The supplied venue scope and evidence availability are assertions to audit against retained source material.

```bash
python scripts/analyze_traction.py assets/synthetic-traction.json --output /tmp/ignition-traction-example.json
python scripts/test_analyze_traction.py
```

The example is entirely synthetic. Use a new output filename for each run: existing files and symlinks are rejected. No command makes network calls, trades, posts or changes the input. Reports contain no generated timestamp, so identical input bytes and rule version produce identical report bytes.

## Input: `ignition.observations.v1`

The input must be strict UTF-8 JSON. Duplicate object keys, NaN/Infinity, extra or missing fields, duplicate identifiers, conflicting metadata, and out-of-order swap observations are rejected. Limits are 16 MiB, 50,000 swaps, 1,000 candidates, 1,024 characters per ordinary string and 128 characters per quote amount. Arrays below are required even when empty. Fields are required; only the two creation timestamps may be null.

| Top-level field | Meaning |
| --- | --- |
| `schema_version` | Exactly `ignition.observations.v1`. |
| `source_kind` | `observed`, `synthetic`, or `unknown`. This is a supplied classification, not authentication. Unknown source gates candidates to insufficient data. |
| `window_start`, `window_end` | Observation bounds in exact UTC `YYYY-MM-DDTHH:MM:SSZ` format. Their positive whole-second difference must be even. Prior window is `[window_start, midpoint)`; current is `[midpoint, window_end)`. |
| `cutoff` | Decision/knowledge timestamp in the same format, at or after `window_end`. Evidence must have been available by this cutoff. Keeping it separate allows indexing/capture latency. |
| `covered_venues` | Nonempty array of distinct exact venue IDs; never an all-market coverage claim. |
| `candidates` | Explicit candidate universe. Every candidate appears in the report, including candidates with no observations and failed gates. |
| `swaps` | Observations ordered by ascending `event_time`; equal timestamps are allowed. |
| `suspected_bots` | Supplied wallet labels. Empty means no labels were supplied, not that activity is bot-free. |
| `supplied_clusters` | Disjoint supplied wallet grouping hypotheses for sensitivity analysis. Empty does not establish independent ownership. |

Candidate fields:

| Field | Meaning |
| --- | --- |
| `candidate_id` | Unique nonempty stable ID used by the report and outcome journal. |
| `chain_id`, `token_id` | Exact case-sensitive canonical chain and token identifiers. Normalize aliases upstream. The engine does not infer equivalent addresses or chain names. |
| `quote_unit` | Exact canonical chain-qualified quote-asset identifier, such as `eip155:1/erc20:0x...`. Amounts use whole units of this asset. Different quote units are never combined. |
| `quote_decimals` | Integer from 0 through 36. All candidates sharing a quote unit must agree on decimals. |
| `created_at` | Proven token-creation event time, or null when unknown. This is age since creation, not age since first tradability. |
| `creation_available_at` | When the creation evidence was first available; null iff creation time is null. Must be on or after creation and no later than cutoff. |
| `creation_evidence_refs` | Distinct retained evidence references; nonempty when creation is known. |
| `coverage` | Object described below. |

The exact `(chain_id, token_id, quote_unit)` triple cannot repeat under another candidate ID. Multiple quote markets for a token may be supplied as separate candidates, but creation metadata must agree. No cross-candidate quote arithmetic or ranking is performed.

Coverage fields:

| Field | Meaning |
| --- | --- |
| `status` | `complete`, `partial`, or `unknown`; completeness is asserted only for the specified token/quote/venue scope. |
| `window_start`, `window_end` | Claimed covered interval. Must have positive duration. It must span the complete requested lookback to pass the coverage gate. |
| `venue_ids` | Distinct subset of top-level covered venues. Every swap must belong to this candidate's declared venue scope. |
| `gaps` | Distinct explicit gap descriptions or retained gap-reference IDs. Partial/unknown status fails coverage even when this list is empty. |
| `evidence_refs` | Retained indexing/coverage evidence; required to be nonempty for complete coverage. |
| `available_at` | When this coverage assertion and its evidence were first available; no later than cutoff. |

Complete coverage with gaps or an empty venue scope is contradictory and rejected. Complete coverage also requires `coverage.window_end <= coverage.available_at <= cutoff`: evidence cannot establish completeness for a future interval. Its bounds must span the top-level observation interval. For example, observation end 12:00:00, coverage availability 12:00:20 and decision cutoff 12:01:00 are valid. A smaller interval is accepted for transparent metrics but produces `coverage_does_not_span_lookback`. No polling, live coverage verification or all-chain discovery is provided.

Each swap contains exactly:

| Field | Meaning |
| --- | --- |
| `candidate_id`, `venue_id` | References to the declared candidate and venue scope. Quote identity comes from the candidate. |
| `tx_id`, `log_index` | Exact transaction ID and nonnegative integer event ordinal up to 2,147,483,647. A `(chain_id, tx_id, log_index)` may occur only once, including across venues/candidates. All logs of one chain/transaction must agree on event time. |
| `wallet_id` | Reported canonical economic buyer/seller wallet identifier. Require chain-specific canonicalization upstream; these opaque strings are not authenticated chain addresses. The engine cannot resolve router recipients, custody or transaction senders; incorrect attribution contaminates the result. |
| `side` | `buy` or `sell`, relative to the candidate token. |
| `quote_amount` | Positive unsigned fixed-point decimal string in the declared quote asset's whole units. No exponent, rounding, numeric JSON values or more fractional digits than `quote_decimals`. |
| `event_time` | Swap timestamp. Known creation time cannot be later than this event. |
| `available_at` | First availability of the observation, at or after its event. |
| `evidence_refs` | Nonempty distinct references to retained normalized records and source evidence. References are not independent decoding or authentication. |

Observations outside `[window_start, window_end)` remain in retained counts and provenance but do not enter metrics, including events between observation end and decision cutoff. In-window observations with `available_at > cutoff` are excluded and create an explicit insufficient-data reason. Event-time ordering is checked before these exclusions. A timestamped assertion alone cannot prove historical availability.

Each suspected-bot record has `chain_id`, `wallet_id`, a nonempty `reason`, nonempty `evidence_refs`, and `available_at <= cutoff`. Duplicate chain/wallet labels are rejected. These remain suspicions, regardless of their reason text.

Each supplied cluster has `cluster_id`, `chain_id`, at least two distinct `wallet_ids`, nonempty `evidence_refs`, `available_at <= cutoff`, and `basis` from `claimed_common_control`, `behavioral_similarity`, `shared_infrastructure_funding`, or `unknown`. Cluster IDs are unique, and a chain/wallet cannot occur in two clusters. All supplied hypotheses are applied only in the separately named sensitivity scenario. A shared exchange withdrawal source or other infrastructure funding does not establish a common owner and never merges the strict-wallet scenario.

Creation, coverage and cohort metadata first available after cutoff are rejected; they cannot be used retrospectively. Swaps are the only input evidence whose future availability is retained as excluded observations.

## Rules and interpretation

All amounts are converted to exact integer atomic units. Shares, HHI and growth ratios use exact `Fraction` arithmetic and are reported as strings such as `1/6` or `2`. A zero denominator gives null, never invented growth. Buy quote is the sum of buys; sell quote is separately reported. `buy_minus_sell_quote` is only their signed arithmetic difference. None measures net external capital, investor profit, wallet balances or current exposure.

Each window has raw and eligible metrics, each in two modes:

- `strict_wallets`: distinct wallet IDs, never claimed distinct owners.
- `supplied_cluster_sensitivity`: each supplied cluster counts as one hypothetical participant; unclustered wallets stay separate. Quote totals and swap counts are unchanged by grouping.

Eligible metrics remove all swaps from both windows for any supplied suspected-bot wallet or suspected-roundtrip wallet. A suspected roundtrip is an opposite-side pair from one candidate/wallet within 60 seconds anywhere in the usable observation lookback, including across the midpoint. It detects rapid two-sided activity, including legitimate trading; it does not prove a closed lot, wash trading, or token inventory reconciliation. A suspect label applies consistently to both windows, and each window lists only suspect wallets participating in that window. Pairs crossing the outer observation boundaries are outside this narrow heuristic's coverage. Classification uses information available at the report's decision cutoff; it does not recreate an alert previously emitted at the midpoint.

Exclusions expose separate wallet lists for both suspicions and deduplicated union counts. Denominators include all usable events, all participating wallets and all buying wallets before filtering. Excluded buy quote is reported in the candidate's exact quote unit. The same wallet can be in both suspect cohorts without being double-counted in the union.

Each metrics object contains `buyer_count`, `seller_count`, `buy_event_count`, `sell_event_count`, `buy_quote`, `sell_quote`, `buy_minus_sell_quote`, `top_buyer_share`, and `buyer_hhi`. Concentration uses buying quote spend, not token balances. In the sensitivity mode, buyers and sellers are hypothetical grouped participants.

Rule version `ignition.traction.v1` requires at least 3 eligible prior buyers, 5 eligible current buyers, and 5 eligible current buy events. A heuristic candidate must have at least 1.5× buyer growth, 1.5× buy quote growth, current top-buyer spend share at most 1/2, and current buyer-spend HHI at most 1/4. Thresholds are explicit review heuristics and have not been validated as predictors. There is no weighted score or probability.

| Candidate `state` | Meaning |
| --- | --- |
| `insufficient_data` | Unknown source/age, incomplete coverage, unavailable in-window observations, token absent for part of the lookback, or insufficient eligible buyer sample. Each reason is listed. Metrics remain visible. |
| `outside_early_window` | Other gates pass but age since token creation exceeds seven days at cutoff. |
| `heuristic_candidate` | Gates pass, age is at most seven days, and all strict-wallet rules pass. |
| `no_acceleration` | Gates and early-age condition pass but at least one strict-wallet acceleration/concentration rule fails. |

`comparison` shows all checks and ratios separately for both modes. The candidate state uses strict wallets; `supplied_cluster_sensitive` flags disagreement between strict and grouped rule results. Review a sensitive candidate as dependent on grouping assumptions. Other flags report observed rule components even when the state is insufficient data; they do not override its gate.

## Output: `ignition.report.v1`

The report preserves `input_sha256` of the exact input bytes, `source_kind`, `rule_version`, the knowledge `cutoff`, observation `window_start`/`window_end`/`midpoint`, every evaluated candidate, explicit rules, declared venue coverage and supplied cohort evidence. Token age is explicitly measured at the decision cutoff, not at observation end. Each candidate preserves its exact identity, creation and coverage metadata, window metrics, comparisons, exclusions, reasoned state, flags, observation counts and retained evidence references.

`persistence.state` is always `unknown`: this schema does not accept matured balances and cannot compute retention or current inventory from swaps. Holder growth, independent benchmark repricing, exit capacity, historical wallet skill and net external capital are also outside the native engine. Do not substitute transfers, swap counts or buy-minus-sell quote for those measurements.

The evidence journal may consume `candidates[].candidate_id` and `candidates[].quote_unit` plus `cutoff`, `source_kind` and the complete report hash. Preserve the original input alongside the report; hashes establish byte identity, not truth, complete discovery or authenticity. A supplied candidate universe may itself be incomplete; the engine retains all supplied candidates but cannot discover omitted tokens or prove unbiased universe selection.
