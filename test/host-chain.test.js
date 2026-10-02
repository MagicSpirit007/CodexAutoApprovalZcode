import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConfiguredNodeApprovalBridge, createNodeExecutionAdapter } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/exec/index.js';
import { createConfiguredHookRunner } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/hooks/configured-runner.js';
import { createRuntimeApprovalBridge } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/runtime/helpers/approval-bridge.js';
import { createToolExecutor } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/tool/executor.js';
import { ToolRegistryImpl } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/tool/registry.js';
import { PermissionService, defaultPermissionConfig } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/permission/service.js';
import { createNodePluginAdapter } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/plugins/index.js';
import { addMarketplace, installMarketplacePlugin, uninstallMarketplacePlugin } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/plugins/marketplace.js';
import { getCurrentModelInvocationContext, ModelRetryBudget } from '../host-adapter/upstream/apps/zcode-cli/packages/contracts/dist/index.js';
import { retryBudgetAllows, retryAttemptLoopContinues, retryBudgetMaxAttempts } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/model/retry-budget.js';
import { createModel } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/model/model.js';
import { AiSdkModelAdapterError } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/model/errors.js';

const sourcePlugin = path.resolve('plugins/codex-auto-approval');
const assess = outcome => JSON.stringify({ outcome, risk_level: outcome === 'allow' ? 'low' : 'high', user_authorization: 'high', rationale: 'Native test policy result' });
async function fixture(t, { outcome = 'allow', failure, mode = 'build', disabled = false, delay = 0, userDisabled = false, missingFinish = false, invalidOutput = false, clickImmediately = false, streamError = false, reviewModel, userReviewModel, investigate = false, supportsTools = true, missingModel = false, missingCredential = false, mutateAfterReview = false, mutateBeforeExecution = false, humanResult } = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zcode-native-chain-'));
  const plugin = path.join(workspace, 'installed-plugin');
  await cp(sourcePlugin, plugin, { recursive: true });
  const packagedHook = JSON.parse(await readFile(path.join(plugin, 'hooks/hooks.json'), 'utf8')).hooks.PermissionRequest[0].hooks[0];
  const selections = [], requests = [], events = [], retryBudgets = [], invocationContexts = [];
  let registered = false, firstClick;
  let executions = 0, humanRequests = 0, hookCalls = 0;
  const runtime = {
    sessionId: 'native-session', workingDirectory: workspace, branchGeneration: 0,
    config: { mode, taskType: 'interactive' }, rootTraceContext: { traceId: 'trace', sessionId: 'native-session', turnId: 'turn', queryId: 'query-native' },
    selection: { providerId: 'native-provider', modelId: 'first', options: { reasoningLevel: 'high' } },
    getSessionModelSelection() { return this.selection; },
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [
      { message: { role: 'user', content: 'Execute the approved probe' }, metadata: { source: 'real_user' } },
      { message: { role: 'user', content: 'Synthetic message is not human authorization' }, metadata: { source: 'legacy_synthetic' } },
      { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'HIDDEN_SECRET' }, { type: 'text', text: 'Visible plan', providerOptions: { hidden: 'MAIN_PROVIDER_METADATA' } }] } },
    ] },
    modelFactory({ selection }) {
      selections.push(structuredClone(selection));
      if (missingModel) throw Object.assign(new Error('Configured review model no longer exists'), { code:'review_model_not_found' });
      if (missingCredential) throw Object.assign(new Error('Native credential unavailable'), { code:'review_credentials_missing' });
      return createModel({ providerId: selection.providerId, modelId: selection.modelId, options: selection.options,
        properties: { supportsToolCall: supportsTools },
        optionSpecs: { maxOutputTokens: { max: 4096 }, reasoningLevel: { values: ['high', 'max'] } }, executor: {
        async *streamText(request) {
          hookCalls++; requests.push(request);
          retryBudgets.push(getCurrentModelInvocationContext()?.modelRetryBudget);
          invocationContexts.push(getCurrentModelInvocationContext());
          if (delay) await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            request.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(request.abortSignal.reason); }, { once: true });
          });
          if (failure === 'provider_request_blocked') throw new AiSdkModelAdapterError('model_request_failed', 'request has been blocked due to unusual activity.', {
            context: { statusCode: 405, requestId: 'native-block-request', retryable: false },
          });
          if (failure) throw Object.assign(new Error(failure), { code: failure });
          if (streamError) yield { type: 'error', error: { name: 'ProviderBusinessError', message: 'request has been blocked due to unusual activity.' } };
          yield { type: 'reasoning_delta', text: 'HIDDEN_REVIEW_REASONING', providerMetadata: { anthropic: { signature: 'PRIVATE_SIGNATURE' } } };
          if (investigate && request.messages.length < 6) {
            yield { type: 'tool_call', toolCall: { id: `read-${request.messages.length}`, name: 'read_file', input: { path: 'proof.txt' }, providerOptions: { openai: { itemId: 'PRIVATE_TOOL_ITEM' } } } };
            yield { type: 'finish', finishReason: 'tool-calls', usage: {}, providerMetadata: { openai: { responseId: 'PRIVATE_RESPONSE_ID' } } };
            return;
          }
          yield { type: 'text_delta', text: invalidOutput ? 'invalid assessment' : assess(outcome) };
          if (!missingFinish) yield { type: 'finish', finishReason: 'stop', usage: {} };
        },
      } });
    },
  };
  const configFile = path.join(workspace, 'config.json');
  await writeFile(configFile, JSON.stringify({ plugins: { enabledPlugins: { 'codex-auto-approval@local': true }, options: reviewModel ? { 'codex-auto-approval@local': { reviewModel } } : {} } }));
  await writeFile(path.join(workspace,'proof.txt'), 'Visible investigation proof');
  const userConfigFile = path.join(workspace, 'user-config.json');
  await writeFile(userConfigFile, JSON.stringify({ plugins: { enabledPlugins: { 'codex-auto-approval@local': !userDisabled }, options: userReviewModel ? { 'codex-auto-approval@local': { reviewModel: userReviewModel } } : {} } }));
  const bridge = createRuntimeApprovalBridge(runtime, createConfiguredNodeApprovalBridge([userConfigFile, configFile]));
  const executionPort = createNodeExecutionAdapter();
  const hookRunner = createConfiguredHookRunner({ approvalBridgePort: bridge, executionPort, emitEvent: async event => events.push(event), getWorkingDirectory: () => workspace,
    config: { enabled: !disabled, maxOutputBytes: 32768, timeoutMs: 95000, events: { PermissionRequest: [{ matcher: '*', hooks: [{
      ...packagedHook,
      plugin: { name: 'codex-auto-approval', id: 'codex-auto-approval@local', rootPath: plugin, dataPath: path.join(workspace, 'data') },
    }] }] } } });
  const registry = new ToolRegistryImpl();
  registry.register({ name: 'ApprovalProbe', description: 'Test approval execution count', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    metadata: { name: 'ApprovalProbe', readOnly: false, destructive: false, concurrentSafe: false, sideEffectScope: 'filesystem', riskLevel: 'medium', needsApproval: true },
    handler: async () => { executions++; return { executed: true }; } });
  const permissionService = new PermissionService();
  const permissionBroker = { requestPermission: async (_request, { signal, onRegistered }) => {
    humanRequests++;
    return new Promise((resolve, reject) => {
      registered = true;
      firstClick = () => resolve(humanResult ?? { decision: 'allow' });
      void onRegistered?.();
      const timer = setTimeout(() => resolve({ decision: 'deny', reason: 'Human test fallback' }), 1800);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  } };
  const executor = createToolExecutor({ registry, permissionService, permissionBroker, hookRunner,
    emitEvent: async event => {
      events.push(event);
      if ((mutateAfterReview && event.type === 'permission_review_completed' && event.payload.outcome === 'allow') || (mutateBeforeExecution && event.type === 'tool_call_started')) {
        await writeFile(configFile, JSON.stringify({ plugins: { options: { 'codex-auto-approval@local': { reviewModel: specifiedReview('changed-after-validation') } } } }));
      }
      if (event.type === 'permission_requested' && clickImmediately) {
        assert.equal(registered, true, 'receiver must exist before publishing permission');
        firstClick(); firstClick();
      }
    }, sessionId: runtime.sessionId, workingDirectory: workspace, mode,
    traceContext: runtime.rootTraceContext });
  t.after(async () => {
    await executionPort.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { runtime, selections, requests, events, retryBudgets, invocationContexts, executor, bridge, permissionService, configFile, userConfigFile,
    counts: () => ({ executions, humanRequests, hookCalls }),
    execute: (id = crypto.randomUUID(), options) => executor.execute({ id, name: 'ApprovalProbe', input: { value: 'same action' } }, { traceContext: runtime.rootTraceContext, ...options }) };
}

test('native permission chain executes exactly once and inherits session model/options', async t => {
  const f = await fixture(t);
  const result = await f.execute();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.counts().executions, 1);
  assert.equal(f.counts().humanRequests, 0);
  assert.equal(f.events.some(e => e.type === 'permission_requested'), false);
  assert.deepEqual(f.events.filter(e => e.type.startsWith('permission_review')).map(e => e.type), ['permission_review_started', 'permission_review_completed']);
  assert.equal(f.invocationContexts[0].traceContext.sessionId, 'native-session');
  assert.equal(f.invocationContexts[0].traceContext.queryId, 'query-native');
  assert.equal(f.invocationContexts[0].metadata.querySource, 'auto_review');
  assert.deepEqual(f.selections[0], f.runtime.selection);
  assert.equal(f.retryBudgets[0], ModelRetryBudget.SingleAttempt);
  assert.equal(f.requests[0].options.maxOutputTokens, 4096);
  assert.equal(f.requests[0].options.reasoningLevel, 'high');
  const payload = JSON.parse(f.requests[0].messages[1].content.slice(f.requests[0].messages[1].content.indexOf('{')));
  assert.deepEqual(payload.user_messages, ['Execute the approved probe']);
  assert.doesNotMatch(JSON.stringify(payload), /HIDDEN_SECRET/);
  f.runtime.selection = { ...f.runtime.selection, modelId: 'second', options: { reasoningLevel: 'max' } };
  assert.equal((await f.execute()).success, true);
  assert.equal(f.counts().executions, 2);
  assert.equal(f.selections.at(-1).modelId, 'second');
  assert.equal(f.selections.at(-1).options.reasoningLevel, 'max');
});
test('approval retry budget disables nested provider retries while ordinary session budget is unchanged', () => {
  assert.equal(retryBudgetAllows(ModelRetryBudget.SingleAttempt, 1, 11), false);
  assert.equal(retryAttemptLoopContinues(ModelRetryBudget.SingleAttempt, 2, 11), false);
  assert.equal(retryBudgetMaxAttempts(ModelRetryBudget.SingleAttempt, 11), 1);
  assert.equal(retryBudgetAllows(ModelRetryBudget.Default, 1, 11), true);
});
test('native denial prevents execution and returns corrective feedback to main model', async t => {
  const f = await fixture(t, { outcome: 'deny' });
  const result = await f.execute();
  assert.equal(result.success, false);
  assert.equal(f.counts().executions, 0);
  assert.equal(f.counts().humanRequests, 0);
  assert.match(JSON.stringify(result), /must not attempt/);
  assert.match(JSON.stringify(result), /Native test policy result/);
  f.runtime.rootTraceContext.turnId = 'follow-up-turn';
  await f.execute();
  const nextPayload = JSON.parse(f.requests.at(-1).messages[1].content.slice(f.requests.at(-1).messages[1].content.indexOf('{')));
  assert.equal(nextPayload.prior_denials[0].action.tool, 'ApprovalProbe');
  assert.deepEqual(nextPayload.prior_denials[0].action.arguments, { value: 'same action' });
  assert.equal(nextPayload.prior_denials[0].assessment.outcome, 'deny');
});
test('native technical failure waits for the human broker', async t => {
  const f = await fixture(t, { failure: 'authentication' });
  const result = await f.execute();
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result), /Human test fallback/);
  assert.equal(f.events.find(e => e.type === 'permission_requested').payload.reviewFailure.code, 'authentication');
  assert.equal(f.counts().executions, 0);
});
test('native cancellation never executes and terminates model completion', async t => {
  const f = await fixture(t, { delay: 5000 });
  const controller = new AbortController();
  const promise = f.execute('cancel', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Test cancellation')), 300);
  const result = await promise;
  assert.equal(result.success, false);
  assert.equal(f.counts().executions, 0);
});
test('native circuit breaker interrupts on third denial and resets next host turn', async t => {
  const f = await fixture(t, { outcome: 'deny' });
  assert.equal((await f.execute()).turnControl, undefined);
  assert.equal((await f.execute()).turnControl, undefined);
  const third = await f.execute();
  assert.equal(third.turnControl.stopTurnAfterResult, true);
  assert.equal(third.turnControl.reason, 'auto_review_circuit_breaker');
  f.runtime.rootTraceContext.turnId = 'next-turn';
  assert.equal((await f.execute()).turnControl, undefined);
  assert.equal(f.counts().executions, 0);
});
test('native model change cancels the old completion and reviews the new snapshot', async t => {
  const f = await fixture(t, { delay: 350 });
  const promise = f.execute();
  for (let wait = 0; !f.counts().hookCalls && wait < 250; wait++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(f.counts().hookCalls, 'review model must start within five seconds');
  f.runtime.selection = { ...f.runtime.selection, modelId: 'changed-mid-review', options: { reasoningLevel: 'max' } };
  const result = await promise;
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.counts().executions, 1);
  assert.equal(f.selections.at(-1).modelId, 'changed-mid-review');
});
test('native plugin deactivation cancels review and restores human fallback in current session', async t => {
  const f = await fixture(t, { delay: 5000 });
  const promise = f.execute();
  for (let wait = 0; !f.counts().hookCalls && wait < 250; wait++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(f.counts().hookCalls, 'review model must start within five seconds');
  await writeFile(f.configFile, JSON.stringify({ plugins: { enabledPlugins: { 'codex-auto-approval@local': false } } }));
  assert.equal((await promise).success, false);
  assert.equal(f.counts().executions, 0);
  assert.equal(f.counts().hookCalls, 1);
  assert.match(JSON.stringify(await f.execute()), /Human test fallback/);
  assert.equal(f.counts().hookCalls, 1);
  assert.equal(f.events.filter(e => e.type === 'permission_review_started').length, 1, 'already disabled capability must restore native flow without another review');
});
test('rolling circuit breaker trips at ten denials in the last fifty reviews', async t => {
  const f = await fixture(t);
  const hookInput = { hookEventName: 'PermissionRequest', cwd: f.runtime.workingDirectory, sessionId: f.runtime.sessionId,
    turnId: 'rolling', toolCallId: 'call', toolName: 'ApprovalProbe', toolInput: { value: 'test' }, mode: 'build' };
  for (let index = 0; index < 20; index++) {
    const lease = await f.bridge.open({ ...hookInput, requestId: `rolling-${index}` });
    const { DesktopBridgeClient } = await import('../src/desktop-client.js');
    const context = await new DesktopBridgeClient({ ...lease.env }).context();
    const outcome = index % 2 ? 'deny' : 'allow';
    const result = lease.finish({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
      behavior: outcome, bindingId: context.bindingId, assessment: JSON.parse(assess(outcome)),
    } } });
    if (outcome === 'deny') assert.equal(result.hookSpecificOutput.decision.interrupt, index === 19);
    await lease.close();
  }
});
test('Plan restriction remains effective before automatic review', async t => {
  const f = await fixture(t, { mode: 'plan' });
  assert.equal((await f.execute()).success, false);
  assert.equal(f.counts().hookCalls, 0);
  assert.equal(f.counts().executions, 0);
});
test('hard disallowed tool rule remains effective before review', async t => {
  const f = await fixture(t);
  const actual = new PermissionService({ ...defaultPermissionConfig, disallowedTools: new Set(['ApprovalProbe']) });
  f.permissionService.checkPermission = actual.checkPermission.bind(actual);
  assert.equal((await f.execute()).success, false);
  assert.equal(f.counts().hookCalls, 0);
});
test('disabled plugin restores the native human broker', async t => {
  const f = await fixture(t, { disabled: true });
  assert.equal((await f.execute()).success, false);
  assert.equal(f.counts().hookCalls, 0);
  assert.equal(f.counts().humanRequests, 1);
});

test('workspace enable overrides user disable and workspace disable restores human approval', async t => {
  const f = await fixture(t, { userDisabled: true });
  assert.equal((await f.execute()).success, true);
  assert.equal(f.counts().hookCalls, 1);
  await writeFile(f.configFile, JSON.stringify({ plugins: { enabledPlugins: { 'codex-auto-approval@local': false } } }));
  assert.equal((await f.execute()).success, false);
  assert.equal(f.counts().executions, 1);
  assert.equal(f.counts().hookCalls, 1);
});

test('clean marketplace installation loads packaged hooks; disabling and uninstalling remove hooks', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'zcode-clean-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marketplace = path.join(directory, 'marketplace'), storageRoot = path.join(directory, 'storage');
  await cp(path.resolve('marketplace.json'), path.join(marketplace, 'marketplace.json'));
  await cp(sourcePlugin, path.join(marketplace, 'plugins/codex-auto-approval'), { recursive: true });
  await addMarketplace({ source: { source: 'directory', path: marketplace }, storageRoot });
  const result = await installMarketplacePlugin({ marketplace: 'codex-auto-review-local', name: 'codex-auto-approval', storageRoot });
  const installed = result.installed[0];
  assert.equal(JSON.parse(await readFile(path.join(installed.installPath, 'build-info.json'), 'utf8')).bridgeProtocol, 2);
  const adapter = createNodePluginAdapter({ storageRoot });
  const config = { enabled: true, dirs: [], extraKnownMarketplaces: {}, enabledPlugins: { [installed.id]: true }, suppressedBuiltins: [], options: {} };
  const discover = () => adapter.discoverPlugins({ config, storageRoot, workingDirectory: directory, officialPluginRoots: [] });
  assert.equal((await discover()).hooks.PermissionRequest.length, 1);
  config.enabledPlugins[installed.id] = false;
  assert.equal((await discover()).hooks.PermissionRequest, undefined);
  await uninstallMarketplacePlugin({ pluginId: installed.id, storageRoot, removeCache: true });
  assert.equal((await discover()).plugins.some(plugin => plugin.id === installed.id), false);
});

test('review failure registers the manual receiver before publication; first and duplicate clicks execute once', async t => {
  const f = await fixture(t, { failure: 'authentication', clickImmediately: true });
  assert.equal((await f.execute()).success, true);
  assert.equal(f.counts().executions, 1);
  assert.equal(f.counts().humanRequests, 1);
});

test('native interception asks once without execution or policy denial and survives replay', async t => {
  const f = await fixture(t, { failure: 'provider_request_blocked' });
  assert.equal((await f.execute()).success, false);
  assert.equal(f.counts().executions, 0);
  assert.equal(f.counts().hookCalls, 1);
  assert.equal(f.counts().humanRequests, 1);
  const requested = f.events.find(event => event.type === 'permission_requested').payload;
  assert.equal(requested.reviewFailure.code, 'provider_request_blocked');
  assert.equal(requested.reviewFailure.httpStatus, 405);
  assert.equal(requested.reviewFailure.requestId, 'native-block-request');
  assert.equal(requested.reviewFailure.retryable, false);
  const completed = f.events.find(event => event.type === 'permission_review_completed');
  assert.equal(completed.payload.outcome, 'failed');
  assert.deepEqual(completed.payload.reviewFailure, requested.reviewFailure);
  const { projectPermissionReview } = await import('../host-adapter/upstream/apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/product-projection-permission-review.js');
  const row = { rowId: 'block-row', kind: 'toolCall', toolCallId: completed.payload.toolCallId, toolName: 'ApprovalProbe', status: 'running', inputText: '' };
  const started = f.events.find(event => event.type === 'permission_review_started');
  const projected = projectPermissionReview(completed, projectPermissionReview(started, row)[0].row)[0].row;
  assert.equal(projected.permissionReview.status, 'failed');
  assert.deepEqual(projected.permissionReview.reviewFailure, requested.reviewFailure);
});

test('manual first and duplicate clicks after provider interception execute once', async t => {
  const f = await fixture(t, { failure: 'provider_request_blocked', clickImmediately: true });
  assert.equal((await f.execute()).success, true);
  assert.equal(f.counts().executions, 1);
  assert.equal(f.counts().hookCalls, 1);
  assert.equal(f.counts().humanRequests, 1);
});
for (const [name, options, code] of [
  ['missing stream finish', { missingFinish: true }, 'missing_finish'],
  ['invalid assessment', { invalidOutput: true }, 'parse'],
  ['provider rejection', { failure: 'provider_business_error' }, 'provider_business_error'],
  ['streamed provider error', { streamError: true }, 'provider_business_error'],
  ['total timeout', { failure: 'timeout' }, 'timeout'],
]) test(`${name} exposes a structured manual fallback`, async t => {
  const f = await fixture(t, options);
  assert.equal((await f.execute()).success, false);
  assert.equal(f.counts().executions, 0);
  assert.equal(f.events.find(e => e.type === 'permission_requested').payload.reviewFailure.code, code);
});

test('native interaction registry accepts the very first published click, ignores duplicates and cleans up', async () => {
  const { V4InteractionRegistry } = await import('../host-adapter/upstream/apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/interaction-registry.js');
  const { raceClientRequestWithV4Interaction } = await import('../host-adapter/upstream/apps/zcode-cli/packages/bootstrap/dist/zcode-protocol/interaction-response-race.js');
  const registry = new V4InteractionRegistry();
  let legacyRequests = 0;
  const result = await raceClientRequestWithV4Interaction({ v4Interactions: registry }, 'first-click', undefined,
    async () => { legacyRequests++; throw new Error('legacy request unnecessary after answer'); },
    answer => answer.optionId, undefined, async () => {
      assert.equal(registry.has('first-click'), true);
      assert.equal(registry.resolve('first-click', { optionId: 'allowOnce' }), true);
      assert.equal(registry.resolve('first-click', { optionId: 'deny' }), false);
    });
  assert.equal(result, 'allowOnce');
  assert.equal(legacyRequests, 0);
  assert.equal(registry.has('first-click'), false);
});

test('review projection is replayable and creates no manual interaction', async () => {
  const { projectPermissionReview } = await import('../host-adapter/upstream/apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/product-projection-permission-review.js');
  const row = { rowId: 'tool-row', kind: 'toolCall', toolCallId: 'call', toolName: 'Bash', status: 'running', inputText: '' };
  const started = { type: 'permission_review_started', payload: { requestId: 'request', toolCallId: 'call', toolName: 'Bash' } };
  const start = projectPermissionReview(started, row);
  assert.equal(start.length, 1);
  assert.equal(start[0].op, 'row.upserted');
  assert.equal(start[0].row.permissionReview.status, 'reviewing');
  const done = { type: 'permission_review_completed', payload: { ...started.payload, outcome: 'allow' } };
  const finish = projectPermissionReview(done, start[0].row);
  assert.equal(finish[0].row.permissionReview.status, 'allow');
  assert.deepEqual(projectPermissionReview({ ...done, payload: { ...done.payload, requestId: 'stale' } }, start[0].row), []);
  assert.deepEqual(projectPermissionReview(started, { ...row, status: 'cancelled' }), []);
});
test('provider error projection removes credentials, endpoints and stack lines', async () => {
  const { approvalReviewFailure } = await import('../host-adapter/upstream/apps/zcode-cli/packages/contracts/dist/index.js');
  const failure = approvalReviewFailure(Object.assign(new Error('authorization: Bearer SECRET apiKey=PRIVATE https://provider.example/private?token=PRIVATE\nstack trace'), { code: 'authentication' }));
  assert.equal(failure.code, 'authentication');
  assert.doesNotMatch(failure.message, /SECRET|PRIVATE|provider.example|stack trace/);
});

test('new human authorization invalidates an in-flight allow and is included in the replacement review', async t => {
  const f = await fixture(t, { delay: 550 });
  const pending = f.execute();
  for (let wait = 0; !f.counts().hookCalls && wait < 250; wait++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(f.counts().hookCalls);
  f.runtime.messageHistory.borrowReadOnlyRuntimeEntries = () => [
    { message: { role: 'user', content: 'Changed authorization; review this new instruction' }, kind: 'message' },
  ];
  assert.equal((await pending).success, true);
  assert.equal(f.counts().executions, 1);
  assert.ok(f.counts().hookCalls >= 2);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /Changed authorization/);
});
test('actual native review total deadline falls back after 90 seconds', { skip: process.env.ZCODE_TEST_REVIEW_DEADLINE !== '1' }, async t => {
  const f = await fixture(t, { delay: 120000 });
  const started = Date.now();
  assert.equal((await f.execute()).success, false);
  assert.equal(f.counts().executions, 0);
  assert.equal(f.events.find(e => e.type === 'permission_requested').payload.reviewFailure.code, 'timeout');
  assert.ok(Date.now() - started < 105000, 'review must not restart its total 90-second deadline');
});

const specifiedReview = (modelId = 'review-only', reasoningLevel = 'max') => ({ mode: 'specified', providerId: 'custom-native', modelId, options: { reasoningLevel } });
test('specified review model uses native config while main selection stays unchanged and actual model is recorded', async t => {
  const f = await fixture(t, { reviewModel: specifiedReview() });
  const main = structuredClone(f.runtime.selection);
  assert.equal((await f.execute()).success, true);
  assert.deepEqual(f.selections[0], { providerId: 'custom-native', modelId: 'review-only', options: { reasoningLevel: 'max' } });
  assert.deepEqual(f.runtime.selection, main);
  assert.equal(f.events[0].payload.actualReviewModel.modelId, 'review-only');
});
test('workspace override wins user default; clearing override and restart resolves persisted user review selection', async t => {
  const f = await fixture(t, { reviewModel: { mode: 'inherit' }, userReviewModel: specifiedReview() });
  assert.equal((await f.execute()).success, true);
  assert.equal(f.selections[0].modelId, 'first');
  await writeFile(f.configFile, JSON.stringify({ plugins: { enabledPlugins: { 'codex-auto-approval@local': true } } }));
  assert.equal((await f.execute()).success, true);
  assert.equal(f.selections.at(-1).modelId, 'review-only');
  assert.equal(JSON.parse(await readFile(f.userConfigFile, 'utf8')).plugins.options['codex-auto-approval@local'].reviewModel.modelId, 'review-only');
});
test('in-flight review config changes invalidate old result and bind replacement to new review model', async t => {
  const f = await fixture(t, { reviewModel: specifiedReview('old-review'), delay: 350 });
  const pending = f.execute();
  for (let i = 0; !f.counts().hookCalls && i < 250; i++) await new Promise(resolve => setTimeout(resolve,20));
  await writeFile(f.configFile, JSON.stringify({ plugins: { options: { 'codex-auto-approval@local': { reviewModel: specifiedReview('new-review') } } } }));
  assert.equal((await pending).success, true);
  assert.equal(f.counts().executions, 1);
  assert.equal(f.selections.at(-1).modelId, 'new-review');
  assert.equal(f.events.find(event=>event.type==='permission_review_completed').payload.actualReviewModel.modelId,'new-review');
  assert.ok(f.events.some(event=>event.type==='permission_review_started' && event.payload.actualReviewModel?.modelId==='new-review'));
});
test('private reasoning and metadata survive every native read continuation without leaking or crossing reviews', async t => {
  const f = await fixture(t, { investigate: true });
  assert.equal((await f.execute()).success, true);
  assert.equal(f.requests.length,3);
  const assistants = f.requests[2].messages.filter(message => message.role === 'assistant');
  assert.equal(assistants.length,2);
  for (const assistant of assistants) {
    assert.match(JSON.stringify(assistant.content),/HIDDEN_REVIEW_REASONING/);
    assert.match(JSON.stringify(assistant.content),/PRIVATE_SIGNATURE/);
    assert.equal(assistant.toolCalls[0].providerOptions.openai.itemId,'PRIVATE_TOOL_ITEM');
    assert.equal(assistant.providerOptions.openai.responseId,'PRIVATE_RESPONSE_ID');
  }
  assert.equal(f.requests[1].messages.at(-1).toolName,'read_file');
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages),/HIDDEN_SECRET|MAIN_PROVIDER_METADATA/);
  assert.doesNotMatch(JSON.stringify(f.events),/HIDDEN_REVIEW_REASONING|PRIVATE_SIGNATURE|PRIVATE_TOOL_ITEM|PRIVATE_RESPONSE_ID/);
  assert.equal((await f.execute()).success,true);
  assert.doesNotMatch(JSON.stringify(f.requests[3].messages),/HIDDEN_REVIEW_REASONING|PRIVATE_/);
});
test('unsupported model tools fail to human and never execute',async t => {
  const f=await fixture(t,{ supportsTools:false });
  assert.equal((await f.execute()).success,false);
  assert.equal(f.counts().executions,0);
  assert.equal(f.counts().hookCalls,0);
  assert.equal(f.events.find(event=>event.type==='permission_requested').payload.reviewFailure.code,'review_model_incompatible');
});

for (const [label,options,code] of [
 ['deleted model',{missingModel:true},'review_model_not_found'],
 ['missing native credentials',{missingCredential:true},'review_credentials_missing'],
 ['unsupported reasoning',{reviewModel:specifiedReview('review','impossible')},'invalid_model_request'],
 ['malformed stored model option',{reviewModel:{mode:'specified',providerId:'custom-native',modelId:'review',apiKey:'never-accepted'}},'review_configuration_invalid'],
]) test(`${label} fails to human without fallback model`,async t=>{
 const f=await fixture(t,options);assert.equal((await f.execute()).success,false);assert.equal(f.counts().executions,0);assert.equal(f.counts().hookCalls,0);
 assert.equal(f.events.find(event=>event.type==='permission_requested').payload.reviewFailure.code,code);
});

test('configuration changed after validated result retains actual model provenance and requires human before execution',async t=>{
 const f=await fixture(t,{reviewModel:specifiedReview('actually-called'),mutateAfterReview:true});
 assert.equal((await f.execute()).success,false);assert.equal(f.counts().executions,0);assert.equal(f.counts().humanRequests,1);
 const completed=f.events.find(event=>event.type==='permission_review_completed'&&event.payload.outcome==='allow');
 assert.equal(completed.payload.actualReviewModel.modelId,'actually-called');
 assert.equal(f.events.find(event=>event.type==='permission_requested').payload.reviewFailure.code,'stale_context');
});

test('technical failure records the last invoked model even if native config changed before manual fallback',async t=>{
 const f=await fixture(t,{reviewModel:specifiedReview('actually-failed'),failure:'authentication',delay:350});
 const pending=f.execute();
 for(let i=0;!f.counts().hookCalls&&i<250;i++)await new Promise(resolve=>setTimeout(resolve,20));
 await writeFile(f.configFile,JSON.stringify({plugins:{options:{'codex-auto-approval@local':{reviewModel:{mode:'specified',providerId:'deleted-provider',modelId:'deleted-model',apiKey:'invalid'}}}}}));
 assert.equal((await pending).success,false);assert.equal(f.counts().executions,0);
 assert.equal(f.events.filter(event=>event.type==='permission_review_completed').at(-1).payload.actualReviewModel.modelId,'actually-failed');
});

for (const [label,humanResult,executed] of [
 ['allow once',{decision:'allow'},true],
 ['modified input',{decision:'allow',modifiedInput:{value:'changed action'}},false],
 ['permission updates',{decision:'allow',permissionUpdates:[{type:'addRules',rules:[]}]},false],
]) test(`late authorization fallback handles ${label} without widening the action`,async t=>{
 const f=await fixture(t,{reviewModel:specifiedReview('called-review'),mutateBeforeExecution:true,clickImmediately:true,humanResult});
 assert.equal((await f.execute()).success,executed);assert.equal(f.counts().executions,executed?1:0);assert.equal(f.counts().humanRequests,1);
 const requested=f.events.find(event=>event.type==='permission_requested');
 assert.equal(requested.payload.optionsPolicy,'no-always-allow');
 assert.ok(f.events.find(event=>event.type==='permission_resolved'));
});
