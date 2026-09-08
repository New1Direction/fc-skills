import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, statfsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { acquire, atomicJSON, digest, fail, integer, paths, readJSON, syncDirectory } from './common.mjs';
import { loadConfig } from './config.mjs';
import { persistedConfig, readDB } from './status.mjs';

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function fileSync(file) { const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function snapshotBoundary(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('SNAPSHOT_INTEGRITY_FAILED');
    const config = db.prepare('SELECT * FROM wt_config WHERE id=1').get();
    if (config?.chain_id !== 4663) fail('SNAPSHOT_CHAIN_MISMATCH');
    return { logical_id: db.prepare('SELECT logical_id FROM op_database WHERE id=1').get().logical_id, config, progress: db.prepare('SELECT * FROM wt_progress WHERE id=1').get(),
      event_head: db.prepare('SELECT coalesce(max(seq),0) AS n FROM wt_events').get().n,
      outbox_head: db.prepare('SELECT coalesce(max(seq),0) AS n FROM wt_outbox').get().n,
      consumer: db.prepare('SELECT fingerprint,cursor FROM op_consumer WHERE id=1').get(),
      policies: db.prepare('SELECT version,fingerprint,cursor FROM wt_policies ORDER BY version').all(),
      head: db.prepare('SELECT number,hash,parent_hash FROM wt_blocks WHERE canonical=1 ORDER BY number DESC LIMIT 1').get() ?? null,
      retained_blocks: db.prepare('SELECT count(*) AS n FROM wt_blocks').get().n,
      results: db.prepare('SELECT status,count(*) AS count FROM op_results GROUP BY status ORDER BY status').all() };
  } finally { db.close(); }
}
const allowedFile = name => ['watchtower.sqlite', 'operator.json', 'registry.json', 'state.json'].includes(name) || /^runs\/[0-9a-f-]{36}\/(run|capture|capture-start|workers|consumer)\.json$/.test(name);

async function exportUnlocked(config, destination, { timeoutMs = 60000 } = {}) {
  const p = config.paths, out = resolve(destination);
  if (!existsSync(p.db)) fail('DATABASE_NOT_FOUND');
  if (existsSync(out)) fail('EXPORT_DESTINATION_MUST_BE_NEW');
  if (!relative(p.root, out).startsWith('..')) fail('EXPORT_MUST_BE_OUTSIDE_WORKSPACE');
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  const fs = statfsSync(dirname(out), { bigint: true });
  if (fs.bavail * fs.bsize < BigInt(statSync(p.db).size) + BigInt(config.limits.minimum_free_bytes)) fail('EXPORT_SPACE_UNAVAILABLE');
  const staging = out + '.partial.' + randomUUID(); mkdirSync(staging, { mode: 0o700 });
  const source = new DatabaseSync(p.db, { readOnly: true });
  const start = performance.now();
  try {
    await backup(source, join(staging, 'watchtower.sqlite'), { rate: 128, progress() { if (performance.now() - start > timeoutMs) fail('EXPORT_TIME_LIMIT'); } });
  } finally { source.close(); }
  const snapshot = join(staging, 'watchtower.sqlite'); chmodSync(snapshot, 0o600);
  // Seal a standalone file with no WAL dependency before hashing or acknowledging it.
  const sealed = new DatabaseSync(snapshot);
  try { sealed.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;'); } finally { sealed.close(); }
  const boundary = snapshotBoundary(snapshot);
  const operator = readJSON(p.config); operator.capture.max_db_bytes = boundary.config.max_bytes;
  atomicJSON(join(staging, 'operator.json'), operator);
  atomicJSON(join(staging, 'registry.json'), readJSON(p.registry));
  const names = ['watchtower.sqlite', 'operator.json', 'registry.json'];
  if (existsSync(p.state)) { atomicJSON(join(staging, 'state.json'), readJSON(p.state)); names.push('state.json'); }
  if (existsSync(p.runs)) for (const dir of readdirSync(p.runs, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^[0-9a-f-]{36}$/.test(dir.name)) fail('UNEXPECTED_RUN_ARCHIVE');
    for (const file of readdirSync(join(p.runs, dir.name))) {
      const name = 'runs/' + dir.name + '/' + file;
      if (!allowedFile(name)) fail('UNEXPECTED_RUN_ARCHIVE');
      atomicJSON(join(staging, name), readJSON(join(p.root, name))); names.push(name);
    }
  }
  const files = [];
  for (const name of names.sort()) { fileSync(join(staging, name)); files.push({ path: name, bytes: statSync(join(staging, name)).size, sha256: await hashFile(join(staging, name)) }); }
  const manifest = { schema: 'msk.operator.export.v1', id: randomUUID(), created_at: new Date().toISOString(), evidence_mode: config.evidence_mode,
    boundary, files, state: 'LOCAL_SNAPSHOT_VERIFIED', source_retained: true,
    notes: ['Snapshot integrity does not establish complete chain history or provider authenticity.', 'Export does not reclaim source space or prove off-host retention.', 'Future source reorgs can retract previously exported research.'] };
  atomicJSON(join(staging, 'manifest.json'), manifest); syncDirectory(staging);
  await verifyExport(staging);
  renameSync(staging, out); syncDirectory(dirname(out));
  return { ...manifest, directory: out, manifest_sha256: digest(manifest) };
}
export async function exportWorkspace(workspace, out, options) {
  const config = persistedConfig(loadConfig(workspace)), lock = acquire(workspace, 'export');
  try { return await exportUnlocked(config, out, options); } finally { lock.release(); }
}
export async function verifyExport(directory) {
  const dir = resolve(directory), manifest = readJSON(join(dir, 'manifest.json'));
  if (manifest.schema !== 'msk.operator.export.v1' || !/^[0-9a-f-]{36}$/.test(manifest.id) || !Array.isArray(manifest.files) || manifest.files.length > 50004) fail('INVALID_EXPORT_MANIFEST');
  const seen = new Set();
  for (const item of manifest.files) {
    if (!allowedFile(item.path) || seen.has(item.path)) fail('INVALID_EXPORT_PATH');
    seen.add(item.path);
    const file = join(dir, item.path);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || statSync(file).size !== item.bytes || await hashFile(file) !== item.sha256) fail('EXPORT_DIGEST_MISMATCH');
  }
  if (!['watchtower.sqlite', 'operator.json', 'registry.json'].every(file => seen.has(file))) fail('INCOMPLETE_EXPORT');
  for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(join(dir, 'watchtower.sqlite' + suffix))) fail('UNSEALED_EXPORT_DATABASE');
  const boundary = snapshotBoundary(join(dir, 'watchtower.sqlite'));
  if (digest(boundary) !== digest(manifest.boundary)) fail('EXPORT_BOUNDARY_MISMATCH');
  const config = loadConfig(dir);
  if (config.capture.from_block !== boundary.config.start_block || config.capture.reorg_depth !== boundary.config.reorg_depth || config.fingerprint !== boundary.consumer.fingerprint || config.capture.max_db_bytes !== boundary.config.max_bytes) fail('EXPORT_CONFIG_MISMATCH');
  return { ...manifest, directory: dir, manifest_sha256: digest(manifest), verified: true };
}
export async function acknowledgeExport(workspace, directory, { sha256, owner } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$/.test(owner)) fail('ACK_REQUIRES_DIGEST_AND_RETENTION_OWNER');
  const lock = acquire(workspace, 'acknowledgement');
  try {
    const verified = await verifyExport(directory);
    if (verified.manifest_sha256 !== sha256) fail('ACK_DIGEST_MISMATCH');
    const config = loadConfig(workspace);
    const logicalId = readDB(config.paths.db, db => db.prepare('SELECT logical_id FROM op_database WHERE id=1').get().logical_id);
    if (verified.boundary.logical_id !== logicalId || verified.boundary.consumer.fingerprint !== config.fingerprint || verified.boundary.config.start_block !== config.capture.from_block) fail('ACK_WORKSPACE_MISMATCH');
    const receipt = { schema: 'msk.operator.export-ack.v1', export_id: verified.id, manifest_sha256: sha256, owner,
      state: 'OPERATOR_ATTESTED_RETENTION_ACKNOWLEDGEMENT', acknowledged_at: new Date().toISOString(),
      off_host_durability_independently_verified: false, source_pruned: false };
    atomicJSON(join(config.paths.root, 'export-acknowledgements', verified.id + '.json'), receipt);
    return receipt;
  } finally { lock.release(); }
}
export async function restoreExport(directory, destination) {
  const verified = await verifyExport(directory), out = resolve(destination);
  if (existsSync(out)) fail('RESTORE_DESTINATION_MUST_BE_NEW');
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  const fs = statfsSync(dirname(out), { bigint: true });
  const required = verified.files.reduce((sum, f) => sum + BigInt(f.bytes), 0n);
  if (fs.bavail * fs.bsize < required + 128n * 1024n ** 2n) fail('RESTORE_SPACE_UNAVAILABLE');
  const { copyFile } = await import('node:fs/promises');
  const stage = out + '.partial.' + randomUUID(); mkdirSync(stage, { mode: 0o700 });
  for (const item of verified.files) {
    const file = join(stage, item.path); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    await copyFile(join(verified.directory, item.path), file); chmodSync(file, 0o600); fileSync(file);
    if (await hashFile(file) !== item.sha256) fail('RESTORE_DIGEST_MISMATCH');
  }
  atomicJSON(join(stage, 'restored-from.json'), { export_id: verified.id, manifest_sha256: verified.manifest_sha256, restored_at: new Date().toISOString(), original_retained: true });
  syncDirectory(stage); renameSync(stage, out); syncDirectory(dirname(out));
  return { schema: 'msk.operator.restore.v1', workspace: out, boundary: verified.boundary, original_retained: true, services_started: false };
}
export async function resizeWorkspace(workspace, newBytes, snapshotDirectory) {
  const config = persistedConfig(loadConfig(workspace)), lock = acquire(workspace, 'resize');
  try {
    newBytes = integer(newBytes, 'MAX_DB_BYTES', config.capture.max_db_bytes + 1);
    const fs = statfsSync(config.paths.root, { bigint: true });
    if (fs.bavail * fs.bsize < BigInt(newBytes - config.capture.max_db_bytes) + BigInt(config.limits.minimum_free_bytes)) fail('CAPACITY_NOT_AVAILABLE_ON_FILESYSTEM');
    const snapshot = await exportUnlocked(config, snapshotDirectory);
    const remaining = statfsSync(config.paths.root, { bigint: true });
    if (remaining.bavail * remaining.bsize < BigInt(newBytes - config.capture.max_db_bytes) + BigInt(config.limits.minimum_free_bytes)) fail('CAPACITY_NOT_AVAILABLE_AFTER_SNAPSHOT');
    const db = new DatabaseSync(config.paths.db);
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      const old = db.prepare('SELECT max_bytes FROM wt_config WHERE id=1').get().max_bytes;
      if (old !== config.capture.max_db_bytes) fail('CAPACITY_CHANGED_DURING_MAINTENANCE');
      db.prepare('UPDATE wt_config SET max_bytes=? WHERE id=1').run(newBytes);
      db.exec('COMMIT;');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
    const original = readJSON(config.paths.config); original.capture.max_db_bytes = newBytes; atomicJSON(config.paths.config, original);
    const receipt = { schema: 'msk.operator.capacity-change.v1', old_max_bytes: config.capture.max_db_bytes, new_max_bytes: newBytes,
      snapshot_id: snapshot.id, snapshot_manifest_sha256: snapshot.manifest_sha256, changed_at: new Date().toISOString(), source_pruned: false };
    atomicJSON(join(config.paths.root, 'last-capacity-change.json'), receipt);
    return receipt;
  } finally { lock.release(); }
}
