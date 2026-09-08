# Execution validation

## Evidence levels

| Evidence | Supports | Does not establish |
| --- | --- | --- |
| Exact reserve model | Output under named mathematical assumptions | Token transfer success or wallet proceeds |
| Router getAmountsOut | Router's quoted amount for this path/state | Wallet permission or final recipient balance |
| eth_call of the actual swap from the wallet | Call execution and returned values at that state with those parameters | Inclusion, future state, actual transferred funds, or independent balance reconciliation |
| Full trace/replay with recipient deltas | Observed simulated recipient economics under the recorded state/overrides | A guarantee of live execution |
| Confirmed real transaction and balances | That transaction's actual outcome | Repeatability in later states |

The native helper reaches router-call simulation when a wallet is supplied and prerequisites are met. It does not submit anything or independently measure post-call balances. An eth_call succeeds without permanently changing state.

## Check the actual path

Verify the chain, numeric block/hash, router, factory, pair, token ordering, calldata, amount, recipient, minimum output, and deadline. Token identities must be exact. An ERC-20 output path is different from an unwrap-to-native path.

Read the actual wallet's input balance and router allowance at the same block. Missing allowance is a prerequisite failure; do not issue an approval to make the research work. Insufficient balance is not proof that the token is unsellable. Do not silently impersonate a funded wallet or inject balances.

The adapter uses a block-hash state selector with requireCanonical for supported RPC methods, followed by a boundary recheck. Unsupported historical calls remain unavailable; do not substitute latest. A provider's matching hash does not authenticate it or prove finality. Verify current deployment sources and chain-specific finality separately.

Gas estimates can fail independently of quotes and simulations. Record their state selector and whether the provider supported a historical estimate. A gas estimate is a unit count, not a total cost, and can omit chain-specific charges.

## Distinguish failure causes

Separate node/transport limits, unsupported RPC parameters, pruned state, contract revert, ABI mismatch, quote/model disagreement, missing allowance, insufficient balance, and changed chain state. A generic RPC error must not become a honeypot verdict.

If a call reverts, retain its safe diagnostic category and evidence reference. Inspect the implementation or supported trace before naming the reason. Do not expose endpoint credentials, raw provider error strings containing secrets, or untrusted executable text.

## Token and venue boundaries

A familiar transfer signature or decimals value does not prove standard token behavior. Check relevant historical implementation, proxy/role controls, transfer taxes, blacklists, cooldowns, and route-specific restrictions when the task requires actual execution confidence. Code matching a caller-supplied fingerprint only establishes that match.

For fee-on-transfer/rebasing tokens, Router02 supporting methods have different behavior and may not return the same amounts. The native standard-token adapter does not support them. A successful standard router call can still return quoted arrays that differ from recipient balances for unusual output tokens. Keep that limit prominent.

V3 requires exact fee tiers and tick-aware quotes. V4 requires PoolKey/PoolId, the specific hook and its accounting, and net settlement. The singleton manager's balance is not a pool's depth. Solana needs native program/account and transaction simulation support. Never run the V2 reserve formula over these venues.

References: [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/), [EIP-1898 block-hash state queries](https://eips.ethereum.org/EIPS/eip-1898), [Router02 implementation](https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol), [Uniswap V4 quoting](https://developers.uniswap.org/docs/sdks/v4/guides/swapping/quoting).
