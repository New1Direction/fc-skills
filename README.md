# fc-skills

**Crypto research tools for your AI agent.**

Research tokens, check liquidity, and monitor Robinhood Chain with 16 focused skills.

A skill gives your agent instructions and tools for a specific job. You ask the question; the skill helps it work through the evidence.

[Start here](docs-site/content/docs/quickstart.mdx) · [Browse the skills](docs-site/content/docs/skills/index.mdx) · [Read the docs](docs-site/content/docs/index.mdx)

## What can I use it for?

| I want to… | Start with |
| --- | --- |
| Understand a token launch | [Autopsy](docs-site/content/docs/skills/autopsy.mdx) |
| Check early buying interest | [Ignition](docs-site/content/docs/skills/ignition.mdx) |
| Understand stock-paired memecoins | [Undertow](docs-site/content/docs/skills/undertow.mdx) |
| Monitor chain activity | [WATCHTOWER](docs-site/content/docs/skills/watchtower.mdx) |
| Test a supported swap route | [CIRCUIT](docs-site/content/docs/skills/circuit.mdx) |

[See all 16 skills →](docs-site/content/docs/skills/index.mdx)

## Try an example

Requires Git and Node.js 24 or newer.

```sh
git clone https://github.com/New1Direction/fc-skills.git
cd fc-skills
node scripts/msk.mjs demo --out ../fc-skills-demo
```

The demo records sample transactions, creates pool reports, and shows how reports update when a block is replaced. It uses a simulated chain. No wallet or provider key is needed.

## Use it with your agent

Give your agent access to the skill's complete folder. Then ask a clear question:

```text
Use Autopsy to investigate this token launch.
Show where the supply went and which findings have transaction evidence.
Ask me for any missing data.
```

## Good to know

- These tools research and simulate. They do not place live trades.
- Live monitoring needs a data provider and a running host.
- Pool support varies. Check the skill page before using real data.

[Monitoring setup](docs-site/content/docs/operations/operator.mdx) · [Developer guide](docs-site/content/docs/development.mdx) · [Validation](operator/validation/README.md)

A project-wide open-source license has not been assigned. See the [third-party notices](THIRD_PARTY_NOTICES.md) for component terms.
