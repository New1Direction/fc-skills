import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { normalizeConfig, probe } from '../skills/watchtower/scripts/capture.mjs';
import { normalizePolicy } from '../skills/watchtower/scripts/workers.mjs';
import { PoolEngine, MANAGER, TOPICS } from '../skills/pulse/scripts/pools.mjs';
import { atomicJSON, digest, fail, integer, paths, readJSON, VERSION } from './common.mjs';

export function validateRegistry(input) {
  if (!input || !Array.isArray(input.pools) || input.pools.length > 64) fail('REGISTRY_REQUIRES_AT_MOST_64_POOLS');
  new PoolEngine(input);
  const normalized = structuredClone(input);
  normalized.manager = normalized.manager.toLowerCase();
  normalized.pools = normalized.pools.map(pool => ({ ...pool, ...Object.fromEntries(['pool_id','currency0','currency1','hooks'].map(k => [k,pool[k].toLowerCase()])) }));
  return normalized;
}
export function policyFor(registry) {
  const fingerprint = digest(registry).slice(0, 24);
  return normalizePolicy({ version: 'operator-' + fingerprint, rules: registry.pools.flatMap((pool, i) =>
    Object.entries(TOPICS).map(([event, topic]) => ({ id: `pool-${i}-${event}`, skill: 'undertow',
      target: { chain_id: 4663, contract_address: MANAGER, pool_id: pool.pool_id.toLowerCase() },
      match: { log_address: MANAGER, topic0: topic, topic1: pool.pool_id.toLowerCase() } }))) });
}
export function loadConfig(workspace) {
  const p = paths(workspace), value = readJSON(p.config), registry = validateRegistry(readJSON(p.registry));
  if (value.schema !== VERSION || value.chain_id !== 4663 || !['live', 'synthetic'].includes(value.evidence_mode)) fail('INVALID_OPERATOR_CONFIG');
  if (Object.keys(value).some(k => !['schema', 'chain_id', 'evidence_mode', 'capture', 'limits', 'created_at'].includes(k))) fail('UNKNOWN_OPERATOR_CONFIG_FIELD');
  const limits = { max_result_bytes: 2 * 1024 * 1024, max_logs_per_block: 10000, minimum_free_bytes: 128 * 1024 * 1024,
    stop_at_storage_ratio: 0.9, drain_seconds: 15, source_stale_seconds: 30, heartbeat_ms: 1000, max_runs: 256, ...value.limits };
  if (Object.keys(value.limits ?? {}).some(k => !['max_result_bytes','max_logs_per_block','minimum_free_bytes','stop_at_storage_ratio','drain_seconds','source_stale_seconds','heartbeat_ms','max_runs'].includes(k))) fail('UNKNOWN_OPERATOR_LIMIT');
  for (const [key, min, max] of [['max_result_bytes', 4096, 16777216], ['max_logs_per_block', 1, 10000], ['minimum_free_bytes', 0, Number.MAX_SAFE_INTEGER], ['drain_seconds', 1, 60], ['source_stale_seconds', 1, 3600], ['heartbeat_ms', 100, 10000], ['max_runs', 1, 10000]]) integer(limits[key], key.toUpperCase(), min, max);
  if (!(limits.stop_at_storage_ratio >= 0.5 && limits.stop_at_storage_ratio <= 0.95)) fail('INVALID_STORAGE_STOP_RATIO');
  const capture = normalizeConfig({ ...value.capture, chain_id: 4663, worker_policy: policyFor(registry) });
  for (const [key, min, max] of [['poll_ms',10,60000],['request_timeout_ms',100,30000],['block_concurrency',1,64],['receipt_concurrency',1,64],['max_blocks_per_round',1,2048],['reorg_depth',1,10000],['max_response_bytes',1024,67108864],['max_pending_receipt_blocks',1,4096]]) integer(capture[key], key.toUpperCase(), min, max);
  if (capture.max_requests_per_second > 1000) fail('REQUEST_RATE_LIMIT');
  integer(capture.max_db_bytes, 'MAX_DB_BYTES', 1024 * 1024);
  const fingerprint = digest({ schema: VERSION, evidence_mode: value.evidence_mode, registry,
    decoder_sha256: digest(readFileSync(new URL('../skills/pulse/scripts/pools.mjs', import.meta.url))) });
  return { ...value, limits, capture, registry, fingerprint, paths: p };
}
export async function initialize(workspace, { fromBlock, registryFile, evidenceMode = 'live', httpEnv = 'MSK_PRIMARY_HTTP', maxBytes = 2 * 1024 ** 3, rpc } = {}) {
  const p = paths(workspace);
  if (existsSync(p.root)) fail('WORKSPACE_MUST_BE_NEW');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(httpEnv)) fail('INVALID_ENDPOINT_ENV');
  if (!['live', 'synthetic'].includes(evidenceMode)) fail('INVALID_EVIDENCE_MODE');
  const registry = registryFile ? validateRegistry(readJSON(registryFile)) : { chain_id: 4663, manager: MANAGER, pools: [], routes: [] };
  if (evidenceMode === 'live' && registry.evidence_mode === 'synthetic') fail('SYNTHETIC_REGISTRY_FOR_LIVE_RUN');
  const capture = { chain_id: 4663, sources: [{ name: 'primary', http_env: httpEnv }], primary_source: 'primary', from_block: 0,
    poll_ms: 250, request_timeout_ms: 5000, block_concurrency: 4, receipt_concurrency: 4, max_blocks_per_round: 32,
    reorg_depth: 128, max_response_bytes: 33554432, max_requests_per_second: 10, max_pending_receipt_blocks: 256,
    duration_seconds: 0, max_db_bytes: integer(maxBytes, 'MAX_DB_BYTES', 1024 * 1024) };
  if (fromBlock === 'latest') {
    const result = await probe(capture, { rpc });
    const primary = result.sources.find(s => s.name === 'primary');
    if (primary?.state !== 'available' || primary.full_blocks !== 'observed_supported' || primary.syncing !== false) fail('LIVE_START_BLOCK_UNAVAILABLE');
    capture.from_block = primary.head_number;
  } else capture.from_block = integer(fromBlock, 'EXPLICIT_FROM_BLOCK');
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  atomicJSON(p.registry, registry);
  atomicJSON(p.config, { schema: VERSION, chain_id: 4663, evidence_mode: evidenceMode, capture, limits: {}, created_at: new Date().toISOString() });
  return { schema: 'msk.operator.init.v1', workspace: p.root, from_block: capture.from_block, research_pools: registry.pools.length, source_env: httpEnv };
}
