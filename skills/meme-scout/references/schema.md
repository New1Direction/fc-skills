# Input and output contract, version 1

`scripts/analyze.py` accepts one UTF-8 JSON object, rejects duplicate keys, nonstandard constants, unknown fields, invalid types, duplicate post IDs, duplicate canonical tokens, and dangling token references. Limits: 5 MB input, 3,000 posts, 100 tokens, 100 identity sources per token; field limits are enforced by the helper. No JSONL, external schemas, network, third-party Python packages, or environment secrets are needed.

## Required top-level fields

| Field | Value |
|---|---|
| `schema_version` | `meme-scout.input.v1` |
| `source_kind` | `observed`, `synthetic`, or `unknown`; a non-observed declaration cannot be upgraded by individual records |
| `window_start`, `cutoff` | Inclusive RFC3339 timestamps with seconds and explicit offset, such as `2026-09-01T00:00:00Z` |
| `narrative` | Object with nonempty `id` and `label` |
| `coverage` | Object with string arrays `queries`, `channels`, `limitations`, and string `selection_notes`; record collection times/date filters here |
| `tokens` | Array of token objects; empty array works for narrative-only research |
| `observations` | Array of post objects; an empty sample is valid and supports no absence inference |

Source provenance is a declaration, not validation of authenticity. Report-level provenance conservatively becomes synthetic if any retained evidence is synthetic; otherwise unknown if any is unknown. Per-record provenance remains visible. Synthetic and unknown observations never become observed-original candidates. Excluded future data does not change retained counts or provenance. The input hash necessarily changes if input bytes change.

## Required post fields

| Field | Value |
|---|---|
| `id`, `platform`, `author_id` | Nonempty strings, at most 200 characters; author identity is scoped to platform |
| `event_time` | Post publication time |
| `available_at` | Earliest defensible availability of **all this record's content and classifications**; must be at or after event time |
| `url` | Retained HTTP(S) source URL, no embedded credentials |
| `text` | Retained text, at most 6,000 characters; do not silently reconstruct omitted content |
| `source_kind` | `observed`, `synthetic`, `unknown` |
| `kind` | `original`, `repost`, `quote`, `reply`, `unknown` |
| `narrative_match` | `confirmed` or `uncertain`, supplied by analyst |
| `sponsorship` | `paid`, `unpaid`, or `unknown`, supplied by analyst |
| `community` | Object with `label` (string or null), `confidence` (`documented`, `inferred`, `unknown`), and nonempty `basis` describing evidence or why unknown |

Optional `coordination_group` and `coordination_basis` are nonempty strings that must appear together. The basis must explain the actual evidence. Optional `token_ids` is an array of distinct canonical `<chain>/<address>` references to declared tokens. Every field in a record must have been available by its `available_at`; later community, sponsorship, narrative, or token-link annotations require a later snapshot, not backdated publication time. If annotations have different availability times, use the latest of them. The helper cannot audit a dishonest timestamp.

## Token fields

Each token requires `chain`, `address`, `available_at`, `identity_status` (`verified`, `ambiguous`, `unverified`), and `evidence` array. Token `available_at` covers both its identity and the supplied identity-status judgment. Evidence objects require `url`, `available_at`, `source_kind`, `role` (`primary`, `secondary`), and nonempty `claim`. An empty evidence array is valid but unresolved. See [token-identity.md](token-identity.md) for syntax and resolution semantics. Claim text should identify the exact relationship, not merely assert “official.”

## Output and exclusions

Report schema `meme-scout.report.v1` includes original-byte `input_sha256`, analyzer version, source declarations, normalized UTC window/cutoff, narrative, supplied coverage, summary counts, documented community evidence, normalized copy groups, per-post candidate classifications, all temporal/association exclusions, retained observations, token records, limitations, and a `meme-scout.handoff.v1` envelope. Lists use stable ordering; repeated execution over identical bytes yields identical output bytes.

Every excluded post retains its ID and all applicable reasons. Future post text, future identity evidence, and future token associations are excluded from retained evidence and handoff. Exclusion IDs and input totals are audit metadata, not observations available at cutoff. Classification exclusions are separately recorded for every retained post, including all applicable reasons. A source URL is never dereferenced by the helper.

Normalized-copy groups compare only confirmed original posts within the same effective provenance, so a known repost or a synthetic imitation does not suppress an observed original. The helper cannot resolve who originated a copied phrase. Times and counts are for this sample. A single documented community label or multiple labels cannot establish independent adoption.

Output paths must not exist. The parent directory must already exist. A failed filesystem write may leave a partial new file; inspect or use a fresh path after correcting the failure. The helper never overwrites an existing output or rewrites the supplied input.
