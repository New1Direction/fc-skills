# Attribution and wallet relationships

## Model edges, then evaluate hypotheses

Store a relationship as: source address, destination address, type, observed time/block, supporting evidence IDs, infrastructure status, and interpretation. Keep this observed graph separate from proposed control groups.

| Observation | What it supports | What it does not establish |
| --- | --- | --- |
| Direct token or native-asset transfer | A value-transfer relationship at that time | Beneficial ownership, purchase, or coordinated intent |
| Same CEX hot wallet / bridge / paymaster funding | Use of shared infrastructure | Common control |
| Same non-infrastructure first funder | A funding relationship worth investigating | Identity or control without corroboration |
| Tight entry timing / same block | Similar timing or response to a common event | Same bundle or operator |
| Same transaction execution | One execution envelope with observed calls | Identical beneficiaries or intent |
| Similar amounts, bytecode, gas settings, or routes | A behavioral/template similarity | An operator fingerprint by itself |
| Trace-supported common executor + linked funding + later proceeds consolidation | Stronger support for a coordination hypothesis | A named person's identity or every wallet's membership |
| Public self-attribution or verified signature | The specific attested claim, subject to source and time | Ownership of every historically connected wallet |

Corroborate using signals with different causes. Timing, ordering, and gas similarity may all derive from one common bot, launchpad, or market event and are not three independent signals. Search for infrastructure explanations before forming a control hypothesis.

## Avoid transitive overreach

Do not union every connected address. If A funds B and B trades through router C, that does not put every user of C into A's cluster. Preserve edge-specific confidence and keep uncertain members separate.

Report a strict, supported address set and any broader scenario separately. Recompute inventory for each set, deduplicate addresses, and show how the conclusion changes. Do not add nested cluster percentages or count internal transfers as external flow.

Use confidence words to describe the strength of a particular claim, not the moral status of an address. Write the supporting observations, plausible alternatives, missing observations, and falsifier beside the hypothesis. Never invent a calibrated probability.

## Infrastructure and labels

Ground exchange, router, bridge, locker, factory, and treasury labels in current evidence and, for historical claims, at the relevant time. Record source and capture date. A provider label is a sourced assertion until independently supported.

Do not auto-classify high-degree addresses as infrastructure or low-degree addresses as personal. A known exchange withdrawal transaction does not identify which customer requested it. A deposit address does not prove an exchange sale occurred.

## Bundles, snipers, and “insiders”

Use “early buyer” for a timing observation. Use “bundle” only when execution/provider evidence supports that grouping; adjacency alone is insufficient. Describe favorable access or allocations concretely. A profitable early trade does not establish privileged information.

For deployer links, distinguish the creation sender, factory, initial supply recipient, fee receiver, admin, and public project account. State only the roles evidenced. A recurring bytecode template can support shared tooling while providing no evidence of a common operator.

## Social corroboration

Use X/Grok or web search to find public claims, not to authenticate them automatically. Retain original URLs, dates, full context needed for the claim, and exact chain/address references. Verify links from primary project sources when resolving contracts. A repeated claim from ten accounts may have one source.

For retrospective investigations, distinguish posts known before the event from later explanations. “Earliest found” is not “first published.” Deleted posts, cropped screenshots, and provider snippets require explicit uncertainty.

Do not pursue private personal information to fill an attribution gap. A useful on-chain autopsy can remain about addresses, roles, flows, and observable coordination.
