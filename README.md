# MSK

Seven crypto and memecoin research skills, packaged together for a private `New1Direction/MSK` repository.

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

## Use

Start with a skill's `SKILL.md`. Give an agent that folder and a concrete pool, token, wallet, retained dataset or question. Keep the entire folder together: scripts and references use paths within the skill. If your agent supports installed skills, use its supported installer or copy selected folders into a user-controlled skill location without overwriting an existing installation.

Example requests:

- Use Autopsy to investigate this launch and distinguish observed transfers from wallet-control hypotheses.
- Use Ignition to assess this retained candidate universe, then use Exit Doctor only for routes it supports.
- Use LP Edge to compare this position with holding, including known costs and missing withdrawal evidence.

The installed ChatGPT originals remain separate from this export; changing this repository does not automatically update them.

## Verify the package

Python 3.12 or later with the standard library and SQLite is sufficient for the bundled verification. Run from the repository root:

```sh
python3 scripts/check_package.py
python3 scripts/check_package.py --tests
```

The first command checks every exported skill file against `manifest.json`. The second also runs each skill suite in a separate process, avoiding collisions between similarly named test modules. The manifest records file hashes, not provider authenticity or a digital signature. Intentional skill edits require a reviewed manifest update.

This export passed all 285 offline tests across the seven suites. All 100 original skill files match the saved source versions byte for byte.

## Evidence and coverage

Keep synthetic, observed, published illustrative, modeled, simulated and executed results distinct. Unknown costs, unavailable provider data and incomplete history stay unknown. A successful offline test or internally consistent RPC transcript does not establish profitable signals or trustworthy external data.

Autopsy's collector handles transfers, not native swap decoding. Exit Doctor's V2 adapter and LP Edge's V3 adapter do not establish support for Robinhood V4 or arbitrary hooks. The discovery skills require retained normalized inputs or available external providers. LP Edge's published Uniswap example checks arithmetic but lacks the block data needed for authenticated historical replay. Live performance remains unproven; see each skill's coverage notes.

## Next development priority

Build a shared live-data adapter beginning with verified FYNCH/Robinhood V4 evidence. Preserve exact pool identities, event order, observation and availability times, raw responses and explicit gaps. Produce the existing skill schemas instead of creating another incompatible feed. Its first acceptance case should take one real retained dataset through the relevant skills and reconcile the results independently.

Then extend prospective signal evaluation: freeze selection and execution policies, retain failures and missing outcomes, account for complete costs, and compare held-out results with simple baselines. These are roadmap items, not bundled capabilities.

## Private GitHub publication

Keep the destination repository **private**. No GitHub repository or push is implied by possession of this local package. A GitHub connection must have access to the destination before uploads can complete.

If restoring the supplied Git bundle on a machine with authenticated GitHub CLI access:

```sh
git clone --branch main MSK.bundle MSK
cd MSK
git remote remove origin
gh repo create New1Direction/MSK --private --source=. --remote=origin --push
```

Use that creation command only when the destination does not already exist. For an existing repository, inspect its contents and visibility before integrating; do not force-push or replace unrelated work.

## Third-party material

Preserved license notices apply. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the collection has no blanket MIT or proprietary license declaration.
