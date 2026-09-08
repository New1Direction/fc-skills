# Robinhood stock references

Use `scripts/stock_reference.py` to capture current official asset metadata and raw equity bid/ask. It retains three ordered responses (assets, symbol prices, assets), their actual retrieval times, source bodies, and SHA-256 digests. It rejects mismatched deployments, metadata changes, invalid values, and future/stale server timestamps. `verify` regenerates the normalized candidate from retained source content.

```sh
python3 scripts/stock_reference.py collect --symbol NVDA --token TOKEN_ADDRESS --out reference.json
python3 scripts/stock_reference.py verify --input reference.json --out reference-check.json
```

A successful capture produces a **reference candidate**, not a historical attribution input. `generatedAt` measures server generation, which may differ from the market observation time. The REST multiplier is current metadata, not evidence of its historical block value. Reconcile a captured reference with block-pinned `uiMultiplier()`, asset identity, session/halt/pause state, and observation availability before preparing `raw_equity` attribution input. Never infer market reopening or mint access from a flag being absent.

If an oracle value already expresses USD per stock token, use the adjusted-oracle path. Applying the multiplier again would count corporate actions twice. A shares-per-token change is not new raw ERC-20 supply. USDG must have its own supplied valuation to call a USDG-denominated mark a USD mark.

The helper makes exactly three GET requests with finite timeouts, no authentication, no retries, and bounded responses. It does not collect live pool prices, submit orders, or prove primary-market access. HTTP failure leaves the reference unavailable. Retained response hashes detect accidental alteration; they are not independent signatures of Robinhood's data.

Sources, checked 2026-09-08:
- [Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis/): identities, raw price semantics, metadata, and corporate-action records.
- [Stock Tokens](https://docs.robinhood.com/chain/stock-tokens/): ERC-20 units, multiplier behavior, and primary issuance permissions.
- [Price feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/): check the current feed interface, scale, freshness, and pause semantics before implementing an onchain adapter.
