#!/usr/bin/env node
/** Read-only arrival comparison. All times and event identities are supplied. */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const STAGES = new Set(['head', 'log', 'feed', 'state_ready', 'candidate', 'simulation', 'health']);
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NS = /^(0|[1-9][0-9]*)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_ROWS = 100000;

function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function label(value, maximum = 256) { return typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= maximum; }
function issue(code, index, detail) { return { code, ...(index === undefined ? {} : { index }), detail }; }
function bigintString(value) { return typeof value === 'string' && value.length <= 100 && NS.test(value); }
function integral(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (bigintString(value)) return value;
  throw new Error('INTEGER_REQUIRED');
}
function hex(value) { if (typeof value !== 'string' || !HASH.test(value)) throw new Error('HASH_REQUIRED'); return value.toLowerCase(); }
function timestamp(value) {
  if (typeof value !== 'string' || !ISO.test(value)) throw new Error('TIMESTAMP_REQUIRED');
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error('TIMESTAMP_REQUIRED');
  // Date.parse normalizes impossible dates such as February 30; reject them.
  const datePart = value.slice(0, 10), [year, month, day] = datePart.split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day)
    throw new Error('TIMESTAMP_REQUIRED');
  const time = value.slice(11, 19).split(':').map(Number);
  if (time[0] > 23 || time[1] > 59 || time[2] > 59) throw new Error('TIMESTAMP_REQUIRED');
  return millis;
}
function canonical(value, depth = 0) {
  if (depth > 24) throw new Error('PAYLOAD_TOO_DEEP');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('NONFINITE_PAYLOAD'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']';
  if (object(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('JSON_PAYLOAD_REQUIRED');
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
  }
  throw new Error('JSON_PAYLOAD_REQUIRED');
}
function fixedRatio(numerator, denominator, places = 6) {
  if (denominator === 0) return null;
  const scaled = BigInt(numerator) * (10n ** BigInt(places)) / BigInt(denominator);
  const whole = scaled / (10n ** BigInt(places));
  const fraction = (scaled % (10n ** BigInt(places))).toString().padStart(places, '0').replace(/0+$/, '');
  return whole.toString() + (fraction ? '.' + fraction : '');
}
function nsMilliseconds(nanos) {
  const value = BigInt(nanos), sign = value < 0n ? '-' : '', abs = value < 0n ? -value : value;
  const fraction = (abs % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return sign + (abs / 1000000n).toString() + (fraction ? '.' + fraction : '');
}
function distribution(values, minimum) {
  const result = { sample_count: values.length, status: values.length >= minimum ? 'SUFFICIENT_MATCHES' : 'INSUFFICIENT_MATCHES',
    quantile_method: 'nearest_rank', unit: 'nanoseconds', min: null, p50: null, p95: null, p99: null, max: null };
  if (values.length < minimum) return result;
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  result.min = sorted[0].toString(); result.max = sorted.at(-1).toString();
  for (const [key, percentile] of [['p50', 50], ['p95', 95], ['p99', 99]])
    result[key] = sorted[Math.ceil(sorted.length * percentile / 100) - 1].toString();
  return result;
}

function validateObservation(value, index) {
  if (!object(value) || value.schema_version !== 'pulse.observation.v1') throw new Error('OBSERVATION_SCHEMA');
  if (value.chain_id !== 4663) throw new Error('CHAIN_MISMATCH');
  for (const field of ['run_id', 'clock_id', 'source', 'event_id']) if (!label(value[field], field === 'event_id' ? 1024 : 256)) throw new Error('IDENTITY_REQUIRED');
  if (!STAGES.has(value.stage)) throw new Error('STAGE_INVALID');
  if (!['live', 'backfill', 'replay'].includes(value.delivery)) throw new Error('DELIVERY_INVALID');
  if (!bigintString(value.observed_mono_ns)) throw new Error('MONOTONIC_TIMESTAMP_INVALID');
  if (!object(value.payload)) throw new Error('PAYLOAD_OBJECT_REQUIRED');
  if (own(value.payload, 'chain_id') && value.payload.chain_id !== 4663) throw new Error('CHAIN_MISMATCH');
  const wall = timestamp(value.observed_at);
  const identity = {};
  for (const field of ['block_number', 'log_index']) if (own(value, field)) identity[field] = integral(value[field]);
  for (const field of ['block_hash', 'transaction_hash']) if (own(value, field)) identity[field] = hex(value[field]);
  if (value.stage === 'head' && (!identity.block_number || !identity.block_hash)) throw new Error('HEAD_IDENTITY_REQUIRED');
  if (value.stage === 'log' && ['block_number', 'block_hash', 'transaction_hash', 'log_index'].some(k => !own(identity, k)))
    throw new Error('LOG_IDENTITY_REQUIRED');
  // Feed IDs are opaque, scoped to the feed stage. Never parse them as transactions.
  const region = own(value, 'region') ? value.region : (own(value.payload, 'collector_region') ? value.payload.collector_region : null);
  if (region !== null && !label(region)) throw new Error('REGION_INVALID');
  return { ...value, index, wall, mono: BigInt(value.observed_mono_ns), identity, region,
    fingerprint: canonical({ identity, payload: value.payload }) };
}

function pipelineDurations(rows, excludedContexts, minimum) {
  const groups = new Map(), issues = [];
  for (const row of rows) {
    if (row.delivery !== 'live' || row.stage === 'health' || excludedContexts.has(canonical([row.run_id, row.clock_id]))) continue;
    const p = row.payload.pipeline_identity;
    if (!object(p)) continue;
    if (p.context_verified !== true || p.event_id !== row.event_id || !['head', 'log', 'feed'].includes(p.origin_stage)) {
      issues.push(issue('PIPELINE_CONTEXT_UNVERIFIED', row.index, 'Pipeline durations require explicit matching event identity and context verification.')); continue;
    }
    if (p.block_hash !== (row.identity.block_hash ?? null) || (p.transaction_hash ?? null) !== (row.identity.transaction_hash ?? null)) {
      issues.push(issue('PIPELINE_CONTEXT_MISMATCH', row.index, 'Pipeline identity does not match the observation block/transaction context.')); continue;
    }
    if (![p.origin_stage, 'state_ready', 'candidate', 'simulation'].includes(row.stage)) continue;
    const key = canonical([row.run_id, row.clock_id, row.source, row.event_id, p]);
    if (!groups.has(key)) groups.set(key, { run_id: row.run_id, clock_id: row.clock_id, source: row.source, event_id: row.event_id, identity: p, stages: new Map(), conflicts: false });
    const group = groups.get(key), old = group.stages.get(row.stage);
    if (old && old.fingerprint !== row.fingerprint) group.conflicts = true;
    if (!old || row.mono < old.mono) group.stages.set(row.stage, row);
  }
  const summaries = new Map();
  for (const group of groups.values()) {
    if (group.conflicts) { issues.push(issue('PIPELINE_PAYLOAD_CONFLICT', undefined, 'Conflicting duplicate pipeline evidence excluded.')); continue; }
    const order = [group.identity.origin_stage, 'state_ready', 'candidate', 'simulation'];
    let negative = false;
    for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) {
      const first = group.stages.get(order[a]), last = group.stages.get(order[b]);
      if (first && last && last.mono < first.mono) negative = true;
    }
    if (negative) { issues.push(issue('NEGATIVE_PIPELINE_DURATION', undefined, 'Stage order contradicts monotonic arrival times; event durations excluded.')); continue; }
    for (let i = 0; i < order.length - 1; i++) {
      const first = group.stages.get(order[i]), last = group.stages.get(order[i + 1]);
      if (!first || !last) continue;
      const key = canonical([group.run_id, group.clock_id, group.source, order[i], order[i + 1]]);
      if (!summaries.has(key)) summaries.set(key, { run_id: group.run_id, clock_id: group.clock_id, source: group.source, from_stage: order[i], to_stage: order[i + 1], values: [] });
      summaries.get(key).values.push(last.mono - first.mono);
    }
  }
  return { verification: 'Pipeline identity and context_verified are supplied assertions, not independently established by this analyzer.',
    summaries: [...summaries.values()].sort((a, b) => canonical([a.run_id, a.clock_id, a.source, a.from_stage, a.to_stage]).localeCompare(canonical([b.run_id, b.clock_id, b.source, b.from_stage, b.to_stage]))).map(({ values, ...rest }) => ({ ...rest, durations_ns: distribution(values, minimum) })), issues };
}

/** Compare first LIVE arrivals only, separately for every run/clock/stage. */
export function analyzeRace(observations, options = {}) {
  const report = { schema_version: 'pulse.race.report.v1', chain_id: 4663, status: 'NO_COMPARABLE_DATA',
    sources: [], source_totals: [], groups: [], issues: [], input_rows: Array.isArray(observations) ? observations.length : 0,
    valid_live_rows: 0, invalid_rows: 0, excluded_delivery_rows: 0, excluded_health_rows: 0,
    quarantined_clock_contexts: [], pipeline: null,
    scope: 'Relative first-arrival measurements within supplied run/clock/stage contexts. No cross-clock or cross-region ranking.',
    denominator: 'The union of observed live event IDs, not the true chain event universe or a chain-loss estimate.',
    interpretation: 'A fast source with gaps can look best among survivors. Read missing-event counts beside delays. No speed, fill, execution, or profitability guarantee.' };
  if (!Array.isArray(observations) || observations.length > MAX_ROWS || !object(options)) {
    report.status = 'INVALID_INPUT'; report.issues.push(issue('INPUT_INVALID', undefined, 'Provide an array of at most 100000 observations and an options object.')); return report;
  }
  const sources = options.sources ?? [], minimum = options.min_matches ?? 20;
  if (!Array.isArray(sources) || sources.length > 64 || sources.some(s => !label(s)) || !Number.isSafeInteger(minimum) || minimum < 1 || minimum > MAX_ROWS || (own(options, 'include_pipeline') && typeof options.include_pipeline !== 'boolean')) {
    report.status = 'INVALID_INPUT'; report.issues.push(issue('OPTIONS_INVALID', undefined, 'sources must be at most 64 names; min_matches is an integer 1–100000; include_pipeline is boolean.')); return report;
  }
  report.min_matches = minimum;
  const sourceNames = new Set(sources), rows = [];
  for (let index = 0; index < observations.length; index++) {
    const value = observations[index];
    const healthOnly = object(value) && (value.stage === 'health' ||
      (object(value.payload) && ['checkpoint', 'block_complete', 'coverage_checkpoint'].includes(value.payload.kind)));
    // Internal collector health names are not providers. Expected providers with
    // no live events must come from explicit options.sources (e.g. run_start).
    if (object(value) && label(value.source) && !healthOnly) sourceNames.add(value.source);
    if (sourceNames.size > 64) { report.status = 'INVALID_INPUT'; report.issues.push(issue('SOURCE_LIMIT', index, 'At most 64 distinct sources are supported.')); return report; }
    try {
      const row = validateObservation(value, index);
      if (row.stage === 'health' || ['checkpoint', 'block_complete', 'coverage_checkpoint'].includes(row.payload.kind)) { report.excluded_health_rows++; continue; }
      if (row.delivery !== 'live') { report.excluded_delivery_rows++; continue; }
      rows.push(row);
    } catch (error) {
      report.invalid_rows++; report.issues.push(issue(error.message, index, 'Observation excluded; event, chain, time, and finite JSON fields must satisfy pulse.observation.v1.'));
    }
  }
  report.sources = [...sourceNames].sort(); report.valid_live_rows = rows.length;
  report.source_totals = report.sources.map(source => ({ source,
    input_rows: observations.filter(row => object(row) && row.source === source).length,
    valid_live_rows: rows.filter(row => row.source === source).length,
    competitive_matches: 0, missing_observed_union_events: 0 }));
  const contexts = new Map(), quarantined = new Set();
  for (const row of rows) {
    const key = canonical([row.run_id, row.clock_id]);
    if (!contexts.has(key)) contexts.set(key, { run_id: row.run_id, clock_id: row.clock_id, rows: [], regions: new Set() });
    const context = contexts.get(key); context.rows.push(row); if (row.region !== null) context.regions.add(row.region);
  }
  for (const [key, context] of contexts) {
    let code = context.regions.size > 1 ? 'REGION_CONTEXT_CONFLICT' : null;
    const perSource = new Map();
    for (const row of context.rows) { if (!perSource.has(row.source)) perSource.set(row.source, []); perSource.get(row.source).push(row); }
    for (const sourceRows of perSource.values()) {
      const sorted = [...sourceRows].sort((a, b) => a.wall - b.wall || (a.mono < b.mono ? -1 : a.mono > b.mono ? 1 : 0));
      let priorWall = -Infinity, priorMax = -1n;
      for (const row of sorted) {
        if (row.wall > priorWall && row.mono < priorMax) code = code ?? 'MONOTONIC_REGRESSION_OR_WALL_CLOCK_STEP';
        priorWall = row.wall; if (row.mono > priorMax) priorMax = row.mono;
      }
    }
    if (code) {
      quarantined.add(key); report.quarantined_clock_contexts.push({ run_id: context.run_id, clock_id: context.clock_id, code, excluded_rows: context.rows.length });
    }
  }
  const partitions = new Map();
  for (const row of rows) {
    if (quarantined.has(canonical([row.run_id, row.clock_id]))) continue;
    const key = canonical([row.run_id, row.clock_id, row.stage]);
    if (!partitions.has(key)) partitions.set(key, { run_id: row.run_id, clock_id: row.clock_id, stage: row.stage, events: new Map(), duplicate_rows: 0, conflicting_rows: 0 });
    const partition = partitions.get(key);
    if (!partition.events.has(row.event_id)) partition.events.set(row.event_id, { event_id: row.event_id, fingerprint: row.fingerprint, conflict: false, first: new Map() });
    const event = partition.events.get(row.event_id), old = event.first.get(row.source);
    if (event.fingerprint !== row.fingerprint) { event.conflict = true; partition.conflicting_rows++; }
    if (old) partition.duplicate_rows++;
    if (!old || row.mono < old.mono) event.first.set(row.source, row);
  }
  for (const partition of [...partitions.values()].sort((a, b) => canonical([a.run_id, a.clock_id, a.stage]).localeCompare(canonical([b.run_id, b.clock_id, b.stage])))) {
    const all = [...partition.events.values()], usable = all.filter(e => !e.conflict), contested = usable.filter(e => e.first.size > 1);
    const group = { run_id: partition.run_id, clock_id: partition.clock_id, stage: partition.stage,
      observed_union_events: all.length, comparable_union_events: usable.length, competitive_events: contested.length,
      conflicted_events: all.length - usable.length, conflicting_rows: partition.conflicting_rows, duplicate_rows: partition.duplicate_rows,
      sources: [], pairwise: [], conflicted_event_ids: all.filter(e => e.conflict).map(e => e.event_id).sort() };
    for (const source of report.sources) {
      const seen = all.filter(e => e.first.has(source)).length, usableSeen = usable.filter(e => e.first.has(source)).length;
      const delays = [], wins = { sole_earliest: 0, tied_earliest: 0, not_earliest: 0 };
      for (const event of contested) {
        const mine = event.first.get(source); if (!mine) continue;
        const times = [...event.first.values()].map(r => r.mono), earliest = times.reduce((a, b) => a < b ? a : b);
        delays.push(mine.mono - earliest);
        if (mine.mono === earliest) wins[times.filter(t => t === earliest).length === 1 ? 'sole_earliest' : 'tied_earliest']++;
        else wins.not_earliest++;
      }
      group.sources.push({ source, seen_live_union_events: seen, usable_live_events: usableSeen,
        missing_observed_union_events: all.length - seen, unusable_conflicted_events: seen - usableSeen,
        observed_union_coverage_pct: fixedRatio(seen * 100, all.length),
        singleton_events: usable.filter(e => e.first.size === 1 && e.first.has(source)).length,
        competitive_matches: delays.length, earliest_counts: wins,
        relative_earliest_delay_ns: distribution(delays, minimum) });
    }
    for (let i = 0; i < report.sources.length; i++) for (let j = i + 1; j < report.sources.length; j++) {
      const a = report.sources[i], b = report.sources[j], delays = [];
      let aOnly = 0, bOnly = 0, neither = 0, aFirst = 0, bFirst = 0, ties = 0;
      for (const event of usable) {
        const left = event.first.get(a), right = event.first.get(b);
        if (!left && !right) { neither++; continue; }
        if (!right) { aOnly++; continue; } if (!left) { bOnly++; continue; }
        const delay = left.mono - right.mono; delays.push(delay);
        if (delay < 0n) aFirst++; else if (delay > 0n) bFirst++; else ties++;
      }
      group.pairwise.push({ source_a: a, source_b: b, matched_events: delays.length,
        a_only_events: aOnly, b_only_events: bOnly, neither_events: neither, excluded_conflicted_events: group.conflicted_events,
        a_earlier: aFirst, b_earlier: bFirst, ties,
        a_minus_b_delay_ns: distribution(delays, minimum),
        sign: 'Negative means A arrived earlier. These samples exclude events missing at either source.' });
    }
    group.status = group.sources.length < 2 || group.sources.some(s => s.competitive_matches < minimum) ? 'INSUFFICIENT_MATCHES' : 'SUFFICIENT_MATCHES';
    report.groups.push(group);
  }
  for (const source of report.source_totals) for (const group of report.groups) {
    const inGroup = group.sources.find(s => s.source === source.source);
    source.competitive_matches += inGroup.competitive_matches;
    source.missing_observed_union_events += inGroup.missing_observed_union_events;
  }
  if (options.include_pipeline === true) report.pipeline = pipelineDurations(rows, quarantined, minimum);
  if (report.groups.length) report.status = report.groups.every(g => g.status === 'SUFFICIENT_MATCHES') ? 'SUFFICIENT_MATCHES' : 'INSUFFICIENT_MATCHES';
  return report;
}

async function boundedBody(response, maximum) {
  if (!response.body) throw new Error('EMPTY_RESPONSE');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE'); } chunks.push(value); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

async function rpcProbe(url, method, params, timeout, maximum) {
  const start = process.hrtime.bigint();
  const result = { method, status: 'ERROR', rtt_ns: null, rtt_ms: null };
  let data;
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    result.http_status = response.status;
    if (!response.ok) { result.error_code = 'HTTP_ERROR'; await response.body?.cancel(); }
    else {
      const body = await boundedBody(response, maximum);
      try { data = JSON.parse(body); } catch { throw new Error('INVALID_JSON_RESPONSE'); }
      if (!object(data) || data.jsonrpc !== '2.0' || data.id !== 1 || (own(data, 'result') === own(data, 'error'))) throw new Error('RPC_ENVELOPE_INVALID');
      if (own(data, 'error')) {
        result.error_code = data.error?.code === -32601 ? 'METHOD_UNAVAILABLE' : 'RPC_ERROR';
        if (Number.isSafeInteger(data.error?.code)) result.rpc_error_code = data.error.code;
      } else { result.status = 'RESPONSE_RECEIVED'; result.value = data.result; }
    }
  } catch (error) {
    const allowed = new Set(['RESPONSE_TOO_LARGE', 'EMPTY_RESPONSE', 'INVALID_JSON_RESPONSE', 'RPC_ENVELOPE_INVALID']);
    result.error_code = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'TIMEOUT' : allowed.has(error.message) ? error.message : 'NETWORK_ERROR';
  }
  const elapsed = process.hrtime.bigint() - start; result.rtt_ns = elapsed.toString(); result.rtt_ms = nsMilliseconds(elapsed);
  return result;
}

function rpcQuantity(value) { if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error('RPC_QUANTITY_INVALID'); return BigInt(value); }

/** Bounded read-only HTTP diagnostics. Endpoint values and remote error bodies never leave this function. */
export async function probeEndpoints(config) {
  const output = { schema_version: 'pulse.rpc.probe.v1', chain_id: 4663, status: 'INVALID_CONFIG', sources: [], issues: [],
    interpretation: 'HTTP round-trip time measures request/response latency. Head timestamps are reported separately and do not establish propagation freshness or feed lead.' };
  if (!object(config) || !Array.isArray(config.sources) || config.sources.length < 1 || config.sources.length > 8) { output.issues.push({ code: 'SOURCES_CONFIG_INVALID' }); return output; }
  const timeout = config.timeout_ms ?? 3000, rounds = config.rounds ?? 1, maximum = config.max_response_bytes ?? 1048576;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10000 || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5 || !Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 4194304 || (own(config, 'probe_logs') && typeof config.probe_logs !== 'boolean')) {
    output.issues.push({ code: 'PROBE_BOUNDS_INVALID' }); return output;
  }
  const names = new Set();
  for (const source of config.sources) {
    if (!object(source) || !label(source.name) || names.has(source.name) || typeof source.http_env !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(source.http_env)) {
      output.issues.push({ code: 'SOURCE_CONFIG_INVALID' }); return output;
    }
    names.add(source.name);
  }
  let filter;
  if (config.probe_logs === true) {
    const raw = config.log_filter;
    if (!object(raw) || typeof raw.address !== 'string' || !ADDRESS.test(raw.address) || !Array.isArray(raw.topics) || raw.topics.length > 4 || raw.topics.some(t => t !== null && (typeof t !== 'string' || !HASH.test(t)))) {
      output.issues.push({ code: 'SCOPED_LOG_FILTER_REQUIRED' }); return output;
    }
    filter = { address: raw.address, topics: raw.topics };
  }
  output.timeout_ms = timeout; output.rounds = rounds; output.max_response_bytes = maximum;
  output.sources = await Promise.all(config.sources.map(async source => {
    const result = { source: source.name, http_env: source.http_env, status: 'UNAVAILABLE', chain_verified: false, rounds: [] };
    let endpoint;
    try {
      if (!process.env[source.http_env]) { result.error_code = 'HTTP_ENV_MISSING'; return result; }
      endpoint = new URL(process.env[source.http_env]);
      if (!['https:', 'http:'].includes(endpoint.protocol)) { result.error_code = 'HTTP_PROTOCOL_REQUIRED'; return result; }
    } catch { result.error_code = 'HTTP_ENDPOINT_INVALID'; return result; }
    for (let n = 0; n < rounds; n++) {
      const round = { index: n + 1, observed_at: new Date().toISOString(), calls: [], head: null };
      result.rounds.push(round);
      const chain = await rpcProbe(endpoint, 'eth_chainId', [], timeout, maximum); const chainValue = chain.value; delete chain.value; round.calls.push(chain);
      try {
        if (chain.status !== 'RESPONSE_RECEIVED') throw new Error('CHAIN_UNAVAILABLE');
        if (rpcQuantity(chainValue) !== 4663n) { result.status = 'WRONG_CHAIN'; result.chain_verified = false; result.error_code = 'CHAIN_MISMATCH'; return result; }
        chain.status = 'SUPPORTED'; result.chain_verified = true;
      } catch { result.status = 'UNAVAILABLE'; result.chain_verified = false; result.error_code = 'CHAIN_UNAVAILABLE_OR_INVALID'; return result; }
      const number = await rpcProbe(endpoint, 'eth_blockNumber', [], timeout, maximum); const numberValue = number.value; delete number.value; round.calls.push(number);
      let head;
      try { if (number.status !== 'RESPONSE_RECEIVED') throw new Error(); head = rpcQuantity(numberValue); number.status = 'SUPPORTED'; }
      catch { result.error_code = 'HEAD_NUMBER_UNAVAILABLE_OR_INVALID'; continue; }
      const block = await rpcProbe(endpoint, 'eth_getBlockByNumber', [numberValue, false], timeout, maximum); const blockValue = block.value; delete block.value; round.calls.push(block);
      try {
        if (block.status !== 'RESPONSE_RECEIVED' || !object(blockValue) || rpcQuantity(blockValue.number) !== head) throw new Error();
        const hash = hex(blockValue.hash), seconds = rpcQuantity(blockValue.timestamp), nowSeconds = BigInt(Math.floor(Date.now() / 1000));
        block.status = 'SUPPORTED'; round.head = { block_number: head.toString(), block_hash: hash, reported_timestamp_unix_seconds: seconds.toString(),
          observed_wall_unix_seconds: nowSeconds.toString(), wall_minus_reported_head_seconds: (nowSeconds - seconds).toString(),
          timestamp_ahead_of_collector: seconds > nowSeconds, propagation_latency_ns: null };
      } catch { result.error_code = 'HEAD_BLOCK_UNAVAILABLE_OR_INVALID'; continue; }
      if (filter) {
        const logs = await rpcProbe(endpoint, 'eth_getLogs', [{ ...filter, blockHash: round.head.block_hash }], timeout, maximum);
        const logsValue = logs.value; delete logs.value; round.calls.push(logs);
        if (logs.status === 'RESPONSE_RECEIVED' && Array.isArray(logsValue)) {
          if (logsValue.every(log => object(log) && typeof log.blockHash === 'string' && log.blockHash.toLowerCase() === round.head.block_hash)) {
            logs.status = 'SUPPORTED'; logs.returned_log_count = logsValue.length;
            logs.coverage = 'Provider response only; an empty response does not establish independent completeness.';
          } else { logs.status = 'ERROR'; logs.error_code = 'LOG_BLOCK_MISMATCH'; }
        } else if (logs.status === 'RESPONSE_RECEIVED') { logs.status = 'ERROR'; logs.error_code = 'LOG_RESPONSE_INVALID'; }
      }
      result.status = 'READ_ONLY_PROBE_COMPLETE';
    }
    return result;
  }));
  output.status = 'PROBE_COMPLETE'; return output;
}

async function main() {
  const args = process.argv.slice(2), flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--input', '--output', '--options', '--probe-config'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: race.mjs --input observations.json --output report.json [--options options.json], or --probe-config config.json --output report.json');
    flags.set(args[i], args[i + 1]);
  }
  if (!flags.has('--output') || flags.has('--input') === flags.has('--probe-config')) throw new Error('Supply one input or probe-config and an output.');
  const result = flags.has('--probe-config') ? await probeEndpoints(JSON.parse(await readFile(flags.get('--probe-config'), 'utf8'))) :
    analyzeRace(JSON.parse(await readFile(flags.get('--input'), 'utf8')), flags.has('--options') ? JSON.parse(await readFile(flags.get('--options'), 'utf8')) : {});
  await writeFile(flags.get('--output'), JSON.stringify(result, null, 2) + '\n');
  if (['INVALID_INPUT', 'INVALID_CONFIG'].includes(result.status)) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write('PULSE race command failed: ' + (error.code ?? 'INVALID_INPUT_OR_IO') + '\n'); process.exitCode = 2; });
