import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { analyzeRace, probeEndpoints } from './race.mjs';

const hash = digit => '0x' + digit.repeat(64);
function observation(source, event = 1, mono = 1000000n, overrides = {}) {
  return { schema_version: 'pulse.observation.v1', chain_id: 4663, run_id: 'run-a', clock_id: 'clock-a',
    source, stage: 'head', event_id: 'head:' + event, observed_mono_ns: String(mono),
    observed_at: '2026-09-08T14:00:00.000Z', delivery: 'live', block_number: event,
    block_hash: hash(String(event % 10)), payload: { event }, ...overrides };
}
function race(rows, options = {}) { return analyzeRace(rows, { sources: ['a', 'b'], min_matches: 1, ...options }); }
function source(group, name) { return group.sources.find(s => s.source === name); }

test('known signed pairwise lag and relative first arrival remain separate', () => {
  const report = race([observation('a', 1, 1000n), observation('b', 1, 3000n)]);
  assert.equal(report.status, 'SUFFICIENT_MATCHES');
  assert.equal(source(report.groups[0], 'a').relative_earliest_delay_ns.p50, '0');
  assert.equal(source(report.groups[0], 'b').relative_earliest_delay_ns.p50, '2000');
  assert.equal(report.groups[0].pairwise[0].a_minus_b_delay_ns.p50, '-2000');
  assert.equal(report.groups[0].pairwise[0].a_earlier, 1);
});

test('fast source with many gaps retains missing events and survivorship warning', () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(observation('b', i, BigInt(i * 1000 + 500)));
  for (let i = 1; i <= 2; i++) rows.push(observation('a', i, BigInt(i * 1000)));
  const report = race(rows), group = report.groups[0];
  assert.equal(group.observed_union_events, 10);
  assert.equal(source(group, 'a').observed_union_coverage_pct, '20');
  assert.equal(source(group, 'a').missing_observed_union_events, 8);
  assert.equal(source(group, 'a').relative_earliest_delay_ns.p50, '0');
  assert.equal(group.pairwise[0].matched_events, 2);
  assert.equal(group.pairwise[0].b_only_events, 8);
  assert.match(report.interpretation, /survivors/);
});

test('zero-event configured source stays in every union denominator', () => {
  const report = race([observation('a')], { sources: ['a', 'b', 'offline'] });
  assert.equal(report.status, 'INSUFFICIENT_MATCHES');
  assert.equal(source(report.groups[0], 'offline').seen_live_union_events, 0);
  assert.equal(source(report.groups[0], 'offline').missing_observed_union_events, 1);
  assert.equal(source(report.groups[0], 'offline').observed_union_coverage_pct, '0');
  assert.equal(report.groups[0].pairwise.length, 3);
});

test('empty run retains configured zero-event source totals', () => {
  const report = race([]);
  assert.deepEqual(report.sources, ['a', 'b']);
  assert.deepEqual(report.source_totals.map(s => s.valid_live_rows), [0, 0]);
  assert.equal(report.status, 'NO_COMPARABLE_DATA');
});

test('single-source events never masquerade as competitive zero-latency samples', () => {
  const report = race([observation('a', 1), observation('a', 2)]);
  const a = source(report.groups[0], 'a');
  assert.equal(a.singleton_events, 2);
  assert.equal(a.competitive_matches, 0);
  assert.equal(a.relative_earliest_delay_ns.p50, null);
});

test('minimum samples gates quantiles without hiding observed sample counts', () => {
  const report = race([observation('a'), observation('b')], { min_matches: 20 });
  assert.equal(report.status, 'INSUFFICIENT_MATCHES');
  const stats = report.groups[0].pairwise[0].a_minus_b_delay_ns;
  assert.equal(stats.sample_count, 1); assert.equal(stats.p50, null);
});

test('nearest-rank percentiles use nanosecond BigInts beyond JS safe integer', () => {
  const rows = [], base = 999999999999999999999999999n;
  for (let i = 1; i <= 100; i++) {
    rows.push(observation('a', i, base + BigInt(i * 1000)));
    rows.push(observation('b', i, base + BigInt(i * 1000 + i)));
  }
  const stats = source(race(rows).groups[0], 'b').relative_earliest_delay_ns;
  assert.equal(stats.p50, '50'); assert.equal(stats.p95, '95'); assert.equal(stats.p99, '99');
  assert.equal(stats.min, '1'); assert.equal(stats.max, '100');
});

test('ties count explicitly instead of arbitrary source winners', () => {
  const group = race([observation('a'), observation('b')]).groups[0];
  assert.equal(group.pairwise[0].ties, 1);
  assert.equal(source(group, 'a').earliest_counts.tied_earliest, 1);
  assert.equal(source(group, 'b').earliest_counts.tied_earliest, 1);
});

test('first observation is deduplicated independent of input ordering', () => {
  const rows = [observation('a', 1, 8000n), observation('b', 1, 5000n), observation('a', 1, 1000n)];
  const group = race(rows).groups[0];
  assert.equal(group.duplicate_rows, 1);
  assert.equal(group.pairwise[0].a_minus_b_delay_ns.p50, '-4000');
});

test('conflicting duplicate payload quarantines event and keeps it in union', () => {
  const rows = [observation('a'), observation('b'), observation('a', 1, 2000000n, { payload: { event: 99 } })];
  const group = race(rows).groups[0];
  assert.equal(group.observed_union_events, 1); assert.equal(group.comparable_union_events, 0);
  assert.equal(group.conflicted_events, 1); assert.equal(group.conflicting_rows, 1);
  assert.equal(source(group, 'a').unusable_conflicted_events, 1);
  assert.equal(group.pairwise[0].matched_events, 0);
});

test('same event ID with different block or optional identity conflicts', () => {
  for (const change of [{ block_hash: hash('f') }, { block_number: 2 }, { transaction_hash: hash('d') }]) {
    const group = race([observation('a'), observation('b', 1, 2000000n, change)]).groups[0];
    assert.equal(group.conflicted_events, 1);
  }
});

test('canonical JSON key ordering is harmless but payload meaning differences are not', () => {
  const a = observation('a', 1, 1000n, { payload: { x: 1, y: { z: 'a', n: 'b' } } });
  const b = observation('b', 1, 2000n, { payload: { y: { n: 'b', z: 'a' }, x: 1 } });
  assert.equal(race([a, b]).groups[0].conflicted_events, 0);
});

test('backfill and replay never win or poison live event payload', () => {
  const rows = [observation('a', 1, 5000n), observation('b', 1, 8000n),
    observation('b', 1, 1n, { delivery: 'backfill', payload: { wrong: 1 } }),
    observation('a', 1, 2n, { delivery: 'replay', payload: { wrong: 2 } })];
  const report = race(rows);
  assert.equal(report.excluded_delivery_rows, 2);
  assert.equal(report.groups[0].conflicted_events, 0);
  assert.equal(report.groups[0].pairwise[0].a_minus_b_delay_ns.p50, '-3000');
});

test('health and checkpoint markers excluded from latency and union', () => {
  const report = race([observation('a', 1, 1n, { stage: 'health', payload: { kind: 'block_complete' } }),
    observation('b', 2, 1n, { payload: { kind: 'checkpoint' } })]);
  assert.equal(report.excluded_health_rows, 2); assert.equal(report.groups.length, 0);
});

test('internal health-only source is not inferred as an RPC provider', () => {
  const rows = [observation('pulse', 1, 1n, { stage: 'health', payload: { kind: 'run_start', sources: ['a', 'b', 'offline'] } }),
    observation('pulse', 2, 2n, { stage: 'health', payload: { kind: 'run_stop' } }),
    observation('checkpoint-internal', 2, 2n, { payload: { kind: 'checkpoint' } }),
    observation('a', 1, 1000n), observation('b', 1, 2000n)];
  const report = race(rows, { sources: ['a', 'b', 'offline'] });
  assert.deepEqual(report.sources, ['a', 'b', 'offline']);
  assert.equal(report.groups[0].sources.length, 3);
  assert.equal(source(report.groups[0], 'offline').missing_observed_union_events, 1);
  assert.equal(report.excluded_health_rows, 3);
  assert.equal(report.sources.includes('pulse'), false);
  const health = analyzeRace(rows.slice(0, 3), { sources: [] });
  assert.deepEqual(health.sources, []);
  assert.deepEqual(health.source_totals, []);
});

test('feed sequence IDs never join log IDs or head stages', () => {
  const event = 'shared-looking-id';
  const rows = [observation('a', 1, 1n, { stage: 'feed', event_id: event }),
    observation('b', 1, 2n, { stage: 'log', event_id: event, transaction_hash: hash('d'), log_index: 0 })];
  const report = race(rows);
  assert.equal(report.groups.length, 2);
  assert.equal(report.groups.reduce((n, g) => n + g.competitive_events, 0), 0);
});

test('different runs and restart clocks never share latency samples', () => {
  const report = race([observation('a'), observation('b', 1, 1n, { clock_id: 'clock-after-restart' }),
    observation('b', 1, 2n, { run_id: 'new-run' })]);
  assert.equal(report.groups.length, 3);
  assert.equal(report.groups.reduce((n, g) => n + g.competitive_events, 0), 0);
});

test('a reused clock ID after reset quarantines the entire context', () => {
  const rows = [observation('a', 1, 9000n), observation('a', 2, 10n, { observed_at: '2026-09-08T14:00:01.000Z' }), observation('b', 1, 10000n)];
  const report = race(rows);
  assert.equal(report.groups.length, 0);
  assert.equal(report.quarantined_clock_contexts[0].code, 'MONOTONIC_REGRESSION_OR_WALL_CLOCK_STEP');
});

test('different collector regions cannot be hidden under one clock ID', () => {
  const report = race([observation('a', 1, 1n, { region: 'west' }), observation('b', 1, 2n, { region: 'east' })]);
  assert.equal(report.groups.length, 0);
  assert.equal(report.quarantined_clock_contexts[0].code, 'REGION_CONTEXT_CONFLICT');
});

test('mismatched or missing chain invalidates rows', () => {
  for (const chain_id of [1, '4663', undefined, true]) {
    const report = race([observation('a', 1, 1n, { chain_id })]);
    assert.equal(report.invalid_rows, 1); assert.equal(report.groups.length, 0);
  }
  assert.equal(race([observation('a', 1, 1n, { payload: { chain_id: 1 } })]).invalid_rows, 1);
});

test('malformed, impossible, or naive timestamps excluded', () => {
  for (const observed_at of ['2026-02-30T12:00:00Z', '2026-09-08T25:00:00Z', '2026-09-08T14:00:00', 'yesterday', null]) {
    assert.equal(race([observation('a', 1, 1n, { observed_at })]).invalid_rows, 1);
  }
});

test('negative, floating, or unsafe monotonic integers excluded', () => {
  for (const observed_mono_ns of ['-1', '1.5', '1e9', 1, '01', true])
    assert.equal(race([observation('a', 1, 1n, { observed_mono_ns })]).invalid_rows, 1);
});

test('nonfinite and non-JSON payloads do not crash the report', () => {
  for (const payload of [{ x: NaN }, { x: 1n }, { x: undefined }, [], null])
    assert.equal(race([observation('a', 1, 1n, { payload })]).invalid_rows, 1);
});

test('bad options and nonarray input give structured failures', () => {
  assert.equal(analyzeRace(null).status, 'INVALID_INPUT');
  assert.equal(analyzeRace([], { min_matches: 0 }).status, 'INVALID_INPUT');
  assert.equal(analyzeRace([], { sources: [1] }).status, 'INVALID_INPUT');
});

function pipelineRow(stage, mono, overrides = {}) {
  const p = { event_id: 'pipeline-event', origin_stage: 'head', context_verified: true, block_hash: hash('1'), transaction_hash: null };
  return observation('a', 1, mono, { event_id: 'pipeline-event', stage, payload: { pipeline_identity: p }, ...overrides });
}

test('pipeline durations require matching supplied context and explicit opt-in', () => {
  const rows = [pipelineRow('head', 100n), pipelineRow('state_ready', 300n), pipelineRow('candidate', 1000n), pipelineRow('simulation', 5000n)];
  assert.equal(race(rows).pipeline, null);
  const report = race(rows, { include_pipeline: true });
  assert.deepEqual(report.pipeline.summaries.map(s => s.durations_ns.p50).sort(), ['200', '4000', '700'].sort());
});

test('negative pipeline duration is excluded rather than absolute-valued', () => {
  const report = race([pipelineRow('head', 1000n), pipelineRow('state_ready', 500n)], { include_pipeline: true });
  assert.equal(report.pipeline.summaries.length, 0);
  assert.equal(report.pipeline.issues[0].code, 'NEGATIVE_PIPELINE_DURATION');
});

test('pipeline stages from different source/clock/event cannot produce durations', () => {
  const report = race([pipelineRow('head', 100n), pipelineRow('state_ready', 300n, { source: 'b' }),
    pipelineRow('candidate', 1000n, { clock_id: 'other' })], { include_pipeline: true });
  assert.equal(report.pipeline.summaries.length, 0);
});

test('unverified or mismatched pipeline context cannot produce durations', () => {
  const row = pipelineRow('state_ready', 1000n); row.payload.pipeline_identity.context_verified = false;
  const report = race([pipelineRow('head', 1n), row], { include_pipeline: true });
  assert.equal(report.pipeline.summaries.length, 0);
  assert.equal(report.pipeline.issues[0].code, 'PIPELINE_CONTEXT_UNVERIFIED');
});

test('analyzer leaves inputs unchanged and yields repeatable JSON', () => {
  const rows = [observation('a'), observation('b')], before = JSON.stringify(rows);
  assert.equal(JSON.stringify(race(rows)), JSON.stringify(race(rows)));
  assert.equal(JSON.stringify(rows), before);
});

async function mockEndpoint(handler) {
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    await handler(JSON.parse(body), res, req);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/secret-token`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
function answer(res, result) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result })); }

test('read-only probe separates RTT from reported head time and never outputs endpoint', async () => {
  const methods = [];
  const endpoint = await mockEndpoint(async (request, res) => {
    methods.push(request.method);
    if (request.method === 'eth_chainId') answer(res, '0x1237');
    else if (request.method === 'eth_blockNumber') answer(res, '0x64');
    else if (request.method === 'eth_getBlockByNumber') answer(res, { number: '0x64', hash: hash('a'), timestamp: '0x1' });
    else if (request.method === 'eth_getLogs') answer(res, []);
  });
  process.env.PULSE_TEST_RPC = endpoint.url;
  try {
    const report = await probeEndpoints({ sources: [{ name: 'test', http_env: 'PULSE_TEST_RPC' }], probe_logs: true,
      log_filter: { address: '0x' + '1'.repeat(40), topics: [hash('2')] } });
    assert.deepEqual(methods, ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs']);
    const source = report.sources[0]; assert.equal(source.chain_verified, true);
    assert.equal(source.status, 'READ_ONLY_PROBE_COMPLETE');
    assert.equal(source.rounds[0].head.propagation_latency_ns, null);
    assert.equal(source.rounds[0].head.reported_timestamp_unix_seconds, '1');
    assert.ok(BigInt(source.rounds[0].calls[0].rtt_ns) >= 0n);
    assert.equal(JSON.stringify(report).includes('secret-token'), false);
    assert.equal(JSON.stringify(report).includes('127.0.0.1'), false);
  } finally { delete process.env.PULSE_TEST_RPC; await endpoint.close(); }
});

test('wrong-chain probe stops before head or log methods', async () => {
  const methods = [];
  const endpoint = await mockEndpoint(async (request, res) => { methods.push(request.method); answer(res, '0x1'); });
  process.env.PULSE_TEST_RPC = endpoint.url;
  try {
    const report = await probeEndpoints({ sources: [{ name: 'wrong', http_env: 'PULSE_TEST_RPC' }] });
    assert.deepEqual(methods, ['eth_chainId']);
    assert.equal(report.sources[0].status, 'WRONG_CHAIN'); assert.equal(report.sources[0].chain_verified, false);
  } finally { delete process.env.PULSE_TEST_RPC; await endpoint.close(); }
});

test('remote RPC error text is never included in probe reports', async () => {
  const endpoint = await mockEndpoint(async (_request, res) => { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'super-secret-token endpoint URL here' } })); });
  process.env.PULSE_TEST_RPC = endpoint.url;
  try {
    const report = await probeEndpoints({ sources: [{ name: 'error', http_env: 'PULSE_TEST_RPC' }] });
    assert.equal(report.sources[0].rounds[0].calls[0].error_code, 'METHOD_UNAVAILABLE');
    assert.equal(JSON.stringify(report).includes('super-secret'), false);
  } finally { delete process.env.PULSE_TEST_RPC; await endpoint.close(); }
});

test('missing env source remains reported and probing is bounded', async () => {
  delete process.env.PULSE_TEST_MISSING;
  const report = await probeEndpoints({ sources: [{ name: 'missing', http_env: 'PULSE_TEST_MISSING' }] });
  assert.equal(report.sources.length, 1); assert.equal(report.sources[0].error_code, 'HTTP_ENV_MISSING');
  assert.equal((await probeEndpoints({ sources: [{ name: 'x', http_env: 'PULSE_TEST_MISSING' }], rounds: 6 })).status, 'INVALID_CONFIG');
  assert.equal((await probeEndpoints({ sources: [{ name: 'x', http_env: 'PULSE_TEST_MISSING' }], probe_logs: true })).status, 'INVALID_CONFIG');
});

test('oversized response is bounded and remote body remains private', async () => {
  const endpoint = await mockEndpoint(async (_request, res) => { res.end('secret'.repeat(2000)); });
  process.env.PULSE_TEST_RPC = endpoint.url;
  try {
    const report = await probeEndpoints({ sources: [{ name: 'large', http_env: 'PULSE_TEST_RPC' }], max_response_bytes: 1024 });
    assert.equal(report.sources[0].rounds[0].calls[0].error_code, 'RESPONSE_TOO_LARGE');
    assert.equal(JSON.stringify(report).includes('secret'), false);
  } finally { delete process.env.PULSE_TEST_RPC; await endpoint.close(); }
});
