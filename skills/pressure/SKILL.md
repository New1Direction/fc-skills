---
name: pressure
description: Investigate Robinhood Chain stock-token issuance, supply destinations and changes in measured liquidity. Use for mint/burn reconciliation, supply replenishment, stock-token scarcity research, wallet-specific trade-size comparisons, and prospective signal evaluation. Includes bounded ERC-20 receipt collection, raw-versus-multiplier accounting, retained liquidity comparisons and an outcome journal. Produces research evidence; does not execute trades or infer sellable float from aggregate balances.
---

# PRESSURE

Explain whether observed stock-token supply is expanding or contracting, where balances and transfers are observed, and how supported trade-size measurements change. Focus on Robinhood Chain **4663**. Keep supply, custody, pool inventory, wallet execution and hypotheses distinct.

## Choose a workflow

| Question | Native workflow and reference |
| --- | --- |
| Did token supply change? | `collect`, `verify`, `analyze`; [collection.md](references/collection.md) and [supply.md](references/supply.md). |
| Where did issuance initially go? | Supply analysis reports direct mint recipients, labeled holdings and subsequent observed wallet activity. It does not identify fungible units after mixing. |
| Is liquidity getting harder to trade? | `liquidity`; [liquidity.md](references/liquidity.md) compares exact retained sizes, directions, wallets, routes and evidence types. |
| What can these observations establish together? | `report` accepts supply evidence and optional liquidity inputs, checks the asset, and exposes time alignment without a causal score. |
| Do these signals improve selection? | `freeze`, `outcome`, `journal`; [outcomes.md](references/outcomes.md) freezes a candidate universe and retains missing outcomes and controls. |

Node.js24+ runs normal commands using built-in modules. Read the relevant reference before preparing strict JSON inputs. Read [stock-semantics.md](references/stock-semantics.md) for multiplier/price interpretation and [integration.md](references/integration.md) before using FYNCH, PULSE, Undertow or HOOK LAB evidence.

## Get a concrete case

Reuse the exact chain/address, retained block hashes, source/deployment expectations and observation window already available. Resolve stocks through official deployment metadata; tickers alone are insufficient. A useful first case is one known stock token, a short window containing an issuance event, tracked recipient/venue addresses with evidence, and a few previously qualified wallet routes.

Use existing FYNCH canonical exports or PULSE events to locate the window. This skill is a bounded investigation tool, not another continuous indexer. FYNCH Float supplies useful raw custody observations, but its inspected snapshot format lacks a block hash and does not measure complete V4 pool inventory. Add the missing independent pins and preserve its coverage warnings; do not relabel it complete.

## Commands

Run from this skill directory. Set `PRESSURE_RPC_URL` privately to an available archive endpoint for collection. Environment values are not saved in evidence.

```sh
node scripts/pressure.mjs demo --out /tmp/pressure-demo
node scripts/pressure.mjs collect --input request.json --rpc-env PRESSURE_RPC_URL --out output/collection.json
node scripts/pressure.mjs verify --input output/collection.json --out output/verification.json
node scripts/pressure.mjs analyze --input output/collection.json --out output/supply.json
node scripts/pressure.mjs liquidity --input liquidity-observations.json --out output/liquidity.json
node scripts/pressure.mjs report --input research-bundle.json --out output/report.json
node scripts/pressure.mjs freeze --input cohort.json --journal output/study.jsonl --out output/frozen.json
node scripts/pressure.mjs outcome --input outcome.json --journal output/study.jsonl --out output/recorded.json
node scripts/pressure.mjs journal --journal output/study.jsonl --out output/outcomes.json
node --test scripts/test_*.mjs
```

The demo requires a new output directory and is explicitly synthetic. It keeps the independent teaching cases and also generates `research-bundle.json` with an explicitly constructed same-asset/block scenario for `report`. `analyze` accepts either a native collection (with transcript replay) or a normalized supply dataset (with supplied-evidence limitations). `verify` and `analyze` also accept the bundled synthetic EVM envelope, validating only its nested collection; outer setup/assertion fields are not authenticated. Invalid `verify` results are saved and exit with code2. `report` input is `{ "supply": <collection-or-dataset>, "liquidity": <optional-liquidity-input> }`; the liquidity token and decimals must match the supply token. A failed collection remains unavailable. The optional actual EVM harness and retained validation evidence are described in [validation.md](references/validation.md).

## Collect and reconcile supply

Pin both start and end block hashes. The accounting window is **(start, end]**: start snapshots precede the included events. The collector examines every transaction receipt reported in up to 64 intervening blocks, capped at 256 receipts and 20 tracked addresses. It checks canonical header continuity, transaction/log identities, endpoint code/decimals, supply, multiplier and balances, then rechecks canonical endpoints. Bounds or missing evidence stop a complete result; never silently drop data to fit a limit.

Account once from standard ERC-20 `Transfer` events. Do not count a parallel scaled-UI event again. Mint/burn events must reconcile with raw `totalSupply`, and tracked flows must reconcile with each address's balances. The multiplier is a separate 18-decimal ratio; its change does not itself mint raw tokens. Refer to stock semantics before valuing a token or explaining a corporate action.

Expected endpoint runtime hashes are supplied expectations. They do not establish proxy implementation identity, stability between snapshots, source correspondence or truthful token behavior. Use deployment review and HOOK LAB where applicable. Full receipt enumeration remains provider-derived without a cryptographic receipt-trie proof. Digests and replay verify internal consistency, not provider authenticity.

## Interpret destinations and liquidity

Use address labels only with retained references and validity intervals. Report measured categories and unmeasured balances explicitly. Do not call unmeasured supply free float or assume it is outside pools. V4 PoolManager custody is aggregate custody across pools and other obligations, not one pool's reserves. Tokens sent to a venue are not necessarily sold or added as liquidity. Later outflows from a mint recipient cannot identify the same minted units after fungible balances mix.

Compare only observations with matched wallet, token pair/decimals, route/configuration identity, direction, size and evidence kind. A quote, a wallet call and fork wallet-balance evidence establish different things. Apply the user's explicit freshness and cost policy. Unknown costs stay unknown; fees already included in output must not be charged again. Convert other cost currencies with retained contemporaneous evidence before asserting complete costs.

A venue marginal reference measures execution shortfall at size. An external stock reference measures premium/discount and may need exactly one multiplier adjustment; it is not the venue's own price-impact baseline. A largest tested passing size is a tested point, never a maximum capacity or permission to interpolate. Recollect after code/config changes or reorgs.

## Evaluate and report

Freeze a complete candidate universe, selection policy and fixed horizon before recording outcomes. Include unselected controls, reverted routes and missing outcomes. Preserve modeled, wallet-fork and executed claims separately. The journal does not authenticate fills or costs; retain evidence behind them. Descriptive differences do not establish causality or a profitable edge.

Lead with the observed supply change and usable coverage. Show raw mint/burn, supply reconciliation, multiplier effects, measured holdings and destination evidence, then supported liquidity comparisons. Explain what remains unknown and what additional observation would resolve it. Keep trade signals unset until a separately validated strategy justifies them. A mint is not an automatic sell signal.

Before claiming a usable Pons trading route, require exact deployment and actual-wallet evidence through HOOK LAB and the intended consumer. PRESSURE's supply research does not grant mint/redemption privileges, build a swap router, or enable Ape/FYNCH live execution. Direct issuer mint/burn access is restricted to onboarded authorized participants; do not assume an ordinary wallet can arbitrage every stock-token premium away.
