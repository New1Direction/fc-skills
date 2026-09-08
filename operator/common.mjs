import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const VERSION = 'msk.operator.v1';
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function fail(code) { throw Object.assign(new Error(code), { code }); }
export function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_' + name);
  return value;
}
export function readJSON(file, max = 16 * 1024 * 1024) {
  if (statSync(file).size > max) fail('INPUT_BYTE_LIMIT');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function syncDirectory(dir) {
  let fd;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function atomicJSON(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file); syncDirectory(dirname(file));
}
export function paths(workspace) {
  const root = resolve(workspace);
  return { root, config: join(root, 'operator.json'), registry: join(root, 'registry.json'), db: join(root, 'watchtower.sqlite'),
    lock: join(root, 'operator.lock'), state: join(root, 'state.json'), stop: join(root, 'stop.json'), runs: join(root, 'runs'), maintenance: join(root, 'maintenance.json') };
}
export function processIdentity(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}
export function alive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; return true; }
  try {
    const raw = readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
    if (['Z','X'].includes(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0])) return false;
  } catch {}
  const identity = processIdentity(owner.pid);
  return !(identity && owner.identity && identity !== owner.identity);
}
function guarded(p, fn) {
  const guard = join(p.root, 'ownership.guard');
  let acquired = false;
  for (let i = 0; i < 50; i++) {
    try { mkdirSync(guard, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); }
  }
  if (!acquired) fail('OWNERSHIP_UPDATE_BUSY_OR_INTERRUPTED');
  // This short guard is never automatically reclaimed: that would reintroduce
  // the read-then-rename race when two processes recover a dead owner together.
  try { return fn(); } finally { rmSync(guard, { recursive: true }); }
}
export function acquire(workspace, kind = 'run') {
  const p = paths(workspace); mkdirSync(p.root, { recursive: true, mode: 0o700 });
  return guarded(p, () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(p.lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ownerFile = join(p.lock, 'owner.json');
      // An incompletely created lock needs explicit inspection; do not race its writer.
      if (!existsSync(ownerFile)) fail('INCOMPLETE_OPERATOR_LOCK');
      const prior = readJSON(ownerFile);
      if (alive(prior) || (prior.children ?? []).some(alive)) fail('OPERATOR_BUSY');
      renameSync(p.lock, p.lock + '.stale.' + randomUUID());
      continue;
    }
    const owner = { run_id: randomUUID(), pid: process.pid, identity: processIdentity(process.pid), kind, created_at: new Date().toISOString(), children: [] };
    atomicJSON(join(p.lock, 'owner.json'), owner);
    return { owner, update() { atomicJSON(join(p.lock, 'owner.json'), owner); }, release() { return guarded(p, () => {
      if (existsSync(join(p.lock, 'owner.json')) && readJSON(join(p.lock, 'owner.json')).run_id === owner.run_id) { rmSync(p.lock, { recursive: true }); syncDirectory(p.root); }
    }); } };
  }
  fail('OPERATOR_LOCK_RECOVERY_FAILED');
  });
}
export function errorCode(error) {
  const code = error?.code ?? error?.message;
  return /^[A-Z][A-Z0-9_:-]{0,100}$/.test(code ?? '') ? code : 'OPERATOR_OPERATION_FAILED';
}
export function diskBytes(file) {
  return ['', '-wal', '-shm', '-journal'].reduce((sum, suffix) => {
    try { return sum + statSync(file + suffix).size; } catch (error) { if (error.code !== 'ENOENT') throw error; return sum; }
  }, 0);
}
