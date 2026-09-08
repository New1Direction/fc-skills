# Robinhood stock-token semantics

Primary documentation checked 2026-09-08. Resolve the exact deployment on chain 4663 and retain source time; a ticker match is insufficient.

## Supply, shares, and corporate actions

Robinhood describes Stock Tokens as standard 18-decimal ERC-20s with an ERC-8056 multiplier. Corporate actions change represented shares without changing raw `balanceOf()` or `totalSupply()`. Direct issuer mint/burn is restricted to onboarded authorized participants/market makers; ordinary holders use secondary venues. A recipient of newly minted tokens is not automatically a verified participant identity. Read `uiMultiplier()` at the observation block; retain pending multiplier and effective time separately. A scheduled update is not yet an effective update. Chainlink's documented token price already incorporates the multiplier. [Robinhood integration documentation](https://docs.robinhood.com/chain/building-with-stock-tokens/)

Keep these quantities separate in every report:

```text
raw_token_units = ERC-20 integer amounts
token_quantity = raw_token_units / 10^token_decimals
represented_shares = token_quantity * multiplier_raw / 10^18
```

A supply comparison requires both raw supply endpoints and complete, aligned raw transfer evidence over the intervening interval. Reconcile endpoint supply change against mint-like transfers from zero minus burn-like transfers to zero. A residual is a discrepancy requiring investigation. Endpoint reconciliation by itself does not prove every transfer was collected: missing mint and burn events can offset.

A multiplier-only change is not new issuance or fresh tokens reaching an AMM. A transfer between two addresses is custody movement, not supply creation. In mixed windows, report raw supply change and multiplier change independently; attributing the total represented-share change requires an explicit decomposition convention.

## Reference prices

The REST `/rhj/assets` response supplies exact `deployments[]`, decimal-string `currentMultiplier`, pending metadata, and underlying trading capabilities. `/rhj/prices/{symbol}` is documented with a 15-second cache and provides raw underlying-equity bid/ask plus `generatedAt`; it is not already multiplier-adjusted. Convert to a token-equivalent reference once. Corporate-action metadata is cached for one hour and includes scheduled/processed status; it cannot replace a historical onchain multiplier read. Underlying tradability flags do not establish a wallet's permission to mint, burn, or execute a DEX route. [Robinhood Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis/)

```text
token_reference_bid = underlying_bid * shares_per_token
token_reference_ask = underlying_ask * shares_per_token
```

An indicative midpoint is not an executable hedge price. Preserve bid/ask, currency, quote generation time, retrieval time, and the selected multiplier's block/time. Historical outcomes must not silently apply today's multiplier or reference to older observations. A stablecoin amount requires its own USD basis before being compared with a USD stock reference.

## ABI drift and duplicate events

ERC-8056 was marked Draft at retrieval. Its current specification names optional `TransferWithUIAmount`; Robinhood's deployed-integration documentation instead presents `TransferWithScaledUI`. Do not assume either optional event signature from a standard name. Verify deployment/source correspondence and ABI before decoding a chain-specific event. Standard ERC-20 raw `Transfer` is the supply ledger input; an additional scaled transfer event must not be counted as another transfer. The specification includes pending-multiplier access and allows implementation-specific update/cancellation behavior. [ERC-8056 specification](https://eips.ethereum.org/EIPS/eip-8056), [Robinhood event documentation](https://docs.robinhood.com/chain/building-with-stock-tokens/)

## Interpretation limits

Stock supply expanding, a large wallet moving tokens, or the manager receiving tokens can motivate investigation. Each remains insufficient by itself to infer imminent selling, premium compression, executable arbitrage, or improved LP returns. The useful test is whether compatible, retained route observations changed after the supply observation, at a specified wallet and size, with known costs and honest missing-data states.
