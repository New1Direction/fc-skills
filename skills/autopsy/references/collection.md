# Bounded EVM collection

The native helper uses Python 3.10+ standard library and a supplied HTTP(S) RPC. It only invokes eth_chainId, eth_getBlockByNumber, eth_getCode, eth_call, and eth_getLogs. It cannot sign or submit transactions. RPC service costs and access remain those of the user's configured provider.

Resolve the chain and exact address first. Confirm which numbered blocks cover the question; verify finality using the chain's current rules/provider. A numeric block is not automatically finalized. Archive access may be necessary for historical state.

Set `AUTOPSY_RPC_URL` through the host's secret/environment facility. Do not paste credentials into a report, command transcript, or skill file. With the variables below already set to verified non-secret values, invoke the helper from its skill directory:

```bash
python3 scripts/collect_evm.py \
  --rpc-env AUTOPSY_RPC_URL \
  --chain-id "$AUTOPSY_CHAIN_ID" \
  --token "$AUTOPSY_TOKEN" \
  --from-block "$AUTOPSY_FROM_BLOCK" \
  --to-block "$AUTOPSY_TO_BLOCK" \
  --out /absolute/case/evidence.json
```

Create the case output directory first. Output must not exist; use a new filename for a later capture. Both boundaries are inclusive integers. Defaults are 1,000 blocks per initial request, 300 total RPC calls, and 120 seconds; --max-calls must be at least 5 to allow chain and boundary verification. Range errors split into smaller ranges within the same budgets. The helper reserves capacity for final boundary rechecks.

Use a smaller initial chunk when a provider documents a strict cap. Keep raw observations from a failed pass; a retry is a separate capture. Do not expand the window indefinitely or rotate providers to evade access limits. Use another available provider when an ordinary failure or unsupported historical read warrants it, recording the provenance separately.

Exit 0 means the selected-range log capture met the helper's complete criterion. Exit 2 includes incomplete/invalidated capture or a local/argument failure. When a packet was written, inspect its coverage and diagnostics before deciding what can support the report. Check output existence; an unsuccessful invocation is not an empty case.

The helper checks that the RPC reports the requested chain, that logs use the exact token emitter and standard ERC-20 Transfer encoding, and that boundary hashes stay consistent. It preserves raw results, validates duplicate identities, and labels gaps. It does not prove that every interior log is canonical, that the provider did not silently truncate, that token events faithfully encode balances, or that selected blocks include the entire launch. For material findings, corroborate receipts/block hashes and state with an independent source where practical.

At the end block it queries runtime code, decimals, and totalSupply. These are metadata observations at that boundary, not historical admin checks or contract verification. No symbol string is needed to establish identity. Nonstandard/malicious event emission requires implementation-aware reconciliation.

Obtain creation traces, successful receipts, swap/LP events, balance snapshots, proxy storage, and fees through already available tools as the case requires. Read protocol-forensics.md for chain-specific pitfalls. Solana mint/account evidence must use native tools; this collector does not support it.

For an offline workflow, open assets/training-case.json. It is deliberately synthetic and must never be described as a live token investigation.
