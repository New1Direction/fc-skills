# Original expression, copies, and communities

Assess evidence in layers rather than collapsing it into a hype score:

| Layer | Supported observation | Important limitation |
|---|---|---|
| Original candidate | Confirmed narrative match, original post, no supplied campaign group, not paid, no normalized copy shared by another author | “Unknown” sponsorship remains unknown; accounts may share control |
| Amplification | Repost, quote, reply, or unknown post kind | Quote/reply text can be substantive; review manually before making broader adoption claims |
| Shared text | Same normalized text across distinct platform/account IDs | Could be a catchphrase, common source, or coincidence; does not prove coordination |
| Supplied campaign | `coordination_group` with a stated basis | Analyst assertion; shared hashtags alone are insufficient |
| Community assignment | Explicit community label with `documented` basis | Assignment and communities' independence still require source review |

The native normalizer applies Unicode NFKC, case folding, URL removal, and whitespace collapse. It does not remove punctuation, infer semantic paraphrases, compare images, or detect all campaigns. All members of a cross-author identical-text group are excluded from original-candidate counts; it does not choose an originator. Same-author duplicates remain visible as post activity but never increase distinct-author counts. Platform/account identity remains platform scoped.

The report retains every temporal exclusion and every candidate exclusion reason. It counts synthetic/unknown evidence separately and excludes it from observed-adoption candidates. Never label synthetic counts live evidence. “Unknown” paid status is reported explicitly among candidates; “unpaid” is a supplied classification and not independently verified by the helper.

For qualitative independence, check original expression, recurring participation before the event, shared ownership/team disclosures, attribution to a common source, and explicit campaign/promotion disclosures. Describe evidence and uncertainty rather than certifying organic users. Do not infer bots from activity frequency alone. Promotional language is not by itself evidence of payment; absence of a label is not proof of unpaid status.

Assign a community only with an explicit basis such as the post's community location, author self-identification, or a cited history of relevant participation. Language, geography, interests, followers, and account appearance alone do not establish membership. Keep inferred labels separate; unassigned posts remain unassigned. Overlapping community labels and cross-posts do not establish independent uptake. The analyzer reports per-label counts only for documented labels attached to original candidates.

Evidence of temporal sequence does not establish a causal transmission path. Discuss shared news, a common influencer, deliberate promotion, existing fandom, and sampling differences when relevant. Retained posts cannot establish profitable trading timing or sufficient exit liquidity.
