# Liquidity pressure from retained trade-size observations

`analyzeLiquidity(input)` in `scripts/liquidity.mjs` compares supplied observations. It performs no RPC requests, does not create a router, and does not authenticate the supplied evidence. The result explicitly says `RETAINED_INPUT_ASSERTIONS_NOT_INDEPENDENTLY_VERIFIED` and preserves `evidence_mode: synthetic | retained`. The bundled `assets/liquidity.synthetic.json` is a fabricated teaching example, never a current market result.

Use two or more block observations of the same wallet, exact token pair, route identity, route configuration, evidence kind, direction and input amount. One point is retained but returns `INSUFFICIENT_COMPARABLE_HISTORY`. Capture both buying and selling at the sizes under investigation; an improvement on one side does not establish improvement on the other.

## Input contract

The root object requires:

| Field | Meaning |
| --- | --- |
| `schema_version` | Exactly `pressure.liquidity.v1` |
| `evidence_mode` | `synthetic` or `retained` |
| `chain_id` | Exactly `4663` |
| `asset`, `quote_asset` | Each `{address, decimals}`; distinct exact addresses, decimals 0–36 |
| `wallet` | Wallet whose quote/call/fork scope the rows represent |
| `as_of` | Explicit UTC analysis timestamp |
| `policy` | `{max_snapshot_age_seconds, max_reference_age_seconds, max_execution_cost_bps}` |
| `observations` | 1–10,000 rows ordered by increasing block number and block timestamp |

Each row requires:

```json
{
  "id": "retained-run-row-id",
  "block": {"number": 123, "hash": "0x...32 bytes...", "timestamp": "2026-09-08T10:00:00Z"},
  "observed_at": "2026-09-08T10:00:01Z",
  "route": {"id": "exact-route-id", "identity_hash": "0x...32 bytes...", "configuration_hash": "0x...32 bytes..."},
  "direction": "sell",
  "input_raw": "1000000000000000000",
  "output_raw": "99500000",
  "status": "ok",
  "evidence_kind": "quote",
  "evidence_refs": ["retained artifact with its checksum"],
  "canonical": true,
  "identity_verified": true,
  "fees_in_output": "included",
  "costs": {"coverage": "complete", "items": [
    {"id": "gas", "kind": "gas", "amount_raw": "100000", "currency": "0x...quote token...", "included_in_output": false, "evidence_ref": "retained gas and conversion calculation"}
  ]}
}
```

The abbreviated addresses above describe the schema, not runnable inputs. The synthetic asset file is a complete runnable input. All raw amounts are canonical decimal **strings**, with uint256 bounds; JavaScript numbers are rejected. Timestamps must be explicit UTC. Fractions use positive decimal-string numerators and denominators. Policy cost thresholds are nonnegative decimal strings. No token symbol is accepted as identity.

`direction: buy` means quote token input and asset output. `direction: sell` means asset input and quote output. Exact-input sizes are compared in the corresponding input currency. Every row inherits the root wallet and pair; optional row overrides must match exactly. Native-asset swap routes are outside this ERC-20 comparison contract; the zero address is permitted as an unconverted gas-cost currency.

`status` is `ok`, `unavailable` or `reverted`. An unsuccessful row must have `output_raw: null`. Zero output cannot stand in for missing liquidity. Reverted outcomes remain evidence about that exact attempt; their cause requires the underlying failure evidence.

## Evidence and identity

- `quote`: decoded venue or routing quote. It does not establish the wallet can execute.
- `wallet_call`: decoded output from an exact wallet `eth_call`. Return values alone do not establish post-call wallet balance deltas or full settlement.
- `wallet_fork`: independently measured wallet balance changes from an isolated local fork using the intended caller, recipient, route, token set and size. This is a simulated state outcome, never a mined live fill.

Never relabel a quote as wallet execution. Keep these categories in separate comparisons. A report with an identity hash but unverified runtime correspondence must use `identity_verified: false`. A post-reorg row must use `canonical: false` until canonical recapture. These fields are assertions supplied by the upstream collector: verify raw reports before setting them.

Use HOOK LAB to establish the exact manager, pool key, hook/router/dependency runtime and configuration. The input `identity_hash` should bind that full identity evidence, not just the hook address. `configuration_hash` should bind mutable fees, access restrictions, dependencies, relevant token behavior and route call conventions. Do not include the changing market price or liquidity state in that hash, because those are the measured quantities. A code/configuration change creates a different comparison scope and requires requalification.

### Mapping HOOK LAB evidence

No automatic HOOK LAB importer is provided. Manually normalize only reviewed retained reports, preserving the original artifact and digest in `evidence_refs`:

1. Confirm chain, block hash, exact caller and recipient, token addresses/decimals, runtime checks and calldata.
2. For a quote or `eth_call`, decode the actual supported ABI. Keep its quote/call evidence kind and do not invent balance measurements.
3. For a successful isolated fork, calculate input from the wallet's negative input-token delta and output from its positive output-token delta. Verify the entire intended amount was consumed. A different recipient, partial fill, extra unmatched token flow, pre-seeded balance, spoofed privilege, altered contract/storage, or inconsistent replay scope needs separate analysis and must not be promoted into an ordinary funded-wallet row.
4. Retain gas and other expenses separately with their actual denomination. A local EVM gas result is not automatically the full Robinhood transaction cost; account for any additional chain-specific cost before marking coverage complete.
5. Pin the block header and route evidence. Recheck canonicality externally when reusing evidence.

A `wallet_fork` label alone is insufficient proof that these conditions hold. If raw evidence is unavailable, preserve the gap instead of promoting an assertion.

## Costs and exact arithmetic

`output_raw` is the observed output after any fees already taken inside the route. `fees_in_output: included` asserts the upstream adapter has checked that interpretation. `unknown` leaves all-in price unavailable.

Cost items have unique IDs and `kind: gas | fee | other`. Fees already reflected in output use `included_in_output: true` and are **not** deducted again. Additional expenses use `false`. An ERC-20 output does not include native gas, so gas cannot be marked included. An expense in any other currency remains unconverted, suppressing all-in metrics; no USDG=$1 assumption or inferred FX rate is inserted. Explicit zero expenses are allowed, but `coverage: complete` remains an evidence-backed upstream assertion, not a result of an empty list.

Let `Q` be quote input/output in whole quote-token units, `A` asset input/output in whole raw contract-token units, and `C` additional expense already expressed in quote units:

- Buy observed unit price = `Q / A`; all-in unit price = `(Q + C) / A`.
- Sell observed unit price = `Q / A`; all-in unit proceeds = `(Q - C) / A`.
- A nonpositive net sell result leaves the positive net-price metric unavailable and records the reason.
- Output change = `(new output / prior output - 1) * 10000` basis points.

Outputs are reduced `{numerator, denominator}` fractions, never rounded floating-point estimates. For example, the synthetic sell observations produce all-in shortfalls of 60 and 210 bps. Those numbers demonstrate the math and say nothing about actual Robinhood liquidity.

## Reference semantics

A row may provide:

```json
{
  "kind": "external_underlying",
  "quote_per_asset": {"numerator": "50", "denominator": "1"},
  "ui_multiplier": {"numerator": "2", "denominator": "1"},
  "observed_at": "2026-09-08T10:00:00Z",
  "evidence_ref": "underlying price, quote-currency conversion and active multiplier evidence"
}
```

The three reference kinds are deliberately distinct:

| `kind` | Units and resulting metric |
| --- | --- |
| `venue_marginal` | Same-route marginal quote units per raw contract token. Requires `block: {number, hash}` equal to the observation. Produces **all-in execution shortfall**, which includes costs and is not pure AMM impact. |
| `external_underlying` | Quote units per underlying share, multiplied once by active `ui_multiplier` expressed as shares per whole contract token. Missing multiplier leaves the token-reference gap unknown. |
| `external_token` | External quote units per whole contract token, already adjusted. `ui_multiplier` is rejected to prevent applying it twice. Produces the external-reference premium directly. |

For `external_underlying`, convert an onchain `uiMultiplier()` integer to a rational with denominator `1000000000000000000`. Read the multiplier effective at that block. A staged future multiplier is not the active multiplier. Robinhood's stock-token balances stay in raw units as the share relationship changes. Robinhood's Chainlink feeds already price the token, so use `external_token` for those feeds. Underlying market-price inputs need one active multiplier application. [Robinhood stock-token integration](https://docs.robinhood.com/chain/building-with-stock-tokens/), [Robinhood oracle units](https://docs.robinhood.com/chain/oracles-and-price-feeds/), [Chainlink tokenized-equity methodology](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood).

The external premium is signed `(observed route unit price / external token reference - 1) * 10000`; a sell-side discount is negative. It remains a premium/discount at this size. It is not pure pool price impact, an arbitrage profit, or evidence of permission to mint/redeem. An underlying USD price cannot become quote-token units without an explicit retained currency conversion. `oraclePaused`, market-session freshness and source compatibility must be checked upstream; a recent fetch does not make an old underlying price current.

Venue execution shortfall uses all-in unit price versus the same-block venue marginal price. Buying above marginal or selling below marginal is positive adverse shortfall. Favorable execution is negative. Each route/block/direction/evidence group reports the **largest tested input** whose shortfall meets the explicit policy threshold. It does not interpolate, assume monotonicity, prove all smaller amounts work, or establish maximum capacity. External-reference premiums never generate that venue-depth threshold result.

If supplied underlying multipliers change between two windows, the comparison is blocked because a fixed raw amount may represent a different underlying exposure. If no multiplier evidence is supplied, the comparator only describes changes for the fixed raw amount; it cannot exclude corporate actions as an explanation.

## Freshness, comparison and limits

Snapshot freshness is measured from the **block timestamp** to explicit `as_of`, not from the time an old block was downloaded. Reference age is measured from its actual price timestamp to the observation block. Future references, impossible timestamps, conflicting block hashes and duplicate observations are rejected. A historical study can use its explicit historical `as_of`; that does not make it a current executable quote.

Comparisons require the same route identity/configuration, direction, input, wallet/pair and evidence kind. Missing or noncanonical/unverified/stale points suppress the comparison. Incomplete costs preserve the raw observed output comparison but suppress all-in comparisons. Same-block cross-route rankings additionally require known all-in costs in the same quote units. Rankings do not combine route liquidity or assume independent execution across routes sharing a pool.

A price change at one tested input does not prove its cause. Distinguish supply replenishment, underlying repricing, fee changes, pool inventory redistribution and unrelated flow with the supply and destination modules plus retained swap/LP evidence. No aggregate pressure score or profitable threshold has been calibrated here.

In Uniswap V4, multiple pools share one manager and intermediate legs can settle through net deltas. A manager balance or transfer alone therefore does not identify an individual pool's reserves or prove an LP deposit. This module has no manager-inventory input and accepts no manager-balance evidence kind. [Uniswap V4 flash accounting](https://developers.uniswap.org/docs/protocols/v4/concepts/flash-accounting).
