# Reporting

Make the answer useful to a reader deciding which claim deserves belief. Start with the answer to the user's question and the evidence strength; put the investigation mechanics after it.

For a full case, use this shape, omitting inapplicable sections:

1. **Finding:** Two to four sentences stating what is established, what remains a hypothesis, and why it matters.
2. **Case scope:** Exact chain/address, launch definition, captured window, cutoff, finality, and sources.
3. **Timeline:** Material events with transaction links and precise event identifiers.
4. **Supply path:** Initial allocation, observed acquisitions, transfers, verified disposals, and retained inventory. Name the denominators and unresolved balances.
5. **Relationships:** Observed funding/execution/consolidation edges, proposed groups, and alternative explanations. A compact directed graph is useful only when the edges tell the story.
6. **Liquidity, privileges, and exits:** Report the covered mechanisms and their evidence. Keep unsupported analyses visible as gaps, not empty “safe” results.
7. **What could change this finding:** Strongest competing explanation and the next useful evidence.
8. **Evidence appendix:** Source IDs, capture information, hashes where retained, and reproducible calculations.

Link every material claim to the chain-specific transaction or raw evidence record. For routed trades, a transaction hash plus log/instruction identifiers is more precise than an explorer homepage. If no valid explorer URL is available, give the exact identifiers instead of inventing a link.

Use a table for exact amounts and roles. Use a graph only when it helps explain relationships; label edges by the observed transfer or execution rather than “owns.” Keep raw integer amounts in JSON, with display amounts in the brief.

Prefer explicit findings such as “18% of supply at block N was held by these addresses” over “high concentration.” State which addresses and why they are grouped. Distinguish a measured fee from an inferred or configured fee.

Keep factual sentences separate from interpretation. For example:

- Fact: Wallet A transferred 10,000 units to B in transaction T.
- Derived: This equals 1% of the verified supply at block N.
- Hypothesis: A and B may share control; linked funding and later consolidation support this, while service-based distribution remains plausible.

If capture is incomplete, lead with the supported result and quantify or describe the missing window. Never bury a gap that could reverse the conclusion. Avoid a universal risk score, promise of sellability, guaranteed profit, or categorical accusation unsupported by the case.

For user-facing files, save the report through the host's artifact workflow. Do not put live case evidence, wallet lists, credentials, or user material back into the installed skill directory. Keep training examples conspicuously synthetic.
