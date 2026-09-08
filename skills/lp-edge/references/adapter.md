# Native canonical V3 adapter

`scripts/collect_v3.py` collects retained read-only JSON-RPC evidence for one canonical Uniswap V3 pool, optional NonfungiblePositionManager NFT, and a fixed range. Python standard library only; `lp_math.py` is bundled. No V2, V4, hooks, taxed transfers, rebases, native-token wrapping, alternative position managers, signing, state overrides, approvals, transaction submission, or persistent monitoring.

## Prepare a request

Copy `assets/example-v3-request.json`. Its addresses, bytecode fingerprints, NFT, wallet, blocks, and verification descriptions are **synthetic placeholders**. Replace them with independently verified deployment and standard-token evidence. There is no preverified Robinhood Chain deployment in this adapter.

Required fields:

- `chain_id`: positive integer; `block_numbers`: 1–16 strictly increasing numeric heights, optionally ending with `"latest"`. Latest resolves once to a concrete block before state reads.
- `factory`, `pool`, `token0`, `token1`: distinct canonical EVM addresses. Token0 must sort below token1.
- `fee`: integer fee in millionths; `tick_lower`, `tick_upper`: integer bounds within TickMath limits, checked against actual factory/pool spacing.
- `expected_code_sha256`: SHA256 of runtime bytecode, without `0x`, for **every** configured contract role. Optional manager adds a `position_manager` key. Expected fingerprints must come from an independent deployment verification process; copying unknown RPC output into the expected map establishes no independent verification.
- `deployment_evidence`, `standard_token_evidence`: bounded source descriptions. These are provenance declarations checked by the researcher, not authenticated by the program.

Optional `position_manager` plus decimal-string `token_id` includes NFT state and ownership. Its token identities, fee and range must match the request. Optional `wallet` is the real wallet being examined. `max_log_block_span` defaults to 100,000 and cannot exceed it. Raw token amounts, token IDs, and position liquidity use canonical decimal strings, never floats or scientific notation.

Run with an RPC endpoint already supplied in an environment variable:

```sh
python3 scripts/collect_v3.py --config request.json --rpc-env LP_EDGE_RPC_URL --out evidence.json
python3 scripts/collect_v3.py --verify evidence.json
python3 scripts/analyze_evidence.py evidence.json --output accounting.json
```

The bridge supports one or two NFT snapshots. One snapshot produces current position accounting; two may also support an interval comparison. Read `references/quant-inputs.md` for the optional costs and continuity assumptions supported by the analyzer. Pool-only and longer snapshot collections remain valid evidence but need a separately verified analysis workflow. Output files are created exclusively; select a new path for each run.

## What is checked and retained

The adapter checks chain ID, configured bytecode hashes, pool/factory/token/NFT identities, factory `getPool`, factory/pool fee spacing, ABI widths and signed padding, token decimals, price/tick consistency, active liquidity, fee globals, boundary tick state, NFT balances and owner. Address and hash matches do not prove audited opcode behavior or authenticate proxy implementations. A verified runtime hash can remain unchanged while an underlying proxy implementation changes. Unsupported token behavior or unverified upgradeability prevents using these calculations as execution assurance.

All `eth_call` and `eth_getCode` reads use EIP-1898 `{blockHash, requireCanonical:true}` selectors. A provider that does not support them produces incomplete evidence; the adapter does not silently weaken anchoring. Each snapshot rechecks its original block header after collection. Header hashes, numbers and timestamps are retained along with exact call byte data and sanitized method/parameter/result records. Free-text RPC errors and unrelated response fields are discarded to avoid retaining credentials echoed by a provider.

`--verify` replays every retained RPC record and rederives normalized state, call outcomes and activity coverage. JSON comparisons distinguish integers, floats and booleans. Extra, missing, reordered or mismatched calls, changed normalized fields, and changed anchors fail reconciliation. The capture timestamp is format-checked but cannot be independently reconstructed. A fabricated internally consistent transcript can still reconcile: verification is **internal consistency**, not independent proof of provider honesty, finality, historical completeness or real collection. `source_kind: synthetic` remains synthetic. Live CLI collection labels its source `live_rpc`; this metadata is not a cryptographic attestation.

## Wallet call simulations

Set `simulate.mint` with desired and minimum raw amounts plus `deadline_seconds` (1–3600). The adapter reads wallet balances and existing manager allowances, then uses that wallet as `from` for a read-only manager mint call. Desired amounts are spending caps; they need not both be consumed. A shortfall versus a cap is advisory, since one-sided or ratio-limited mints can still succeed. Successful returned amounts must respect minima, caps, observed balances and allowances. The tool never supplies approvals or funds missing balances.

Set `simulate.collect: true` to call NFT collection to its owning wallet. Set `simulate.withdraw` with requested liquidity, minimum amounts and deadline to call **one atomic manager multicall containing decreaseLiquidity then collect**. It requires the wallet to own the existing NFT and enough recorded position liquidity; approved operators are outside native simulation scope. Withdrawal collects all claimable amounts up to uint128 limits, including previously owed amounts, so the collection result is not necessarily withdrawal principal or newly earned fees.

Each requested simulation starts from the original pinned snapshot. A mint simulation does not create an NFT for a subsequent simulation. Results distinguish `not_requested`, `missing_prerequisites`, `rpc_error`, `unavailable`, and `call_succeeded`. An RPC error does not by itself prove an EVM revert. Success means the wallet call returned expected ABI data. It is not a submitted transaction, measured wallet balance delta, gas estimate, economic success, future success or permission to trade. Gas and all-in costs remain separate supplied evidence.

## Historical activity and bounded operation

For consecutive snapshots of an NFT, two numeric-range `eth_getLogs` requests cover `(start_block, end_block]`: one for IncreaseLiquidity/DecreaseLiquidity/Collect, one for ERC721 Transfer. Thus transfers out and back remain visible even when endpoint owners match. Both boundary headers are rechecked after log reads. This is weaker than hash-pinned state. Returned logs are checked for filter identity, range, duplicate identity, ordering and ABI shape. Provider-returned log absence remains `provider_returned_no_events`, with `provider_completeness_unverified: true`; it does not automatically certify an unchanged interval. Event-bearing intervals require separate accounting periods or a verified event ledger. Oversized or failed requests remain unavailable, never zero activity.

Defaults are 1,000 calls and 300 seconds; hard limits are 1,000 calls, 3,600 seconds, 16 snapshots, 8 MiB per response, 24 MiB retained transcript content, 1,000 logs per response, and 100,000 blocks per requested interval. Calls have a maximum 20-second transport deadline. No retries or scans beyond the request are performed. Any failed core identity/state/anchor read leaves the packet incomplete or invalid. Complete state collection can still contain unavailable activity coverage or failed wallet calls; inspect those fields before drawing conclusions.

## Primary sources

- [Uniswap V3 pool state interface](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolState.sol)
- [Canonical NonfungiblePositionManager](https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol)
- [Canonical Multicall](https://github.com/Uniswap/v3-periphery/blob/main/contracts/base/Multicall.sol)
- [EIP-1898 block-hash state selection](https://eips.ethereum.org/EIPS/eip-1898)

Source interfaces checked 2026-09-08. Offline tests exercise synthetic and adversarial transcripts; they do not establish a live provider/deployment validation.
