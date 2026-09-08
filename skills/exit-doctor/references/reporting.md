# Decision brief

Lead with the supported result and cutoff. Show quoted amounts in the requested output asset. When additional costs are incomplete, say net proceeds are unresolved and show the known quote; do not replace missing costs with zero.

A useful compact table contains: input size, modeled output, router quote, minimum output constraint, call status, additional-cost coverage, and conditional net estimate if available. Include average price and separately defined impact only when they help the decision. Avoid overwhelming small outputs with meaningless rounded percentages.

After the table, state:

- Exact chain, token pair, route/pool, block/hash/time, finality and deployment-verification scope.
- Whether the wallet was supplied and the actual simulation level reached.
- Costs already embedded, additional costs assumed/measured, and unresolved conversions/charges.
- Strongest limitation or failure that could change the result.
- Any explicit model scenario and how it changes the state before the user's trade.
- The evidence packet and reproducible calculations.

Use “quoted,” “modeled,” “router-call succeeded,” or “recipient balance delta measured” precisely. Do not turn successful calls into “safe to sell,” provider quotes into guaranteed proceeds, or largest tested size into an optimal allocation.

The native report is single-route. Describe its dependence as one route through one pool; do not claim exhaustive routing or best execution across the market. Current-state findings need a new quote before a later execution decision. Historical and synthetic examples must remain labeled.

Keep cases and live wallet data outside the installed skill. Save user-facing artifacts through the host's standard workflow. Do not publish, sign, approve, or trade as part of the brief.
