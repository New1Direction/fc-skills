# Balance and cost accounting

Recompile the built candidate, then bind its entire HOOK LAB request to retained fork evidence. The self-contained fork validator checks source/fork identities, calldata/sender, raw balances, receipt/gas arithmetic, forbidden overrides, source writes and canonical recheck. Validation proves consistency, not RPC authenticity.

For cycles, `spread_input_raw` is wallet input-currency change, with local Anvil gas added back for ETH. It includes route fees, impact and refunds. `amount_out_raw` is settled credit, equal to prepaid input plus spread; this includes unspent input and is not pure swap output.

Open routes retain input debit/refund and output in separate units. Intermediate wallet balances and all router route-currency/native deltas are checked. Unexpected losses or residuals prevent net comparison. Unrelated assets are not enumerated.

## Nitro estimate

`costs.mjs` calls `gasEstimateComponents(address,bool,bytes)` on virtual NodeInterface `0x00000000000000000000000000000000000000c8`, with actual sender, value, gas cap and router calldata. It uses canonical EIP-1898 block hash and rechecks chain/header. Unsupported interface/archive behavior gives unknown cost.

Returned words: total gas, L1-equivalent gas, L2 base fee, estimated L1 base fee. Total estimate is **total gas × L2 base fee**. L1 is already included. This follows the [NodeInterface ABI](https://github.com/OffchainLabs/nitro-contracts/blob/main/src/node-interface/NodeInterface.sol) and [Arbitrum estimation method](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas). Future fees can differ; Robinhood support must be observed.

ETH cycle estimate = normalized wallet ETH change − source total estimate. Add back local gas first to avoid charging it twice. ERC-20 cycles use a supplied positive fraction `numerator_input_raw / denominator_native_wei`, rounding cost up. This is an external block-bound assumption, not a verified executable conversion. Missing conversion means unknown net.

Costs retain exact route/transaction digests, state, raw request/result, observation time and expiration. Default assessment uses current time and excludes expired estimates. `as_of` permits explicit historical review. A historical parent remains historical even if collected now. No report is live execution authorization.

Compare compatible scopes and conversions. Rank estimated absolute net input units across supplied samples, retaining failed/missing cases as exclusions. This is not a global optimizer or future profit proof.
