# Evidence contract and scope

## Envelope
Use schema `lp-research.v1`, a named mode, period with integer Unix-second start/end (end > start), chain_id, two distinct exact token identities in pair, denomination, evidence_kind, nonempty source_refs, and coverage_complete (boolean). Synthetic examples deliberately use illustrative identities. Real adapters must authenticate addresses, actual deployment semantics and canonical state independently; a schema-valid input is not chain proof.

All numerical money values are finite decimal **strings**, never JSON floats. All amounts within a report use the same explicit valuation unit and convention. Helper outputs are exact numerator/denominator pairs, avoiding hidden rounding. Null is unknown. A zero is an observed value only with complete coverage. Booleans about coverage/costs are caller assertions, not verified facts; retain their supporting evidence.

## Live adapters
No RPC or signing client is bundled. Read current FYNCH/Ape APIs or retained datasets using available authorized tools, then normalize with the exact mode contract below. Record chain, block hash, ordered event identity, pool/manager, token decimals, source, observation and availability times, state/fee changes, gaps and valuation provenance. Stop conclusions at the weakest unresolved dependency.
Robinhood V4 requires exact PoolKey, hook permissions, dynamic LP/protocol/hook fees, token behavior and actual wallet execution context. Neither EVM branding nor V3 math authenticates those semantics. Do not scrape a displayed APR and treat it as earned LP income.

## Provenance and valuation
Keep source snapshots and normalized inputs together. Hashes show retained-byte integrity, not truth. Cross-check consequential critical states with independently acquired evidence when available. Exclude stale, circular, missing or unsupported conversions instead of assigning zero. USDG is not automatically USD; stock-token quote returns are not automatically stock-market dollar returns. Common-axis structural depth is not executable liquidation capacity.

## Decision boundary
These are research skills. They do not sign, broadcast, manage approvals or automatically rebalance positions. A future automation integration needs explicit policy, budgets, execution evidence and existing user authorization. Skill use does not grant it. Keep missing costs unknown and disclose event gaps. Never infer whale intent, profitability or fraud from a metric alone.

## Composition
LP Edge can provide supported position accounting; Autopsy can investigate transfer/ownership evidence; Scout Network can evaluate follower timing; Ignition can supply normalized observed demand. Use them only where available and applicable. None is required to read this folder or run its helper. Keep report identity/provenance when combining results.

## Primary mechanics references
Checked 2026-09-08. These explain mechanics, not arbitrary deployment authenticity.
- [Swap/LP/protocol/hook fees](https://developers.uniswap.org/docs/get-started/concepts/fees)
- [Concentrated liquidity](https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity)
- [V4 dynamic fees](https://developers.uniswap.org/docs/protocols/v4/concepts/dynamic-fees)
- [V3 position accounting source](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/Position.sol)
- [V3 NFT manager source](https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol)

## Validation limits
Bundled offline cases test arithmetic, input rejection and evidence qualification. They do not establish live coverage, economic edge, wallet truth, canonical deployment support or full counterfactual replay. Do not call the skills production trading systems.

## Mode-specific normalized input

The helper input has schema lp-research.v1 and mode fee-migration-watch. Required: chain_id integer, pair [exact-token-id, exact-token-id], denomination (exact settlement token identity or explicit valuation series ID), evidence_kind, source_refs (nonempty strings), coverage_complete boolean, windows [prior,current].
Each window: start/end integer Unix seconds and pools array. Each pool: id, volume decimal string, lp_fees decimal string or null. Volume counts each swap once using one-sided notional in the stated denomination; lp_fees is allocated LP income valued consistently, not gross charges. Two windows must be adjacent and the same duration. All missing/unsupported pools stay in upstream coverage; never mark coverage_complete true merely because observed logs returned successfully.
The helper compares an identical cohort, reports exact share changes/rates and returns missing-history when coverage/cohort is incomplete. It does not authenticate sources, decode logs, inspect ticks or prove migrations.
