import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';
import { Tools } from '../src/tools.js';
import { Store } from '../src/store.js';
import { Agent } from '../src/agent.js';
import { Reviewer } from '../src/reviewer.js';

export const call = (name, args, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
export const assistant = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls });
export const final = content => ({ role: 'assistant', content });
export const state = () => ({ messages: [{ role: 'user', content: 'Make a local report' }], userMessages: [{ role: 'user', content: 'Make a local report' }], denials: [], summary: '' });
export const config = (raw = {}) => resolveConfig({ ...raw, model: { model: 'test-model', apiKeyEnv: '', maxAttempts: 1, ...raw.model } }, {});
export async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
export class Scripted {
  constructor(replies, cfg = { model: 'test-model' }) { this.replies = [...replies]; this.seen = []; this.config = cfg; }
  async complete(messages, options) {
    this.seen.push({ messages: structuredClone(messages), options });
    const item = this.replies.shift();
    if (item instanceof Error) throw item;
    if (typeof item === 'function') return item(messages, options);
    if (!item) throw new Error('Scripted model exhausted');
    return item;
  }
}
export async function harness(t, replies, reviews = [final('{"outcome":"allow"}')], raw = {}) {
  const workspace = await temp(t), cfg = config(raw);
  const tools = await new Tools(workspace, cfg).initialize();
  const store = new Store(workspace); await store.lock(); t.after(() => store.unlock());
  const client = new Scripted(replies), reviewClient = new Scripted(reviews), events = [];
  const reviewer = new Reviewer(cfg.approval, reviewClient, tools);
  const create = extra => new Agent({ config: cfg, client, reviewer, tools, store, notify: e => events.push(e), ...extra });
  return { workspace, cfg, client, reviewClient, reviewer, tools, store, events, create };
}
