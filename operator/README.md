# MSK Operator v1

Run Robinhood Chain capture, durable research workers, and PULSE exact-pool analysis through one command. This is a repository integration alongside the 16 exported MSK skills.

Requires Node.js 24+ on a persistent host. The runtime uses Node built-ins and bundled skill helpers; npm dependencies are only needed for the Fumadocs site.

```sh
node scripts/msk.mjs help
node scripts/msk.mjs demo --out ../msk-operator-demo
node --test operator/test_*.mjs
```

Read the [complete Operator guide](../docs-site/content/docs/operations/operator.mdx) for initialization, exact registry fields, environment configuration, 24-hour acceptance, recovery, and exports. The demo uses a local synthetic RPC and cannot pass live acceptance.

| Module | Responsibility |
| --- | --- |
| `config.mjs` | Validate chain, exact pool keys, source references, limits, and consumer identity |
| `runtime.mjs` | Own the workspace and supervise independent capture, worker, and consumer processes |
| `consumer.mjs` | Commit single-block PULSE reports and source acknowledgements atomically; retract orphan generations |
| `status.mjs` | Report retained coverage, source freshness, worker progress, report status, and run acceptance |
| `storage.mjs` | Seal and verify SQLite snapshots, bind retention acknowledgements, restore, and expand capacity |
| `common.mjs` | Atomic state writes, process ownership, bounded input reads, and hashes |
| `fixtures.mjs`, `demo.mjs` | Explicitly synthetic HTTP boundary and recovery demonstration |

All included transactions reported by the source are retained from the explicit starting block, including failures and unknown types. Exact-pool filtering applies to research dispatches, not full-block capture. Coverage is provider-derived; internal calls and independent finality are not established.

The consumer uses the existing PULSE decoder and state engine on each independently reconciled block. WATCHTOWER's `undertow` routing hint does not mean the full UNDERTOW workflow ran. Reports are provisional research, not executable quotes or trade instructions.

Runtime files should live outside the repository on local durable storage. Use one active workspace owner; concurrent operation on a shared network filesystem is unsupported. Snapshot before migration. Nothing automatically prunes evidence or signs transactions.

## Linux service example

[`msk-operator.service`](msk-operator.service) is an inactive template. Prepare a dedicated `msk` account, checkout, named endpoint environment file, exact registry, and initialized workspace first. Verify the paths and Node version on the intended host before installing it.

The example uses `/opt/msk`, `/var/lib/msk/robinhood`, and `/etc/msk/endpoint.env`. Restrict the endpoint file to its service account/administrator. Give that account write access to the workspace parent and read access to the checkout. Runtime configuration stores only endpoint variable names.

The service runs continuously. It restarts after an abnormal supervisor termination, but refuses automatic restarts for CLI configuration/runtime failures (exit 1 or 2). Investigate storage, source, worker, or ownership failures before restarting. The 24-hour acceptance procedure uses a bounded foreground run and a retained final report; a still-running service has not passed that gate.

No host has been provisioned or service enabled by adding this template.
