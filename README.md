# MSK

Eight crypto and memecoin research skills in the private `New1Direction/MSK` repository. Current development focuses on Robinhood Chain (4663); each existing skill retains its explicitly documented native venue support.

Each skill includes its instructions, deterministic Python helpers, references, examples and offline tests. The folders are independent: use one skill or compose their reports. This collection performs research and read-only simulations; it does not sign or broadcast trades.

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

## Use

Start with a skill's `SKILL.md`. Give an agent that folder and a concrete pool, token, wallet, retained dataset or question. Keep the entire folder together: scripts and references use paths within the skill. If your agent supports installed skills, use its supported installer or copy selected folders into a user-controlled skill location without overwriting an existing installation.

Example requests:

- Use Autopsy to investigate this launch and distinguish observed transfers from wallet-control hypotheses.
- Use Ignition to assess this retained candidate universe, then use Exit Doctor only for routes it supports.
- Use LP Edge to compare this position with holding, including known costs and missing withdrawal evidence.
- Use Undertow to explain this NVDA-paired meme’s returns, distinguish routed turnover from observed wallet participation, and map shared quote relationships.

The installed ChatGPT originals remain separate from this export; changing this repository does not automatically update them.

## Verify the package

Python 3.12 or later with the standard library and SQLite is sufficient for the bundled verification. Run from the repository root:

```sh
python3 scripts/check_package.py
python3 scripts/check_package.py --tests
```

The first command checks every exported skill file against `manifest.json`. The second also runs each skill suite in a separate process, avoiding collisions between similarly named test modules. The manifest records file hashes, not provider authenticity or a digital signature. Intentional skill edits require a reviewed manifest update.

The version 0.2.0 export passes 424 offline tests across eight suites, including 139 Undertow tests. The manifest verifies every exported skill file against its saved source version. The seven original skills are preserved byte for byte.

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
