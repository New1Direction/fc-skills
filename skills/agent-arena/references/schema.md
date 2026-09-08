# Evidence schema and CLI

The native input is one JSON object with `schema: "arena-input@1"`. `assets/example.json` is a complete synthetic example; every source in it begins `synthetic://`. No live records are bundled.

## Header

- `scope`: positive integer `chainId`, nonempty unique lowercase EVM `wallets`, exact `currency` numeraire. Internal transfers between scoped wallets are not external flows. USD, USDG and other numeraires are distinct; adapters must provide currency conversions with retained evidence.
- `window`: timezone-aware ISO `start`, `end`, `asOf`, integer `maxMarkAgeSeconds` (0–31,536,000). Start precedes end. An unfinished window produces unavailable metrics. The tool uses the supplied as-of cut, not the system clock; future relative to that cut is excluded.
- `coverage`: `start`, `end`, nonempty `sourceRefs`, and explicit booleans `transactionsComplete`, `externalFlowsComplete`, `positionsComplete`, `liabilitiesComplete`, `costsIncludedInNAV`, `attemptsComplete`. These are importer assertions, not proofs. Missing attempts do not invalidate independently reconciled NAV, but attempt/fee coverage remains incomplete. Other false coverage flags withhold full performance.
- `events`: retained event objects. Repeated identical IDs are idempotent; changed contents under one ID are rejected. Maximum 200,000 events / 128 MiB per review. Additional metadata is retained and hashed.

Amounts and quantities are finite plain decimal **strings**, with at most 40 integer and 30 fractional digits. Arithmetic uses Decimal with 160 significant digits; repeating divisions are approximated at that precision. Return and drawdown outputs are fractions, not percentages.

## Shared event fields

Every event contains `id`, `type`, `at`, `observedAt`, `evidenceRef`. Timestamps require explicit timezone; observation cannot precede occurrence. Only records whose occurrence and observation are at or before `asOf` can affect the report. Preserve genuinely captured timestamps; backdating a supplied timestamp does not establish point-in-time availability.

### snapshot

Fields: `phase` (`regular`, `before-flow`, `after-flow`), `complete` boolean, `cash` in reporting currency, `positions` array, `liabilities` array. An empty array explicitly asserts no components of that kind; `complete: false` identifies an incomplete inventory.

Each position has exact `assetId` (prefer `eip155:4663/erc20:0x...`), nonnegative `quantity`, and `mark` either null or `{price, at, observedAt, sourceRef}`. Price is reporting currency per quantity unit. Keep Robinhood raw-token versus UI-share units and multipliers consistent upstream. Zero positions need no mark. Shorts/debts belong in liabilities.

Each liability has `id`, and `value` in reporting currency (nonnegative decimal or null); a priced liability also has `at`, `observedAt`, `sourceRef`. Fees owed, borrow balances and accrued debt must be included. Do not include the same borrowing in both negative cash and a liability.

Cash and all components describe the same portfolio instant. Marks must be at or before that instant, observed by the snapshot observation and as-of cut, and no older than `maxMarkAgeSeconds`. Missing, future and stale marks leave full NAV null while identifying the known component subtotal. A marked NAV is not a liquidation simulation.

Exactly one `regular` or `after-flow` snapshot is required at each window boundary. `(start,end]` is the external-flow and terminal-attempt accounting interval: opening NAV already includes activity at `start`. Attempt states are selected at window end; a later receipt cannot erase the pending state at that boundary. Unresolved attempts originating before the window remain visible as `pendingCarriedIntoWindow`.

### flow

Fields: `kind` (`deposit` or `withdrawal`), signed `amount` (positive deposit, negative withdrawal), optional `beforeSnapshotId`, `afterSnapshotId`. The amount is the external transfer's fair value in reporting currency. In-kind transfers need retained contemporaneous valuation; internal trades, swaps, staking transformations and transfers among scoped wallets are not deposits.

Exact TWR requires both referenced snapshots at the flow's exact timestamp, with matching before/after phases and `NAV_after - NAV_before == amount`. No market movement or unallocated gas can hide in this difference. Missing brackets withhold TWR without inventing an approximation. Multiple distinct flows at an identical timestamp withhold TWR; an adapter may aggregate simultaneous transfers into one net-flow record only if underlying evidence establishes their ordering and net valuation. Net-zero transfers need no flow only when their portfolio effect truly cancels and source evidence remains retained.

### decision

Fields: `agentId`, `action`; retain the actual decision document through `evidenceRef`. This is an assertion about authored intent. Links alone do not independently authenticate an agent.

### attempt

Fields: stable `attemptId`, `status` (`pending`, `succeeded`, `failed`), optional exact 32-byte `txHash`, optional `decisionId`, `feeAmount` (currency string or null), explicit `feesIncludedInNAV`.

A lifecycle can have separate immutable evidence IDs for pending and terminal states under one attempt ID. It can have at most one distinct terminal record; corrections need a new review with explained corrected source evidence, not history rewriting. Attempt hash and non-null decision link cannot change; a transaction cannot be counted under multiple attempt IDs. Order status records by event then observation time; terminal-to-pending regressions reject. Pending replacement transactions should use distinct attempt IDs, retaining their decision association.

`feeAmount` is total realized gas/trading costs for that terminal attempt, already reflected in snapshot NAV. Do not repeat a fee in multiple terminal records; pending estimated fees never enter the observed terminal fee total. A receipt collector must convert native gas cost using an evidenced contemporaneous currency rate. Failed attempts can incur gas. Unknown fee breakdown remains unknown, not zero. `feesIncludedInNAV: false` on a terminal attempt invalidates performance until the importer supplies reconciled NAV.

Prior decision attribution requires decision occurrence no later than first attempt occurrence, and decision observation no later than first attempt observation. The report still labels authorship and causal profit attribution unverified.

## CLI

Run from the skill folder, or replace paths with absolute paths:

```bash
python scripts/arena.py analyze --input assets/example.json --out /tmp/report.json
python scripts/arena.py journal-init --db /tmp/review.sqlite --input assets/example.json
python scripts/arena.py journal-import --db /tmp/review.sqlite --input /tmp/additional-evidence.json
python scripts/arena.py journal-verify --db /tmp/review.sqlite
python scripts/arena.py journal-export --db /tmp/review.sqlite --out /tmp/export.json
python scripts/arena.py journal-report --db /tmp/review.sqlite --out /tmp/journal-report.json
python -m unittest discover -s tests -v
```

The full header is frozen for a journal, including window, as-of and coverage. Imports supply that same header and a batch of events; duplicates are checked against retained contents. Use another journal for another review window. Verification/export/report accept optional `--expected-head <previously-recorded-hash>`; it checks exact equality against that separately retained head. Any legitimate append changes the head, so use the anchor corresponding to the intended journal version.

CLI malformed input, corrupt journals and conflicting evidence return exit 2 and JSON on stderr. Valid but incomplete evidence returns exit 0 with `INCOMPLETE_EVIDENCE`, nullable metrics and explicit issues; applications must inspect those fields. All commands are read-only concerning networks, accounts and wallets.
