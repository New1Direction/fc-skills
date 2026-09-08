/** Bounded Ethereum ABI encoder. No SDK, network access or signing. */
import { keccakHex } from './keccak.mjs';

const assert = (condition, message) => { if (!condition) throw new TypeError(message); };
const MAX_BYTES = 1_048_576;
const HEX = /^0x(?:[a-fA-F0-9]{2})*$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const word = x => x.toString(16).padStart(64, '0');
const bytes = x => {
  assert(typeof x === 'string' && x.length <= 131074 && HEX.test(x), 'ABI bytes must be bounded even-length hex');
  return x.slice(2).toLowerCase();
};
function integer(x) {
  assert(typeof x === 'bigint' || (typeof x === 'number' && Number.isSafeInteger(x)) ||
    (typeof x === 'string' && x.length <= 79 && DECIMAL.test(x)), 'ABI integer must be exact and canonical');
  return BigInt(x);
}
function joined(parts) {
  const length = parts.reduce((n, p) => n + p.length, 0);
  assert(length <= MAX_BYTES * 2, 'ABI encoding exceeds one MiB');
  return parts.join('');
}
function tuple(parts) {
  let offset = parts.reduce((n, p) => n + (p.dynamic ? 32 : p.hex.length / 2), 0);
  const heads = [], tails = [];
  for (const part of parts) {
    if (part.dynamic) {
      heads.push(word(BigInt(offset)));
      tails.push(part.hex);
      offset += part.hex.length / 2;
    } else heads.push(part.hex);
  }
  return joined([...heads, ...tails]);
}
function value(type, x, depth = 0) {
  assert(depth <= 12, 'ABI type depth exceeds 12');
  if (typeof type === 'string') {
    let match;
    if (type === 'address') {
      assert(typeof x === 'string' && ADDRESS.test(x), 'ABI address must be 20-byte hex');
      return { dynamic: false, hex: x.slice(2).toLowerCase().padStart(64, '0') };
    }
    if (type === 'bool') {
      assert(typeof x === 'boolean', 'ABI bool must be boolean');
      return { dynamic: false, hex: word(x ? 1n : 0n) };
    }
    if ((match = /^(u?int)([0-9]+)?$/.exec(type))) {
      const bits = Number(match[2] ?? 256), signed = match[1] === 'int';
      assert(bits >= 8 && bits <= 256 && bits % 8 === 0, 'Unsupported ABI integer width');
      const n = integer(x), lower = signed ? -(1n << BigInt(bits - 1)) : 0n;
      const upper = 1n << BigInt(signed ? bits - 1 : bits);
      assert(n >= lower && n < upper, `ABI ${type} out of range`);
      return { dynamic: false, hex: word(n < 0n ? (1n << 256n) + n : n) };
    }
    if ((match = /^bytes([0-9]+)$/.exec(type))) {
      const width = Number(match[1]), hex = bytes(x);
      assert(width >= 1 && width <= 32 && hex.length === width * 2, 'Fixed ABI bytes width mismatch');
      return { dynamic: false, hex: hex.padEnd(64, '0') };
    }
    if (type === 'bytes') {
      const hex = bytes(x);
      return { dynamic: true, hex: word(BigInt(hex.length / 2)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0') };
    }
    throw new TypeError('Unsupported ABI type');
  }
  assert(object(type) && Object.keys(type).length === 1, 'ABI descriptor must specify tuple or array');
  assert(Array.isArray(x) && x.length <= 64, 'ABI tuple or array must contain at most 64 values');
  if (Object.hasOwn(type, 'tuple')) {
    assert(Array.isArray(type.tuple) && type.tuple.length <= 64 && type.tuple.length === x.length, 'ABI tuple arity mismatch');
    const parts = type.tuple.map((t, i) => value(t, x[i], depth + 1));
    return { dynamic: parts.some(p => p.dynamic), hex: tuple(parts) };
  }
  assert(Object.hasOwn(type, 'array'), 'Unsupported ABI descriptor');
  const parts = x.map(v => value(type.array, v, depth + 1));
  // Array element offsets start AFTER its length word, as required by the ABI.
  return { dynamic: true, hex: word(BigInt(x.length)) + tuple(parts) };
}

/** Types: Solidity scalar strings, {tuple:[types...]}, or {array:elementType}. */
export function abiEncode(types, values) {
  assert(Array.isArray(types) && types.length <= 64 && Array.isArray(values) && types.length === values.length, 'ABI argument arity mismatch');
  return '0x' + tuple(types.map((type, i) => value(type, values[i])));
}

export function selector(signature) {
  assert(typeof signature === 'string' && signature.length <= 256 && /^[A-Za-z][A-Za-z0-9_]*\([A-Za-z0-9_(),\[\]]*\)$/.test(signature), 'Invalid function signature');
  return keccakHex(Buffer.from(signature)).slice(0, 10);
}

/** Exact source ABI: UR 2.1.1 and its pinned V4 periphery ExactInputParams. */
export function encodeUniversalV4(route, settlementCurrencies) {
  const pathType = { tuple: ['address', 'uint24', 'int24', 'address', 'bytes'] };
  const swapType = { tuple: ['address', { array: pathType }, { array: 'uint256' }, 'uint128', 'uint128'] };
  const path = route.hops.map(h => [h.currency_out, h.pool_key.fee, h.pool_key.tick_spacing, h.pool_key.hooks, h.hook_data]);
  const params = [
    abiEncode(['address', 'uint256', 'bool'], [route.currency_in, route.amount_in, true]),
    // Empty minHopPriceX36 is explicitly supported by this pinned periphery.
    // Aggregate amountOutMinimum remains positive; there is no per-hop price floor.
    abiEncode([swapType], [[route.currency_in, path, [], route.amount_in, route.minimum_out]]),
    ...settlementCurrencies.map((currency, i) => abiEncode(['address', 'uint256'], [currency, i === 0 ? route.minimum_out : '0']))
  ];
  const actions = '0x0b07' + '0f'.repeat(settlementCurrencies.length);
  const actionInput = abiEncode(['bytes', { array: 'bytes' }], [actions, params]);
  return selector('execute(bytes,bytes[],uint256)') + abiEncode(['bytes', { array: 'bytes' }, 'uint256'], ['0x10', [actionInput], route.deadline]).slice(2);
}
