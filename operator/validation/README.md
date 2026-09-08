# Operator v1 validation — 2026-09-08

Validation used Node.js 24.19.0 and Python 3.12. The package suite passed 1,422 offline tests; the separate Operator suite passed 24 tests. The Fumadocs build and TypeScript checks passed, with 30 content pages, 16 skill search checks, and 45 distinct local link/asset targets verified.

The package gate initially exposed a PULSE test that read the live API after a fixed 150 ms, before HTTP backfill reliably finished. The test now waits for complete fixture reconciliation within a bounded deadline and deliberately delays fixture RPC responses. All original state, journal, source, race, and restart assertions remain. No PULSE production helper changed; the manifest records the updated test hash.

| Retained evidence | Meaning |
| --- | --- |
| `source-hashes.json` | Exact Operator module and CLI bytes used for this validation |
| `synthetic-demo.json` | Local HTTP capture, restart/reorg, report retraction, and verified snapshot results |
| `sample-pool-report.json` | An actual synthetic consumer result with its full block, receipts, and registry inputs |
| `synthetic-acceptance.json` | The demo correctly fails live 24-hour acceptance |
| `live-probe-2026-09-08.json` | One bounded public-mainnet RPC request timed out from the build environment |

The final demo retained eight RPC-reported included transactions and eight receipts across two canonical blocks. It produced three current dispatch reports and retained one retracted report after replacing the second block. It made 74 allowed read-only RPC requests and no forbidden requests. These counts describe this small synthetic run; they are not a mainnet throughput benchmark.

The example export digest refers to the locally verified demo snapshot. The complete demo database and snapshot are reproducible with `node scripts/msk.mjs demo --out NEW_DIRECTORY`; they are not embedded in this repository. A recorded local export digest does not prove off-host retention.

The [public source configuration](https://docs.robinhood.com/chain/connecting/) identifies the endpoint used by the bounded live probe. A timeout in this environment does not establish a chain outage. No continuous host, real pool registry, sustained mainnet capture, 24-hour acceptance, fastest-provider comparison, or profitable execution has been established by this validation.

To repeat the checks:

```sh
python3 scripts/check_package.py --tests
npm run test:operator
node scripts/msk.mjs demo --out ../msk-new-demo
npm run build
npm run typecheck
npm run check:docs
```
