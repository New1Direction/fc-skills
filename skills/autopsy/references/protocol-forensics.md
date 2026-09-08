# Protocol forensics: reconstruct the mechanism before naming the actor

Reference checked against primary documentation on 2026-09-08.
This is an investigation method, not a claim that every adapter is implemented.
The bundled collector is EVM-only. Solana requires a connected native data provider
or retained native evidence with sufficient history; never pass a mint to the EVM helper.
Verify deployed code/program versions against the investigated chain and historical window.

Contents: launch chronology; EVM historical control; token movement; V2/V3/V4 liquidity; Solana native evidence; conclusion limits.

## 1. Resolve the launch into separate events

Keep these timestamps separate, with transaction coordinates and evidence IDs:

| Event | Evidence required | Common mistake |
|---|---|---|
| Contract creation / mint initialization | Creation receipt or trace; native mint initialization | Calling the oldest indexed transfer the deployment |
| Initial allocation | Mint/transfer instructions, recipients, supply state | Treating initial distribution as public purchases |
| Pool initialization | Verified factory/manager event or native pool instruction | Assuming the pool is funded or tradable |
| Initial liquidity | Position/reserve state plus liquidity action | Counting a token transfer as an LP deposit |
| First observed successful trade | Decoded successful execution and actual asset flow | Using a chart candle as proof of the first trade |
| Bonding-curve completion | Version-correct curve state / instruction | Equating completion with completed migration |
| Migration | Migration instruction and source/destination asset reconciliation | Labeling transferred curve assets a developer exit |
| First destination-pool trade | Destination venue execution | Restarting the token's history at migration |

“First observed” becomes “first” only with continuous coverage back to the relevant origin.
Define opening cohorts explicitly: transaction count, blocks/slots, or elapsed time from a named event.
Do not silently mix bonding-curve buyers with post-migration buyers.
For Pump launches, obtain the historical program/IDL and decode the actual migration;
do not hard-code an old Raydium destination, a dollar threshold, or today's reserve constants.
[Pump program documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)

## 2. EVM evidence and historical control

- Resolve `eth_chainId`, exact token address, analysis block number and block hash.
- Retain successful receipts, emitting addresses, ordered logs, code, and required state reads.
- Order by block number, transaction index, log index; timestamps alone cannot resolve ordering.
- A top-level deployment receipt may contain `contractAddress`; factory `CREATE`/`CREATE2`
  needs suitable traces or a corroborated factory record. Transaction sender may be a factory caller.
- Run bounded log queries, record every requested range, and retain failures and pagination.
  A provider timeout, range cap, or truncated response is not a range with zero events.
- Block-tagged state reads normally describe a block boundary, not the state before a chosen
  transaction inside that block. Use replay/trace evidence for claims at transaction granularity.
- Recheck block hashes before sealing the report. Invalidate orphaned evidence after a reorg.

[Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/)

Control checks must describe the state then as well as now:

- Read runtime bytecode and the implementation, beacon, and admin slots where ERC-1967 applies.
- Resolve a beacon's implementation at the same historical boundary; record upgrades in between.
- Empty ERC-1967 slots do not establish absence of a proxy or absence of upgrade authority.
- Inspect the implementation's actual authorization path, role memberships, and delegated control.
  `owner() == 0` says nothing conclusive about separate roles, beacon control, or custom storage.
- Tie source/ABI to the applicable runtime and implementation version. Unverified code is a gap;
  a verified source badge alone does not prove behavior, immutability, or an operator's identity.
- If historical state is unavailable, report current control and historical control separately.

[ERC-1967](https://eips.ethereum.org/EIPS/eip-1967)

## 3. Token movement is not trade attribution

Maintain distinct records for emitted events, decoded actions, and reconciled balance changes.
Restrict token events to the exact emitter; matching event signatures from other contracts prove nothing.
`Transfer` does not specify a purchase, sale, OTC payment, gift, bridge, or beneficial owner.
Decimals and metadata can be absent; keep integer base units as the accounting source of truth.
Zero-address mint/burn event conventions and supply behavior must be checked against the implementation.
Do not assume a zero-address event or a dead-address transfer reduces `totalSupply`.
[ERC-20 specification](https://eips.ethereum.org/EIPS/eip-20)

For each material acquisition or exit, reconcile the whole transaction:

1. Identify every involved asset and actual debit/credit owner, including wrapped native assets.
2. Distinguish transaction sender, router, pool, intermediate custodian, payer, and recipient.
3. Decode all route legs once; prevent multi-hop swaps from becoming multiple independent buyers.
4. Separate token fees, LP/protocol fees, hook charges, gas, and native transfers.
5. Compare observed amounts with expected accounting; retain an explicit residual when unresolved.

A wallet's end-of-block balance delta can include other transactions; it is not a per-trade receipt.
Reflection, rebasing, nonstandard events, fee-on-transfer behavior, and internal netting require
implementation-aware reconciliation. A log ledger alone may not reconstruct balances or supply.
Never infer a universal buy/sell tax from one trade, or assume every wallet shares fee exemptions.
Describe “observed effective charge for this path, sender, size, and state” when that is all you measured.
Successful historical selling establishes that execution, not present or future universal sellability.

## 4. Liquidity: keep venue accounting separate

### Uniswap V2 and verified equivalents

- Verify factory, pair, token ordering, and deployed variant; a familiar ABI is insufficient.
- Reconcile `Mint`, `Burn`, `Swap`, and `Sync` with reserves and actual token balances.
- A direct transfer can change balances without minting LP shares; `sync` updates recorded reserves.
- `skim` can remove excess over reserves. Treat donations, skims, swaps, and withdrawals separately.
- Track LP-share ownership and enforceable lock terms at the relevant block. A burn or lock claim
  must identify the actual shares and proportion; it does not remove token-admin powers.
- Reserve ratio describes marginal price under the applicable mechanism, not the average proceeds
  from liquidating a position. Quote assets can themselves be volatile or restricted.

[V2 pair implementation](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)
[V2 architecture](https://developers.uniswap.org/docs/protocols/v2/concepts/architecture)

### Uniswap V3 and verified equivalents

- Resolve the concrete pool and fee tier; reconstruct initialized ticks, liquidity changes,
  current tick/price, and positions for the range under analysis.
- Active liquidity is range-dependent. Pool token balances and TVL are not executable depth.
- Below-range or above-range inventory can be single-sided without a fresh deposit or withdrawal.
- Compare depth over explicit price bands before and after a change; account for price moving
  through ticks before concluding someone removed buy-side or sell-side liquidity.
- Distinguish position liquidity reduction from collection of amounts owed; do not classify
  every collection as fees or count the same principal twice.
- Trace position-manager ownership and transfers when attributing control; the core position
  owner can be a manager contract rather than the person funding the position.

[Concentrated liquidity](https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity)
[Active liquidity](https://developers.uniswap.org/docs/sdks/v3/guides/managing-liquidity/active-liquidity)
[Position lifecycle](https://developers.uniswap.org/docs/liquidity/overview)

### Uniswap V4

- Identify chain, PoolManager, full PoolKey, and PoolId. Currency pair alone is ambiguous.
- Keep currencies, fee field, tick spacing, hook address, and initialization evidence together.
- All pools share a singleton manager: its ERC-20 balance is not one pool's inventory.
- Resolve per-pool state through supported state access; reconstruct position/range changes
  and relevant actions. Unsupported state access must become a coverage limitation.
- Unlock operations use deferred accounting. Net settlement transfers can combine several pools;
  do not assign a manager transfer to the nearest `Swap` log by timing alone.
- Include ERC-6909 claims and native-currency settlement where present; external transfers
  alone can omit meaningful internal accounting changes.
- Decode each deployed hook's applicable permissions and behavior, including dynamic fees,
  returned deltas, custom curves, allowlists, and external settlement where relevant.
- A core swap event or vanilla V3-style quote may not describe final trader economics.
  An unsupported hook is an explicit attribution/quote limit, never a zero-cost assumption.

[PoolManager](https://developers.uniswap.org/docs/protocols/v4/concepts/poolmanager)
[V4 core architecture](https://github.com/Uniswap/v4-core)
[Reading pool state](https://developers.uniswap.org/docs/protocols/v4/guides/read-pool-state)
[Hooks](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks)
[Custom accounting example](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/async-swap)

## 5. Solana native evidence branch

Use this branch only with a connected provider or supplied native evidence that supports it.
Keep cluster identity, mint, owning Token Program, slot, commitment, and transaction signature.
Distinguish mint account, token account, token-account owner, delegate, program PDA, and fee payer.
A wallet can hold several accounts for one mint; aggregate by owner only after resolving ownership.
The mint's creator/payer, mint authority, metadata authority, and pool creator can be different actors.
Inspect mint/freeze authorities and their historical changes; record revocation of each role separately.
[Token account model](https://solana.com/docs/tokens)
[Authority changes](https://solana.com/docs/tokens/basics/set-authority)

For transactions, retain versioned message keys, resolved lookup-table addresses, outer and inner
instructions, execution status, logs, pre/post token balances, pre/post lamport balances, and fees.
Index balances against the correct resolved account list and preserve integer amounts.
Missing balance metadata is unknown; infer zero for a new/closed account only with corroborating
creation/closure evidence. Reject failed instructions as completed transfers or swaps.
Pair native balance reconciliation with wrapping/unwrapping, rent deposits/refunds, and fees.
Decode CPI paths and resolve actual token owners before naming a buyer or exit recipient.
A signature query for the mint alone is not proof that all token-account transfers were collected.
Current account scans do not reveal every closed historical account or past owner.
[Solana transaction response](https://solana.com/docs/rpc/http/gettransaction)
[RPC structures](https://solana.com/docs/rpc/json-structures)

Token-2022 requires extension-aware decoding at both mint and token-account level:

- TransferFeeConfig: record epoch-effective fee, cap, changing authority, and withheld amounts;
  fees may remain on recipient accounts or be harvested, rather than immediately paid out.
- PermanentDelegate: record its transfer/burn authority independently of mint/freeze revocation.
- TransferHook: resolve the hook program and relevant execution; do not assume ordinary transfer behavior.
- Record applicable default/frozen/paused/nontransferable state and other material extensions.
- Confidential amounts or unsupported extensions impose a visibility boundary on supply-flow claims.

[Token extensions](https://solana.com/docs/tokens/extensions)
[Transfer fees](https://solana.com/docs/tokens/extensions/transfer-fees)
[Permanent delegate](https://solana.com/docs/tokens/extensions/permanent-delegate)
[Transfer hooks](https://solana.com/docs/tokens/extensions/transfer-hook)
[Confidential balances](https://solana.com/docs/tokens/extensions/confidential-transfer)

## 6. Bound the conclusion

Protocol evidence can establish recorded actions, authority, custody, and reconciled asset flows.
It does not by itself prove an off-chain identity, common beneficial ownership, malicious intent,
independent retail demand, a private bundle, original acquisition cost, or sustainable profitability.
A transfer into an exchange is an observed deposit, not an observed sale; a bridge requires
destination-chain evidence before continuing the flow. LP inventory ratios do not prove conviction.
Close each mechanism finding with: observed action; resulting state/amount; attribution confidence;
plausible alternative; exact missing evidence that would distinguish the alternatives.
