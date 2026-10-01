import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { hash, clip, cancelled } from './util.js';

const schema = (name, description, properties, required) => ({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
const string = { type: 'string' };
export const readTools = [
  schema('read_file', 'Read a UTF-8 file inside the workspace. Output may be truncated; use offset/limit to read omitted text.', { path: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } }, ['path']),
  schema('list_files', 'List entries of a workspace directory without following links.', { path: string }, ['path'])
];
export const toolSchemas = [...readTools,
  schema('write_file', 'Create or replace a UTF-8 file after approval of the exact content and existing file hash. Parent directory must exist.', { path: string, content: string }, ['path', 'content']),
  schema('shell', 'Execute a command after approval. Every shell command is reviewed. Use a bounded timeout appropriate to the command.', { command: string, cwd: string, timeout_ms: { type: 'integer', minimum: 1 }, justification: string }, ['command', 'justification']),
  schema('request_user_input', 'Ask the human for missing information or explicit authorization. This pauses unattended sessions until a human responds.', { question: string }, ['question'])
];
function validate(name, args) {
  const s = toolSchemas.find(t => t.name === name)?.parameters;
  if (!s || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown tool or invalid arguments');
  for (const key of Object.keys(args)) {
    if (!(key in s.properties)) throw new Error(`Unexpected argument ${key}`);
    const p = s.properties[key];
    if (p.type === 'string' ? typeof args[key] !== 'string' : !Number.isSafeInteger(args[key]) || args[key] < p.minimum) throw new Error(`Invalid argument ${key}`);
  }
  for (const key of s.required) if (!(key in args)) throw new Error(`Missing argument ${key}`);
}
function inside(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
export class Tools {
  constructor(workspace, config) { this.workspace = workspace; this.config = config; }
  async initialize() { this.root = await fs.realpath(this.workspace); return this; }
  async safePath(input, create = false) {
    const target = path.resolve(this.root, input);
    if (!inside(this.root, target)) throw new Error('Tool path is outside the workspace');
    let actual;
    try { actual = await fs.realpath(target); } catch (e) {
      if (!create || e.code !== 'ENOENT') throw e;
      actual = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
      // A dangling symlink is not a new file.
      try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Dangling symlink target'); } catch (e2) { if (e2.code !== 'ENOENT') throw e2; }
    }
    if (!inside(this.root, actual)) throw new Error('Symlink target is outside the workspace');
    const rel = path.relative(this.root, actual).split(path.sep);
    if (rel.some(p => ['.zcode', '.git', '.aws', '.codex', '.agents'].includes(p.toLowerCase())) || path.basename(actual).toLowerCase() === 'zcode.config.json' || actual === this.config.configPath) throw new Error('Agent access to runtime state, configuration or protected metadata is blocked');
    return actual;
  }
  async prepare(name, args) {
    validate(name, args);
    args = structuredClone(args);
    if (name === 'read_file' || name === 'list_files') return { name, args, needsApproval: false };
    if (name === 'request_user_input') return { name, args, needsApproval: false };
    let evidence;
    if (name === 'write_file') {
      const target = await this.safePath(args.path, true);
      let beforeHash = null;
      try {
        const st = await fs.stat(target);
        if (!st.isFile()) throw new Error('Write target must be a regular file');
        if (st.nlink !== 1) throw new Error('Writing hardlinked files is blocked');
        beforeHash = hash(await fs.readFile(target));
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      evidence = { target, beforeHash, contentHash: hash(args.content) };
    } else {
      const cwd = await this.safePath(args.cwd ?? '.');
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Shell cwd must be a directory');
      evidence = { cwd, shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', timeoutMs: args.timeout_ms ?? this.config.runtime.shellTimeoutMs };
    }
    const action = { name, args, workspace: this.root, evidence };
    return { ...action, needsApproval: true, fingerprint: hash(action) };
  }
  async execute(action, { signal } = {}) {
    cancelled(signal);
    const { name, args } = action;
    if (name === 'read_file') {
      const target = await this.safePath(args.path);
      const st = await fs.stat(target);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) throw new Error('Read target must be a regular file no larger than 8 MiB');
      const content = await fs.readFile(target, { encoding: 'utf8', signal });
      const offset = args.offset ?? 0, limit = Math.min(args.limit ?? this.config.runtime.maxToolOutputChars, this.config.runtime.maxToolOutputChars);
      return { path: args.path, offset, totalChars: content.length, content: content.slice(offset, offset + limit), truncated: offset + limit < content.length };
    }
    if (name === 'list_files') {
      const entries = await fs.readdir(await this.safePath(args.path), { withFileTypes: true });
      return { entries: entries.slice(0, 1000).map(e => ({ name: e.name, type: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 1000 };
    }
    // Approval is tied to the exact tool arguments and pre-execution file evidence.
    const fresh = await this.prepare(name, args);
    if (fresh.fingerprint !== action.fingerprint) throw Object.assign(new Error('Action evidence changed after review; request a fresh approval'), { executed: false });
    if (name === 'write_file') {
      await fs.writeFile(action.evidence.target, args.content, { flag: action.evidence.beforeHash === null ? 'wx' : 'w' });
      return { written: args.path, contentHash: action.evidence.contentHash };
    }
    if (name === 'shell') return this.shell(action, signal);
    throw new Error(`Tool ${name} cannot execute directly`);
  }
  shell(action, signal) {
    const { args, evidence } = action;
    const env = { ...process.env };
    for (const key of [this.config.model.apiKeyEnv, this.config.approval.model.apiKeyEnv]) if (key) delete env[key];
    const argv = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command] : ['-c', args.command];
    return new Promise((resolve, reject) => {
      const child = spawn(evidence.shell, argv, { cwd: evidence.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', truncated = false, timedOut = false;
      const max = this.config.runtime.maxToolOutputChars;
      const append = (current, chunk) => { const s = current + chunk.toString(); if (s.length > max) truncated = true; return s.slice(0, max); };
      child.stdout.on('data', d => { stdout = append(stdout, d); });
      child.stderr.on('data', d => { stderr = append(stderr, d); });
      const kill = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, evidence.timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
      signal?.addEventListener('abort', kill, { once: true });
      if (signal?.aborted) kill();
      child.on('error', e => { cleanup(); reject(e); });
      child.on('close', (code, exitSignal) => { cleanup(); resolve({ code, exitSignal, stdout: clip(stdout, max), stderr: clip(stderr, max), truncated, timedOut, cancelled: Boolean(signal?.aborted) }); });
    });
  }
}
