---
name: night-desk
description: Value Robinhood Chain stock-token positions using separate equity references, corporate-action-adjusted token references, onchain marks and size-specific retained exit evidence. Use for overnight valuation, stock-token premiums, stale-price diagnosis and portfolio exit-value comparisons. Includes bounded read-only Robinhood REST collection; does not generate swap routes or execute trades.
---

# Night Desk

Explain what a Robinhood Chain position is worth under each available measurement, when each measurement was obtained, and what remains unknown. A reference price, pool mark, route quote and simulated wallet result are distinct evidence classes.

## Run

Python 3.12+, standard library only. Run paths relative to this skill folder.

```bash
python3 scripts/night_desk.py demo --out /tmp/night-desk-demo.json
python3 scripts/night_desk.py analyze --input assets/example-input.json --out /tmp/night-desk-report.json
python3 scripts/night_desk.py collect --symbol NVDA --token 0xEXACT_ADDRESS --out /tmp/night-desk-capture.json --report-out /tmp/night-desk-reference.json
```

Replace the address placeholder with a verified contract. Collection makes at most four HTTPS GET requests to Robinhood's documented API and retains raw response bodies, timing and hashes even when normalization fails. It creates reference evidence only. It does not collect a wallet balance, DEX price, quote or simulation.

For supplied observations, read [the input contract](references/schema.md). For collection failures, scheduling or application integration, read [operations](references/operations.md). `analyze(input)` in `scripts/night_desk.py` is importable without executing the CLI.

## Interpretation

- Identify assets by chain 4663 and exact contract, amounts by raw ERC-20 units with 18 decimals. Symbols are display and API lookup fields.
- REST equity bid/ask must be multiplied once by a contemporaneous shares-per-token ratio. An already-adjusted Chainlink reference must not receive another multiplier. Current REST metadata cannot establish a past block's multiplier.
- Keep closed, halted, stale, missing, invalid and unknown-session states visible. Server `generatedAt` freshness does not establish exchange-tick freshness. A midpoint is a valuation mark, never a redeemable price.
- Accept retained execution evidence only for the requested wallet, raw size, route, exact input/output identities and canonical block context. Report quotes and wallet-call simulations separately; this helper does not independently verify either. Preserve missing gas and conversion costs as missing net value.
- Keep exact USD conversion evidence for output assets, including stablecoins; do not silently assume USDG or another token equals one dollar. The helper values in USD only.

Present the reference bid/ask, adjusted position value, onchain mark/premium and retained exit amount in separate columns or paragraphs. Include source times, coverage gaps, and quote versus simulation scope. Synthetic examples are labeled and cannot establish an investment edge.

## Validate

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
```

The tests exercise amount units, multiplier accounting, source timing, identity mismatches, stale and missing evidence, collection failures and cost reconciliation. Official source links and API assumptions are retained in [operations](references/operations.md).
