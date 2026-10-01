import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseAssessment, Reviewer } from '../src/reviewer.js';
import { ModelError } from '../src/util.js';
import { config, harness, call, assistant, final, state, Scripted, temp } from './helpers.js';
import { Tools } from '../src/tools.js';

test('reviewer defaults to the full current model profile; override supports independent provider and reasoning', () => {
  const c = config({ model: { baseUrl: 'http://localhost:7001/v1', wireApi: 'responses', reasoningEffort: 'high' } });
  assert.deepEqual(c.approval.model, c.model);
  const other = config({ approval: { model: { model: 'review-model', baseUrl: 'http://localhost:7002/v1', apiKeyEnv: 'REVIEW_KEY', wireApi: 'chat', reasoningEffort: 'low' } } });
  assert.equal(other.approval.model.model, 'review-model'); assert.equal(other.approval.model.apiKeyEnv, 'REVIEW_KEY');
  assert.equal(other.model.model, 'test-model');
});
test('provider override cannot accidentally export main credentials', () => {
  assert.throws(() => config({ approval: { model: { baseUrl: 'https://other.example/v1' } } }), /apiKeyEnv/);
});
test('bad configuration is rejected', () => {
  for (const raw of [{ runtime: { maxTurns: -1 } }, { approval: { maxAttempts: 0 } }, { model: { wireApi: 'unknown' } }, { model: { apiKey: 'do-not-store' } }, { model: { baseUrl: 'https://user:pass@host/v1' } }]) assert.throws(() => config(raw));
});
test('bare decisions and wrapped JSON preserve Codex assessment defaults', () => {
  assert.equal(parseAssessment('{"outcome":"allow"}').risk_level, 'low');
  assert.equal(parseAssessment('```json\n{"outcome":"deny"}\n```').risk_level, 'high');
  assert.equal(parseAssessment('{"outcome":"deny"}').user_authorization, 'unknown');
});
for (const input of ['ALLOW', '{"outcome":"yes"}', '{"outcome":"allow","risk_level":"safe"}', '{"outcome":"allow","rationale":7}', '{"outcome":"allow","user_authorization":"sure"}']) test(`invalid assessment fails closed: ${input}`, () => assert.throws(() => parseAssessment(input), ModelError));

test('denial returns the rationale to main model, which continues with a safer write', async t => {
  const h = await harness(t, [assistant(call('shell', { command: 'dangerous-operation', justification: 'I want it' })), assistant(call('write_file', { path: 'report.txt', content: 'safe alternative' }, 'safe')), final('done')], [final('{"outcome":"deny","rationale":"Broad destruction is not authorized"}'), final('{"outcome":"allow"}')]);
  const result = await h.create().start('Create a report');
  assert.equal(result.status, 'complete');
  assert.equal(await fs.readFile(path.join(h.workspace, 'report.txt'), 'utf8'), 'safe alternative');
  const returned = JSON.parse(h.client.seen[1].messages.find(m => m.role === 'tool').content);
  assert.equal(returned.executed, false); assert.match(returned.rationale, /not authorized/); assert.match(returned.instructions, /materially safer/);
  assert.equal(h.reviewClient.seen.length, 2);
});
test('one denied call does not cancel unrelated calls in the same batch', async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'denied.txt', content: 'blocked' }, 'deny'), call('write_file', { path: 'allowed.txt', content: 'allowed' }, 'allow')), final('done')], [final('{"outcome":"deny"}'), final('{"outcome":"allow"}')]);
  const result = await h.create().start('Create report');
  assert.equal(result.status, 'complete');
  await assert.rejects(fs.stat(path.join(h.workspace, 'denied.txt')));
  assert.equal(await fs.readFile(path.join(h.workspace, 'allowed.txt'), 'utf8'), 'allowed');
});
for (const error of [new ModelError('Review timed out', { code: 'timeout' }), new ModelError('Bad credentials', { code: 'credentials' }), new ModelError('Invalid JSON', { code: 'parse', retryable: true })]) test(`technical review failure pauses for human and never executes: ${error.code}`, async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'pending.txt', content: 'human approved' })), final('done')], [error], { approval: { maxAttempts: 1 } });
  const paused = await h.create().start('Write a report');
  assert.equal(paused.status, 'waiting_approval'); assert.match(paused.pending.reason, /not a policy denial/);
  assert.equal(paused.denials.length, 0);
  await assert.rejects(fs.stat(path.join(h.workspace, 'pending.txt')));
  const id = paused.pending.id;
  await assert.rejects(h.store.submit('wrong-request', 'allow'), /no longer pending/);
  await h.store.submit(id, 'allow', 'Approve exactly this local report write');
  const resumed = await h.create().resume();
  assert.equal(resumed.status, 'complete'); assert.equal(await fs.readFile(path.join(h.workspace, 'pending.txt'), 'utf8'), 'human approved');
});
test('human denial after review failure continues to main model', async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'no.txt', content: 'no' })), final('I will choose a safer path')], [new ModelError('timeout', { code: 'timeout' })]);
  const p = await h.create().start('Report'); await h.store.submit(p.pending.id, 'deny', 'Do not write');
  const result = await h.create().resume(); assert.equal(result.status, 'complete');
  assert.equal(JSON.parse(h.client.seen[1].messages.find(m => m.role === 'tool').content).source, 'user');
});
test('manual approval mode does not invoke review model', async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'manual.txt', content: 'x' })), final('done')], [], { approval: { reviewer: 'user' } });
  const p = await h.create().start('Write'); assert.equal(p.status, 'waiting_approval'); assert.equal(h.reviewClient.seen.length, 0);
});
test('review input budget never truncates the action into an automatic approval', async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'big.txt', content: 'x'.repeat(1000) }))], [], { approval: { inputMaxChars: 100 } });
  const p = await h.create().start('Write'); assert.equal(p.status, 'waiting_approval'); assert.match(p.pending.reason, /input_budget/); assert.equal(h.reviewClient.seen.length, 0);
});
test('reviewer read-only investigation works and never sees hidden reasoning', async t => {
  const workspace = await temp(t), cfg = config(), tools = await new Tools(workspace, cfg).initialize();
  await fs.writeFile(path.join(workspace, 'evidence.txt'), 'a bounded report');
  const client = new Scripted([assistant(call('read_file', { path: 'evidence.txt' })), final('{"outcome":"allow"}')]);
  const s = state(); s.messages.push({ role: 'assistant', content: 'inspect', reasoning_content: 'PRIVATE REASONING', responseItems: [{ type: 'reasoning', summary: 'HIDDEN' }] });
  const reviewer = new Reviewer(cfg.approval, client, tools);
  const action = await tools.prepare('write_file', { path: 'out.txt', content: 'report' });
  assert.equal((await reviewer.decide(action, s)).status, 'allow');
  const seen = JSON.stringify(client.seen);
  assert.match(seen, /bounded report/); assert.doesNotMatch(seen, /PRIVATE REASONING|HIDDEN/);
});
test('reviewer cannot execute shell or writes even when model calls them', async t => {
  const workspace = await temp(t), cfg = config(), tools = await new Tools(workspace, cfg).initialize();
  const client = new Scripted([assistant(call('write_file', { path: 'evil.txt', content: 'x' })), final('{"outcome":"deny"}')]);
  const reviewer = new Reviewer(cfg.approval, client, tools);
  assert.equal((await reviewer.decide(await tools.prepare('shell', { command: 'echo safe', justification: 'test' }), state())).status, 'deny');
  assert.match(client.seen[1].messages.at(-1).content, /only call read_file/);
  await assert.rejects(fs.stat(path.join(workspace, 'evil.txt')));
});
test('total review deadline also bounds a hung reviewer or read-only investigation', async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'deadline.txt', content: 'x' }))], [], { approval: { timeoutMs: 40 } });
  h.reviewClient.complete = () => new Promise(() => {});
  // Keep the event loop alive: AbortSignal.timeout deliberately uses an unref timer.
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  const started = Date.now();
  const p = await h.create().start('Task');
  assert.equal(p.status, 'waiting_approval'); assert.match(p.pending.reason, /timeout/); assert.ok(Date.now() - started < 900);
});
test('consecutive denials trip a resumable breaker, human guidance unblocks it', async t => {
  const calls = Array.from({ length: 3 }, (_, i) => assistant(call('write_file', { path: `${i}.txt`, content: 'blocked' }, `d${i}`)));
  const h = await harness(t, [...calls, final('Using the clarified safe direction')], calls.map(() => final('{"outcome":"deny"}')));
  const p = await h.create().start('Work'); assert.equal(p.status, 'waiting_input'); assert.equal(p.pending.kind, 'guidance'); assert.equal(p.denials.length, 3);
  await h.store.submit(p.pending.id, 'respond', 'Do read-only investigation and stop trying these writes');
  assert.equal((await h.create().resume()).status, 'complete');
});
test('rolling denial circuit trips even when allowed actions reset the consecutive counter', async t => {
  const calls = Array.from({ length: 5 }, (_, i) => assistant(call('write_file', { path: `rolling-${i}.txt`, content: 'x' }, `r${i}`)));
  const h = await harness(t, calls, calls.map((_, i) => final(JSON.stringify({ outcome: i % 2 ? 'allow' : 'deny' }))), { approval: { rollingWindow: 5, rollingDenialLimit: 3 } });
  const result = await h.create().start('Task'); assert.equal(result.status, 'waiting_input');
  assert.equal(result.consecutiveDenials, 1); assert.equal(result.denials.length, 3); assert.equal(h.reviewClient.seen.length, 5);
});
test('a transient malformed assessment retries inside the same review instead of denying the action', async t => {
  const h = await harness(t, [assistant(call('write_file', { path: 'parse-retry.txt', content: 'x' })), final('done')], [final('malformed'), final('{"outcome":"allow"}')]);
  const result = await h.create().start('Task'); assert.equal(result.status, 'complete'); assert.equal(result.denials.length, 0); assert.equal(h.reviewClient.seen.length, 2);
});
test('exact-action override is single-use and goes through review again', async t => {
  const c = assistant(call('write_file', { path: 'denied.txt', content: 'report' }));
  const h = await harness(t, [c, assistant(call('request_user_input', { question: 'May I write this report?' }, 'question')), c, final('done')], [final('{"outcome":"deny","rationale":"Need explicit authorization"}'), final('{"outcome":"allow"}')]);
  const p = await h.create().start('Report'); assert.equal(p.pending.kind, 'question');
  await h.store.override(p.denials[0].id, 'I approve that exact write after seeing the stated risk');
  await h.store.submit(p.pending.id, 'respond', 'Retry exactly the denied report');
  const result = await h.create().resume(); assert.equal(result.status, 'complete');
  assert.equal(h.reviewClient.seen.length, 2); assert.match(JSON.stringify(h.reviewClient.seen[1]), /explicit_user_override/);
  assert.equal(result.overrides[0].used, true);
});
test('critical or otherwise denied action stays blocked after override', async t => {
  const c = assistant(call('write_file', { path: 'still-blocked.txt', content: 'x' }));
  const h = await harness(t, [c, assistant(call('request_user_input', { question: 'Need guidance' }, 'q')), c, final('blocked')], [final('{"outcome":"deny"}'), final('{"outcome":"deny","risk_level":"critical","rationale":"Absolute deny"}')]);
  const p = await h.create().start('Task'); await h.store.override(p.denials[0].id, 'Approved after risk warning'); await h.store.submit(p.pending.id, 'respond', 'Retry once');
  await h.create().resume(); await assert.rejects(fs.stat(path.join(h.workspace, 'still-blocked.txt')));
});
