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

Input mode lp-wallet-autopsy requires envelope plus opening_equity, closing_equity, contributions, withdrawals, external_costs as decimal strings (null allowed for unknown closing or costs), costs_complete and positions_complete booleans. Optional episodes array contains id, closed boolean, pnl decimal string/null. All equity/flows use one explicitly documented denomination; external_costs excludes costs already reflected in equity. coverage_complete concerns complete interval events. Values are reconciled upstream inputs, not raw transfers. The helper calculates marked whole-account P&L and a qualified closed-episode count; it cannot authenticate a wallet, reconstruct fee growth or establish realizable liquidation.
