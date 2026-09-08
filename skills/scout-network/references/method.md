# Evidence and interpretation

## Cohort before reputation

A scout is a wallet identified before the discovery period by a rule that did not depend on the period's eventual returns. Collect every first discovery for each selected wallet in a fixed event-time window, with first availability recorded separately. Include zero-activity selected wallets, failed following attempts, untradeable tokens, and censored outcomes. A complete export of winners is still an incomplete cohort. The helper checks supplied counts and timestamps, not the truth of the selection rule or manifest. Verify the manifest against the available source and disclose blind spots before using its rankings.

Define discovery eligibility before extracting data (for example, first qualifying ordinary purchase after first public tradability, with chain, venues, age window and minimum purchase size). Do not retune the definition to erase failures or privilege. There is one normalized case per wallet/chain/token; consolidate same-discovery fills upstream. Historical PnL and balance changes alone cannot reconstruct these cases.

## Collector and normalization boundary

Discover applicable verified host data tools and read their schemas. Use chain-native token identifiers, transactions, block heights/hashes, receipts, swap flows, token decimals, wallet acquisition provenance, and historical executable routes as available. Preserve their source references and data coverage. Obtain provider/indexer first-availability timestamps or clearly identify conservative estimates; event time is not an availability proxy. Do not imply that a connector, RPC endpoint, complete history, simulations, or archival state exists when it does not.

Neither a URL nor a transaction hash authenticates a supplied row. Validate token decimals, gross-versus-net flow conventions, partial fills, acquired/disposed quantities, fees, transfers, quote asset identity, and duplicated records upstream. Split currencies into separate reports. If native gas must be converted, the normalizer needs a contemporaneous, cutoff-available conversion with its own source; the helper accepts only already harmonized quote-currency costs and does not perform conversions.

Privileged distributions, private presales, issuer funding, and insider allocation paths do not establish ordinary follower opportunity. Classify uncertain access as unknown. Funding links suggest dependence rather than proving identity; a common exchange withdrawal source alone is insufficient to establish one owner. Missing relationship evidence never establishes independence.

## Follower scenario

Entry target is **discovery first availability + supplied follower delay**. Entry quote amount must equal the supplied budget, excluding separately recorded fees. The supported exit policy closes the entire acquired quantity at **actual scenario entry time + fixed holding duration**. A bounded supplied lag permits the first executable fill after each target; upstream must choose that first eligible fill, not a later favorable price within the lag. The evaluator verifies the window, not first-fill selection.

Use historical executable route evidence at the stated block/state and size, with price impact, transfer taxes, restrictions, route fees, gas and MEV assumptions. An indicative chart price or quote does not demonstrate executable sale capacity. `simulated` requires an upstream verified executable route/wallet-call simulation and explicit assumptions; it remains hypothetical. `executed` means actual independently evidenced follower executions matching the scenario, not the scout's original trades. A normalized record's mode is an assertion, not a helper-verified simulation.

There is no maximum-price exit, future winner wallet selection, terminal mark, or inferred sale from disappearing balances. Partial exits and failed attempts stay visible but receive no completed-trade return. Their known costs stay in raw evidence and are excluded from the explicitly named completed-case aggregates; default unresolved tolerance is zero, so they prevent ranking. Any user-authorized relaxed unresolved gate produces conditional rankings with missing-outcome bias prominently disclosed.

## Reporting and interpretation

Lead with whether the supplied cohort supports a ranking at all. For each wallet show all visible picks, evaluated cases, every unresolved/unfollowable status, distinct tokens, net gains/losses, median and aggregate completed-case returns, token capital share and positive-profit concentration. Report group assignments and pairwise token overlap alongside ranking; no network PnL or independent confirmation total is produced.

The default gates are engineering choices, uncalibrated: at least 3 evaluated discoveries on 3 distinct tokens, zero unresolved/unfollowable picks, and at most 50% of capital or positive profits attributable to one token. These do not establish statistical significance. All-negative wallets can meet data-quality gates; ranking eligibility does not recommend a purchase or imply profitable skill. Small samples, token dependence, market regime changes, multiple comparisons, latency, and capacity remain material uncertainty. Compare against an explicitly declared simple baseline in a separate forward test if making a predictive claim.

For sensitivity, predeclare alternate delays/budgets/exit policies and re-normalize historical executions for each; changing a scenario label without new matching fills is invalid. Scenario/threshold predeclaration is a workflow requirement: the helper has no timestamps for those choices and cannot verify that they preceded outcomes. Do not call an optimized retrospective scenario a forward-validated signal. Keep every run, its input hash, rule version, source kind, cohort/exclusions, cutoff and scenario. Use chronological windows or prospective scorekeeping to test whether reputation survives unseen data. No numerical confidence probability is fabricated by this skill.
