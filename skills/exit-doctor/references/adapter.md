# Native V2 adapter

The collector uses Python 3.10+ standard library, one supplied HTTP(S) RPC, a numeric block, and one standard ERC-20 input/output pair. It targets the canonical V2 997/1000 quote mechanism. It does not assume a deployment exists on a chain because that chain is EVM-compatible.

Resolve the router, factory, pair, token addresses, and mechanism through primary deployment/source evidence. Obtain runtime code at the investigated block; record SHA-256 of decoded bytecode bytes when supplying expected fingerprints. SHA-256 here is an artifact fingerprint, not Ethereum's Keccak code hash. The helper checks the supplied fingerprints, not their source's trustworthiness.

## Request

Create a case request JSON outside the installed skill with these fields:

| Field | Value |
| --- | --- |
| chain_id | Exact integer EVM chain ID |
| block_number | Explicit nonnegative block number |
| router, factory, pair | Independently resolved addresses |
| token_in, token_out | Distinct nonzero ERC-20 addresses, in the sell direction |
| amounts_in_raw | One to twenty positive decimal integer strings in input-token raw units |
| wallet | Actual sender/recipient address for call simulation, or null |
| slippage_bps | User-selected minimum-output tolerance, default 100 when omitted; identify this default in the report |
| deployment_evidence | Primary source URL or retained evidence locator supporting the deployment review |
| expected_code_sha256 | Optional mapping for router, factory, pair, token_in, token_out to independently obtained fingerprints |

Convert human token amounts exactly using verified decimals; refuse excessive fractional precision. Do not pass a USD position value as token units. The native helper does not resolve ticker ambiguity or discover the best route automatically.

Set EXIT_DOCTOR_RPC_URL using the host's secret/environment facility; never embed its value in the request or report. Create the case directory, then run from the skill directory:

```bash
python3 scripts/collect_v2.py \
  --config /absolute/case/request.json \
  --rpc-env EXIT_DOCTOR_RPC_URL \
  --out /absolute/case/evidence.json
```

Default capture budget is 160 RPC calls and 120 seconds, with a final boundary check reserved. Use --max-calls and --max-seconds when the task supplies a different finite budget. The per-response byte limit and 20-size cap bound work. Use an unused output filename for every capture; writes must not replace earlier evidence.

## Verification performed

The helper checks chain ID; before/after boundary hash; nonempty runtime code and optional fingerprints; router.factory(); pair.factory(); factory.getPair(); pair token0/token1; reserves; decimals; pair token balances; and router quotes against the fixed-fee integer model.

A route marked identity_verified has internally consistent relationships, not a cryptographic guarantee that it is an official deployment. matched_config means all required fingerprints match supplied configuration. Unverified fingerprints remain explicit. A balance/reserve discrepancy or unsupported fee model must not become verified executable capacity.

State reads use EIP-1898 blockHash/requireCanonical. If the provider lacks that capability or archive state, capture the failure. Do not silently switch to latest. A matching before/after hash does not prove finality or an honest provider.

With a wallet, the helper reads token balance, allowance to the router, and native balance. It tests swapExactTokensForTokens through eth_call only when token prerequisites permit it, using the same wallet as sender and recipient. Its deadline is based on the captured block time, not a promise that the request remains usable later. No approval, signature, state override, or transaction submission occurs.

Optional eth_estimateGas uses the numeric height with a boundary recheck because support for historical estimates varies. Record gas_anchor_mode and retain failures. A native balance is not by itself proof that all transaction costs can be paid.

## Coverage

Complete describes this scoped capture: requested state/quotes and checks succeeded under the named assumptions. It does not establish general token sellability, full routing coverage, a measured recipient balance delta, or future execution. Partial preserves usable observations alongside missing reads or execution limitations. Invalidated evidence cannot support canonical findings; unavailable means the capture did not establish the required base evidence.

Inspect both process exit status and the written packet. A failed command is not an empty successful market. Never fill missing results with synthetic values. Use the bundled synthetic assets only when explicitly doing an offline example.
