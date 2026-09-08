# Research report interpretation

Use `scripts/research.py` to combine one or more attribution inputs with an optional flow input. Each module can also run alone. The combined wrapper produces JSON and an optional Markdown brief, retains failed price candidates, checks compatible asset units/PoolKeys/windows/cutoffs, and rejects conflicting shared block histories from the join. Input order is preserved; no profitability score or investment ranking is generated.

```sh
python3 scripts/research.py --attribution /path/a.json --attribution /path/b.json --flows /path/flows.json --out /path/report.json --markdown /path/report.md
```

## Lead with supported observations

Explain what the meme gained or lost against its quote asset, how much the local quote token moved, and whether stock reference evidence supports separating local premium changes. Present multiplicative factors without describing them as additive contributions or causal effects.

Participation joined to a price observation is **asset-wide across the retained registered pools**. It is not automatically specific to the one pool used for attribution. A wallet can have both net-buy and net-sell transactions during the window; these counts are not mutually exclusive groups and do not count independent people.

State the observation window, baseline, knowledge cutoff, collection coverage and asset universe. Explain which transactions were quarantined and why. Unknown or excluded attribution prevents a complete participation claim. Current source capture, retrospective imports, synthetic examples, modeled scenarios, and executed outcomes have different evidentiary meaning.

## Output structure

- `comparison_rows`: every submitted price candidate, returns when available, component qualification, join status/reasons, and eligible asset-wide participation.
- `attribution_reports`: the complete reproducible price decompositions with source references and limitations.
- `flow_report`: full supplied asset universe, original-unit cashflows, transaction deltas, rotation hypotheses and structural quote groups.
- `input_manifest`: SHA-256 of normalized input JSON. Changing serialization whitespace does not change this digest; changing parsed content does. It is not a provider signature.
- `report_created_at`: actual report creation. It does not prove any historical alert existed.

`COMPLETE_MARK_ATTRIBUTION` means complete mathematical decomposition using the required supplied fields. `SUPPLIED_CHECKS_PASSED` does not establish independent chain verification. `SCOPES_ALIGNED` means a compatible join, not verified economic actors or complete historical capture. Keep these meanings visible instead of shortening them to “verified alpha”.

## From finding to testable idea

A useful research candidate might combine positive quote-relative performance with broader observed participation and adequate quote evidence. To investigate whether that predicts returns, freeze the rule and full candidate universe before outcomes, specify latency and intended sizes, record actual observation availability, and retain negative and missing outcomes. Compare with quote-token holding and simple unfiltered baselines under equivalent costs and availability. The included code does not perform this prospective evaluation.

Do not claim profit from a chart mark, growing token count, provider-derived notional, or an unfilled quote. Actual executable paths and complete costs belong in an independently validated execution/outcome workflow. Fee, hook, tax, approval, and route access evidence must fit the actual V4 route.
