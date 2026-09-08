# fc-skills Operator

Run Robinhood Chain monitoring and pool research from one command line.

The Operator connects WATCHTOWER’s transaction capture to PULSE’s pool analysis. It tracks progress, recovers missed blocks, and keeps reports tied to their source evidence.

## Try it

Requires Node.js 24 or newer. Run from the repository root:

```sh
node scripts/msk.mjs demo --out ../fc-skills-demo
```

Open `../fc-skills-demo/demo-report.json` to see the results. The demo uses a simulated chain and needs no provider key or wallet.

## Run live monitoring

You need an RPC provider, a persistent host, and durable storage. Pool reports also need a registry of verified pool identities.

Follow the [setup and recovery guide](../docs-site/content/docs/reference/operator-runbook.mdx) for the full configuration and commands. A [Linux service template](msk-operator.service) is included for unattended operation.

After setup, check progress or stop the Operator:

```sh
node scripts/msk.mjs status --workspace ../fc-robinhood
node scripts/msk.mjs reports --workspace ../fc-robinhood --limit 20
node scripts/msk.mjs stop --workspace ../fc-robinhood
```

Capture covers included transactions reported by your provider, including failed transactions. It does not include private pending transactions or internal calls.

A live 24-hour run has not yet been validated. See the [validation record](validation/README.md).
