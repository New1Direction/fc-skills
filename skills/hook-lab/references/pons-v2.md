# Pons V2 family adapter

This adapter studies one documented Robinhood Chain deployment against public source at commit `8b9bf371030279133017b5c1b713823f5889c5d2`. Its status is **SOURCE_DERIVED_UNVERIFIED_DEPLOYMENT**. The candidate addresses in `assets/pons-v2-candidate.json` are discovery inputs, not an execution allowlist.

Sources:

- [Pons deployment and integration documentation](https://docs.ponsfamily.com/v2).
- [Pinned PonsV2MemeHook](https://github.com/ponsdotdev/ponsfamily/blob/8b9bf371030279133017b5c1b713823f5889c5d2/contractsV2/src/v2/hooks/PonsV2MemeHook.sol).
- [Pinned launch interfaces](https://github.com/ponsdotdev/ponsfamily/blob/8b9bf371030279133017b5c1b713823f5889c5d2/contractsV2/src/v2/interfaces/ILaunchpadV2.sol).
- [Pinned factory](https://github.com/ponsdotdev/ponsfamily/blob/8b9bf371030279133017b5c1b713823f5889c5d2/contractsV2/src/v2/PonsV2LaunchFactory.sol).

## Inspection

`discoverPonsPool({token, block:{number,hash}, chain_id:4663}, {rpc})` takes an async `rpc(method, params)` function returning the raw JSON-RPC result. Wrap it in the host's bounded RPC client: timeouts, response-size limits, credential redaction and request limits remain the transport's responsibility. Discovery issues at most 12 logical reads and never retries itself.

It checks `eth_chainId`, verifies the requested number/hash, reads both factory/hook wiring directions, reads the factory token record, reconstructs its graduated PoolKey, reads the hook's pool-specific policy, observes factory/hook/PoolManager bytecode, and rechecks the block hash. Every `eth_call` and `eth_getCode` uses `{blockHash, requireCanonical:true}`. There is no `latest` fallback.

The result retains raw request/result evidence and observed runtime SHA-256 digests. A digest of code from that same provider is **not an independent source-to-runtime match**. The status stays `CANDIDATE_STATE_OBSERVED`; even consistent getter responses could come from different code with matching selectors. Initialization receipts, source correspondence and intended-wallet simulation remain outstanding.

Discovery supports only the exact candidate factory and hook. A token from another Pons generation or deployment must not be forced through this adapter. Pons stacks are replaced together and historical tokens keep their original factory, hook and escrow.

Token-at-block request shape:

```javascript
const request = {
  chain_id: 4663,
  token: retainedTokenAddress,
  block: { number: retainedBlockNumber, hash: retainedBlockHash }
};
const candidate = await discoverPonsPool(request, { rpc: boundedReadOnlyRpc });
```

Replace the named variables with a known token and its actual retained block identity. A number without a hash, the string `latest`, or a different chain fails validation before any contract reads.

## ABI layouts

`decodeLaunch(raw)` accepts exactly 13 static ABI words from `launches(bytes32)` and checks address, bool and uint16 padding:

1. `registered` bool
2. `memecoinIsCurrency0` bool
3. `memecoin` address
4. `quoteToken` address, zero for native ETH
5. `creator` address
6. `buybackCreatorRecipient` address
7. `protocolFeeRecipient` address
8. `creatorTaxBps` uint16
9. `protocolFeeShareBps` uint16
10. `buybackBurnBps` uint16
11. `hookFeeBps` uint16
12. `maxInternalPriceImpactBps` uint16
13. `buybackEnabled` bool

`decodeLaunchedToken(raw)` accepts exactly 15 words from `getLaunchedToken(address)`: token, curve, deployer, creatorFeeRecipient, pairToken, graduationThreshold, poolFee, tickSpacing, creatorTaxBps, buybackEnabled, phase, sweptQuote, sweptTokens, sweptAt, exists. Types follow the pinned interface. Large uint256 fields return decimal strings. `tickSpacing` requires canonical int24 sign extension. Enum values are `0=NotGraduated`, `1=Swept`, `2=PoolCreated`, `3=Rescued`.

`reconstructPonsPool(record)` requires `exists=true`, `phase=2`, distinct currencies, zero core fee and valid tick spacing. It sorts the record's launch token and pair token and hashes the full ABI-encoded PoolKey. It never substitutes current global launch configuration for the token's stored configuration. `encodePonsRead()` only exposes `memeHook()`, `poolManager()`, `factory()`, `getLaunchedToken(address)` and `launches(bytes32)`.

## Fee arithmetic

`quotePonsFees()` is a reconciliation helper over supplied **core** swap deltas. It does not traverse ticks, calculate a swap from liquidity, obtain a router quote, or simulate a wallet call. Never feed already hook-adjusted wallet deltas into it and subtract fees twice.

Input shape:

```javascript
{
  pool_key: {currency0, currency1, fee: 0, tickSpacing, hooks},
  launch: decodeLaunch(rawHookGetter),
  amount_specified: "-100",
  zero_for_one: true,
  core_delta0: "-100",
  core_delta1: "200"
}
```

All addresses and policy fields are required. Supply canonical integer strings for raw amounts; unsafe JavaScript numbers, hex strings, zero requested amount, invalid signs and impossible source bounds are rejected. These example raw amounts are synthetic and are not an economic quote.

`assets/pons-fees.synthetic.json` is an offline runnable example. Pass its parsed content to `quotePonsFees()`. It supplies an exact-input core fill of 1,000,000 raw input for 1,999,999 raw output. At 100 bps hook fee and 50 bps creator tax the separate floors produce 19,999 + 9,999 = 29,998 raw fee units and 1,970,001 raw adjusted output. Its synthetic evidence label survives in the output. No real token, pool or trade is represented by the example's placeholder currency addresses.

The reviewed hook's `afterSwap` path charges the **unspecified currency**:

```text
specifiedIsCurrency0 = (amountSpecified < 0) == zeroForOne
unspecifiedDelta = specifiedIsCurrency0 ? coreDelta1 : coreDelta0
fee = floor(abs(unspecifiedDelta) * perPoolHookFeeBps / 10000)
tax = floor(abs(unspecifiedDelta) * perPoolCreatorTaxBps / 10000)
total = fee + tax
```

The two floors are distinct: a basis of 199 with both rates at 100 bps charges 1 + 1 = 2 raw units, not 3. In a normal exact-input swap the fee reduces output; in exact-output it increases required input. Fee currency can be either the memecoin or the quote asset. It is not uniformly a quote-token fee.

Output includes the original and hook-adjusted signed deltas, fee currency, base fee, creator tax, specified fill and partial-fill flag. Signed deltas are from the PoolManager caller's perspective: negative means owed, positive means received. The hook's positive return delta is subtracted from the caller's unspecified currency delta. Exact-output input increases must remain within int128 accounting limits.

The source returns early for zero rates. Otherwise negating the int128 minimum would revert; the helper rejects that impossible fee calculation. BigInt preserves exact arithmetic. A computed result stays `SOURCE_DERIVED_FEE_ARITHMETIC`, irrespective of whether supplied numbers look plausible.

## Caller and configuration boundaries

The reviewed hook enables `beforeInitialize`, `afterSwap`, and `afterSwapReturnDelta`, represented by low 14 address bits `0x2044`. Address flags identify callback selection only; they cannot establish implementation behavior.

Initialization is restricted to the factory. Ordinary swaps have no caller allowlist in the reviewed `_afterSwap` body and use ordinary V4 routing. Launch creation can separately be whitelisted. A launch-creation restriction does not establish a swap restriction.

Global owner-controlled fee policy supplies terms for new launches. Existing pool rates come from the hook's `launches(poolId)` snapshot. Factory-controlled recipient and buyback changes still alter relevant pool configuration; do not claim all configuration is immutable. The sweep operator can rotate. Factory and buyback-vault wiring are one-time in this source, and ownership transfers remain possible.

Fee sweeps are separate operations. Conversion or buyback swaps require the trusted operator; creators can distribute eligible already-quoted fees. Hook-originated internal swaps may skip callbacks in V4 and must not be treated as ordinary fee-paying swaps. Never impersonate that operator or the hook to qualify the user's route. The fee helper covers the ordinary caller path only.

The hook's ERC20 fee take checks actual received balance against the requested amount. Nonstandard quote or memecoin transfer behavior can invalidate arithmetic-only expectations. Final wallet accounting must also cover router charges, native value, gas, approvals, settlement and refunds.

## Promotion and current evidence

Before producing a deployment-specific adapter that other skills can trust, retain independent runtime correspondence, token-specific Initialize and PoolRegistered receipts, actual swaps, and exact intended-wallet route simulations at explicit block hashes. Reconcile core events, hook fees and wallet balances. Record caller and configuration scope and invalidate support when those change.

At creation, the official explorer's contract API returned HTTP 403 in this environment. No runtime match, real Pons V4 swap fixture, or wallet-route simulation was completed here. The public Pons repository contains source only; its root `abi.json` and `contract-meta.json` describe V1 and cannot verify this V2 deployment. Tests use synthetic RPC responses and arithmetic cases.

FYNCH main at `7db4f6791993b55f856ac52a6f6c901aae34e25b` has a narrow pregraduation [Pons adapter](https://github.com/New1Direction/FYNCH/blob/7db4f6791993b55f856ac52a6f6c901aae34e25b/docs/FYNCH_PONS_V2.md). Its launch/curve evidence does not qualify graduated-hook execution. Reuse retained receipts when available; preserve the boundary between a source-derived calculation, provider-observed state and verified wallet behavior.
