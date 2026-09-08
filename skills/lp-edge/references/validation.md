# Verification scope

## Native support

Target canonical Uniswap V3 EVM pools and standard ERC-20 token behavior. Use independently verified chain deployments and code fingerprints. Other pool implementations, V4 hooks, taxed or rebasing tokens, signing, broadcasting, and production profitability are outside native verification.

## Offline verification

Run `python3 -m unittest discover -s scripts -p 'test_*.py'`. The creation suite passes 78 tests covering arithmetic, schemas, missing inputs, provenance, raw-evidence binding, contract and block checks, ABI encoding, and read-only simulation outcomes. Separate source review and example use checked the financial interpretation. The native CLI evidence-to-accounting path was exercised with an explicitly synthetic transport. These checks verify supported offline behavior, not live operation.

## Published historical arithmetic

Run `python3 scripts/check_published_case.py --output NEW_CHECK.json` from this skill directory. The retained `assets/published-position37.json` contains the numeric inputs from [Uniswap's June 26, 2023 math primer](https://blog.uniswap.org/uniswap-v3-math-primer-2), retrieved September 8, 2026.

The position is above its range. Integer math produces principal of 0 token0 and 9,999,999,999,999,133 raw WETH units (approximately 0.01 WETH); token0 incremental accrual is 6,261,655 raw USDC units. An independent high-precision principal calculation matches. The article uses rounded intermediate principal values, so its approximate raw figure is not an exact integer oracle.

This is a published-case arithmetic check. The article does not supply block number/hash, underlying RPC responses, stored owed balances or token1 fee inputs. Keep those fields unknown. It does not verify the live adapter, full collectible balances, historical chain replay, execution, costs, or profitability.

## Live verification limitation

During creation on September 8, 2026, ordinary public RPC requests returned HTTP 403 or timed out; no suitable connected RPC tool was available. No live collection, stateful fork reconciliation, or actual wallet transaction was completed. Offline fixture checks do not change this status.

Before relying on native collection for a live decision, run the adapter against an accessible authorized RPC, retain and independently check a pinned snapshot, and reconcile at least one position's principal and fees against an independently observed manager call or historical transaction. For execution claims, additionally simulate the actual wallet path and inspect token balance deltas. Report exactly which checks completed; do not treat this document as deployment certification.
