# Integration contracts

On 2026-09-08, inspected [Arbitrage Ape at 1bade97a833b18d015c3a41ca8f47a464bdf5432](https://github.com/New1Direction/arbitrage-ape/tree/1bade97a833b18d015c3a41ca8f47a464bdf5432) and [FYNCH at 7db4f6791993b55f856ac52a6f6c901aae34e25b](https://github.com/New1Direction/FYNCH/tree/7db4f6791993b55f856ac52a6f6c901aae34e25b). These are source observations, not deployment attestations.

- Ape's `ArbitrageVault.sol` requires zero V4 hooks. Its local `OrdinarySwapProbe.sol` accepts hooks for diagnosis; that separate probe does not change the vault's supported routes.
- FYNCH's Pons adapter establishes pregraduation factory/launch evidence and explicitly leaves graduated hook behavior unverified.
- PULSE supplies pool identity/state and invalidation signals, not arbitrary-hook traversal or wallet execution support.
- Exit Doctor's V2 and LP Edge's V3 native assumptions do not automatically apply to V4.

HOOK LAB exports reviewable JSON evidence. It does not patch these applications, relax allowlists or enable executor support. A production adapter must be implemented, reviewed and tested in the actual consumer's call path before support changes.

## Negative access acceptance case

Ape retained a basis-hook investigation for `0x48b1022b01ba841bf811d269f24b6f3836dac080`, bytecode hash `0x81cbe103726325b877a2548b3d9c754c4844685470839256d0ebd44defdcf778`. Its [retained access evidence](https://github.com/New1Direction/arbitrage-ape/blob/1bade97a833b18d015c3a41ca8f47a464bdf5432/evidence/basis-hook-access.json) reports manager-only beforeSwap, a pause gate and a tx.origin allowlist. It reports no verified source or ordinary-wallet integration. These are historical supplied findings, not new live verification.

A successful replay using a historical owner/origin cannot qualify an ordinary wallet. Caller chain, tx.origin, current configuration, authorization and target matter. Operator sweep/buyback functions are also distinct from ordinary swaps.

## Export and invalidation

Keep original identity, call, fork, source-review and qualification reports together. Store chain, PoolId/PoolKey, addresses/code hashes, implementation dependencies, reviewed configuration, source artifacts, exact wallet/calldata/amount/recipient, block/hash, failures and environment limits. Scope remains one exact case unless independent cases establish broader coverage.

Invalidate on PULSE reorg/lag signals, changed code/configuration, changed route/caller, stale state under an explicit consumer policy, unsupported tokens or missing settlement evidence. Re-simulate current state before use. Neither an allowlist nor `EXACT_CASE_EVIDENCE_CONSISTENT` is a command to trade.

Stock-token multipliers/corporate actions are separate valuation concerns. ERC-20 settlement stays in raw units. Anvil EVM gas lacks a validated Nitro/L1 data fee model, so it cannot alone establish total Robinhood costs or net profit.
