import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNodeApprovalBridge } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/src/exec/approval-bridge.ts';
import { DesktopBridgeClient } from '../src/desktop-client.js';
import { reviewDesktopPermission } from '../src/desktop-hook.js';

const assessment = outcome => ({ outcome, risk_level: outcome === 'allow' ? 'low' : 'high', user_authorization: 'high', rationale: 'Mock policy rationale' });
const decision = output => output.hookSpecificOutput.decision;
const hook = { hookEventName: 'PermissionRequest', cwd: '', sessionId: 's', turnId: 't', requestId: 'r', toolCallId: 'c', toolName: 'Bash', toolInput: { command: 'echo test' }, mode: 'build' };
async function fixture(t, complete = async () => ({ role: 'assistant', content: JSON.stringify(assessment('allow')) })) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zcode-desktop-test-'));
  const state = { workspace, modelSnapshot: { providerId: 'native', modelId: 'mock', options: { reasoningLevel: 'high' } },
    state: { userMessages: ['Run echo test'], messages: [], denials: [] } };
  const records = [];
  const owner = { snapshot: () => state, complete, record: (...args) => { records.push(args); return records.length === 3; } };
  const controller = new AbortController();
  const lease = await createNodeApprovalBridge(owner).open({ ...hook, cwd: workspace }, controller.signal);
  const env = { ...process.env, ...lease.env };
  t.after(async () => { await lease.close(); await rm(workspace, { recursive: true, force: true }); });
  return { workspace, state, lease, env, records, controller };
}
async function child(env, input = hook) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.resolve('plugins/codex-auto-approval/bin/permission-request.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => stdout += data);
    proc.stderr.on('data', data => stderr += data);
    proc.on('error', reject);
    proc.on('exit', code => {
      try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    proc.stdin.end(JSON.stringify(input));
  });
}

test('real PermissionRequest child allows once, never persists grants', async t => {
  const f = await fixture(t);
  const output = await child(f.env);
  assert.equal(decision(output).behavior, 'allow');
  const accepted = f.lease.finish(output);
  assert.deepEqual(decision(accepted), { behavior: 'allow' });
  assert.equal(f.records.length, 1);
  assert.equal(decision(f.lease.finish(output)).behavior, 'ask');
});
test('real hook denial contains rationale and anti-circumvention feedback', async t => {
  const f = await fixture(t, async () => ({ role: 'assistant', content: JSON.stringify(assessment('deny')) }));
  const output = await child(f.env);
  assert.equal(decision(output).behavior, 'deny');
  assert.match(decision(output).message, /Mock policy rationale/);
  assert.match(decision(output).message, /must not attempt/);
  assert.equal(decision(f.lease.finish(output)).interrupt, false);
});
test('stock desktop or absent bridge falls back to human', async () => {
  const output = await child({ PATH: process.env.PATH });
  assert.equal(decision(output).behavior, 'ask');
});
for (const code of ['authentication', 'network', 'input_budget']) test(`${code} failure asks human, never counts as denial`, async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error(code), { code }); });
  const output = await child(f.env);
  assert.equal(decision(output).behavior, 'ask');
  assert.equal(decision(f.lease.finish(output)).behavior, 'ask');
  assert.equal(f.records.length, 0);
});
test('invalid assessments are retried three times then ask', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { role: 'assistant', content: 'invalid' }; });
  assert.equal(decision(await child(f.env)).behavior, 'ask');
  assert.equal(calls, 3);
});
test('changed action or session cannot be reviewed under another binding', async t => {
  const f = await fixture(t);
  assert.equal(decision(await child(f.env, { ...hook, toolInput: { command: 'rm -rf /' } })).behavior, 'ask');
  assert.equal(decision(await child(f.env, { ...hook, sessionId: 'another' })).behavior, 'ask');
});
test('model and reasoning options snapshot is refreshed after change', async t => {
  let calls = 0, state;
  const f = await fixture(t, async () => {
    if (++calls === 1) state.modelSnapshot = { providerId: 'native', modelId: 'second', options: { reasoningLevel: 'max' } };
    return { role: 'assistant', content: JSON.stringify(assessment('allow')) };
  });
  state = f.state;
  const output = await child(f.env);
  assert.equal(decision(output).behavior, 'allow');
  assert.equal(calls, 2);
  assert.equal(decision(f.lease.finish(output)).behavior, 'allow');
});
test('answer becomes stale when human authorization changes after review', async t => {
  const f = await fixture(t);
  const output = await child(f.env);
  f.state.state.userMessages.push('Do not execute that command');
  assert.equal(decision(f.lease.finish(output)).behavior, 'ask');
  assert.equal(f.records.length, 0);
});
test('parallel session tokens are isolated', async t => {
  const a = await fixture(t), b = await fixture(t);
  const spoof = new DesktopBridgeClient({ ...a.env, ZCODE_APPROVAL_BRIDGE_TOKEN: b.env.ZCODE_APPROVAL_BRIDGE_TOKEN });
  await assert.rejects(spoof.context(), { code: 'authentication' });
  assert.equal(decision(await child(b.env)).behavior, 'allow');
});
test('cancel closes bridge and invalidates completed answer', async t => {
  const f = await fixture(t);
  const output = await child(f.env);
  f.controller.abort();
  assert.equal(decision(f.lease.finish(output)).behavior, 'ask');
  await assert.rejects(new DesktopBridgeClient(f.env).context());
});
test('investigation reads only workspace files and denies write tool', async t => {
  let calls = 0;
  const f = await fixture(t, async params => {
    if (++calls === 1) return { role: 'assistant', content: '', tool_calls: [
      { id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"evidence.txt"}' } },
      { id: 'write', type: 'function', function: { name: 'shell', arguments: '{"command":"echo unsafe"}' } },
    ] };
    assert.match(params.messages.find(message => message.tool_call_id === 'read').content, /evidence/);
    assert.match(params.messages.find(message => message.tool_call_id === 'write').content, /only call read_file/);
    return { role: 'assistant', content: JSON.stringify(assessment('deny')) };
  });
  await writeFile(path.join(f.workspace, 'evidence.txt'), 'evidence');
  assert.equal(decision(await child(f.env)).behavior, 'deny');
  assert.equal(calls, 2);
});
test('parent cancellation propagates distinctly from policy denial', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort(new Error('User cancelled'));
  await assert.rejects(reviewDesktopPermission(hook, { env: f.env, signal: controller.signal }), /User cancelled/);
});
test('bridge deadline cancels a provider that ignores cancellation without approving', async t => {
  const f = await fixture(t, async () => new Promise(() => {}));
  const bridge = new DesktopBridgeClient(f.env);
  const context = await bridge.context();
  await assert.rejects(bridge.rpc('model/complete', { bindingId: context.bindingId, messages: [] }, { deadline: Date.now() + 30 }), { code: 'timeout' });
  f.controller.abort();
  assert.equal(f.records.length, 0);
});
