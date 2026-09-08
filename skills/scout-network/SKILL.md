---
name: scout-network
description: Evaluate memecoin discovery wallets using complete historical picks, point-in-time evidence, and realistic follower execution assumptions. Use to build or audit a scout wallet watchlist, compare discovery quality, or test whether historical finds were followable. Does not execute trades or collect live wallet data natively.
---

# Scout Network

Find wallets whose discoveries were useful to an ordinary follower at the stated decision time. A profitable insider allocation, a token's eventual high, and an unrealized wallet balance are not evidence of followable skill.

## Workflow

1. Establish chain and observation window, decision cutoff, wallet selection rule, quote currency, follower delay, entry budget, and exit policy. Freeze the wallet cohort before its observation window. If working retrospectively from famous winners, label the selection bias and do not rank that sample as validated scouts.
2. Read [references/method.md](references/method.md). Use available verified host data tools to collect every eligible discovery, including losers, failed attempts, dead tokens, and unresolved outcomes. Preserve transaction/block references, event time, first availability time, source type, and omitted coverage. This skill has no native RPC collector; do not fabricate a live scan or install a collector implicitly. If data access is absent, work from supplied normalized evidence and state the limitation.
3. Separate ordinary buys from privileged allocations, issuer-linked/insider access, and unknown access. Assess related-wallet groups using evidence available at the cutoff; dependence evidence is not proof of ownership. Do not count a coordinated group or repeated token as independent confirmations.
4. For repeatable evaluation, normalize to [references/schema.md](references/schema.md), then run `python scripts/evaluate.py INPUT.json --output NEW_REPORT.json`. Outputs are created exclusively and never overwrite an existing path. Keep real runs distinct from the synthetic example. The helper ranks only complete declared cohorts and matured, available outcomes under the supplied scenario; it cannot verify upstream normalization or source authenticity.
5. Report wallet-level sample size, every status denominator, cohort coverage and exclusions, executable follower results, token concentration, overlap, relationship uncertainty, and ranking gate failures. Label simulated results hypothetical and executed results realized. Show absolute returns in their original currency and exact ratios; never pool currencies. Missing costs/exits remain unknown, not zero. Do not invent confidence percentages or treat engineering gates as statistically calibrated.

Rankings apply only to the frozen supplied cohort and scenario. Show sensitivity to delay, size, costs, exit policy and uncertain clustering by evaluating separately specified scenarios; do not choose the scenario after observing its winners. A small or incomplete sample may yield no ranking and still be useful evidence.

For a current candidate, pass exact chain, token address, discovery timestamp, decision cutoff, and evidence references to Ignition for launch context, Autopsy for allocation/funding investigation, or Exit Doctor for current exit capacity when those skills are available. These handoffs are optional; this skill works independently. No signing, fund movement, approvals, social posting, or scheduling is part of this workflow.

## Local verification

`python -m unittest discover -s tests -v`

`python scripts/evaluate.py examples/synthetic.json --output /tmp/scout-demo-NEW.json`

The example is fictional and tests bookkeeping, not predictive performance.
