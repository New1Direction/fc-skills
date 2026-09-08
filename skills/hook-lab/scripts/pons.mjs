/** Pons V2 source-derived inspection and fee arithmetic; no swap execution. */
import { createHash } from 'node:crypto';
import { keccakHex } from './keccak.mjs';

export const PONS_CANDIDATE = Object.freeze({
  chain_id: 4663,
  factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  hook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  pool_manager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  source_commit: '8b9bf371030279133017b5c1b713823f5889c5d2',
  status: 'SOURCE_DERIVED_UNVERIFIED_DEPLOYMENT',
});
const ZERO = '0x' + '0'.repeat(40);
const UINT256 = (1n << 256n) - 1n;
const INT128_MAX = (1n << 127n) - 1n;
const INT128_MIN = -(1n << 127n);
const INT256_MAX = (1n << 255n) - 1n;
const INT256_MIN = -(1n << 255n);
function check(condition, message) { if (!condition) throw new Error(message); }
function object(value, label) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}
function address(value, label = 'address', nonzero = false) {
  check(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), `${label} must be a 20-byte address`);
  const normalized = value.toLowerCase();
  check(!nonzero || normalized !== ZERO, `${label} must be nonzero`);
  return normalized;
}
function integer(value, min, max, label) {
  if (typeof value === 'number') check(Number.isSafeInteger(value), `${label} must be an exact integer`);
  else check(typeof value === 'bigint' || (typeof value === 'string' && /^(0|-?[1-9][0-9]*)$/.test(value)), `${label} must be a canonical decimal integer`);
  const result = BigInt(value);
  check(result >= min && result <= max, `${label} out of range`);
  return result;
}
function boolean(value, label) { check(typeof value === 'boolean', `${label} must be boolean`); return value; }
function hash(value, label = 'hash') {
  check(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), `${label} must be 32 bytes`);
  return value.toLowerCase();
}
function abiWords(raw, count) {
  check(typeof raw === 'string' && new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`).test(raw), `expected exactly ${count} ABI words`);
  return Array.from({ length: count }, (_, i) => raw.slice(2 + i * 64, 66 + i * 64));
}
function abiUint(word, bits = 256) {
  const n = BigInt('0x' + word);
  check(n < (1n << BigInt(bits)), `noncanonical uint${bits} padding`);
  return n;
}
function abiInt(word, bits) {
  const n = BigInt('0x' + word);
  const signed = n >> 255n ? n - (1n << 256n) : n;
  check(signed >= -(1n << BigInt(bits - 1)) && signed < (1n << BigInt(bits - 1)), `noncanonical int${bits} padding`);
  return Number(signed);
}
function abiBool(word) { return Boolean(Number(abiUint(word, 1))); }
function abiAddress(word) { check(/^0{24}/.test(word), 'noncanonical address padding'); return '0x' + word.slice(24).toLowerCase(); }
function word(value) { return (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, '0'); }
function addressWord(value) { return address(value).slice(2).padStart(64, '0'); }
function selector(signature) { return keccakHex(Buffer.from(signature, 'utf8')).slice(0, 10); }

/** Strict Solidity public mapping getter return, including canonical padding. */
export function decodeLaunch(raw) {
  const w = abiWords(raw, 13);
  return {
    registered: abiBool(w[0]), memecoinIsCurrency0: abiBool(w[1]),
    memecoin: abiAddress(w[2]), quoteToken: abiAddress(w[3]), creator: abiAddress(w[4]),
    buybackCreatorRecipient: abiAddress(w[5]), protocolFeeRecipient: abiAddress(w[6]),
    creatorTaxBps: Number(abiUint(w[7], 16)), protocolFeeShareBps: Number(abiUint(w[8], 16)),
    buybackBurnBps: Number(abiUint(w[9], 16)), hookFeeBps: Number(abiUint(w[10], 16)),
    maxInternalPriceImpactBps: Number(abiUint(w[11], 16)), buybackEnabled: abiBool(w[12]),
  };
}

/** Strict static IPonsV2LaunchFactory.LaunchedToken return. */
export function decodeLaunchedToken(raw) {
  const w = abiWords(raw, 15);
  const phase = Number(abiUint(w[10], 8));
  check(phase <= 3, 'unknown GraduationPhase');
  return {
    token: abiAddress(w[0]), curve: abiAddress(w[1]), deployer: abiAddress(w[2]),
    creatorFeeRecipient: abiAddress(w[3]), pairToken: abiAddress(w[4]),
    graduationThreshold: abiUint(w[5]).toString(), poolFee: Number(abiUint(w[6], 24)),
    tickSpacing: abiInt(w[7], 24), creatorTaxBps: Number(abiUint(w[8], 16)),
    buybackEnabled: abiBool(w[9]), phase, sweptQuote: abiUint(w[11]).toString(),
    sweptTokens: abiUint(w[12]).toString(), sweptAt: abiUint(w[13]).toString(), exists: abiBool(w[14]),
  };
}

/** Only ABI-encode the reviewed read-only selectors. */
export function encodePonsRead(name, argument) {
  const noArgs = ['memeHook', 'poolManager', 'factory'];
  if (noArgs.includes(name)) {
    check(argument === undefined, `${name} takes no argument`);
    return selector(name + '()');
  }
  if (name === 'getLaunchedToken') return selector('getLaunchedToken(address)') + addressWord(argument);
  if (name === 'launches') return selector('launches(bytes32)') + hash(argument, 'pool_id').slice(2);
  throw new Error('unsupported Pons read selector');
}

function validatePoolKey(value) {
  const k = object(value, 'pool_key');
  const key = {
    currency0: address(k.currency0), currency1: address(k.currency1),
    fee: Number(integer(k.fee, 0n, 0n, 'Pons core fee')),
    tickSpacing: Number(integer(k.tickSpacing, 1n, 32767n, 'tickSpacing')),
    hooks: address(k.hooks, 'hooks', true),
  };
  check(key.currency0 < key.currency1, 'currencies must be distinct and sorted');
  check(key.hooks === PONS_CANDIDATE.hook, 'unsupported Pons deployment');
  return key;
}
export function ponsPoolId(value) {
  const k = validatePoolKey(value);
  const encoded = addressWord(k.currency0) + addressWord(k.currency1) + word(BigInt(k.fee)) + word(BigInt(k.tickSpacing)) + addressWord(k.hooks);
  return keccakHex(Buffer.from(encoded, 'hex'));
}
export function reconstructPonsPool(record) {
  const r = object(record, 'launched_token');
  check(r.exists === true, 'token is not registered with this factory');
  check(r.phase === 2, 'launch has not reached PoolCreated');
  const token = address(r.token, 'launch token', true);
  const quote = address(r.pairToken, 'pairToken');
  check(token !== quote, 'token and quote must differ');
  const currencies = [token, quote].sort();
  const pool_key = validatePoolKey({ currency0: currencies[0], currency1: currencies[1], fee: r.poolFee, tickSpacing: r.tickSpacing, hooks: PONS_CANDIDATE.hook });
  return { pool_key, pool_id: ponsPoolId(pool_key) };
}
function validateLaunch(value, key) {
  const l = object(value, 'launch');
  check(l.registered === true, 'Pons pool is not registered');
  const is0 = boolean(l.memecoinIsCurrency0, 'memecoinIsCurrency0');
  const meme = address(l.memecoin, 'memecoin', true);
  const quote = address(l.quoteToken, 'quoteToken');
  check(meme === (is0 ? key.currency0 : key.currency1) && quote === (is0 ? key.currency1 : key.currency0), 'launch currencies disagree with PoolKey');
  address(l.creator, 'creator', true); address(l.buybackCreatorRecipient, 'buybackCreatorRecipient', true); address(l.protocolFeeRecipient, 'protocolFeeRecipient', true);
  const fee = integer(l.hookFeeBps, 0n, 1000n, 'hookFeeBps');
  const tax = integer(l.creatorTaxBps, 0n, 2000n, 'creatorTaxBps');
  check(fee + tax <= 2000n, 'total hook fee exceeds source bound');
  integer(l.protocolFeeShareBps, 0n, 5000n, 'protocolFeeShareBps');
  integer(l.buybackBurnBps, 0n, 10000n, 'buybackBurnBps');
  integer(l.maxInternalPriceImpactBps, 1n, 9999n, 'maxInternalPriceImpactBps');
  boolean(l.buybackEnabled, 'buybackEnabled');
  return { fee, tax };
}

/**
 * Reconcile the fee on already-computed core deltas for an ordinary swap.
 * Does not traverse ticks, quote a route, or establish wallet execution.
 */
export function quotePonsFees(input) {
  object(input, 'input');
  const evidenceMode = input.evidence_mode ?? 'provided';
  check(['synthetic', 'provided'].includes(evidenceMode), 'evidence_mode must be synthetic or provided');
  const key = validatePoolKey(input.pool_key);
  const { fee, tax } = validateLaunch(input.launch, key);
  const amount = integer(input.amount_specified, INT256_MIN, INT256_MAX, 'amount_specified');
  check(amount !== 0n, 'amount_specified cannot be zero');
  const zeroForOne = boolean(input.zero_for_one, 'zero_for_one');
  const d0 = integer(input.core_delta0, INT128_MIN, INT128_MAX, 'core_delta0');
  const d1 = integer(input.core_delta1, INT128_MIN, INT128_MAX, 'core_delta1');
  const inputDelta = zeroForOne ? d0 : d1;
  const outputDelta = zeroForOne ? d1 : d0;
  check(inputDelta <= 0n && outputDelta >= 0n, 'core deltas disagree with swap direction');
  const specifiedIs0 = (amount < 0n) === zeroForOne;
  const specified = specifiedIs0 ? d0 : d1;
  check(amount < 0n ? specified >= amount : specified <= amount, 'specified fill exceeds requested amount');
  const unspecified = specifiedIs0 ? d1 : d0;
  // Solidity negating int128.min reverts; do not return an impossible quote.
  check(fee + tax === 0n || unspecified !== INT128_MIN, 'unspecified int128 minimum would overflow in source');
  const magnitude = unspecified < 0n ? -unspecified : unspecified;
  const feeAmount = magnitude * fee / 10000n;
  const taxAmount = magnitude * tax / 10000n;
  const total = feeAmount + taxAmount;
  const adjusted0 = d0 - (specifiedIs0 ? 0n : total);
  const adjusted1 = d1 - (specifiedIs0 ? total : 0n);
  check(adjusted0 >= INT128_MIN && adjusted1 >= INT128_MIN, 'hook-adjusted delta would overflow int128');
  return {
    schema_version: 'hook-lab.pons-fees.v1', status: 'SOURCE_DERIVED_FEE_ARITHMETIC',
    evidence_mode: evidenceMode,
    deployment_status: PONS_CANDIDATE.status, source_commit: PONS_CANDIDATE.source_commit,
    pool_id: ponsPoolId(key), swap_kind: amount < 0n ? 'EXACT_INPUT' : 'EXACT_OUTPUT',
    amount_specified: amount.toString(), zero_for_one: zeroForOne,
    specified_fill: (specified < 0n ? -specified : specified).toString(),
    partial_fill: specified !== amount,
    fee_currency: specifiedIs0 ? key.currency1 : key.currency0,
    fee_basis_raw: magnitude.toString(), fee_raw: feeAmount.toString(), creator_tax_raw: taxAmount.toString(), total_raw: total.toString(),
    core_delta0: d0.toString(), core_delta1: d1.toString(),
    hook_adjusted_delta0: adjusted0.toString(), hook_adjusted_delta1: adjusted1.toString(),
    limitations: [
      'Supplied core deltas and pool snapshot are not independently established by this calculation.',
      'Excludes router charges, gas, nonstandard token transfers and later state changes.',
      'Ordinary caller path only; hook-originated internal swaps can skip callbacks.',
      'No wallet call, swap traversal, source-to-runtime match or profitable route is established.',
    ],
  };
}

function rpcQuantity(value, label) {
  check(typeof value === 'string' && /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value), `${label} must be an RPC quantity`);
  return BigInt(value);
}

/** Twelve bounded pinned reads; exact candidate deployment only. No writes. */
export async function discoverPonsPool(request, { rpc }) {
  object(request, 'request');
  check(request.chain_id === 4663, 'Pons discovery requires chain 4663');
  check(typeof rpc === 'function', 'rpc(method, params) is required');
  const token = address(request.token, 'token', true);
  const block = object(request.block, 'block');
  const number = integer(block.number, 0n, UINT256, 'block.number');
  const expectedHash = hash(block.hash, 'block.hash');
  const tag = '0x' + number.toString(16);
  const pin = { blockHash: expectedHash, requireCanonical: true };
  const evidence = [];
  async function read(method, params) {
    const result = await rpc(method, params);
    evidence.push({ method, params: structuredClone(params), result: structuredClone(result) });
    return result;
  }
  check(rpcQuantity(await read('eth_chainId', []), 'chain id') === 4663n, 'RPC chain mismatch');
  function checkHeader(header) {
    object(header, 'block header');
    check(rpcQuantity(header.number, 'header.number') === number && hash(header.hash) === expectedHash, 'block identity changed or mismatched');
    return header;
  }
  const initialHeader = checkHeader(await read('eth_getBlockByNumber', [tag, false]));
  async function call(to, name, argument) { return read('eth_call', [{ to, data: encodePonsRead(name, argument) }, pin]); }
  function singleAddress(raw) { return abiAddress(abiWords(raw, 1)[0]); }
  check(singleAddress(await call(PONS_CANDIDATE.factory, 'memeHook')) === PONS_CANDIDATE.hook, 'factory hook mismatch');
  check(singleAddress(await call(PONS_CANDIDATE.factory, 'poolManager')) === PONS_CANDIDATE.pool_manager, 'factory manager mismatch');
  check(singleAddress(await call(PONS_CANDIDATE.hook, 'factory')) === PONS_CANDIDATE.factory, 'hook factory mismatch');
  check(singleAddress(await call(PONS_CANDIDATE.hook, 'poolManager')) === PONS_CANDIDATE.pool_manager, 'hook manager mismatch');
  const launched_token = decodeLaunchedToken(await call(PONS_CANDIDATE.factory, 'getLaunchedToken', token));
  check(launched_token.token === token, 'factory returned a different token');
  const { pool_key, pool_id } = reconstructPonsPool(launched_token);
  const launch = decodeLaunch(await call(PONS_CANDIDATE.hook, 'launches', pool_id));
  validateLaunch(launch, pool_key);
  check(launch.memecoin === token && launch.quoteToken === launched_token.pairToken, 'factory and hook token identity mismatch');
  check(launch.creatorTaxBps === launched_token.creatorTaxBps && launch.buybackEnabled === launched_token.buybackEnabled && launch.creator === launched_token.creatorFeeRecipient, 'factory and hook launch state disagree');
  const runtime_observations = [];
  for (const [role, target] of [['factory', PONS_CANDIDATE.factory], ['hook', PONS_CANDIDATE.hook], ['pool_manager', PONS_CANDIDATE.pool_manager]]) {
    const code = await read('eth_getCode', [target, pin]);
    check(typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && code.length <= 2 + 2 * 1024 * 1024, `missing or invalid ${role} bytecode`);
    runtime_observations.push({ role, address: target, runtime_sha256: createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex'), source_match: 'UNVERIFIED' });
  }
  checkHeader(await read('eth_getBlockByNumber', [tag, false]));
  return {
    schema_version: 'hook-lab.pons-discovery.v1', status: 'CANDIDATE_STATE_OBSERVED',
    deployment_status: PONS_CANDIDATE.status, source_commit: PONS_CANDIDATE.source_commit,
    chain_id: 4663, block: { number: number.toString(), hash: expectedHash },
    block_header: initialHeader, token, pool_manager: PONS_CANDIDATE.pool_manager,
    factory: PONS_CANDIDATE.factory, pool_key, pool_id, launched_token, launch,
    runtime_observations, evidence,
    limitations: [
      'One provider supplied this state. Matching addresses and getter layouts do not establish source correspondence.',
      'Initialize and PoolRegistered receipts, independent runtime verification and wallet-route simulation are still required.',
      'No pool activity, full transaction replay, executable price or profitable route is established.',
    ],
  };
}
