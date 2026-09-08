---
name: meme-scout
description: Investigate emerging memes and narratives through retained social-post evidence, separate original adoption from amplification, and resolve associated token identities. Use for narrative discovery, cross-community spread, origin claims, or meme-token association research. Does not predict returns or execute trades.
---

# Meme Scout

Discover and explain how a narrative appears in an explicitly bounded social sample. Work from current public search when available or supplied observations when it is not. A short evidence-based answer is useful even without associated tokens or other skills.

## Research and evidence

Establish the narrative, date window, as-of cutoff, relevant languages/platforms, and whether token mapping is wanted. Use reasonable defaults and state them. Read [research.md](references/research.md) for query expansion and source retention. Search with available web/X tools; this skill includes **no live collector, credentials, authenticated Grok client, or background service**. If the relevant tool is absent, analyze supplied evidence and describe the gap. Never substitute invented posts or synthetic fixtures for observed research.

Trace original expression, repeat participation, and movement between communities. Read [adoption.md](references/adoption.md) before attributing independence, origin, coordination, or sponsorship. Keep reposts, quotes, copies, documented campaigns, and paid promotion visible separately. An account is not necessarily a person, and distinct accounts do not prove independence.

Preserve both post event time and evidence availability time. A retrospective claim uses only evidence available by its cutoff; later discoveries can be a separate present-day interpretation. Search results are incomplete. Say “first observed in this sample,” never “first ever” without independently adequate evidence.

## Deterministic analysis

For repeatable counts, prepare strict JSON using [schema.md](references/schema.md), retaining source URLs, post text, timestamps, and selection notes. Run:

```bash
python <skill-dir>/scripts/analyze.py observations.json --out /absolute/path/new-report.json
```

The standard-library helper validates a bounded input, hashes its original bytes, applies availability/event cutoffs, separates amplification, flags exact normalized cross-author copies, and reports distinct-author original candidates and documented community assignments. Outputs are created exclusively; existing paths are never overwritten. It does not fetch data, authenticate sources, infer sentiment, identify semantic near-copies, or certify independence. Review the retained evidence and competing explanations before writing conclusions.

For a synthetic, offline smoke test use `examples/synthetic-observations.json` and a fresh output path. Run tests with `python -m unittest discover -s <skill-dir>/tests -v`.

## Token identity and handoff

Read [token-identity.md](references/token-identity.md) when associating a token. Require exact chain and address, preserve competing copies, and retain primary identity evidence available by the cutoff. Names and tickers are search clues. Never infer social-account ownership of a wallet from matching handles or claimed association.

Use the report's `handoff` envelope when another available skill is relevant: Ignition for a bounded launch-readiness investigation, Autopsy for transaction-backed launch history, or Exit Doctor for execution capacity at a specified size. Pass only resolved exact identities as resolved; ambiguous candidates stay ambiguous. Do not invoke another skill merely to complete a standalone narrative report.

## Deliverable

Lead with the supported finding and its scope. Include time window/cutoff, cited example posts, earliest retained evidence, original-candidate versus amplification counts, community attribution strength, unresolved token copies, missing coverage, and at least one plausible alternative explanation where causality or coordination is discussed. Counts describe the retained sample; they are not an all-X census, bullishness score, causal adoption estimate, or profit forecast. A negative search result is not proof of absence.

Keep provenance `observed`, `synthetic`, or `unknown` visible. Report references identify supplied observations, not cryptographic truth. This skill reads and analyzes evidence; it does not sign, trade, post, message, or schedule monitoring.
