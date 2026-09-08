# MSK

Twelve crypto research and live-data skills in the private `New1Direction/MSK` repository. Current development focuses on Robinhood Chain (4663); each existing skill retains its explicitly documented native venue support.

Each skill includes its instructions, deterministic Python or Node.js helpers, references, examples and offline tests. The folders are independent: use one skill or compose their reports. This collection performs data collection, research, deployment planning and read-only simulations; it does not sign or broadcast live trades. The optional EVM harnesses operate inside their own isolated local Anvil processes.

## Included skills

| Skill | Question it helps answer | Native scope |
| --- | --- | --- |
| [Autopsy](skills/autopsy/SKILL.md) | Where did launch supply go, and what explains early wallet activity? | EVM ERC-20 transfers; broader investigation uses available evidence. |
| [Exit Doctor](skills/exit-doctor/SKILL.md) | What does exiting this position size look like after impact and costs? | One canonical 30-bps V2 pool. |
| [Meme Scout](skills/meme-scout/SKILL.md) | Is a narrative spreading through original participation or amplification? | Retained social observations; no bundled X/Grok client. |
| [Ignition](skills/ignition/SKILL.md) | Is early buying participation accelerating? | Normalized swap observations and a signal/outcome journal. |
| [Scout Network](skills/scout-network/SKILL.md) | Were a discovery wallet's historical finds realistically followable? | Supplied point-in-time cohorts and follower execution evidence. |
| [Second Wind](skills/second-wind/SKILL.md) | Is a dormant token attracting new participation? | Supplied historical windows and coverage. |
| [LP Edge](skills/lp-edge/SKILL.md) | Do fees compensate for inventory changes and costs versus holding? | Canonical V3 accounting, range scenarios and read-only wallet calls. |
| [Undertow](skills/undertow/SKILL.md) | Is a Robinhood meme gaining against its stock quote, and where is observed capital rotating? | Chain4663 attribution, supplied attributed flows, bounded canonical V4 evidence, current stock-reference capture. |
| [PULSE](skills/pulse/SKILL.md) | Which source delivers usable Robinhood data first, and how do we operate our own data path? | Multi-source WS/HTTP collection, RPC Race, provisional and reconciled V4 state, private Nitro planning and probes. |
| [HOOK LAB](skills/hook-lab/SKILL.md) | What does this Robinhood V4 hook do, and what evidence supports this exact wallet call? | Exact deployment identity, Pons V2 source-derived fees, pinned calls/traces, isolated Anvil fork balances, evidence consistency and drift checks. |
| [PRESSURE](skills/pressure/SKILL.md) | Is stock-token supply changing, where are balances moving, and what do measured liquidity observations support? | Bounded full-receipt collection, raw supply/multiplier reconciliation, custody observations, retained trade-size comparisons and prospective outcome journals. |
| [WATCHTOWER](skills/watchtower/SKILL.md) | Can we retain every included Robinhood transaction promptly and verify the reported monitored interval has no gaps? | Full RPC blocks and receipts, fresh-tail priority, durable recovery, research workers and source latency comparisons. |

## Use

Start with a skill's `SKILL.md`. Give an agent that folder and a concrete pool, token, wallet, retained dataset or question. Keep the entire folder together: scripts and references use paths within the skill. If your agent supports installed skills, use its supported installer or copy selected folders into a user-controlled skill location without overwriting an existing installation.

Example requests:

- Use WATCHTOWER to capture all included transactions, reconcile receipt coverage, operate bounded workers and measure actual source arrival.
- Use PRESSURE to reconcile a stock-token issuance window and compare supported liquidity measurements while retaining missing outcomes.
- Use HOOK LAB to inspect a graduated Pons pool, model its hook charges and retain the evidence needed for an exact wallet route.
- Use Autopsy to investigate this launch and distinguish observed transfers from wallet-control hypotheses.
- Use Ignition to assess this retained candidate universe, then use Exit Doctor only for routes it supports.
- Use LP Edge to compare this position with holding, including known costs and missing withdrawal evidence.
- Use PULSE to compare provider arrivals, retain recoverable chain events and prepare a private Robinhood Nitro node.
- Use Undertow to explain this NVDA-paired meme’s returns, distinguish routed turnover from observed wallet participation, and map shared quote relationships.

The installed ChatGPT originals remain separate from this export; changing this repository does not automatically update them.

## Verify the package

Python 3.12+ with the standard library and SQLite runs the research helpers. PULSE, HOOK LAB, PRESSURE and WATCHTOWER require Node.js24+ and use built-in modules for normal operation. HOOK LAB’s optional fork collector requires an Anvil binary; its optional actual-EVM smoke also requires solc. These dependencies are not bundled. Both runtimes are required for complete package verification. Run from the repository root:

```sh
python3 scripts/check_package.py
python3 scripts/check_package.py --tests
```

The first command checks every exported skill file against `manifest.json`. The second also runs each skill suite in a separate process, avoiding collisions between similarly named test modules. The manifest records file hashes, not provider authenticity or a digital signature. Intentional skill edits require a reviewed manifest update.

The version 0.6.0 export passes **1,100 tests across twelve skill suites**, including 114 WATCHTOWER tests. WATCHTOWER also passed an actual isolated Anvil transaction/receipt collection check, a 10,000-transaction synthetic workload and independent operator use. All eleven earlier skill inventories are preserved byte for byte.

## WATCHTOWER chain-wide transaction monitoring

WATCHTOWER captures every RPC-reported included transaction from an explicit first block, including successful and reverted transactions, contract creation and unknown types. Fresh tail blocks can arrive while bounded workers recover older gaps. Concurrent receipt enrichment advances its own completeness cursor. Durable SQLite WAL storage, incremental progress, bounded queues, reorg invalidation, outbox retractions and restart recovery preserve the actual evidence state.

Run capture and research workers as separate processes. All transactions receive cheap classifications; exact configured address/topic rules produce reviewable research dispatch records. No token filter limits intake. Specialized skill execution, internal-call tracing and FYNCH/Ape production adapters are not automatic. Existing FYNCH canonical ingestion ownership and Ape execution gates remain intact.

```sh
node skills/watchtower/scripts/watchtower.mjs demo --out /tmp/watchtower-new-demo
node skills/watchtower/scripts/watchtower.mjs bench --out /tmp/watchtower-bench.json --blocks 100 --transactions 100
```

The source/operator instructions target a synced Robinhood Nitro node connected to the official sequencer feed, with independent RPC observations. WATCHTOWER reads executed full blocks; it does not itself decode or verify the feed. Source arrival and durable-capture percentiles use exact object/run/clock identity; live, recovered and replay observations remain separate.

**Deployment status:** the service, skill and Linux templates are built and locally validated. The EVM check retained all five actual synthetic transactions and receipts across three blocks through a read-only proxy with zero collector writes. A 10,000-transaction synthetic workload completed durable capture and classification; its timings exclude network/Nitro and do not establish mainnet throughput. No working live mainnet source, deployed host, sustained capacity, full internal tracing or fastest-provider result is established. Storage is bounded and never silently pruned; production retention/export ownership still needs deployment integration.

See [WATCHTOWER operations](skills/watchtower/references/operations.md) and [validation](skills/watchtower/references/validation.md) for exact scope and reproducible commands.

## PRESSURE supply and liquidity research

PRESSURE reconciles raw ERC-20 issuance and balances over pinned block windows, separates changes in the stock-token multiplier, follows observed mint-recipient wallet activity, compares retained wallet/route/size-specific liquidity measurements, and records prospective candidate universes with controls and missing outcomes. It does not turn custody balances into complete pool inventory or a free-float estimate.

The native collector enumerates every transaction receipt reported in a bounded window and retains a replayable RPC transcript. Observed endpoint code matches and receipt enumeration do not authenticate providers, resolve arbitrary proxy upgrades or establish economic backing. Liquidity observations are supplied inputs; PRESSURE does not build router calldata or quote unsupported routes.

Run an offline demonstration from the repository root:

```sh
node skills/pressure/scripts/pressure.mjs demo --out /tmp/pressure-demo-new
```

The demo includes independent teaching cases, a generated synthetic joint report and an outcome study that retains a missing selected case. Its EVM fixture separately verifies mint/burn, balances, multiplier changes, receipt omission detection and zero collector writes. Optional EVM reproduction needs a trusted Anvil binary and solc module; neither is bundled.

FYNCH supply/data interfaces and Robinhood stock-token documentation were inspected and linked in the skill. Live mainnet supply capture and Pons wallet-route verification remain open because an available archive RPC was not established. This release exports the research tools and evidence; it does not change FYNCH or Ape production permissions.

## HOOK LAB execution research

HOOK LAB includes seven commands: deployment identity, Pons discovery, Pons fee arithmetic, exact read-only calls/traces, isolated Anvil forks, qualification consistency and identity comparison. It binds retained evidence to an exact chain/block/hash, PoolKey, code/configuration graph, wallet and calldata. The first family models Pons V2 hook fees with separate integer rounding. It is not a full V4 traversal quoter or production router calldata builder.

The user-supplied awesome-uniswap-hooks catalog is incorporated as a pinned research index, with primary-source selection criteria. No catalog code or dependency tree is bundled. The Pons deployment remains a published candidate until build/runtime correspondence and an actual wallet route are independently established. A public Robinhood RPC probe timed out in the build environment.

The retained Ape source rejects nonzero hooks in its vault. HOOK LAB exports reviewable evidence and does not change Ape/FYNCH production permissions. Successful local evidence consistency is not execution approval, a contract audit or a profitability claim. See HOOK LAB’s references and retained synthetic EVM evidence for precise coverage.

## PULSE live data runtime

PULSE bundles four components in one installed operator skill:

- **RPC Race:** first-arrival comparisons by exact event and clock, missing observations, p50/p95/p99, and separate bounded HTTP capability probes.
- **Live Collector:** persistent provider heads/logs plus optional raw sequencer-feed capture, startup buffering, reconnect backfill, explicit lag/reorg handling and a recoverable journal.
- **Pool State Engine:** immediate provisional V4 observations and a separate complete-block view, exact integer arithmetic and affected-route invalidation. Neither view is a trade-size quote or arbitrary-hook execution model.
- **Node Operator:** private Nitro Compose/config generation, official asset digest/chain checks, local sync/freshness and peer probes. A Linux collector service template is also included.

From `skills/pulse`, after setting source environment variables and editing the example to include available sources:

```sh
node scripts/pulse.mjs collect --config assets/pulse.example.json --out /tmp/pulse/events.jsonl --duration 60
node scripts/pulse.mjs race --journal /tmp/pulse/events.jsonl --sources provider,local-nitro --out /tmp/pulse/race.json
node scripts/pulse.mjs pools --registry assets/pools.synthetic.json --blocks assets/blocks.synthetic.json --out /tmp/pulse/synthetic-state.json
```

Use a real registry with `collect --registry` to enable pool views. The pool replay example is explicitly synthetic. For continuous collection, use `--duration 0` and the systemd template. The read API is loopback-only. A bounded spool and expired-cursor recovery keep its role distinct from FYNCH's existing retained store.

**Deployment status:** software, operator instructions and templates are built and locally verified. A public HTTP probe timed out and a direct public feed connection failed from this build environment. Real provider speed, sustained production throughput, an actual synced Nitro deployment and FYNCH/Ape production wiring remain unverified. No server was provisioned and no trade was signed or submitted. Supply the target host, source credentials and verified node assets for deployment; see PULSE's references for exact commands and boundaries.

## Evidence and coverage

Keep synthetic, observed, published illustrative, modeled, simulated and executed results distinct. Unknown costs, unavailable provider data and incomplete history stay unknown. A successful offline test or internally consistent RPC transcript does not establish profitable signals or trustworthy external data.

Autopsy's collector handles transfers, not native swap decoding. Exit Doctor's V2 adapter and LP Edge's V3 adapter do not establish support for Robinhood V4 or arbitrary hooks. The discovery skills require retained normalized inputs or available external providers. LP Edge's published Uniswap example checks arithmetic but lacks the block data needed for authenticated historical replay. Undertow adds a bounded Robinhood V4 collector with PoolKey, bytecode fingerprint, receipt, block and transcript checks. Every nonzero hook remains unqualified for wallet/execution interpretation, and native swap sender is never assumed to be the trader. Its higher-level flow analysis requires separately attributed retained observations. Live public RPC and stock-API smoke requests timed out in the build environment; no real NVDA bundle or profitable signal was validated. See each skill's coverage notes.

## Robinhood Chain acceptance case

Run one real, frozen FYNCH NVDA pool family through Undertow using exact PoolKeys, retained block hashes, independently established code fingerprints, historical multiplier/reference observations, beneficiary evidence and coverage. Reconcile raw swaps and marks independently. FYNCH's repository integration surfaces were inspected, but a live authenticated connection and production UI changes are not bundled.

Undertow's combined synthetic example is runnable from its skill directory:

```sh
python3 scripts/research.py --attribution examples/attribution.json --flows examples/flows.json --out /tmp/undertow-report.json --markdown /tmp/undertow-report.md
```

Then extend prospective evaluation: freeze selection and execution policies, retain failures and missing outcomes, account for complete costs, and compare held-out results with simple baselines. These remain acceptance and roadmap work, not established trading capabilities.

## Repository use

Keep this repository private. Clone the existing repository using your normal authenticated GitHub connection; preserve complete skill folders and their scoped license notices. Inspect existing changes before integrating updates and do not force-push unrelated history. The package manifest is an integrity inventory, not a publisher signature.

## Third-party material

Preserved license notices apply. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the collection has no blanket MIT or proprietary license declaration.
