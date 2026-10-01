import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './util.js';

export function sessionPath(workspace, id) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid session ID');
  return path.join(workspace, '.zcode', 'sessions', id);
}
export async function atomicJson(filename, value) {
  const tmp = `${filename}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(tmp, filename); } catch (e) { await fs.rm(tmp, { force: true }); throw e; }
}
export class Store {
  constructor(workspace, id = randomUUID()) { this.workspace = workspace; this.id = id; this.dir = sessionPath(workspace, id); }
  async lock() {
    const root = await fs.realpath(this.workspace);
    // Never place privileged session metadata through a repository-controlled link.
    let dir = root;
    for (const component of ['.zcode', 'sessions', this.id]) {
      dir = path.join(dir, component);
      try { await fs.mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Session storage must use real directories, not symlinks');
    }
    this.dir = dir;
    const filename = path.join(this.dir, 'runner.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try { this.lockHandle = await fs.open(filename, 'wx', 0o600); await this.lockHandle.writeFile(String(process.pid)); return; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const pid = Number(await fs.readFile(filename, 'utf8'));
        if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid session lock; inspect runner.lock manually');
        try { process.kill(pid, 0); } catch (check) { if (check.code === 'ESRCH') { await fs.rm(filename); continue; } throw check; }
        throw new Error('Session already has an active runner');
      }
    }
    throw new Error('Could not acquire session lock');
  }
  async unlock() { if (this.lockHandle) { await this.lockHandle.close(); this.lockHandle = null; await fs.rm(path.join(this.dir, 'runner.lock'), { force: true }); } }
  async save(state) { await atomicJson(path.join(this.dir, 'state.json'), state); }
  async load() { return JSON.parse(await fs.readFile(path.join(this.dir, 'state.json'), 'utf8')); }
  async event(type, data = {}) { await fs.appendFile(path.join(this.dir, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`, { mode: 0o600 }); }
  async answer(request) {
    try {
      const result = JSON.parse(await fs.readFile(path.join(this.dir, `answer-${request.id}.json`), 'utf8'));
      if (result.requestId !== request.id || result.fingerprint !== request.fingerprint || !['allow', 'deny', 'respond', 'retry', 'skip'].includes(result.decision)) throw new Error('Human answer does not match the pending request');
      return result;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async submit(requestId, decision, text = '') {
    const state = await this.load();
    const p = state.pending;
    if (!p || p.id !== requestId) throw new Error('Request is no longer pending');
    const allowed = p.kind === 'approval' ? ['allow', 'deny'] : ['question', 'guidance'].includes(p.kind) ? ['respond'] : p.kind === 'recovery' ? ['retry', 'skip'] : ['retry'];
    if (!allowed.includes(decision)) throw new Error(`This request accepts: ${allowed.join(', ')}`);
    const value = { requestId, fingerprint: p.fingerprint, decision, text, at: new Date().toISOString() };
    // Exclusive creation: a later process cannot overwrite a human's decision.
    await fs.writeFile(path.join(this.dir, `answer-${requestId}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  }
  makePending(kind, data) { return { id: randomUUID(), kind, ...data, fingerprint: data.fingerprint ?? hash({ kind, ...data }) }; }
  async override(denialId, reason) {
    if (!reason?.trim()) throw new Error('Explicit risk-informed approval text is required');
    const state = await this.load();
    const denial = state.denials.slice(-10).find(d => d.id === denialId);
    if (!denial) throw new Error('Select one of the 10 most recent denial IDs from status');
    state.overrides ??= [];
    state.overrides.push({ fingerprint: denial.action.fingerprint, denialId, reason, used: false });
    // This is a narrow human marker. It cannot grant direct execution or change policy.
    if (state.pending?.kind === 'guidance') state.pending = null;
    state.breakerTripped = false;
    state.reviewHistory = []; state.consecutiveDenials = 0;
    await this.save(state);
  }
}
