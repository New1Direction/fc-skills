---
name: agent-arena
description: Audit trading-agent performance from retained portfolio, funding, attempt and decision evidence. Use for agent scorecards, cashflow-adjusted returns, open inventory, failed-trade costs and inspectable research journals. Native tools analyze normalized evidence; they do not collect complete live wallet history or prove agent authorship.
---

# Agent Arena

Produce an inspectable scorecard for an exact wallet scope, currency and observation window. Distinguish portfolio performance from attribution to an agent, and arithmetic completeness from independently verified source coverage.

## Use

1. Read [references/schema.md](references/schema.md) when importing evidence. Preserve raw evidence links, exact asset identities and all attempts, including pending and failed ones. An adapter must reconcile complete positions, liabilities and external funding; a list of winning transactions is insufficient.
2. Run the self-contained Python 3.12 CLI:

   ```bash
   python scripts/arena.py analyze --input assets/example.json --out /tmp/arena-report.json
   python scripts/arena.py journal-init --db /tmp/arena.sqlite --input assets/example.json
   python scripts/arena.py journal-verify --db /tmp/arena.sqlite
   python scripts/arena.py journal-report --db /tmp/arena.sqlite
   ```

   `journal-import` appends evidence under the same frozen review header; exact repeats are idempotent, conflicts are rejected atomically. `journal-export` produces a portable dataset. Create a separate journal for another scope or window. See CLI `--help` for each command.
3. Explain cashflow-adjusted absolute PnL, retained snapshot valuations, return availability, observed drawdown, costs, unresolved attempts and agent attribution separately. Read [references/accounting.md](references/accounting.md) for formulas and [references/provenance.md](references/provenance.md) for journal guarantees.

## Interpretation

- Deposits and withdrawals are external funding. All trading fees and failed-transaction gas must already be reflected in complete snapshot NAV; the attempt cost breakdown is informational and is never subtracted again.
- A missing, stale or future position/liability mark leaves full NAV unavailable. Do not replace missing inventory or liabilities with zero. Marked value is not an executable liquidation quote.
- Exact TWR needs consistent before/after valuations at every funding event. Missing brackets, conflicting ordering, zero/negative return denominators or incomplete coverage produce an explicit unavailable result. Report only observed snapshot drawdown, not an intraperiod maximum that was never measured.
- The journal detects inconsistent retained contents against its hash chain. Anyone controlling the database can rewrite and rehash it or remove an unanchored suffix. Hashes do not establish complete wallet history, authentic timestamps, strategy ownership or causation.
- Timestamped decisions linked to attempts support a retained attribution claim. They are not independent proof that an agent authored or submitted a transaction. Do not label the scorecard cryptographically verified trading skill, annualize short samples, invent Sharpe ratios or infer future profitability.

The included fixture is synthetic and deliberately contains funding, withdrawal, open inventory, a loss, a failed attempt, a pending attempt and an unattributed success. Native collection, signing, live execution and public leaderboard publishing are outside this skill.
