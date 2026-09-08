# Signal journal and basic outcome evaluation

The local SQLite journal records supplied reports and attributed outcomes. It preserves actual ingestion times, rejects overwrites, prevents accidental SQL update/delete, and appends explicit revisions. It does not authenticate providers, prove a historical alert, protect against a malicious database owner, or run scheduled monitoring.

## Record a report

Use a journal path in the case workspace, outside this skill:

```bash
python3 scripts/signal_journal.py --db /absolute/case/signals.sqlite record /absolute/case/report.json
```

The script retains the exact report SHA-256, parsed payload, cutoff, source kind and actual recorded_at. All candidate rows remain, including nonpassing and insufficient-data rows. Duplicate hashes are rejected. Format: ignition.report.v1 with cutoff, source_kind and candidates containing unique candidate_id and quote_unit values.

## Attribute an outcome

Create an outcome JSON with schema_version ignition.outcome.v1:

- id: unique outcome ID; report_sha256: exact previously recorded report hash.
- candidate_id and quote_unit: exact matching report values.
- source_kind: same observed/synthetic/unknown kind as the report.
- horizon_at: target evaluation time after the report cutoff.
- available_at: time the outcome and cited evidence became available, no earlier than horizon_at.
- status: resolved, unavailable, censored, or execution_failed.
- basis: executed, simulated, or modeled. Keep these separate even for synthetic examples.
- method: predeclared entry delay, size, horizon/exit rule and cost method identifier/explanation. Review the actual methodology; matching names are not proof of equivalence.
- cost_coverage: complete for a resolved economic outcome.
- entry_all_in_quote: positive decimal string including acquisition and entry costs.
- exit_net_quote: signed decimal string after complete exit costs; costs can exceed receipts.
- evidence: one to 100 objects with unique id, source locator/attribution, and available_at.
- supersedes_id: omitted for the first observation, or the preceding outcome ID for a correction to the same report/candidate/horizon.

For unresolved states both amount fields must be null. Missing costs or exits cannot become zero or a resolved return. Retain execution failures; monetary loss requires supported reconciliation.

```bash
python3 scripts/signal_journal.py --db /absolute/case/signals.sqlite outcome /absolute/case/outcome.json
python3 scripts/signal_journal.py --db /absolute/case/signals.sqlite summary --as-of 2026-09-08T12:00:00Z
```

Replace the example timestamp with the intended cutoff. A summary excludes reports/outcomes ingested later even if source timestamps are earlier. Later revisions do not alter an earlier as-of summary.

## Interpretation

Resolved return is exactly `exit_net_quote / entry_all_in_quote - 1`, emitted as numerator/denominator. Groups separate source kind, basis, quote unit, horizon duration and method. Unknown/failed outcomes and candidates with no outcome stay visible. Overlapping snapshots are not independent trades and must not be added into portfolio return. A positive-return count does not establish profitable edge.

Retain entry/exit evidence and review assumptions. Prospective evaluation freezes rules and candidate selection before outcomes, including failures and disappeared tokens. Replay needs information available at decision time and realistic latency; imported reports remain retrospective. Native metrics are basic bookkeeping, not a complete backtester or significance test.

Inputs are bounded to 10 MiB and journal payload size is capped. Split long studies into documented journals rather than weakening checks or truncating adverse outcomes. Preserve every segment when aggregating a study.

## Complete offline example

For an explicitly requested synthetic exercise, generate a report from `assets/synthetic-traction.json`, record that report in a fresh journal, then ingest `assets/synthetic-loss-outcome.json`. The outcome is an invented loss bound to the exact deterministic report hash; changed inputs or report bytes require a newly attributed matching outcome. It does not measure a historical trade. Review the summary at the actual current UTC time so both ingestion records are visible.
