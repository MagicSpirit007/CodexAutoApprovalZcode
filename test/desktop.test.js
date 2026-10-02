import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNodeApprovalBridge } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/src/exec/approval-bridge.ts';
import { DesktopBridgeClient } from '../src/desktop-client.js';
import { reviewDesktopPermission } from '../src/desktop-hook.js';
import { AiSdkModelAdapterError } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/src/model/errors.ts';
import { ProviderBusinessError } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/src/model/model-execution.ts';

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
  const packagedHook = JSON.parse(await readFile('plugins/codex-auto-approval/hooks/hooks.json', 'utf8')).hooks.PermissionRequest[0].hooks[0];
  const args = packagedHook.args.map(arg => arg.replaceAll('${ZCODE_PLUGIN_ROOT}', path.resolve('plugins/codex-auto-approval')));
  return new Promise((resolve, reject) => {
    const proc = spawn(packagedHook.command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => stdout += data);
    proc.stderr.on('data', data => stderr += data);
    proc.on('error', reject);
    proc.on('close', code => {
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


test('bridge v2 mismatch falls back without issuing a native model request', async t => {
  const f=await fixture(t);
  const result=await reviewDesktopPermission(hook,{env:{...f.env,ZCODE_APPROVAL_BRIDGE_VERSION:'1'}});
  assert.equal(decision(result).behavior,'ask');
  assert.equal(decision(result).reviewFailure.code,'bridge_unavailable');
});
test('sanitized diagnostics retain safe HTTP/business/retry details and strip secrets in every field', async t => {
  const f=await fixture(t,async()=>{throw Object.assign(new Error('sk-HIDDEN_BARE https://provider.example/?key=PRIVATE\nunsafe stack'),{
    name:'ProviderBusinessError',providerCode:'1309',statusCode:401,providerRequestId:'safe-request',retryAfterMs:200000,
    responseBodySummary:{secret:'RAW_BODY'},responseHeaders:{'authorization':'Bearer PRIVATE'},retryable:false });});
  const result=await child(f.env);
  const failure=decision(result).reviewFailure;
  assert.equal(failure.businessCode,'1309');assert.equal(failure.httpStatus,401);assert.equal(failure.requestId,'safe-request');
  assert.equal(failure.retryAfterMs,90000);assert.equal(failure.retryable,false);
  assert.doesNotMatch(JSON.stringify(failure),/HIDDEN_BARE|PRIVATE|RAW_BODY|provider.example|unsafe stack/);
});

for (const [message, statusCode, expectedCode, retryable] of [
  ['request has been blocked due to unusual activity.', 405, 'provider_request_blocked', false],
  ['Method Not Allowed', 405, 'model_request_failed', false],
  ['Invalid credentials', 401, 'model_request_failed', false],
  ['Temporary upstream failure', 503, 'model_request_failed', true],
]) test(`native adapter diagnostics survive approval bridge: ${statusCode} ${expectedCode}`, async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    throw new AiSdkModelAdapterError('model_request_failed', message, { context: {
      statusCode, retryable, requestId: 'request-safe', providerErrorCode: 'provider-safe',
      headers: { authorization: 'Bearer PRIVATE' }, responseBody: 'PRIVATE_BODY',
    } });
  });
  const output = await child(f.env);
  const failure = decision(output).reviewFailure;
  assert.equal(decision(output).behavior, 'ask');
  assert.equal(failure.code, expectedCode);
  assert.equal(failure.message, message);
  assert.equal(failure.httpStatus, statusCode);
  assert.equal(failure.requestId, 'request-safe');
  assert.equal(failure.businessCode, 'provider-safe');
  assert.equal(failure.retryable, retryable);
  assert.equal(calls, retryable ? 3 : 1);
  assert.equal(decision(f.lease.finish(output)).behavior, 'ask');
  assert.equal(f.records.length, 0);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE/);
});

test('untrusted context is not used as native provider evidence', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('request has been blocked due to unusual activity.'), {
    context: { statusCode: 405, requestId: 'untrusted' },
  }); });
  const failure = decision(await child(f.env)).reviewFailure;
  assert.equal(failure.code, 'review_error');
  assert.equal(failure.httpStatus, undefined);
  assert.equal(failure.requestId, undefined);
});

for (const nested of [false, true]) test(`explicit native business interception stays blocked (nested=${nested})`, async t => {
  const business = new ProviderBusinessError({ providerCode: 'unusual_activity', providerId: 'fixture', providerKind: 'anthropic',
    providerMessage: 'request has been blocked due to unusual activity.', statusCode: 405, responseStatus: 405,
    providerRequestId: 'business-request', responseBodySummary: {} });
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw nested ? new AiSdkModelAdapterError('model_request_failed', business.message, {
    cause: business, context: { statusCode: 405, requestId: 'host-request', retryable: false },
  }) : business; });
  const output = await child(f.env);
  assert.equal(decision(output).reviewFailure.code, 'provider_request_blocked');
  assert.equal(decision(output).reviewFailure.httpStatus, 405);
  assert.equal(decision(output).reviewFailure.requestId, 'business-request');
  assert.equal(decision(output).reviewFailure.retryable, false);
  assert.equal(decision(output).behavior, 'ask');
  assert.equal(calls, 1);
  assert.equal(f.records.length, 0);
});
