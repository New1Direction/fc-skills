---
name: second-wind
description: Investigate dormant memecoins showing renewed participation by comparing their own historical windows, new buyer cohorts, capital breadth, incumbent selling, and usable liquidity. Use for revival or second-wave research. Analyze retained evidence or collect through verified available providers; does not execute trades.
---

# Second Wind

Determine whether an established token had documented dormancy before the research cutoff, then assess renewed participation and competing explanations. A price bounce, a new pool, marketing, or old holders returning does not establish new demand. Findings are evidence assessments, never revival probabilities or profit promises.

## Workflow

1. Resolve exact chain, token identifier, token unit, quote unit, pool scope, and an explicit UTC cutoff. For discovery requests, identify candidates through available current sources before applying this analysis; the bundled helper does not search markets.
2. Read [live research](references/live-research.md) when collecting data, and [method](references/method.md) when assessing a candidate. Select equal-duration historical active, subsequent dormant, and current windows using information available at the cutoff. Fix dormancy criteria before inspecting the current outcome; avoid selecting only an unusually quiet hour.
3. Preserve source responses and citations. Normalize only supported observations using [schema](references/schema.md). Unknown fields remain null or absent. Coverage gaps are unknown activity. The helper validates supplied evidence relationships, not raw-chain authenticity or provider truth.
4. Run the deterministic analyzer with a fresh output path:

   ```bash
   python scripts/analyze.py --input assets/synthetic-example.json --output /tmp/second-wind-example.json
   ```

   The bundled input is synthetic. Never present it as a live token finding. Real data must include actual retained evidence references and its source kind. Read the output's exclusions, coverage, and limitations before interpreting its classification.
5. Report documented dormancy, activity change against the token's own baseline, genuinely new versus returning buyers, capital concentration and unresolved group relationships, incumbent net selling, and quote-unit liquidity/depth. Explicitly separate measured facts, upstream assertions, inferences, and unknowns. Show cutoff, source kind, input hash, window duration, thresholds, and material exclusions. Treat heuristic thresholds as uncalibrated engineering defaults.

Do not identify people behind wallets. Shared funding or coordinated timing supports suspected dependency, not proof of common ownership. If relationship coverage is unknown, wallet breadth cannot become independent-capital breadth. Pool migrations, rebases, changed token units, or changed quote assets require a separately justified reconciliation; the native helper conservatively rejects these comparisons.

## Boundaries and follow-up

Works standalone with retained normalized observations. No native all-chain RPC collector, signer, trading, allowance approvals, messaging, or scheduling is included. Use only available providers whose capability and semantics have been checked. Unsupported chains or missing history limit conclusions; never invent adapter support.

Read [handoff](references/handoff.md) only when a follow-up needs early traction analysis, a launch autopsy, or position-size exit analysis. Ignition, Autopsy, and Exit Doctor are optional; lack of those skills does not block this report.
