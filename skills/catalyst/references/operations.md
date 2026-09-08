# Collection and operation

## Configure a bounded read

Start from the demo `config.json` only as a schema example: every demo CIK/address/evidence marker is synthetic. Replace the entire issuer/binding/pool universe using verified project evidence. Add `userAgent` containing your application's name and actual operator contact email. The live command rejects missing contacts and obvious placeholder addresses; it never invents a contact.

```bash
python scripts/catalyst.py collect --config /absolute/config.json --db /absolute/catalyst.sqlite --cycles 1
python scripts/catalyst.py export --db /absolute/catalyst.sqlite --out /absolute/events.json
```

`collect` makes only HTTP GET requests to canonical SEC submissions and filing archives. It does not require an API key. There is no live network call in the demo or tests.

Default limits per cycle: 100 HTTP requests, 25 documents, five overlapping historical submissions files per configured issuer, four MiB per response, five requests/second, 15-second HTTP time budget. Storage defaults to 256 MiB. All are explicit config fields. `cycles` is bounded to 1–100, with configured 1–60 second pauses. A socket operation can finish after the overall HTTP deadline by at most its configured socket timeout; responses exceeding the deadline are rejected.

The process shares one request limiter across SEC clients, including document requests. At the maximum setting, successive requests are spaced at least 0.101 seconds apart. A nonblocking OS lock permits one collector per database; interrupted processes release their lock automatically. **Other databases, processes or machines must share the same operator-wide SEC budget through external coordination.** Native code does not establish that distributed budget. Run one collector for the declared universe unless such coordination exists.

## Coverage and recovery

Each cycle retains the source submissions response, discovers selected accessions, and commits metadata before fetching primary documents. Recent source rows and historical files overlapping `startDate` are inspected. History beyond `maxHistoricalFiles` is reported as `HISTORY_TRUNCATED`; raise the explicit bounded limit or narrow the range after review. This version does not automatically paginate an arbitrarily large historical archive over future cycles.

`SOURCE_RANGE_READ` means the configured source range was read and selected documents retained during that cycle. It is not independent proof that SEC enumerated every filing, global EDGAR coverage or continuous availability. All configured issuers/forms/start dates are included in the retained run config. Missing issuers, truncated history, request limits and pending/failed documents produce `PARTIAL`.

Restart with the same database to recover discovered documents. Accession deduplication preserves the first local discovery timestamp. Failed retrievals or parses are retried on later cycles, with lower-attempt pending documents processed first. An accession whose selected metadata changes remains an explicit review error; its original metadata is not overwritten.

Successful primary documents are retained once per accession. The collector does not continuously re-fetch already retained documents to detect later edits at the same URL. New amended accessions remain independent events. Narrative primary documents are stored as raw bytes with metadata; exhibits and linked documents are outside native collection.

HTTP 403 or 429 stops the cycle; CLI also stops later requested cycles. Inspect the retained response headers, honor `Retry-After`, and review the combined request budget before restarting. No immediate automated retry or bypass is attempted. Other retrieval failures remain visible and can recover next cycle. Oversized/trickling bodies are rejected; no truncated body is presented as complete.

Storage capacity includes the SQLite database and WAL, with a reserve for writes. The check is a conservative operational stop, not an exact filesystem quota; it excludes separately exported JSON files. There is no automatic deletion. Stop collection, checkpoint and back up the database with SQLite's backup API, verify the backup, then explicitly choose a retention/capacity plan. Do not copy only an active database file while ignoring its WAL.

Exit code 0 means the command completed within its stated scope; `collect` exits 2 when any requested cycle was partial. Validation/transport/storage failures also exit 2 with structured error output. An interrupted run is exported as `INTERRUPTED_RUN`. Read each run's actual coverage rather than treating a process exit alone as proof of event completeness.

## Integrate without slowing transaction capture

Run CATALYST as a separate bounded worker. `export` reads its own retained state and produces `CatalystEvents@1`; it does not write into WATCHTOWER. An application can join `associations[].stockTokenAddress` and exact `poolId` records to its canonical registry.

WATCHTOWER raw transactions alone do not supply prices, interval coverage or a finality proof. A verified pool adapter must produce end-of-block price observations and explicit canonical interval evidence for `CatalystObservations@1`. Re-export after reorgs and rerun response analysis; `canonical:false` observations are excluded and contradictory canonical claims are rejected. Invalidated responses must be replaced or marked withdrawn by the consumer; CATALYST does not push updates into a running application.

Do not import an entire document into an ingestion callback or ask an LLM to classify filings on the transaction-capture thread. Narrative analysis is optional downstream work and must retain the quoted source passages and model-output provenance separately from the deterministic parser.

## Inspect retained bytes

SQLite `raw.sha256` keys address the exact retained response bytes. `fetches` records URL, response receipt time, status, headers and raw hash. `discoveries` links each accession to source response observations. `filings` stores independent metadata/document state; `runs` stores config and coverage.

The source document can be recovered using a parameterized query against `raw`, then checked with SHA-256 against the exported event. Never construct a filesystem path from a filing document name. The native tool rejects external URLs, encoded/traversing paths, arbitrary redirects and HTML execution.
