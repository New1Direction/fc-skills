# Discovery and collection

## Establish a bounded universe

Prefer the user's declared chain and venues. Locate candidates through verified launch/pool events, a documented provider's new-listing stream, or a reproducible saved query. State how the universe was obtained, first/last observation times, indexing delay if known, and missing venues. A newly indexed token can be old; first observed is not first tradable.

For a current shortlist, record the cutoff before collecting. Use a finite provider budget and stop at the declared scope. If the feed has pagination, retain page/cursor boundaries and explain incomplete traversal. If only promoted or searched tokens are available, label the selection bias and keep that universe in later evaluation.

DEX Screener documents token profiles, ads, boosts, orders, token pairs and search. Use those for candidate identity and contextual snapshots within documented coverage. Aggregate transactions or buy counts do not establish distinct buying wallets, and a profile update is not a launch event. Promotion metadata is a separate observation, not proof of fraud or organic demand. Primary reference: [DEX Screener API](https://docs.dexscreener.com/api/reference).

X search can help explain a discovered token or narrative. It is not a complete enumeration of launches or posts. Capture the query, time range, returned URLs and retrieval time. See [xAI X Search](https://docs.x.ai/developers/tools/x-search) for supported controls. Use a verified connected capability if available; do not invent a Grok connection, credential, or result.

## Collect required observations

Obtain wallet-level executed swaps from a chain-native decoder or documented provider. Preserve chain, venue identity, transaction signature/hash and event index, exact token direction, quote amount/unit, event time and available_at. De-duplicate the same swap returned by multiple sources before normalization. Multi-hop router transactions and arbitrage legs need explicit interpretation; neither a router address nor a transaction count is a unique human buyer.

On EVM, retain block number/hash, transaction/log index, reorg checks, pool identity and decoding version where available. On Solana, retain signature, slot, instruction position, program/account identity and finality. Protocol-specific decoding is required; ERC-20 transfer events are not swap events. Never apply an EVM decoder to Solana or V2 reserve assumptions to V3/V4/bonding curves.

The native helper accepts normalized observations and validates its contract and time constraints; it does not independently reconstruct these mechanisms. Capture original responses and the normalization method so conclusions can be challenged. A source locator or SHA-256 binds a retained artifact, not a truthful provider.

If wallet-level evidence is unavailable, deliver a preliminary discovery shortlist and name the missing data. Do not populate synthetic swaps, mark incomplete coverage complete, or infer absent activity from rate limits.
