# MSK

**16 skills for onchain research, Robinhood Chain data, and wallet-call simulation.**

Investigate launches, measure early participation, retain chain activity, explain stock-token markets, and test exact routes. Each skill includes agent instructions, executable helpers, examples, references, and explicit coverage limits.

**[Read the documentation](https://msk-field-manual.apt-tetra-2799.chatgpt.site)** · [Quickstart](https://msk-field-manual.apt-tetra-2799.chatgpt.site/docs/quickstart/) · [Skill catalog](https://msk-field-manual.apt-tetra-2799.chatgpt.site/docs/skills/) · [Workflows](https://msk-field-manual.apt-tetra-2799.chatgpt.site/docs/workflows/)

The repository and hosted documentation are private. Use the source links below if you have repository access but cannot open the owner-only documentation site.

## Start in three commands

Requires Python 3.12+ and Node.js 24+. Clone with an authenticated GitHub account that has access:

```sh
git clone https://github.com/New1Direction/MSK.git
cd MSK
python3 scripts/check_package.py
```

Run a complete offline example in a new output directory:

```sh
python3 scripts/research_demo.py --out /tmp/msk-first-research
```

This produces a synthetic disclosure, valuation reports, a portfolio journal, and `research-bundle.json` with exact-asset links. It makes no live network requests and submits no trades. Choose a different output directory if that path already exists.

To use a skill with an agent, open its `SKILL.md` and provide the complete folder through your agent's supported skill installation workflow. Give it a concrete question and the required evidence. Keep scripts and references together; repository updates do not automatically update separately installed copies.

## The skills

| Skill | What it is used for |
| --- | --- |
| [Autopsy](skills/autopsy/SKILL.md) | Reconstruct launch supply, wallet activity, funding evidence, and exits |
| [Meme Scout](skills/meme-scout/SKILL.md) | Trace retained meme and narrative adoption across communities |
| [Ignition](skills/ignition/SKILL.md) | Measure early buying participation, spending, and concentration |
| [Scout Network](skills/scout-network/SKILL.md) | Evaluate discovery wallets and whether their historical picks were followable |
| [Second Wind](skills/second-wind/SKILL.md) | Investigate renewed participation in dormant tokens |
| [PULSE](skills/pulse/SKILL.md) | Collect live observations, compare RPC sources, cache provisional V4 state, and prepare Nitro nodes |
| [WATCHTOWER](skills/watchtower/SKILL.md) | Retain all RPC-reported included transactions over an explicit interval, reconcile receipts, and operate research workers |
| [Undertow](skills/undertow/SKILL.md) | Separate meme returns from stock-quote moves, premiums, and corporate actions |
| [PRESSURE](skills/pressure/SKILL.md) | Reconcile stock-token issuance, supply destinations, and retained liquidity measurements |
| [CATALYST](skills/catalyst/SKILL.md) | Collect SEC disclosures and map them to exact stock-token identities |
| [Night Desk](skills/night-desk/SKILL.md) | Compare equity references, adjusted token values, onchain marks, and retained exit evidence |
| [HOOK LAB](skills/hook-lab/SKILL.md) | Investigate exact V4 hook deployments, fees, configuration, and wallet calls |
| [CIRCUIT](skills/circuit/SKILL.md) | Build pinned Universal Router 2.1.1 V4 routes and measure complete wallet calls on isolated forks |
| [Exit Doctor](skills/exit-doctor/SKILL.md) | Assess size-specific exits through a supported canonical 30-bps V2 route |
| [LP Edge](skills/lp-edge/SKILL.md) | Analyze canonical V3 LP fees, inventory, operating costs, and performance versus holding |
| [Agent Arena](skills/agent-arena/SKILL.md) | Audit supplied portfolio performance with external funding, open inventory, and failed attempts |

## Put them together

- **Early discovery:** Meme Scout + Scout Network → Ignition or Second Wind → Autopsy → a venue-supported exit assessment.
- **FYNCH research:** CATALYST + PRESSURE + Undertow + Night Desk → exact-asset application evidence → Agent Arena performance accounting.
- **Arbitrage Ape research:** PULSE + WATCHTOWER → HOOK LAB deployment evidence → CIRCUIT route construction and fork measurement.

These are research workflows. The [existing JSON handoff](references/research-integration.md) composes CATALYST and Night Desk evidence. Other service and application connections require explicit integration.

## Build the Fumadocs site

From the repository root:

```sh
npm ci
npm run dev
```

Build and validate the static export:

```sh
npm run build
npm run typecheck
npm run check:docs
```

Edit pages in [`docs-site/content/docs/`](docs-site/content/docs/). The site includes all 16 skill guides, verified commands, full-text search, page outlines, light/dark themes, workflows, operations notes, and capability references. Generated public files are staged in `out/`. See the [development guide](docs-site/content/docs/development.mdx).

## Verification and scope

```sh
python3 scripts/check_package.py --tests
```

**v0.8.0:** 16 skills, 317 exported skill files, and 1,422 passing offline release tests. CIRCUIT also retains eight actual-protocol EVM validation scenarios. The [manifest](manifest.json) records file hashes and byte lengths; it is an integrity inventory, not a publisher signature.

Exit Doctor's native adapter is V2; LP Edge's is V3. Exact V4 hook and route research belongs to HOOK LAB and CIRCUIT. Several discovery skills analyze retained normalized inputs rather than collecting live data themselves. Installing skills does not deploy monitoring services or connect FYNCH/Ape production consumers. No skill signs or submits live trades.

Keep synthetic, observed, modeled, simulated, and executed results distinct. Unknown costs and incomplete history remain unknown. See the [capability matrix](docs-site/content/docs/reference/capabilities.mdx), [evidence guide](docs-site/content/docs/reference/evidence.mdx), and [preserved release runbook](docs-site/content/docs/reference/release-runbook.mdx).

## Third-party material

Preserve [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and all scoped license notices inside the skill folders. Keep this repository private.
