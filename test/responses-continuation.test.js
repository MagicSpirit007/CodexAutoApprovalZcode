import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeApprovalBridge } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/runtime/helpers/approval-bridge.js';
import { createNodeApprovalBridge } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/exec/index.js';
import { createNodeExecutionAdapter } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/exec/index.js';
import { createConfiguredHookRunner } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/hooks/configured-runner.js';
import { createToolExecutor } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/tool/executor.js';
import { ToolRegistryImpl } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/tool/registry.js';
import { PermissionService } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/permission/service.js';
import { defaultRuntime } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/model/runner-runtime.js';
import { AiSdkModelAdapter } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/model/index.js';
import { ApprovalContinuation } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/runtime/helpers/approval-continuation.js';
import { runWithModelInvocationContext, ModelRetryBudget } from '../host-adapter/upstream/apps/zcode-cli/packages/contracts/dist/index.js';

test('strict Responses second request requires full native call and encrypted reasoning', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const body = JSON.parse(text); requests.push(body);
    if (requests.length === 2 && (!body.input.some(item => item.type === 'function_call' && item.call_id === 'call-read') || body.input.some(item => item.type === 'item_reference'))) {
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Missing full function_call for call-read', type: 'invalid_request_error' } })); return;
    }
    const output = requests.length === 1 ? [
      { type: 'reasoning', id: 'reasoning-private', summary: [], encrypted_content: 'encrypted-fixture' },
      { type: 'function_call', id: 'function-private', call_id: 'call-read', name: 'read_file', arguments: '{"path":"proof.txt"}', status: 'completed' },
    ] : [{ type: 'message', id: 'message-result', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'assessment', annotations: [] }] }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `response-${requests.length}`, object: 'response', created_at: 1, model: 'fixture', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const model = new AiSdkModelAdapter({ env: {} }).createModel({ providerId: 'fixture', modelId: 'fixture',
    providerConfig: { access: { type: 'api-key', apiKey: 'fixture-only' }, api: { type: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } },
    modelConfig: { properties: { contextWindow: 20000, supportsToolCall: true }, optionSpecs: { reasoningLevel: { values: ['high'], map: '{}' }, maxOutputTokens: { max: 8192, map: '{}' } } }, options: { reasoningLevel: 'high' } });
  const continuation = new ApprovalContinuation();
  const initial = [{ role: 'system', content: 'Review' }, { role: 'user', content: 'Read proof' }];
  await runWithModelInvocationContext({ metadata: { querySource: 'auto_review' }, modelRetryBudget: ModelRetryBudget.SingleAttempt }, async () => {
    const first = await model.generateText({ messages: initial, tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, readOnly: true }], options: { maxOutputTokens: 1000 } });
    const visibleAssistant = { role: 'assistant', content: '', tool_calls: [{ id: 'call-read', function: { name: 'read_file', arguments: '{"path":"proof.txt"}' } }] };
    assert.equal(first.toolCalls.length, 1);
    continuation.save('binding', 1, initial, initial, visibleAssistant, { role: 'assistant', content: [{ type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'reasoning-private', reasoningEncryptedContent: 'encrypted-fixture' } } }], toolCalls: first.toolCalls.map(call => ({ ...call, providerOptions: { openai: { itemId: 'function-private' } } })) });
    const visible = [...initial, visibleAssistant, { role: 'tool', content: 'proof', tool_call_id: 'call-read' }];
    const restored = continuation.restore('binding', 1, visible, [...initial, { role: 'assistant', content: '' }, { role: 'tool', content: 'proof', toolCallId: 'call-read' }]);
    await model.generateText({ messages: restored, options: { maxOutputTokens: 1000 } });
  });
  assert.equal(requests.length, 2);
  for (const body of requests) { assert.equal(body.store, false); assert.ok(body.include.includes('reasoning.encrypted_content')); }
  assert.ok(requests[1].input.some(item => item.type === 'function_call_output' && item.call_id === 'call-read'));
  assert.ok(requests[1].input.some(item => item.type === 'reasoning' && item.encrypted_content === 'encrypted-fixture'));
});

for (const legacyStore of [true, false]) test(`strict streaming Responses bridge and executor (legacy store=${legacyStore})`, async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'responses-private-'));
  await writeFile(path.join(workspace, 'proof.txt'), 'synthetic proof');
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bodies = [];
  const encode = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const round = (bodies.length - 1) % 3;
    if (round > 0 && (body.input.some(item => item.type === 'item_reference') || !body.input.some(item => item.type === 'function_call' && item.call_id === 'read-first'))) {
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Missing full function_call', type: 'invalid_request_error' } })); return;
    }
    const output = round < 2 ? [
      { type: 'reasoning', id: `reasoning-${round}`, summary: [], encrypted_content: `encrypted-${round}` },
      ...[0, 1].map(index => ({ type: 'function_call', id: `item-${round}-${index}`, call_id: round === 0 && index === 0 ? 'read-first' : `read-${round}-${index}`, name: 'read_file', arguments: '{"path":"proof.txt"}', status: 'completed' })),
    ] : [{ type: 'message', id: 'assessment-item', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ outcome: bodies.length > 3 ? 'deny' : 'allow', risk_level: 'low', user_authorization: 'high', rationale: 'Synthetic proof verified' }), annotations: [] }] }];
    const response = { id: `response-${bodies.length}`, object: 'response', created_at: 1, model: 'fixture', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const events = [{ type: 'response.created', response: { ...response, output: [] } }];
    output.forEach((item, output_index) => {
      events.push({ type: 'response.output_item.added', output_index, item: item.type === 'function_call' ? { ...item, arguments: '' } : item });
      if (item.type === 'function_call') events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments });
      if (item.type === 'message') events.push({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: item.content[0].text });
      events.push({ type: 'response.output_item.done', output_index, item });
    });
    events.push({ type: 'response.completed', response });
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(encode).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const selection = { providerId: 'fixture', modelId: 'fixture', options: { reasoningLevel: 'high' } };
  // Test-only old-behavior control: SDK defaults store=true. Never roll back shared production files.
  const adapter = new AiSdkModelAdapter({ env: {}, ...(legacyStore ? { runtime: { ...defaultRuntime,
    streamText: options => defaultRuntime.streamText({ ...options, onError: () => {}, providerOptions: { ...options.providerOptions, openai: { ...options.providerOptions?.openai, store: true } } }) } } : {}) });
  const runtime = { sessionId: 'fixture-session', workingDirectory: workspace, branchGeneration: 0, config: { mode: 'build', taskType: 'interactive' },
    rootTraceContext: { traceId: 'fixture-trace', sessionId: 'fixture-session', turnId: 'fixture-turn' }, getSessionModelSelection: () => selection,
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [{ message: { role: 'user', content: 'Read proof.txt before allowing this read-only action.' }, metadata: { source: 'real_user' } }] },
    modelFactory: () => adapter.createModel({ ...selection,
      providerConfig: { access: { type: 'api-key', apiKey: 'fixture-only' }, api: { type: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } },
      modelConfig: { properties: { contextWindow: 20000, supportsToolCall: true }, optionSpecs: { reasoningLevel: { values: ['high'], map: '{}' }, maxOutputTokens: { max: 8192, map: '{}' } } } }) };
  const bridge = createRuntimeApprovalBridge(runtime, createNodeApprovalBridge);
  const execution = createNodeExecutionAdapter();
  t.after(() => execution.close());
  const pluginRoot = path.resolve('plugins/codex-auto-approval');
  const hooks = createConfiguredHookRunner({ approvalBridgePort: bridge, executionPort: execution, getWorkingDirectory: () => workspace,
    config: { enabled: true, maxOutputBytes: 32768, timeoutMs: 95000, events: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'process', command: process.execPath,
      args: [path.join(pluginRoot, 'bin/permission-request.js')], plugin: { name: 'codex-auto-approval', id: 'fixture-plugin', rootPath: pluginRoot, dataPath: path.join(workspace, 'plugin-data') } }] }] } } });
  let executions = 0, humans = 0;
  const registry = new ToolRegistryImpl();
  registry.register({ name: 'ReadProbe', description: 'Synthetic no-effect action', inputSchema: { type: 'object', properties: {} }, metadata: { name: 'ReadProbe', alwaysAsk: true, readOnly: false, destructive: false, concurrentSafe: false, sideEffectScope: 'none', riskLevel: 'medium', needsApproval: true }, handler: async () => { executions++; return { executed: true }; } });
  const executor = createToolExecutor({ registry, permissionService: new PermissionService(), hookRunner: hooks, permissionBroker: { requestPermission: async () => { humans++; return { decision: 'deny' }; } }, emitEvent: async () => {}, sessionId: runtime.sessionId, workingDirectory: workspace, mode: 'build', traceContext: runtime.rootTraceContext });
  for (const requestId of ['review-one', 'review-two']) {
    const result = await executor.execute({ id: requestId, name: 'ReadProbe', input: {} }, { traceContext: runtime.rootTraceContext });
    if (legacyStore) {
      assert.equal(result.success, false);
      assert.equal(executions, 0);
      assert.equal(humans, 1);
      assert.equal(bodies.length, 2);
      assert.ok(bodies[1].input.some(item => item.type === 'item_reference'));
      assert.equal(bodies[1].input.some(item => item.type === 'function_call' && item.call_id === 'read-first'), false);
      return;
    }
    assert.equal(result.success, requestId === 'review-one', JSON.stringify(result));
    assert.equal(executions, 1);
    assert.equal(humans, 0);
    assert.doesNotMatch(JSON.stringify(result), /encrypted-|reasoning-/);
  }
  assert.equal(bodies.length, 6);
  for (let index = 0; index < bodies.length; index++) {
    const body = bodies[index]; assert.equal(body.store, false); assert.ok(body.include.includes('reasoning.encrypted_content'));
    assert.equal(body.previous_response_id, undefined); assert.equal(body.conversation, undefined);
    if (index % 3 === 0) assert.equal(body.input.filter(item => item.type === 'function_call').length, 0);
    else {
      const calls = body.input.filter(item => item.type === 'function_call');
      const results = body.input.filter(item => item.type === 'function_call_output');
      assert.equal(calls.length, (index % 3) * 2); assert.deepEqual(calls.map(call => call.call_id).sort(), results.map(result => result.call_id).sort());
      assert.ok(body.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'encrypted-0'));
    }
  }
});
