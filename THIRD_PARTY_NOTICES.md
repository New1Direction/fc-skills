# Third-party notices

`skills/lp-edge/scripts/lp_math.py` retains its `GPL-2.0-or-later` SPDX identifier and attribution to Uniswap V3 TickMath. The referenced implementation is [Uniswap/v3-core TickMath.sol](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol). Its source and adapted constants remain included with the package. A verbatim GPL version 2 text is supplied in [LICENSES/GPL-2.0.txt](LICENSES/GPL-2.0.txt).

This packaging step preserves the individual files' existing notices and does not relicense third-party code. No collection-wide public redistribution license is assigned to otherwise unlicensed material. Review the applicable notices and derived-code obligations before any later public release or relicensing.

The published Uniswap case fixture retains its source attribution and missing-evidence limitations. Other primary-source links within the skills remain attached to the methods they inform.

CIRCUIT's isolated EVM fixture retains upstream UniversalRouter 2.1.1, PoolManager and Permit2 creation artifacts and their deployment-library source. Exact repositories, commits, artifact hashes and corresponding-source URLs are in `skills/circuit/assets/contracts/source-lock.json`; the harness verifies that the artifact bytes match the retained deployment source. UniversalRouter source is GPL-3.0-or-later, PoolManager components retain BUSL-1.1/MIT terms, and Permit2 retains MIT terms. Their full upstream license texts are included beside the artifacts. The original local fixture is separately identified. These upstream terms remain applicable; the collection does not relicense those components.

CIRCUIT's local validation uses upstream build artifacts; it does not claim to reproduce their source builds independently or attest to Robinhood runtime correspondence. Its self-contained fork/RPC/Keccak helpers were copied from MSK's HOOK LAB with their existing notices preserved.
