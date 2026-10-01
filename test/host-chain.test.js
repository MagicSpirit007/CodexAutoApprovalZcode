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

const sourcePlugin = path.resolve('plugins/codex-auto-approval');
const assess = outcome => JSON.stringify({ outcome, risk_level: outcome === 'allow' ? 'low' : 'high', user_authorization: 'high', rationale: 'Native test policy result' });
async function fixture(t, { outcome = 'allow', failure, mode = 'build', disabled = false, delay = 0, userDisabled = false } = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zcode-native-chain-'));
  const plugin = path.join(workspace, 'installed-plugin');
  await cp(sourcePlugin, plugin, { recursive: true });
  const selections = [], requests = [], events = [], retryBudgets = [];
  let executions = 0, humanRequests = 0, hookCalls = 0;
  const runtime = {
    sessionId: 'native-session', workingDirectory: workspace, branchGeneration: 0,
    config: { mode, taskType: 'interactive' }, rootTraceContext: { traceId: 'trace', sessionId: 'native-session', turnId: 'turn' },
    selection: { providerId: 'native-provider', modelId: 'first', options: { reasoningLevel: 'high' } },
    getSessionModelSelection() { return this.selection; },
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [
      { message: { role: 'user', content: 'Execute the approved probe' }, metadata: { source: 'real_user' } },
      { message: { role: 'user', content: 'Synthetic message is not human authorization' }, metadata: { source: 'legacy_synthetic' } },
      { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'HIDDEN_SECRET' }, { type: 'text', text: 'Visible plan' }] } },
    ] },
    modelFactory({ selection }) {
      selections.push(structuredClone(selection));
      return createModel({ providerId: selection.providerId, modelId: selection.modelId, options: selection.options,
        properties: { supportsToolCall: true },
        optionSpecs: { maxOutputTokens: { max: 4096 }, reasoningLevel: { values: ['high', 'max'] } }, executor: {
        async generateText(request) {
          hookCalls++; requests.push(request);
          retryBudgets.push(getCurrentModelInvocationContext()?.modelRetryBudget);
          if (delay) await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            request.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(request.abortSignal.reason); }, { once: true });
          });
          if (failure) throw Object.assign(new Error(failure), { code: failure });
          return { text: assess(outcome), finishReason: 'stop', usage: {} };
        },
      } });
    },
  };
  const configFile = path.join(workspace, 'config.json');
  await writeFile(configFile, JSON.stringify({ plugins: { enabledPlugins: { 'codex-auto-approval@local': true } } }));
  const userConfigFile = path.join(workspace, 'user-config.json');
  await writeFile(userConfigFile, JSON.stringify({ plugins: { enabledPlugins: { 'codex-auto-approval@local': !userDisabled } } }));
  const bridge = createRuntimeApprovalBridge(runtime, createConfiguredNodeApprovalBridge([userConfigFile, configFile]));
  const executionPort = createNodeExecutionAdapter();
  const hookRunner = createConfiguredHookRunner({ approvalBridgePort: bridge, executionPort, getWorkingDirectory: () => workspace,
    config: { enabled: !disabled, maxOutputBytes: 32768, timeoutMs: 95000, events: { PermissionRequest: [{ matcher: '*', hooks: [{
      type: 'process', command: process.execPath, args: [path.join(plugin, 'bin/permission-request.js')], timeoutMs: 95000,
      plugin: { name: 'codex-auto-approval', id: 'codex-auto-approval@local', rootPath: plugin, dataPath: path.join(workspace, 'data') },
    }] }] } } });
  const registry = new ToolRegistryImpl();
  registry.register({ name: 'ApprovalProbe', description: 'Test approval execution count', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    metadata: { name: 'ApprovalProbe', readOnly: false, destructive: false, concurrentSafe: false, sideEffectScope: 'filesystem', riskLevel: 'medium', needsApproval: true },
    handler: async () => { executions++; return { executed: true }; } });
  const permissionService = new PermissionService();
  const permissionBroker = { requestPermission: async (_request, { signal }) => {
    humanRequests++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ decision: 'deny', reason: 'Human test fallback' }), 1800);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  } };
  const executor = createToolExecutor({ registry, permissionService, permissionBroker, hookRunner,
    emitEvent: async event => events.push(event), sessionId: runtime.sessionId, workingDirectory: workspace, mode,
    traceContext: runtime.rootTraceContext });
  t.after(async () => {
    await executionPort.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { runtime, selections, requests, events, retryBudgets, executor, bridge, permissionService, configFile,
    counts: () => ({ executions, humanRequests, hookCalls }),
    execute: (id = crypto.randomUUID(), options) => executor.execute({ id, name: 'ApprovalProbe', input: { value: 'same action' } }, { traceContext: runtime.rootTraceContext, ...options }) };
}

test('native permission chain executes exactly once and inherits session model/options', async t => {
  const f = await fixture(t);
  const result = await f.execute();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.counts().executions, 1);
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
  while (!f.counts().hookCalls) await new Promise(resolve => setTimeout(resolve, 20));
  f.runtime.selection = { ...f.runtime.selection, modelId: 'changed-mid-review', options: { reasoningLevel: 'max' } };
  const result = await promise;
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.counts().executions, 1);
  assert.equal(f.selections.at(-1).modelId, 'changed-mid-review');
});
test('native plugin deactivation cancels review and restores human fallback in current session', async t => {
  const f = await fixture(t, { delay: 5000 });
  const promise = f.execute();
  while (!f.counts().hookCalls) await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(f.configFile, JSON.stringify({ plugins: { enabledPlugins: { 'codex-auto-approval@local': false } } }));
  assert.equal((await promise).success, false);
  assert.equal(f.counts().executions, 0);
  assert.equal(f.counts().hookCalls, 1);
  assert.match(JSON.stringify(await f.execute()), /Human test fallback/);
  assert.equal(f.counts().hookCalls, 1);
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
  assert.equal(JSON.parse(await readFile(path.join(installed.installPath, 'build-info.json'), 'utf8')).bridgeProtocol, 1);
  const adapter = createNodePluginAdapter({ storageRoot });
  const config = { enabled: true, dirs: [], extraKnownMarketplaces: {}, enabledPlugins: { [installed.id]: true }, suppressedBuiltins: [], options: {} };
  const discover = () => adapter.discoverPlugins({ config, storageRoot, workingDirectory: directory, officialPluginRoots: [] });
  assert.equal((await discover()).hooks.PermissionRequest.length, 1);
  config.enabledPlugins[installed.id] = false;
  assert.equal((await discover()).hooks.PermissionRequest, undefined);
  await uninstallMarketplacePlugin({ pluginId: installed.id, storageRoot, removeCache: true });
  assert.equal((await discover()).plugins.some(plugin => plugin.id === installed.id), false);
});
