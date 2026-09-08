# Evidence contracts and reproducibility

## Collector packet: exit-doctor.v2-evidence.v1

The packet retains status/status_reason, chain_id, captured_at_utc, block, route, state, wallet_state, quotes, records and diagnostics. Treat the packet as provider observations plus checks, not independent truth.

- block: number, hash, timestamp and after_hash. State selectors are retained in RPC records.
- route: router/factory/pair/token_in/token_out, fee_bps=30, deployment_verification, identity_verified, reserve_balance_match, supported_math, fingerprints and deployment evidence.
- state: reserve_in_raw/reserve_out_raw, decimals_in/decimals_out and balance_in_raw/balance_out_raw. Amounts are decimal strings; absent metadata remains null.
- quotes: amount_in_raw, amount_out_raw, quote_evidence_id, min_output_raw, model_amount_out_raw when available, and simulation details.
- simulation: status, amount_out_raw, evidence_id, gas_estimate_units, gas_evidence_id, and applicable anchoring details. A successful return array is not a measured balance delta.
- records: unique IDs with RPC method, public params, result or sanitized error, and observation time. RPC URL credentials are excluded.

The analyzer binds normalized chain, block headers, bytecode fingerprints, route relationships, reserves, balances, and nonnull decimals to the retained requests and responses. Quoted/simulated output must match its exact method, recipient, calldata, amount, route, and block selector. Invalidated or unavailable evidence cannot become a canonical exit report. Partial packets require checking which exact observations remain usable; the native analyzer requires complete route and reserve evidence even when wallet simulation is unavailable.

## Additional costs: exit-doctor.costs.v1

Optional cost input identifies schema_version, chain_id, token_out and entries. Each entry contains:

- amount_in_raw: exact matching input size.
- status: known or unknown.
- amount_out_cost_raw: a decimal integer string in output-token raw units for known cost, otherwise null.
- unit: output_token_raw.
- includes_pool_fee: false.
- coverage: all_additional_costs for a complete cost estimate.
- source: the retained source or assumption explaining the estimate.
- evidence_ids: relevant evidence IDs, if available.

“Known” means supplied as a complete additional-cost estimate. It does not mean the analyzer independently measured it. Include gas conversion, route/platform fees not already embedded, and other relevant charges in the source explanation. A zero additional cost needs the same completeness and source justification as a positive cost.

The analyzer must not deduct a pool fee again or accept raw wei/gas units as output-token units. Missing size entries or unknown costs produce a null net estimate. Quoted proceeds remain visible.

## Scenarios: exit-doctor.scenarios.v1

Optional scenario input has schema_version and entries with unique id and type:

| type | Parameter |
| --- | --- |
| prior_sell | amount_in_raw: hypothetical X sale before each user size |
| proportional_liquidity_removal | removal_bps: proportional reduction of both reserve sides |
| buy_then_sell | quote_spend_raw: Y spent to buy X, followed by selling all acquired X |

These are model inputs, not observations. Keep them in their own file with no endpoint credentials or wallet secrets. Read scenarios.md for state-order and attribution boundaries. A scenario can be meaningful without claiming any actual wallet will perform it.

## Analysis

```bash
python3 scripts/analyze_exit.py /absolute/case/evidence.json \
  --costs /absolute/case/costs.json \
  --scenarios /absolute/case/scenarios.json \
  --max-impact-bps 100 \
  --out /absolute/case/report.json
```

The evidence input and --out are required; --costs, --scenarios and --max-impact-bps are optional. The 100-bps threshold above is an example chosen for that run, not a recommended allocation rule. Use a nonexisting output path. Omitting --costs deliberately leaves net estimates unresolved. A reverted call or missing wallet prerequisite also leaves the net estimate null, even if a complete cost estimate is supplied.

The report schema is exit-doctor.report.v1. It contains an independent_size_curve, defined price metrics, execution statuses, cost sources/coverage, scenario results and source hashes. threshold.largest_tested_amount_in_raw identifies only a tested size meeting the selected definition of impact; it is not an optimizer result or a wallet execution check. source_kind preserves rpc, synthetic or unknown; fixture notices are untrusted source text. Preserve the exact output field names emitted by the installed script.

Keep the evidence, optional cost/scenario inputs, report and their SHA-256 references together. A hash confirms integrity against retained bytes, not source authenticity. Review semantic conclusions after calculation; a structurally valid packet can still come from an unreliable provider or inappropriate mechanism assumption.

Do not store live cases inside this skill. Use the host's artifact workflow for user-facing case files. The bundled synthetic files are invented examples, never evidence of live execution or profitability.

For an explicitly requested offline example, run from the skill directory, replacing the output path with an unused case path:

```bash
python3 scripts/analyze_exit.py assets/synthetic-evidence.json \
  --costs assets/synthetic-costs.json \
  --scenarios assets/synthetic-scenarios.json \
  --max-impact-bps 500 \
  --out /absolute/case/synthetic-report.json
```
