# Prospective outcome journal

Use the journal to freeze a candidate universe before the measurement period, including unselected controls. It measures descriptive outcomes of supplied cases; it does not discover candidates, run a trading strategy, authenticate fills, or prove a causal signal.

The CLI assigns the current local timestamp when appending. There is no command to backdate a prospective cohort. The JavaScript test harness can inject time; the synthetic demo does so explicitly. Local timestamps and SHA-256 chains are not trusted timestamps or signatures: an operator can rewrite an entire file. Keep external backups/provenance when evidence authenticity matters.

## Cohort input

`freeze --input cohort.json --journal events.jsonl` accepts exactly:

- `id`, `evidence_mode` (`prospective` or `synthetic`), `policy_id`, `policy_sha256` (`sha256:` plus 64 lowercase hex), `chain_id:4663`.
- `quote_asset:{address,decimals}`, `capital_per_case_raw` (positive decimal integer string).
- `horizon_seconds` (1–2,592,000) and `max_signal_age_seconds` (0–604,800); these are explicit study choices, not recommended trading parameters.
- `candidates`: 1–1000 records `{id,token,selected,signal,observed_at,block:{number,hash,timestamp},evidence_refs}`. Addresses/hashes lowercase. All times are UTC epoch seconds. A candidate observation must predate registration and meet the chosen age limit. A block timestamp must not postdate its observation.

Register the complete predefined universe, a frozen policy hash, and equal declared capital per case. Retain signals, missing evidence and rejected cases. Do not selectively log only winners. A cohort can have no selected cases or no controls; then comparative performance remains unavailable. The helper cannot prove that the provided universe is representative.

## Outcome input

`outcome --input outcome.json --journal events.jsonl` accepts exactly:

`{cohort_id,candidate_id,measurement_start_at,measurement_end_at,result_kind,gross_pnl_raw,costs_raw,cost_coverage,evidence_refs}`.

Use the frozen registration time as measurement start and exactly registration plus the fixed horizon as end. Outcomes cannot be appended before maturity or for candidates absent from the cohort. Each candidate has one immutable outcome. For corrections, create a separate study with references to the erroneous evidence; do not silently rewrite the original journal.

`result_kind` is `modeled`, `wallet_fork`, or `executed`. These are supplied provenance claims and remain separate. `gross_pnl_raw` is signed PnL before the separately listed costs, in the cohort's quote asset. `costs_raw` is a nonnegative integer string or null; coverage is `complete`, `partial`, or `unknown`. Complete costs require a numeric amount. Avoid double-counting fees already included in proceeds; document the accounting boundary in referenced evidence. Native gas must be valued in the quote asset with a retained contemporaneous conversion before reporting a complete-cost result. Unknown costs keep net PnL unknown.

The declared capital denominator must represent the same exposure in every case; the journal does not verify position sizing from receipts. Unrealized marks, future peaks and partial exits must not be substituted for the specified fixed-horizon metric. For fork outcomes, document assumptions about entry inventory, path, subsequent state and complete costs; one isolated `eth_call` is not a return measurement.

## Summary

`journal --journal events.jsonl --out outcomes.json` reports every cohort, pending and matured-missing cases, unknown costs, and results by selection and provenance kind. Net PnL equals gross PnL minus costs only when cost coverage is asserted complete. Returns use exact rational basis points and equal declared capital. Selected-minus-control differences require complete same-kind outcomes for both entire groups; otherwise they stay unavailable. No confidence interval, causal treatment effect, profitable edge or annualized return is inferred from a small descriptive study.

Journal files are bounded at 8 MiB/10,000 events and use an exclusive writer lock and fsync. Hash-chain, chronology and schema checks run on every read. A missing final newline or corrupt event fails visibly. After a crashed writer, inspect and recover the lock from a known stopped process; the tool does not silently erase another writer's lock. Store production event journals with the existing durable research store or a reviewed backup process, outside the skill directory.
