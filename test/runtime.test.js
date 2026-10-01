import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/store.js';
import { ModelError, hash } from '../src/util.js';
import { config, harness, call, assistant, final, temp } from './helpers.js';
import { Tools } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { Reviewer } from '../src/reviewer.js';

test('changed file evidence after approval prevents stale execution', async t => {
  const h = await harness(t, [], []);
  await fs.writeFile(path.join(h.workspace, 'file.txt'), 'original');
  const action = await h.tools.prepare('write_file', { path: 'file.txt', content: 'replacement' });
  await fs.writeFile(path.join(h.workspace, 'file.txt'), 'changed by user');
  await assert.rejects(h.tools.execute(action), /changed after review/);
  assert.equal(await fs.readFile(path.join(h.workspace, 'file.txt'), 'utf8'), 'changed by user');
});
test('workspace escape, metadata and symlink escape are blocked', async t => {
  const h = await harness(t, [], []);
  for (const input of ['../outside.txt', '.zcode/sessions', 'zcode.config.json', '.git/config']) await assert.rejects(h.tools.prepare('write_file', { path: input, content: 'x' }));
  const outside = await temp(t); await fs.writeFile(path.join(outside, 'private.txt'), 'outside');
  try { await fs.symlink(outside, path.join(h.workspace, 'link'), 'junction'); } catch (e) { if (['EPERM', 'ENOTSUP'].includes(e.code)) { t.diagnostic('OS disallows symlink fixture'); return; } throw e; }
  await assert.rejects(h.tools.execute(await h.tools.prepare('read_file', { path: 'link/private.txt' })), /Symlink/);
});
test('invalid tool arguments do not execute and main model continues', async t => {
  const bad = call('write_file', { path: 'x', content: 'x', hidden: 'side effect' });
  const h = await harness(t, [assistant(bad), final('corrected')], []);
  assert.equal((await h.create().start('Task')).status, 'complete');
  assert.match(h.client.seen[1].messages.find(m => m.role === 'tool').content, /Unexpected argument/);
});
test('read pagination exposes truncation explicitly', async t => {
  const h = await harness(t, [], []); await fs.writeFile(path.join(h.workspace, 'big.txt'), '0123456789');
  const out = await h.tools.execute(await h.tools.prepare('read_file', { path: 'big.txt', offset: 2, limit: 3 }));
  assert.equal(out.content, '234'); assert.equal(out.truncated, true); assert.equal(out.totalChars, 10);
});
test('shell timeout kills operation and returns a tool result', async t => {
  const h = await harness(t, [], []);
  const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10';
  const output = await h.tools.execute(await h.tools.prepare('shell', { command, justification: 'Timeout fixture', timeout_ms: 50 }));
  assert.equal(output.timedOut, true);
});
test('shell strips configured model credentials from child environment', async t => {
  const h = await harness(t, [], [], { model: { apiKeyEnv: 'ZCODE_FAKE_SECRET' } });
  process.env.ZCODE_FAKE_SECRET = 'fixture-key'; t.after(() => { delete process.env.ZCODE_FAKE_SECRET; });
  const command = process.platform === 'win32' ? 'if ($env:ZCODE_FAKE_SECRET) { Write-Output present } else { Write-Output absent }' : 'if [ -n "$ZCODE_FAKE_SECRET" ]; then echo present; else echo absent; fi';
  const out = await h.tools.execute(await h.tools.prepare('shell', { command, justification: 'Environment fixture' }));
  assert.match(out.stdout, /absent/);
});
test('two runners cannot use the same session and answers cannot be overwritten', async t => {
  const h = await harness(t, [assistant(call('request_user_input', { question: 'Which report?' }))], []);
  const p = await h.create().start('Report');
  const another = new Store(h.workspace, h.store.id); await assert.rejects(another.lock(), /active runner/);
  await h.store.submit(p.pending.id, 'respond', 'A'); await assert.rejects(h.store.submit(p.pending.id, 'respond', 'B'), /EEXIST/);
});
test('session storage does not follow repository symlinks outside its workspace', async t => {
  const workspace = await temp(t), outside = await temp(t);
  try { await fs.symlink(outside, path.join(workspace, '.zcode'), 'junction'); } catch (e) { if (['EPERM', 'ENOTSUP'].includes(e.code)) { t.diagnostic('OS disallows symlink fixture'); return; } throw e; }
  await assert.rejects(new Store(workspace).lock(), /real directories/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('crash during side-effect execution requires explicit recovery and never blindly replays', async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'once.txt', content: 'once' })), final('recovered')], [], { approval: { reviewer: 'user' } });
  const p = await h.create().start('Write once');
  p.pending = null; p.queue.phase = 'executing'; p.status = 'running';
  await fs.writeFile(path.join(h.workspace, 'once.txt'), 'operation already ran'); await h.store.save(p);
  const recovery = await h.create().resume(); assert.equal(recovery.pending.kind, 'recovery');
  assert.equal(await fs.readFile(path.join(h.workspace, 'once.txt'), 'utf8'), 'operation already ran');
  await h.store.submit(recovery.pending.id, 'skip');
  assert.equal((await h.create().resume()).status, 'complete');
  assert.equal(await fs.readFile(path.join(h.workspace, 'once.txt'), 'utf8'), 'operation already ran');
});
test('main model errors pause for repair and resume the same conversation', async t => {
  const h = await harness(t, [new ModelError('service unavailable'), final('after repair')], []);
  const p = await h.create().start('Task'); assert.equal(p.pending.kind, 'model');
  await h.store.submit(p.pending.id, 'retry'); assert.equal((await h.create().resume()).final, 'after repair');
});
test('a repaired model configuration can resume without trusting an old queued approval', async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'repaired.txt', content: 'safe' })), final('done')], [new ModelError('bad provider'), final('{"outcome":"allow"}')]);
  const p = await h.create().start('Task'); assert.equal(p.status, 'waiting_approval');
  const updated = config({ model: { model: 'repaired-model' } });
  const reviewer = new Reviewer(updated.approval, h.reviewClient, h.tools);
  const agent = new Agent({ config: updated, client: h.client, reviewer, tools: h.tools, store: h.store });
  assert.equal((await agent.resume()).status, 'complete');
  assert.equal(h.reviewClient.seen.length, 2);
  await assert.rejects(h.store.submit(p.pending.id, 'allow'), /no longer pending/);
});
test('configured turn limit checkpoints rather than losing the task', async t => {
  const h = await harness(t, [assistant(call('list_files', { path: '.' }))], [], { runtime: { maxTurns: 1 } });
  const p = await h.create().start('Task'); assert.equal(p.status, 'paused_limit'); assert.equal(p.queue, null);
});
test('long task compacts conversation while preserving user authority and task continuity', async t => {
  const h = await harness(t, [], [], { runtime: { contextMaxChars: 7000, keepRecentMessages: 4, maxToolOutputChars: 500 } });
  await fs.writeFile(path.join(h.workspace, 'data.txt'), 'evidence '.repeat(70));
  let steps = 0, summaries = 0;
  h.client.complete = async (messages, opts) => {
    assert.match(messages[0].content, /authorized human task/);
    if (++steps <= 120) return assistant(call('read_file', { path: 'data.txt' }, `read-${steps}`));
    return final('120 steps complete');
  };
  // Compaction prompt contains no human authority; verify separately in task calls.
  const complete = h.client.complete;
  h.client.complete = async (messages, opts) => !opts.tools?.length ? (summaries++, final('Read-only progress; continue inspecting data.')) : complete(messages, opts);
  const result = await h.create().start('authorized human task');
  assert.equal(result.status, 'complete'); assert.equal(result.turns, 121); assert.ok(summaries > 3);
  assert.equal(result.userMessages[0].content, 'authorized human task');
});
test('cancellation during review cannot become manual approval or denial', async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'never.txt', content: 'x' }))], []);
  const controller = new AbortController();
  h.reviewClient.complete = async () => { controller.abort(new Error('user cancel')); throw controller.signal.reason; };
  const p = await h.create({ signal: controller.signal }).start('Task');
  assert.equal(p.status, 'interrupted'); assert.equal(p.pending, null); assert.equal(p.denials.length, 0);
  await assert.rejects(fs.stat(path.join(h.workspace, 'never.txt')));
});
test('action fingerprint is stable across argument key order', () => {
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});
