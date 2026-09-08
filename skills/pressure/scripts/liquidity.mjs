/** Retained evidence comparator; no RPC, interpolation, or transaction submission. */
import { createHash } from 'node:crypto';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX = (1n << 256n) - 1n;
const fail = message => { throw new TypeError(message); };
function object(v, path) { if (!v || Array.isArray(v) || typeof v !== 'object') fail(`${path} must be an object`); return v; }
function str(v, path) { if (typeof v !== 'string' || !v.trim() || v.length > 2048) fail(`${path} must be a bounded nonempty string`); return v; }
function address(v, path) { if (typeof v !== 'string' || !ADDRESS.test(v)) fail(`${path} must be an address`); return v.toLowerCase(); }
function hash(v, path) { if (typeof v !== 'string' || !HASH.test(v)) fail(`${path} must be a 32-byte hash`); return v.toLowerCase(); }
function integer(v, path, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(v) || v < min || v > max) fail(`${path} is outside the integer bounds`); return v; }
function uint(v, path, positive = false) { if (typeof v !== 'string' || !UINT.test(v)) fail(`${path} must be a canonical uint256 decimal string`); const n = BigInt(v); if (n > MAX || (positive && !n)) fail(`${path} is outside the uint256 bounds`); return n; }
function one(v, choices, path) { if (!choices.includes(v)) fail(`${path} must be one of ${choices.join(', ')}`); return v; }
function bool(v, path) { if (typeof v !== 'boolean') fail(`${path} must be a boolean`); return v; }
function timestamp(v, path) { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)) fail(`${path} must be a UTC timestamp`); const n = Date.parse(v); if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 19) !== v.slice(0, 19)) fail(`${path} is invalid`); return n; }
function refs(v, path) { if (!Array.isArray(v) || !v.length || v.length > 100) fail(`${path} needs 1–100 retained references`); return v.map((x, i) => str(x, `${path}[${i}]`)); }
function token(v, path) { object(v, path); return { address: address(v.address, `${path}.address`), decimals: integer(v.decimals, `${path}.decimals`, 0, 36) }; }
function gcd(a, b) { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a; }
function fraction(n, d) { if (d <= 0n) fail('Rational denominator must be positive'); const g = gcd(n, d); return { numerator: (n / g).toString(), denominator: (d / g).toString() }; }
function rational(v, path) { object(v, path); return [uint(v.numerator, `${path}.numerator`, true), uint(v.denominator, `${path}.denominator`, true)]; }
function signedDifference(a, b) { return fraction((BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator)) * 10000n, BigInt(a.denominator) * BigInt(b.numerator)); }
function stable(v) { if (Array.isArray(v)) return v.map(stable); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])); return v; }
function digest(v) { return 'sha256:' + createHash('sha256').update(JSON.stringify(stable(v))).digest('hex'); }
function value(f) { return `${f.numerator}/${f.denominator}`; }

export function analyzeLiquidity(input) {
  object(input, 'input');
  if (input.schema_version !== 'pressure.liquidity.v1') fail('Unsupported liquidity schema');
  const evidenceMode = one(input.evidence_mode, ['synthetic', 'retained'], 'evidence_mode');
  if (input.chain_id !== 4663) fail('PRESSURE liquidity scope is chain 4663');
  const asset = token(input.asset, 'asset'), quote = token(input.quote_asset, 'quote_asset');
  if (asset.address === quote.address) fail('Asset and quote asset must differ');
  if ([asset.address, quote.address].includes('0x0000000000000000000000000000000000000000')) fail('Native-asset swap routes require a separate adapter; ERC-20 token addresses cannot be zero');
  const wallet = address(input.wallet, 'wallet');
  const asOf = timestamp(input.as_of, 'as_of');
  object(input.policy, 'policy');
  const snapshotAge = integer(input.policy.max_snapshot_age_seconds, 'policy.max_snapshot_age_seconds', 0, 31536000) * 1000;
  const referenceAge = integer(input.policy.max_reference_age_seconds, 'policy.max_reference_age_seconds', 0, 31536000) * 1000;
  const maxCost = uint(input.policy.max_execution_cost_bps, 'policy.max_execution_cost_bps');
  if (!Array.isArray(input.observations) || !input.observations.length || input.observations.length > 10000) fail('observations needs 1–10000 points');
  const ids = new Set(), positions = new Set(), blockHashes = new Map(), blockTimes = new Map();
  let lastBlock = -1, lastTime = -1;
  const rows = input.observations.map((o, i) => {
    const p = `observations[${i}]`; object(o, p);
    const id = str(o.id, `${p}.id`); if (ids.has(id)) fail('Duplicate observation id'); ids.add(id);
    if (o.chain_id !== undefined && o.chain_id !== 4663) fail(`${p} chain mismatch`);
    if (o.wallet !== undefined && address(o.wallet, `${p}.wallet`) !== wallet) fail(`${p} wallet mismatch`);
    for (const [name, expected] of [['asset', asset], ['quote_asset', quote]]) if (o[name] !== undefined) {
      const actual = token(o[name], `${p}.${name}`); if (actual.address !== expected.address || actual.decimals !== expected.decimals) fail(`${p} ${name} mismatch`);
    }
    object(o.block, `${p}.block`);
    const block = { number: integer(o.block.number, `${p}.block.number`), hash: hash(o.block.hash, `${p}.block.hash`), timestamp: o.block.timestamp };
    const blockTime = timestamp(block.timestamp, `${p}.block.timestamp`), observed = timestamp(o.observed_at, `${p}.observed_at`);
    if (observed > asOf || blockTime > observed) fail(`${p} has future or impossible observation timing`);
    if (block.number < lastBlock || blockTime < lastTime) fail('Observations must be ordered by nondecreasing block and block timestamp');
    lastBlock = block.number; lastTime = blockTime;
    if ((blockHashes.has(block.number) && blockHashes.get(block.number) !== block.hash) || (blockTimes.has(block.number) && blockTimes.get(block.number) !== blockTime)) fail('Conflicting block identity or timestamp; canonicalize before analysis');
    blockHashes.set(block.number, block.hash); blockTimes.set(block.number, blockTime);
    object(o.route, `${p}.route`);
    const route = { id: str(o.route.id, `${p}.route.id`), identity_hash: hash(o.route.identity_hash, `${p}.route.identity_hash`), configuration_hash: hash(o.route.configuration_hash, `${p}.route.configuration_hash`) };
    const direction = one(o.direction, ['buy', 'sell'], `${p}.direction`);
    const evidenceKind = one(o.evidence_kind, ['quote', 'wallet_call', 'wallet_fork'], `${p}.evidence_kind`);
    const evidenceRefs = refs(o.evidence_refs, `${p}.evidence_refs`);
    const inputRaw = uint(o.input_raw, `${p}.input_raw`, true);
    const status = one(o.status, ['ok', 'unavailable', 'reverted'], `${p}.status`);
    const outputRaw = status === 'ok' ? uint(o.output_raw, `${p}.output_raw`, true) : null;
    if (status !== 'ok' && o.output_raw !== null) fail(`${p} unavailable/reverted output must be null, not zero`);
    const canonical = bool(o.canonical, `${p}.canonical`), identityVerified = bool(o.identity_verified, `${p}.identity_verified`);
    one(o.fees_in_output, ['included', 'unknown'], `${p}.fees_in_output`);
    object(o.costs, `${p}.costs`); one(o.costs.coverage, ['complete', 'partial', 'unknown'], `${p}.costs.coverage`);
    if (!Array.isArray(o.costs.items) || o.costs.items.length > 100) fail(`${p}.costs.items must have at most 100 items`);
    const costIds = new Set(); let additionalQuote = 0n, foreignCost = false;
    const costs = o.costs.items.map((c, j) => {
      const cp = `${p}.costs.items[${j}]`; object(c, cp);
      const cid = str(c.id, `${cp}.id`); if (costIds.has(cid)) fail(`${p} duplicate cost id`); costIds.add(cid);
      const kind = one(c.kind, ['gas', 'fee', 'other'], `${cp}.kind`), raw = uint(c.amount_raw, `${cp}.amount_raw`);
      const currency = address(c.currency, `${cp}.currency`), included = bool(c.included_in_output, `${cp}.included_in_output`);
      if (kind === 'gas' && included) fail(`${cp} gas cannot be represented as included in an ERC-20 output`);
      if (!included && currency !== quote.address && raw !== 0n) foreignCost = true;
      if (!included && currency === quote.address) additionalQuote += raw;
      return { id: cid, kind, amount_raw: raw.toString(), currency, included_in_output: included, evidence_ref: str(c.evidence_ref, `${cp}.evidence_ref`) };
    });
    const reasons = [];
    if (status !== 'ok') reasons.push(status.toUpperCase());
    if (!canonical) reasons.push('NONCANONICAL');
    if (!identityVerified) reasons.push('IDENTITY_UNVERIFIED');
    if (asOf - blockTime > snapshotAge) reasons.push('STALE_SNAPSHOT');
    const fullCost = o.costs.coverage === 'complete' && o.fees_in_output === 'included' && !foreignCost;
    if (o.costs.coverage !== 'complete') reasons.push('COST_COVERAGE_INCOMPLETE');
    if (o.fees_in_output !== 'included') reasons.push('FEE_INCLUSION_UNKNOWN');
    if (foreignCost) reasons.push('COST_CURRENCY_UNCONVERTED');
    const assetScale = 10n ** BigInt(asset.decimals), quoteScale = 10n ** BigInt(quote.decimals);
    const observedPrice = outputRaw === null ? null : direction === 'buy' ? fraction(inputRaw * assetScale, outputRaw * quoteScale) : fraction(outputRaw * assetScale, inputRaw * quoteScale);
    let effective = null;
    if (outputRaw !== null && fullCost) {
      if (direction === 'sell' && additionalQuote >= outputRaw) reasons.push('NONPOSITIVE_NET_QUOTE_PROCEEDS');
      else effective = direction === 'buy' ? fraction((inputRaw + additionalQuote) * assetScale, outputRaw * quoteScale) : fraction((outputRaw - additionalQuote) * assetScale, inputRaw * quoteScale);
    }
    let reference = null, premium = null, shortfall = null, multiplierKey = 'not_supplied';
    if (o.reference !== undefined) {
      const r = object(o.reference, `${p}.reference`), kind = one(r.kind, ['venue_marginal', 'external_underlying', 'external_token'], `${p}.reference.kind`);
      let [n, d] = rational(r.quote_per_asset, `${p}.reference.quote_per_asset`);
      const refTime = timestamp(r.observed_at, `${p}.reference.observed_at`);
      if (refTime > blockTime) fail(`${p} reference was not available at the observation block`);
      if (blockTime - refTime > referenceAge) reasons.push('STALE_REFERENCE');
      if (kind === 'venue_marginal') {
        object(r.block, `${p}.reference.block`);
        if (r.block.number !== block.number || hash(r.block.hash, `${p}.reference.block.hash`) !== block.hash) fail(`${p} venue marginal price must share the observation block`);
        if (r.ui_multiplier !== undefined) fail(`${p} venue marginal price is already in raw token units; do not adjust twice`);
      } else if (kind === 'external_token') {
        if (r.ui_multiplier !== undefined) fail(`${p} token reference price is already adjusted; do not apply ui_multiplier twice`);
        multiplierKey = 'already_adjusted_token_price';
      } else {
        if (r.ui_multiplier === undefined) reasons.push('UNDERLYING_CONVERSION_UNKNOWN');
        else { const [mn, md] = rational(r.ui_multiplier, `${p}.reference.ui_multiplier`); n *= mn; d *= md; multiplierKey = value(fraction(mn, md)); }
      }
      reference = { kind, quote_per_raw_token: kind === 'external_underlying' && r.ui_multiplier === undefined ? null : fraction(n, d), observed_at: r.observed_at, evidence_ref: str(r.evidence_ref, `${p}.reference.evidence_ref`), ui_multiplier: r.ui_multiplier ?? null };
      if (reference.quote_per_raw_token && observedPrice && !reasons.includes('STALE_REFERENCE')) {
        // Oracle gap remains a signed premium. A sell-side discount is negative.
        if (kind !== 'venue_marginal') premium = signedDifference(observedPrice, reference.quote_per_raw_token);
        // Costs include fees and gas, so this is execution shortfall, not pure AMM impact.
        else if (effective) { const signed = signedDifference(effective, reference.quote_per_raw_token); shortfall = direction === 'buy' ? signed : fraction(-BigInt(signed.numerator), BigInt(signed.denominator)); }
      }
    }
    const key = JSON.stringify([route.id, route.identity_hash, route.configuration_hash, direction, inputRaw.toString(), evidenceKind]);
    const positionKey = JSON.stringify([key, block.number]); if (positions.has(positionKey)) fail('Duplicate curve point at the same block'); positions.add(positionKey);
    const validObservation = status === 'ok' && canonical && identityVerified && !reasons.includes('STALE_SNAPSHOT');
    const thresholdPass = validObservation && shortfall !== null && BigInt(shortfall.numerator) <= maxCost * BigInt(shortfall.denominator);
    return { id, block, observed_at: o.observed_at, route, direction, input_raw: inputRaw.toString(), output_raw: outputRaw?.toString() ?? null, status, evidence_kind: evidenceKind, evidence_refs: evidenceRefs, canonical, identity_verified: identityVerified,
      fees_in_output: o.fees_in_output, costs: { coverage: o.costs.coverage, items: costs, additional_quote_raw: additionalQuote.toString(), complete_in_quote_units: fullCost },
      observed_quote_per_raw_token: observedPrice, all_in_quote_per_raw_token: effective, reference, external_reference_premium_bps: premium, venue_execution_shortfall_bps: shortfall,
      threshold_pass: thresholdPass, reasons, comparison_eligible: validObservation, _key: key, _multiplier: multiplierKey };
  });
  const groups = new Map(); for (const row of rows) { if (!groups.has(row._key)) groups.set(row._key, []); groups.get(row._key).push(row); }
  const comparisons = [];
  for (const group of groups.values()) for (let i = 1; i < group.length; i++) {
    const a = group[i - 1], b = group[i];
    const reasons = [];
    if (!a.comparison_eligible || !b.comparison_eligible) reasons.push('OBSERVATION_UNAVAILABLE_OR_UNQUALIFIED');
    if (a._multiplier !== b._multiplier) reasons.push('UNDERLYING_DENOMINATION_CHANGED_OR_UNKNOWN');
    const eligible = reasons.length === 0;
    const netEligible = eligible && a.all_in_quote_per_raw_token && b.all_in_quote_per_raw_token;
    comparisons.push({ before: a.id, after: b.id, route_id: b.route.id, direction: b.direction, input_raw: b.input_raw, evidence_kind: b.evidence_kind,
      status: eligible ? 'COMPARABLE_RETAINED_POINTS' : 'NOT_COMPARABLE', reasons,
      output_change_bps: eligible ? fraction((BigInt(b.output_raw) - BigInt(a.output_raw)) * 10000n, BigInt(a.output_raw)) : null,
      all_in_price_change_bps: netEligible ? signedDifference(b.all_in_quote_per_raw_token, a.all_in_quote_per_raw_token) : null,
      interpretation: eligible ? 'Change at this tested input only; reserves, total capacity and cause are not inferred.' : 'No liquidity change inferred.' });
  }
  const crossRoute = [];
  const crossGroups = new Map();
  for (const r of rows) {
    const key = JSON.stringify([r.block.number, r.block.hash, r.direction, r.input_raw, r.evidence_kind, r._multiplier]);
    if (!crossGroups.has(key)) crossGroups.set(key, []); crossGroups.get(key).push(r);
  }
  for (const group of crossGroups.values()) {
    const eligible = group.filter(r => r.comparison_eligible && r.all_in_quote_per_raw_token);
    // A bounded ranking avoids quadratic cross-route pair generation.
    if (eligible.length < 2) continue;
    eligible.sort((a, b) => {
      const diff = BigInt(a.all_in_quote_per_raw_token.numerator) * BigInt(b.all_in_quote_per_raw_token.denominator) - BigInt(b.all_in_quote_per_raw_token.numerator) * BigInt(a.all_in_quote_per_raw_token.denominator);
      const sign = diff === 0n ? 0 : diff < 0n ? -1 : 1;
      return a.direction === 'buy' ? sign : -sign;
    });
    crossRoute.push({ block: eligible[0].block, direction: eligible[0].direction, input_raw: eligible[0].input_raw, evidence_kind: eligible[0].evidence_kind, ordered_observation_ids: eligible.map(r => r.id), interpretation: 'Best retained all-in price at the identical tested input and block; quote observations do not establish wallet execution.' });
  }
  const limitGroups = new Map();
  for (const row of rows) {
    if (row.reference?.kind !== 'venue_marginal') continue;
    const key = JSON.stringify([row.block.number, row.block.hash, row.route.id, row.route.identity_hash, row.route.configuration_hash, row.direction, row.evidence_kind]);
    if (!limitGroups.has(key)) limitGroups.set(key, []); limitGroups.get(key).push(row);
  }
  const tested = [...limitGroups.values()].map(group => {
    const passing = group.filter(r => r.threshold_pass).sort((a, b) => BigInt(a.input_raw) < BigInt(b.input_raw) ? -1 : BigInt(a.input_raw) > BigInt(b.input_raw) ? 1 : 0);
    return { block: group[0].block, route_id: group[0].route.id, direction: group[0].direction, evidence_kind: group[0].evidence_kind,
      max_execution_cost_bps: maxCost.toString(), largest_tested_input_passing_raw: passing.at(-1)?.input_raw ?? null,
      tested_observation_ids: group.map(r => r.id), passing_observation_ids: passing.map(r => r.id),
      interpretation: 'Largest passing tested point only. No maximum route capacity, interpolation or untested amount is established.' };
  });
  return { schema_version: 'pressure.liquidity-report.v1', evidence_mode: evidenceMode, chain_id: 4663, asset, quote_asset: quote, wallet, as_of: input.as_of,
    input_digest: digest(input), provenance: 'RETAINED_INPUT_ASSERTIONS_NOT_INDEPENDENTLY_VERIFIED',
    status: comparisons.some(c => c.status === 'COMPARABLE_RETAINED_POINTS') ? 'RETAINED_COMPARISON_AVAILABLE' : 'INSUFFICIENT_COMPARABLE_HISTORY',
    observations: rows.map(({ _key, _multiplier, ...r }) => r), comparisons, cross_route_rankings: crossRoute, tested_size_limits: tested,
    limitations: ['No live data was collected or transaction submitted.', 'Quote results, wallet-call return values and wallet-fork balance measurements remain separate evidence kinds.', 'Code, canonicality, wallet context and complete-cost assertions must be checked against retained evidence; this comparator does not authenticate them.', 'PoolManager aggregate balances are never used as an individual V4 pool inventory.', 'External reference gaps are premiums at tested sizes, not pure AMM price impact or established profit.'] };
}
