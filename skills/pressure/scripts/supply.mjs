// PRESSURE: exact, bounded accounting over a retained ERC-20 observation window.
// No RPC, signing, token-price assumptions, or fungible-unit provenance inference.
export const ZERO = '0x0000000000000000000000000000000000000000';
export const V4_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const MULTIPLIER_SCALE = 10n ** 18n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const CATEGORIES = ['issuer', 'venue', 'custody', 'treasury', 'locker', 'burn', 'unknown'];
const fail = message => { throw new TypeError(`Invalid PRESSURE dataset: ${message}`); };
const lower = value => value.toLowerCase();
function obj(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`); }
function arr(value, path, max) { if (!Array.isArray(value) || value.length > max) fail(`${path} must be an array of at most ${max} rows`); }
function int(value, path) { if (!Number.isSafeInteger(value) || value < 0) fail(`${path} must be a nonnegative safe integer`); }
function address(value, path) { if (typeof value !== 'string' || !ADDRESS.test(value)) fail(`${path} must be a 20-byte address`); }
function hash(value, path) { if (typeof value !== 'string' || !HASH.test(value)) fail(`${path} must be a 32-byte hash`); }
function uint(value, path) { if (typeof value !== 'string' || value.length > 78 || !UINT.test(value) || BigInt(value) > UINT256_MAX) fail(`${path} must be a canonical uint256 decimal string`); }
function refs(value, path, requireOne = false) {
  arr(value, path, 10000);
  if ((requireOne && value.length === 0) || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 2048)) fail(`${path} needs nonempty evidence reference strings`);
}
function point(value, path) { obj(value, path); int(value.number, `${path}.number`); hash(value.hash, `${path}.hash`); int(value.timestamp, `${path}.timestamp`); }
function balanceMap(snapshot) { return new Map(snapshot.balances.map(x => [lower(x.address), BigInt(x.balance_raw)])); }
function eventOrder(a, b) { return a.block_number - b.block_number || a.transaction_index - b.transaction_index || a.log_index - b.log_index; }
function eventRef(data, event) { return `${data.chain_id}:${lower(data.token.address)}:${lower(event.block_hash)}:${lower(event.transaction_hash)}:${event.log_index}`; }

/** Validate representation and internal identity. Accounting mismatches remain reportable findings. */
export function validateDataset(data) {
  obj(data, 'root');
  if (data.schema_version !== 'pressure.dataset.v1') fail('schema_version must be pressure.dataset.v1');
  if (!['rpc_observed', 'retained', 'synthetic'].includes(data.evidence_mode)) fail('unknown evidence_mode');
  if (data.chain_id !== 4663) fail('chain_id must be 4663');
  obj(data.token, 'token'); address(data.token.address, 'token.address');
  if (lower(data.token.address) === ZERO) fail('token cannot be the zero address');
  int(data.token.decimals, 'token.decimals');
  if (data.token.decimals > 36) fail('token.decimals exceeds supported maximum 36');
  hash(data.token.expected_code_hash, 'token.expected_code_hash');
  obj(data.window, 'window'); point(data.window.start, 'window.start'); point(data.window.end, 'window.end');
  const start = data.window.start.number, end = data.window.end.number;
  if (end < start || end - start > 100000) fail('window must have 0..100000 elapsed blocks');
  if (data.window.end.timestamp < data.window.start.timestamp) fail('window timestamps run backward');
  obj(data.snapshots, 'snapshots');
  for (const side of ['start', 'end']) {
    const snap = data.snapshots[side]; obj(snap, `snapshots.${side}`);
    uint(snap.total_supply_raw, `${side}.total_supply_raw`); uint(snap.multiplier_raw, `${side}.multiplier_raw`);
    if (BigInt(snap.multiplier_raw) === 0n) fail(`${side}.multiplier_raw must be positive`);
    hash(snap.code_hash, `${side}.code_hash`); arr(snap.balances, `${side}.balances`, 10000);
    const seen = new Set();
    for (const row of snap.balances) {
      obj(row, `${side}.balance`); address(row.address, `${side}.balance.address`); uint(row.balance_raw, `${side}.balance_raw`);
      const key = lower(row.address);
      if (key === ZERO || seen.has(key)) fail(`${side}.balances has zero or duplicate address`);
      seen.add(key);
    }
  }
  const startAddresses = [...balanceMap(data.snapshots.start).keys()].sort();
  const endAddresses = [...balanceMap(data.snapshots.end).keys()].sort();
  if (JSON.stringify(startAddresses) !== JSON.stringify(endAddresses)) fail('start/end tracked balance address sets differ');
  arr(data.headers, 'headers', 100001);
  const headers = new Map(), headerHashes = new Set();
  for (let i = 0; i < data.headers.length; i++) {
    const h = data.headers[i]; point(h, `headers[${i}]`); hash(h.parent_hash, 'header.parent_hash');
    if (h.number < start || h.number > end || headers.has(h.number) || headerHashes.has(lower(h.hash))) fail('duplicate or out-of-window header');
    if (i && data.headers[i - 1].number >= h.number) fail('headers must be ordered');
    const prior = headers.get(h.number - 1);
    if (prior && (lower(h.parent_hash) !== lower(prior.hash) || h.timestamp < prior.timestamp)) fail('header parent chain or timestamps disagree');
    headers.set(h.number, h); headerHashes.add(lower(h.hash));
  }
  for (const endpoint of [data.window.start, data.window.end]) {
    const observed = headers.get(endpoint.number);
    if (!observed || lower(observed.hash) !== lower(endpoint.hash) || observed.timestamp !== endpoint.timestamp) fail('window endpoint is not supported by matching header');
  }
  obj(data.coverage, 'coverage');
  if (!['full_receipts', 'log_query', 'supplied'].includes(data.coverage.method)) fail('unknown coverage method');
  if (typeof data.coverage.complete !== 'boolean' || typeof data.coverage.canonical_rechecked !== 'boolean') fail('coverage complete/canonical_rechecked must be booleans');
  refs(data.coverage.evidence_refs, 'coverage.evidence_refs', true);
  arr(data.coverage.missing_blocks, 'coverage.missing_blocks', 100000);
  const missing = new Set();
  for (const n of data.coverage.missing_blocks) {
    int(n, 'coverage missing block');
    if (n <= start || n > end || missing.has(n)) fail('duplicate or out-of-window missing block');
    missing.add(n);
  }
  if (data.coverage.complete && (missing.size || data.headers.length !== end - start + 1)) fail('complete coverage cannot omit blocks or headers');
  arr(data.transfers, 'transfers', 200000);
  const seenEvents = new Set(), txPositions = new Map(), blockPositions = new Map();
  let previous = null;
  for (const t of data.transfers) {
    obj(t, 'transfer'); int(t.block_number, 'transfer.block_number'); hash(t.block_hash, 'transfer.block_hash');
    hash(t.transaction_hash, 'transfer.transaction_hash'); int(t.transaction_index, 'transfer.transaction_index'); int(t.log_index, 'transfer.log_index');
    address(t.from, 'transfer.from'); address(t.to, 'transfer.to'); uint(t.amount_raw, 'transfer.amount_raw');
    if (t.block_number <= start || t.block_number > end) fail('transfer must occur in (start,end]');
    if (lower(t.from) === ZERO && lower(t.to) === ZERO) fail('zero-to-zero transfer has ambiguous issuance semantics');
    const h = headers.get(t.block_number);
    if (!h || lower(h.hash) !== lower(t.block_hash)) fail('transfer lacks its canonical matching header');
    if (previous && (eventOrder(previous, t) >= 0 || (previous.block_number === t.block_number && previous.log_index >= t.log_index))) fail('transfers are duplicate or not in canonical log order');
    previous = t;
    const eventKey = `${lower(t.block_hash)}:${t.log_index}`;
    if (seenEvents.has(eventKey)) fail('duplicate event identity'); seenEvents.add(eventKey);
    const txKey = lower(t.transaction_hash), position = `${t.block_number}:${t.transaction_index}`;
    if (txPositions.has(txKey) && txPositions.get(txKey) !== position) fail('transaction hash occurs at inconsistent positions');
    if (blockPositions.has(position) && blockPositions.get(position) !== txKey) fail('different transactions claim the same block position');
    txPositions.set(txKey, position); blockPositions.set(position, txKey);
  }
  arr(data.attributions, 'attributions', 20000);
  const labels = new Map();
  for (const a of data.attributions) {
    obj(a, 'attribution'); address(a.address, 'attribution.address');
    if (!CATEGORIES.includes(a.category)) fail('unknown attribution category');
    if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > 256) fail('attribution label must be 1..256 characters');
    int(a.valid_from_block, 'attribution.valid_from_block'); int(a.valid_to_block, 'attribution.valid_to_block');
    if (a.valid_to_block < a.valid_from_block) fail('attribution validity runs backward');
    refs(a.evidence_refs, 'attribution.evidence_refs', true);
    const key = lower(a.address), windows = labels.get(key) || [];
    if (windows.some(b => a.valid_from_block <= b.valid_to_block && b.valid_from_block <= a.valid_to_block)) fail('overlapping attribution intervals for one address');
    windows.push(a); labels.set(key, windows);
  }
  return data;
}

function gcd(a, b) { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a; }
function rational(n, d) { const g = gcd(n, d); return { numerator: (n / g).toString(), denominator: (d / g).toString() }; }
function attributionIndex(data) {
  const index = new Map();
  for (const row of data.attributions) { const key = lower(row.address); if (!index.has(key)) index.set(key, []); index.get(key).push(row); }
  return (addr, block) => {
    const a = (index.get(lower(addr)) || []).find(x => x.valid_from_block <= block && block <= x.valid_to_block);
    return a ? { category: a.category, label: a.label, evidence_refs: a.evidence_refs, valid_from_block: a.valid_from_block, valid_to_block: a.valid_to_block } : { category: 'unknown', label: null, evidence_refs: [] };
  };
}
function destinationKey(addr, a) { return `${addr}:${a.category}:${a.label || ''}:${a.valid_from_block ?? ''}:${a.valid_to_block ?? ''}`; }
function balanceDistribution(snapshot, block, attribute) {
  const buckets = Object.fromEntries(CATEGORIES.map(category => [category, { category, balance_raw: 0n, addresses: [] }]));
  let measured = 0n;
  for (const row of snapshot.balances) {
    const amount = BigInt(row.balance_raw), key = lower(row.address), label = attribute(key, block);
    measured += amount; buckets[label.category].balance_raw += amount;
    buckets[label.category].addresses.push({ address: key, balance_raw: amount.toString(), attribution: label, scope: key === V4_MANAGER ? 'v4_manager_aggregate_not_pool_inventory' : 'address_balance' });
  }
  return {
    total_supply_raw: snapshot.total_supply_raw,
    measured_address_balances_raw: measured.toString(),
    unmeasured_address_balances_raw: BigInt(snapshot.total_supply_raw) >= measured ? (BigInt(snapshot.total_supply_raw) - measured).toString() : null,
    buckets: Object.values(buckets).map(row => ({ ...row, balance_raw: row.balance_raw.toString(), addresses: row.addresses.sort((a, b) => a.address.localeCompare(b.address)) })),
    interpretation: 'Disjoint measured address balances and a residual of unmeasured balances. Neither is a free-float or executable-liquidity estimate.'
  };
}

/** Reconcile supplied evidence without upgrading its completeness or authenticity. */
export function analyzeSupply(input) {
  const data = validateDataset(input), start = data.snapshots.start, end = data.snapshots.end;
  const supply0 = BigInt(start.total_supply_raw), supply1 = BigInt(end.total_supply_raw);
  const multiplier0 = BigInt(start.multiplier_raw), multiplier1 = BigInt(end.multiplier_raw);
  const attribute = attributionIndex(data), b0 = balanceMap(start), b1 = balanceMap(end);
  const flows = new Map([...b0].map(([address, balance]) => [address, { address, start_balance_raw: balance, incoming_raw: 0n, outgoing_raw: 0n, mint_incoming_raw: 0n, burn_outgoing_raw: 0n, self_transfer_raw: 0n, evidence_refs: [] }]));
  const recipients = new Map(); let minted = 0n, burned = 0n, zeroEvents = 0;
  const directDestinations = new Map();
  for (const t of data.transfers) {
    const from = lower(t.from), to = lower(t.to), amount = BigInt(t.amount_raw), ref = eventRef(data, t);
    if (amount === 0n) { zeroEvents++; continue; }
    if (from === ZERO) {
      minted += amount;
      if (!recipients.has(to)) recipients.set(to, { address: to, minted_to_address_raw: 0n, first_mint: t, mint_evidence_refs: [], subsequent_outgoing_raw: 0n, subsequent_destinations: new Map() });
      const r = recipients.get(to); r.minted_to_address_raw += amount; r.mint_evidence_refs.push(ref);
      const a = attribute(to, t.block_number), key = destinationKey(to, a);
      if (!directDestinations.has(key)) directDestinations.set(key, { address: to, attribution: a, minted_directly_raw: 0n, evidence_refs: [], scope: to === V4_MANAGER ? 'v4_manager_aggregate_not_pool_inventory' : 'address_receipt' });
      const d = directDestinations.get(key); d.minted_directly_raw += amount; d.evidence_refs.push(ref);
    }
    if (to === ZERO) burned += amount;
    for (const addr of new Set([from, to])) {
      const f = flows.get(addr); if (!f) continue;
      if (from === to) f.self_transfer_raw += amount;
      else {
        if (to === addr) { f.incoming_raw += amount; if (from === ZERO) f.mint_incoming_raw += amount; }
        if (from === addr) { f.outgoing_raw += amount; if (to === ZERO) f.burn_outgoing_raw += amount; }
      }
      f.evidence_refs.push(ref);
    }
    // This is deliberately wallet activity after first mint, not tracing minted units.
    const r = recipients.get(from);
    if (r && from !== to && eventOrder(r.first_mint, t) < 0) {
      r.subsequent_outgoing_raw += amount;
      const a = attribute(to, t.block_number), key = destinationKey(to, a);
      if (!r.subsequent_destinations.has(key)) r.subsequent_destinations.set(key, { address: to, attribution: a, observed_outgoing_raw: 0n, evidence_refs: [], scope: to === V4_MANAGER ? 'v4_manager_aggregate_not_pool_inventory' : (to === ZERO ? 'observed_burn' : 'address_receipt') });
      const d = r.subsequent_destinations.get(key); d.observed_outgoing_raw += amount; d.evidence_refs.push(ref);
    }
  }
  const expectedSupply = supply0 + minted - burned, supplyDifference = supply1 - expectedSupply;
  const balanceRows = [...flows.values()].sort((a, b) => a.address.localeCompare(b.address)).map(f => {
    const observed = b1.get(f.address), expected = f.start_balance_raw + f.incoming_raw - f.outgoing_raw;
    return { ...f, start_balance_raw: f.start_balance_raw.toString(), incoming_raw: f.incoming_raw.toString(), outgoing_raw: f.outgoing_raw.toString(), mint_incoming_raw: f.mint_incoming_raw.toString(), burn_outgoing_raw: f.burn_outgoing_raw.toString(), self_transfer_raw: f.self_transfer_raw.toString(), expected_end_balance_raw: expected.toString(), end_balance_raw: observed.toString(), net_flow_raw: (f.incoming_raw - f.outgoing_raw).toString(), reconciliation_difference_raw: (observed - expected).toString(), reconciled: observed === expected, attribution_start: attribute(f.address, data.window.start.number), attribution_end: attribute(f.address, data.window.end.number), scope: f.address === V4_MANAGER ? 'v4_manager_aggregate_not_pool_inventory' : 'address_balance' };
  });
  const dist0 = balanceDistribution(start, data.window.start.number, attribute), dist1 = balanceDistribution(end, data.window.end.number, attribute);
  const codesMatch = [start.code_hash, end.code_hash].every(x => lower(x) === lower(data.token.expected_code_hash));
  const covered = data.coverage.complete && data.coverage.canonical_rechecked && data.coverage.missing_blocks.length === 0 && data.headers.length === data.window.end.number - data.window.start.number + 1;
  const balancesMatch = balanceRows.every(x => x.reconciled) && dist0.unmeasured_address_balances_raw !== null && dist1.unmeasured_address_balances_raw !== null;
  const reconciled = supplyDifference === 0n && balancesMatch;
  const completeAccounting = codesMatch && covered && reconciled;
  const elapsed = data.window.end.number > data.window.start.number;
  const issues = [];
  if (!codesMatch) issues.push('TOKEN_CODE_IDENTITY_MISMATCH');
  if (!covered) issues.push('INCOMPLETE_OR_UNRECHECKED_COVERAGE');
  if (supplyDifference !== 0n) issues.push('SUPPLY_EVENT_RECONCILIATION_MISMATCH');
  if (!balancesMatch) issues.push('TRACKED_BALANCE_RECONCILIATION_MISMATCH');
  if (data.coverage.method !== 'full_receipts') issues.push('COMPLETENESS_DEPENDS_ON_SUPPLIED_OR_LOG_QUERY_CLAIM');
  if (data.evidence_mode === 'synthetic') issues.push('SYNTHETIC_EVIDENCE_ONLY');
  if (!elapsed) issues.push('EMPTY_OBSERVATION_WINDOW');
  const denominator = (10n ** BigInt(data.token.decimals)) * MULTIPLIER_SCALE;
  const status = !codesMatch ? 'SEMANTICS_UNVERIFIED' : !reconciled ? 'RECONCILIATION_FAILED' : !covered ? 'PARTIAL_WINDOW' : !elapsed ? 'EMPTY_WINDOW' : 'RECONCILED_WINDOW';
  return {
    schema_version: 'pressure.supply-report.v1', status, evidence_mode: data.evidence_mode, chain_id: data.chain_id, token: data.token, window: data.window,
    scope: 'Supplied ERC-20 mint/burn and address-balance evidence in (start,end]. Canonicality and receipt enumeration are provider claims, not cryptographic receipt-trie proofs.',
    coverage: { ...data.coverage, accounting_complete_for_supplied_evidence: completeAccounting, absence_claim_supported_within_supplied_evidence: completeAccounting && elapsed, evidence_authenticity: data.evidence_mode === 'synthetic' ? 'synthetic' : 'not_independently_proven' },
    supply: { start_raw: supply0.toString(), end_raw: supply1.toString(), observed_minted_raw: minted.toString(), observed_burned_raw: burned.toString(), observed_event_net_raw: (minted - burned).toString(), snapshot_supply_change_raw: (supply1 - supply0).toString(), net_issuance_raw: completeAccounting ? (minted - burned).toString() : null, expected_end_from_observed_events_raw: expectedSupply.toString(), reconciliation_difference_raw: supplyDifference.toString(), reconciled: supplyDifference === 0n, zero_amount_events: zeroEvents },
    display_adjusted_supply: { multiplier_scale: MULTIPLIER_SCALE.toString(), start_multiplier_raw: multiplier0.toString(), end_multiplier_raw: multiplier1.toString(), multiplier_changed: multiplier0 !== multiplier1, start: rational(supply0 * multiplier0, denominator), end: rational(supply1 * multiplier1, denominator), change: rational(supply1 * multiplier1 - supply0 * multiplier0, denominator), raw_supply_change_component: rational((supply1 - supply0) * (multiplier0 + multiplier1), 2n * denominator), multiplier_change_component: rational((multiplier1 - multiplier0) * (supply0 + supply1), 2n * denominator), decomposition: 'Symmetric exact arithmetic: delta(S*M) = delta(S)*(M0+M1)/2 + delta(M)*(S0+S1)/2. Multiplier changes are display-unit adjustments, not raw token mint events; their cause requires corporate-action evidence.' },
    tracked_balances: balanceRows,
    distribution: { start: dist0, end: dist1 },
    direct_mint_destinations: [...directDestinations.values()].map(d => ({ ...d, minted_directly_raw: d.minted_directly_raw.toString() })),
    mint_recipient_followup: [...recipients.values()].map(r => ({ address: r.address, minted_to_address_raw: r.minted_to_address_raw.toString(), first_mint_block: r.first_mint.block_number, mint_evidence_refs: r.mint_evidence_refs, start_balance_raw: b0.has(r.address) ? b0.get(r.address).toString() : null, observed_outgoing_after_first_mint_raw: r.subsequent_outgoing_raw.toString(), subsequent_observed_destinations: [...r.subsequent_destinations.values()].map(d => ({ ...d, observed_outgoing_raw: d.observed_outgoing_raw.toString() })), interpretation: 'Subsequent transfers are observed activity of a mint-recipient wallet. Fungibility, prior inventory, and other inflows prevent identifying those transfers as the minted units. No ownership, sale intent, or pool allocation is inferred.' })),
    issues,
    limitations: ['Code hashes alone do not resolve proxy implementations or prove unchanged token semantics; review the source and mutable dependencies.', 'Attribution labels are supplied evidence, bounded by validity intervals, and are not ownership proofs.', 'Total supply and address holdings are not wallet-specific executable liquidity.', 'A V4 manager balance aggregates multiple pools and other accounting obligations.', 'Minting and transfers to venues do not establish selling, future price direction, or profitable trading.']
  };
}
