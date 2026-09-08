# Investigation playbook

## Identity and chronology

Build a compact event table: deployment or mint creation, initial mint/allocation, pool creation, initialization, liquidity provision, first observed tradable swap, launchpad transition, material admin changes, and cutoff. Record exact transaction/log or instruction references.

Confirm whether the creation transaction's sender is a factory, service, EOA, or contract account. Contract creator, transaction sender, funder, initial recipient, and beneficiary are different roles. A deployment trace may identify a creating contract without identifying the human or organization operating it.

If first trading predates accessible history, write “first observed in the captured window.” When comparing launches, align them on an explicitly defined event and elapsed chain time; do not choose the alignment after observing outcomes.

## Opening inventory

Reconstruct mint destinations and transfers before/around launch. Obtain total supply and relevant balances at the same block or slot. Name the denominator in every allocation percentage: minted supply, supply at cutoff, circulating estimate, or captured cohort acquisition.

Use integer raw units for accounting. Display conversion is raw / 10^decimals. Calculate percentages with decimal arithmetic; do not route large token quantities through binary floats. Mint/burn logs, balance changes, and supply reads can disagree for unusual tokens; retain the discrepancy and inspect the implementation.

For ordinary transfer semantics:

`closing_balance[a] = opening_balance[a] + received[a] - sent[a]`

Sum flows over the **union** of cohort addresses. Internal cohort transfers cancel and are not fresh accumulation or exits. When an opening balance is unknown, report net change only. Incoming transfers are not automatically cost basis, and outgoing transfers are not automatically realized losses.

Keep AMM inventory, vesting contracts, lockers, bridges, custodians, and burn conventions identifiable. A nonzero “dead” address holding tokens is not necessarily a supply-reducing burn. Wrapped and bridged supplies need separate liability/backing accounting; do not add them into one circulating total by ticker.

## Early access and privilege

Inspect launch-time implementation, initialization, role assignments, trading-enable conditions, allowlists, exemption mappings, fee setters, transfer limits, and upgrade authority where evidence is available. Pin reads and traces. Current verified source may describe a later implementation.

Compare paths: deployer-associated purchase, ordinary-wallet purchase, ordinary-wallet sale, LP changes, and launchpad migration. Identify actual calldata, caller/sender/origin distinctions, router, route, block, and net balances. An observed privileged successful call does not prove the same call is permissionless.

Estimate empirical transfer taxes only when pre/post balances and the relevant execution path permit it. Separate pool fees, protocol/router fees, transfer taxes, gas, tips, and price impact. Do not use a generic quoted fee as a measurement of the token's actual tax.

## Wallet roles and supply path

Tag observed roles before discussing control: initial recipient, market buyer, liquidity provider, bridge/custody address, router, funder, or collector. Record the evidence for each role and allow roles to change over time.

Read attribution.md before constructing relationship groups. Measure opening inventory, peak observed inventory, later transfers, independently verified sales, current retained inventory, and coverage. Avoid assigning every early buyer to an insider cohort.

A “handoff” is an observed transfer path until acquisition, control, and subsequent disposal evidence supports something stronger. Transfers through a common exchange or mixer break simple continuity claims; do not force a one-to-one origin/destination mapping.

## Liquidity and exits

Resolve exact pools and fee tiers; for v4 resolve pool ID, currencies, fee, tick spacing, and hooks. Obtain actual position and pool events. Separate price-driven inventory changes from added/removed liquidity and moved ranges. “Buy-side” and “sell-side” are interpretations that require a named base/quote convention and price-relative active ranges.

For each suspected disposal, reconstruct the full successful transaction, all token/quote movements, routed hops, intermediate recipients, and fees. Mark reverted transactions as attempts; gas can still be a cost. Net quote received by an attributable recipient is stronger evidence of proceeds than a single Transfer into a router.

Differentiate seller, executor, recipient, and eventual beneficiary. Consolidating several wallets' proceeds into one address is evidence of consolidation, not by itself proof of original common control.

Report realized proceeds in their native quote asset. If translating to USD, retain the rate, source, timestamp, and uncertainty. A tokenized stock quote can differ from the underlying stock price. Preserve both measurements; a gap is not proof of an executable arbitrage or redeemability.

Unrealized mark-to-market value is not exit capacity. If position-size quotes or simulations are included, timestamp and label them as current-state estimates. Historical charts do not establish an achievable historical fill.

## Recurrence and competing hypotheses

Expand into deployer history only for a supported address or relationship. Compare deployment method, bytecode/implementation, initial recipient patterns, fee collectors, funding paths, and subsequent transfers. Shared templates and launchpad factories are common infrastructure, not an operator fingerprint by themselves.

For each material suspicion, state at least one plausible alternative and the observation that would distinguish it. Examples: service-funded independent users versus common controller; LP rebalance versus inventory withdrawal; migration versus rug; exchange deposit versus completed sale; airdrop versus purchased position.

Do not produce a numerical “scam probability” from uncalibrated heuristics. A useful conclusion can be narrow: “The captured history establishes concentrated initial allocation and subsequent sales by three initial recipients. Their common control remains unestablished.”

## Completion check

Ensure every material number has an anchor and denominator; every cluster has explainable edges; every claimed sale has execution evidence; every source gap has an effect on the conclusion. Distinguish clean results from missing observations. State the single next piece of evidence most likely to change the conclusion.
