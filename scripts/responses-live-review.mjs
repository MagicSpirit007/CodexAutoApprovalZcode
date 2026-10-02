// Explicit opt-in acceptance only. Credentials and request bodies remain in memory.
import { readFile, writeFile, mkdtemp, rm, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ApiProviderModelRuntime } from '../host-adapter/upstream/apps/zcode-cli/packages/bootstrap/dist/app/provider-registry-model-runtime.js';
// Match @zcode/provider's export used by the native decoders and model runtime.
// A separate dist copy creates incompatible instances of classes with private fields.
import { ProviderRegistryService, ProviderConfigMap, serializeRegistryModelConfig } from '../host-adapter/upstream/packages/provider/src/index.ts';
import { decodeProviderConfigFile } from '../host-adapter/upstream/packages/provider-node/dist/provider-config-file-codec.js';
import { decodeZCodeBuiltinRelease } from '../host-adapter/upstream/packages/provider-node/dist/zcode-builtin-release.js';
import { createNetworkProxyFetch } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/network/proxy-fetch.js';
import { AiSdkModelAdapter } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/model/index.js';
import { defaultRuntime } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/model/runner-runtime.js';
import { createNodeApprovalBridge } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/exec/index.js';
import { createRuntimeApprovalBridge } from '../host-adapter/upstream/apps/zcode-cli/packages/core/dist/runtime/helpers/approval-bridge.js';
import { approvalReviewFailure } from '../host-adapter/upstream/apps/zcode-cli/packages/contracts/dist/index.js';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const summary = { stage: 'config-read', liveAttempted: false, completed: false, providerLocked: true, modelLocked: true, reasoningLevel: 'max', examples: [], cleaned: false };
const preflightOnly = process.argv[2] === '--preflight-only';
if (!preflightOnly && process.argv[2] !== '--execute-reviewed') throw new Error('Explicit reviewed execution flag required');
const profile = process.argv[3];
if (!profile) throw new Error('Provide the existing .zcode directory');
const receipt = process.argv[4] ?? 'docs/evidence/responses-continuation-2026-10-02/live.json';
// 显式覆盖仅改变本次验收绑定，不写入用户配置，也不默认使用私人供应商。
const overrides = new Map();
for (let index = 5; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  if (!['--provider-id', '--model-id', '--reasoning-level', '--plugin-id'].includes(name) || !process.argv[index + 1]) throw new Error('Unsupported acceptance argument');
  overrides.set(name, process.argv[index + 1]);
}
const builtinFiles = [];
const discoverBuiltins = async directory => {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await discoverBuiltins(file);
    else if (entry.isFile() && entry.name === 'zcode-builtin.json') builtinFiles.push(file);
  }
};
let workspace, transport, registry, modelRuntime;
const registries = [];
const observedFiles = [path.join(profile, 'v2/provider_config.json'), path.join(profile, 'v2/setting.json'), path.join(profile, 'cli/config.json')];
const fingerprints = async () => Promise.all(observedFiles.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')));
let before;
const originalFetch = globalThis.fetch;
try {
  const pluginId = overrides.get('--plugin-id') ?? 'codex-auto-approval@codex-auto-review-local';
  const configured = (await readJson(path.join(profile, 'cli/config.json'))).plugins?.options?.[pluginId]?.reviewModel;
  const PROVIDER = overrides.get('--provider-id') ?? (configured?.mode === 'specified' ? configured.providerId : undefined);
  const MODEL = overrides.get('--model-id') ?? (configured?.mode === 'specified' ? configured.modelId : undefined);
  const reasoningLevel = overrides.get('--reasoning-level') ?? configured?.options?.reasoningLevel ?? 'max';
  if (!PROVIDER || !MODEL || reasoningLevel !== 'max') throw Object.assign(new Error('Explicit provider/model and max reasoning required'), { code: 'review_selection_unavailable' });
  await discoverBuiltins(path.join(profile, 'v2/runtime/provider'));
  if (builtinFiles.length === 0) builtinFiles.push(path.resolve('host-adapter/upstream/config/provider/zcode-builtin.json'));
  builtinFiles.sort();
  observedFiles.push(...builtinFiles);
  before = await fingerprints();
  const personal = decodeProviderConfigFile(await readJson(path.join(profile, 'v2/provider_config.json')));
  summary.stage = 'native-resolve';
  const snapshots = [];
  for (const file of builtinFiles) {
    summary.nativeResolveStep = 'builtin-decode';
    const release = decodeZCodeBuiltinRelease(await readJson(file));
    const config = { revision: 'isolated-memory', zcodeBuiltinRevision: String(release.revision), personalRevision: 'isolated-memory',
      zcodeBuiltinProviders: release.config.providers, zcodeBuiltinProviderTemplates: release.config.providerTemplates,
      zcodeBuiltinModelRules: release.config.modelConfigRules, personalProviders: personal.providers, personalModels: personal.models };
    const current = new ProviderRegistryService({ configSource: { read: async () => config, onDidChange: () => () => {} },
      accountSource: { read: async () => ({ revision: 'isolated-memory', basedOnZCodeBuiltinRevision: config.zcodeBuiltinRevision, providers: ProviderConfigMap.empty() }), onDidChange: () => () => {} } });
    registries.push(current);
    summary.nativeResolveStep = 'registry-start';
    await current.start();
    summary.nativeResolveStep = 'target-resolve';
    const provider = current.getProvider(PROVIDER), model = current.getModel(PROVIDER, MODEL);
    if (!provider || !model || provider.config.api.type !== 'openai-responses' || provider.config.access.type !== 'api-key' || !provider.config.access.apiKey) throw Object.assign(new Error('Locked native configuration unavailable'), { code: 'locked_config_unavailable' });
    summary.nativeResolveStep = 'model-fingerprint';
    snapshots.push({ registry: current, provider, model, fingerprint: JSON.stringify(serializeRegistryModelConfig(model.config)) });
  }
  summary.nativeConfigurationsAgree = snapshots.every(item => item.fingerprint === snapshots[0].fingerprint);
  if (!summary.nativeConfigurationsAgree) throw Object.assign(new Error('Native builtin configurations differ'), { code: 'native_config_mismatch' });
  registry = snapshots[0].registry;
  snapshots.slice(1).forEach(item => item.registry.dispose());
  const { model } = snapshots[0];
  if (!model.config.optionSpecs.reasoningLevel.values.includes('max')) throw Object.assign(new Error('Native max reasoning unavailable'), { code: 'reasoning_unavailable' });
  summary.stage = 'review-selection';
  summary.explicitSelectionOverride = overrides.has('--provider-id') || overrides.has('--model-id');
  if (preflightOnly) { summary.preflightVerified = true; throw Object.assign(new Error('Preflight finished'), { code: 'preflight_finished' }); }
  summary.stage = 'network';
  const settings = await readJson(path.join(profile, 'v2/setting.json'));
  transport = createNetworkProxyFetch({ fetch: originalFetch, env: {}, httpProxy: settings.httpProxy, noProxy: settings.httpProxyNoProxy, caCertFile: settings.httpProxyCaCertPath });
  let active;
  globalThis.fetch = async (url, init) => {
    // Observe only safe structure, never retain or print a body, URL or headers.
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (active) {
      active.requests++;
      active.stateless &&= body.store === false && Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content') && !body.previous_response_id && !body.conversation;
      const input = Array.isArray(body.input) ? body.input : [];
      active.noReferences &&= !input.some(item => item.type === 'item_reference');
      const calls = input.filter(item => item.type === 'function_call');
      const results = input.filter(item => item.type === 'function_call_output');
      if (results.length) {
        active.continuations++;
        active.paired &&= calls.length === results.length && new Set(calls.map(call => call.call_id)).size === calls.length && new Set(results.map(result => result.call_id)).size === results.length && results.every(result => calls.some(call => call.call_id === result.call_id));
        active.argumentsIntact &&= calls.every(call => ['read_file', 'list_files'].includes(call.name) && typeof call.arguments === 'string' && call.arguments.length > 0);
      }
      active.encryptedRestored ||= input.some(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string');
    }
    return transport(url, init);
  };
  workspace = await mkdtemp(path.join(tmpdir(), 'responses-live-private-'));
  for (const file of ['one.txt', 'two.txt']) await writeFile(path.join(workspace, file), 'This isolated text file contains only synthetic acceptance data.');
  const selection = { providerId: PROVIDER, modelId: MODEL, options: { reasoningLevel: 'max' } };
  // SDK's default onError prints raw APICallError bodies/headers; errors still propagate through model events.
  const adapter = new AiSdkModelAdapter({ env: {}, modelIoFullRetentionEnabled: false, runtime: { ...defaultRuntime,
    streamText: options => defaultRuntime.streamText({ ...options, onError: () => {} }) } });
  modelRuntime = new ApiProviderModelRuntime({ registry, modelAdapter: adapter });
  modelRuntime.start();
  let authorization = '';
  const runtime = { sessionId: 'isolated-live-session', workingDirectory: workspace, branchGeneration: 0, config: { mode: 'build', taskType: 'interactive' },
    rootTraceContext: { traceId: 'isolated-live-trace', sessionId: 'isolated-live-session' }, getSessionModelSelection: () => selection,
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [{ message: { role: 'user', content: authorization }, metadata: { source: 'real_user' } }] },
    modelFactory: ({ selection: actual }) => {
      if (actual.providerId !== PROVIDER || actual.modelId !== MODEL || actual.options?.reasoningLevel !== 'max') throw new Error('Unexpected model selection');
      const native = modelRuntime.modelFactory({ selection: actual });
      const wrap = current => ({ ...current, providerId: current.providerId, modelId: current.modelId, properties: current.properties, optionSpecs: current.optionSpecs, options: current.options,
        bind: options => wrap(current.bind(options)), generateText: request => current.generateText(request),
        streamText: async function* (request) { for await (const event of current.streamText(request)) { if (event.type === 'tool_call') active.readCalls++; if (event.providerMetadata?.openai?.reasoningEncryptedContent) active.encryptedReturned = true; yield event; } } });
      return wrap(native);
    } };
  const bridge = createRuntimeApprovalBridge(runtime, createNodeApprovalBridge);
  summary.stage = 'investigation';
  for (const file of ['one.txt', 'two.txt']) {
    active = { requests: 0, readCalls: 0, continuations: 0, stateless: true, noReferences: true, paired: true, argumentsIntact: true, encryptedReturned: false, encryptedRestored: false, decision: 'unverified', executorCount: 0 };
    summary.examples.push(active);
    authorization = `I authorize reading ${file} only. Before deciding, you must use read_file to inspect ${file}. It contains synthetic data. Do not write or execute any command.`;
    const hook = { hookEventName: 'PermissionRequest', cwd: workspace, sessionId: runtime.sessionId, turnId: file, requestId: file, toolCallId: file, toolName: 'ReadProbe', toolInput: { path: file }, mode: 'build' };
    const lease = await bridge.open(hook, new AbortController().signal);
    try {
      summary.liveAttempted = true;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['plugins/codex-auto-approval/bin/permission-request.js'], { env: { PATH: process.env.PATH, ...lease.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', chunk => { output += chunk; if (output.length > 32768) child.kill(); }); child.on('error', reject);
        child.on('close', code => { try { if (code !== 0) throw new Error('Isolated plugin failed'); resolve(JSON.parse(output)); } catch (error) { reject(error); } });
        child.stdin.end(JSON.stringify(hook));
      });
      const decision = lease.finish(result).hookSpecificOutput?.decision;
      active.decision = ['allow', 'deny', 'ask'].includes(decision?.behavior) ? decision.behavior : 'unverified';
      if (active.decision === 'allow') active.executorCount++; // Intentionally no file/command side effect.
      if (decision?.reviewFailure) { const safe = approvalReviewFailure(decision.reviewFailure); active.failure = { code: safe.code, ...(safe.httpStatus ? { httpStatus: safe.httpStatus } : {}) }; }
    } finally { await lease.close(); }
  }
  summary.completed = summary.examples.every(example => example.decision === 'allow' && example.executorCount === 1 && example.readCalls > 0 && example.continuations > 0 && example.paired && example.argumentsIntact && example.stateless && example.noReferences && (!example.encryptedReturned || example.encryptedRestored));
} catch (error) {
  if (error?.code === 'preflight_finished' && preflightOnly) {
    summary.preflightVerified = true;
  } else {
  const safe = approvalReviewFailure(error);
  summary.failure = { stage: summary.stage, code: safe.code, ...(safe.httpStatus ? { httpStatus: safe.httpStatus } : {}) };
  summary.failure.errorClass = ['TypeError', 'ZodError', 'Error'].includes(error?.name) ? error.name : 'OtherError';
  if (preflightOnly && typeof error?.stack === 'string') {
    const frame = error.stack.split('\n').slice(1).find(line => /\/(registry-service|resolver|model-config|provider-config)\.(js|ts):\d+:\d+/.test(line));
    const location = frame?.match(/\/(registry-service|resolver|model-config|provider-config)\.(js|ts):(\d+):(\d+)/);
    if (location) summary.failure.safeSource = `${location[1]}.${location[2]}:${location[3]}`;
  }
  }
} finally {
  summary.stage = 'finalize';
  globalThis.fetch = originalFetch;
  modelRuntime?.dispose();
  registries.forEach(current => current.dispose());
  if (workspace) await rm(workspace, { recursive: true, force: true });
  summary.cleaned = true;
  if (before) summary.configurationUnchanged = JSON.stringify(before) === JSON.stringify(await fingerprints());
  if (summary.configurationUnchanged === false) {
    summary.completed = false;
    summary.failure = { stage: 'finalize', code: 'config_changed_during_acceptance' };
  }
  await mkdir(path.dirname(receipt), { recursive: true });
  await writeFile(receipt, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ completed: summary.completed, liveAttempted: summary.liveAttempted, examples: summary.examples.length, cleaned: summary.cleaned }));
  if (!summary.completed && !(preflightOnly && summary.preflightVerified && summary.configurationUnchanged)) process.exitCode = 2;
}
