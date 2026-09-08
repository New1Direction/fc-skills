# Evidence and report contracts

Keep live cases outside the installed skill. Retain exact raw bytes before normalization; never replace the originals with model summaries. Hash local evidence with `python3 scripts/case_tools.py hash /absolute/case/evidence.json`. A hash is an integrity reference, not a blockchain authenticity proof.

## Native EVM packet: autopsy.evm-evidence.v1

The collector writes chain_id (integer), token, requested_range (inclusive numeric from_block/to_block), captured_at_utc, before/after boundary headers, metadata at to_block, coverage, records, transfers, and diagnostics.

`records` contains IDs such as rpc-000001, method, exact public params, result or sanitized error, and observed_at_utc. The endpoint URL is deliberately not serialized. Record a non-secret provider name separately in the case evidence index.

`transfers` contains evidence_id, block_number, block_hash, transaction_hash, transaction_index, log_index, from, to, and value_raw. All token quantities remain decimal strings. Decimals is an integer or null. A missing metadata read remains null.

Coverage statuses:

- complete: every requested subrange returned valid standard-transfer logs and the two boundary headers matched before/after. This does not establish full launch coverage, finality, truthful RPC responses, or freedom from silent provider truncation.
- partial: gaps, malformed data, exhausted budgets, or unverified anchors. Inspect missing_ranges and diagnostics.
- unavailable: no useful log capture established.
- invalidated: wrong chain, changed anchors, conflicting log identity, or contradictory boundary evidence. Do not derive canonical findings from it.

Generate the observed flow ledger:

`python3 scripts/case_tools.py ledger /absolute/case/evidence.json --out /absolute/case/flows.json`

The ledger checks normalized events against raw records, detects duplicates/omissions, uses exact integers, and checks flow conservation. It requires verified boundary anchors and permits partial coverage with its limitations carried forward. It never converts transfer deltas into holdings, purchases, sales, profit, or owner clusters. Reconcile balances and implementation semantics separately.

## Full report: autopsy.report.v1

Required top-level fields:

| Field | Contract |
| --- | --- |
| schema_version | autopsy.report.v1 |
| case_id | Nonempty human-readable case identifier |
| target | chain_family: evm or solana; chain_id: string describing exact network; address: exact token or mint |
| scope | launch_definition, start, end, finality: nonempty strings; as_of_utc: UTC timestamp |
| coverage | List of area, status, limitations, evidence_ids |
| evidence | List of unique id, source, locator, captured_at_utc, anchor |
| claims | List of unique id, kind, statement, evidence_ids |

Use strings for report scope boundaries so EVM blocks, Solana slots, or explicit unknown boundaries can be represented; do not disguise unknown origins as zero. Retain raw integer boundaries in underlying native evidence.

Each evidence locator must identify the relevant transaction/log, instruction, RPC record, trace, state read, or public source passage. The anchor names a block/slot/hash or the relevant social publication time. When retaining a local file, add `file` (relative to the case directory) and `sha256` (64 lowercase hex characters). Optionally add a JSON `pointer`, for example `/records/0/result` or `/observations/2`. Empty pointer refers to the whole JSON document.

Coverage status is complete, partial, unavailable, or not_applicable. Incomplete/inapplicable areas need an explanation in limitations. Include collection boundaries and limitations even for a complete narrowly scoped area. Evidence IDs must resolve within the report; complete coverage needs supporting evidence.

Claim-specific fields:

- fact: evidence_ids support the exact observation stated.
- derived: also include method and denominator. Put the exact arithmetic, units, and input evidence in method. Write `not applicable: ...` for a non-ratio denominator. Preserve integer quantities as strings in any additional amount fields.
- hypothesis: also include alternatives (nonempty list), falsifier, confidence (low/medium/high), and confidence_reason. Confidence describes the specific inference; it is not a risk or morality score.

Optional timeline, roles, edges, cohorts, and metrics may be added. Keep references to claim/evidence IDs and use null with an explanation for unknown amounts. Do not silently equate a null value to zero.

Run:

`python3 scripts/case_tools.py check-report /absolute/case/report.json --evidence-root /absolute/case`

This verifies required fields, claim kinds, evidence references, hypothesis qualifications, local hashes, path containment, and optional JSON pointers. It does not fetch remote URLs, recompute arbitrary prose calculations, prove cited statements, or certify the correctness of a provider. Review each consequential claim against its evidence after the structural check.

If no live source is accessible, deliver the useful supported brief and concrete missing inputs. Do not fill the evidence index with fabricated records to satisfy the contract.
