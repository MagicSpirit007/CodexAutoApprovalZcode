async function expandCompletedHistory(page) {
  for (let pass = 0; pass < 3; pass++) {
    const closed = page.locator('[data-testid^="chat-assistant-history-trigger-"][data-history-open="false"]');
    const count = await closed.count();
    if (!count) return;
    for (let i = count - 1; i >= 0; i--) await closed.nth(i).click();
    await page.waitForTimeout(200);
  }
}
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw new Error('Run with Windows Node');
const liveGLM = process.argv.includes('--live-glm') || process.argv.includes('--glm-deepseek-review');
const independentDeepSeek = process.argv.includes('--glm-deepseek-review');
const diagnoseGLM = process.argv.includes('--diagnose-glm');
if (independentDeepSeek && !process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY missing; scenario unverified');
const childSafeEnv = { ...process.env };
delete childSafeEnv.DEEPSEEK_API_KEY;
const root = path.resolve('.'), output = path.join(root, 'artifacts/0.1.3/acceptance', independentDeepSeek ? 'glm-main-deepseek-review' : liveGLM ? 'live-glm' : 'windows');
await mkdir(output, { recursive: true });
const profile = liveGLM ? path.join(root, `.private-live-profile-${Date.now()}`) : path.join(output, `e2e-profile-${Date.now()}`);
let cleanupApp, cleanupBrowser, cleanupServer, cleanupLiveSummary, cleanupLiveSummaryPath;
const isGLMTargetLabel = value => /glm[-\s]*5[.]3[-\s]*flash/i.test(value);
let failureStep = 'profile-setup';
let nativeMainProviderReference;
const modelSelectionFacts = { glmChoiceCount: 0, triggerIncludesTarget: false, nativeGLMReferenceFound: false, nativeGLMReferenceEnabled: false };
let safeFailure = () => ({ code: 'setup_error' });
const recordLiveFailure = error => {
  cleanupLiveSummary ??= { ordinaryGLMCompleted: false, reviewCompleted: false, setupOrRuntimeFailure: true };
  const failure = safeFailure(error);
  cleanupLiveSummary.failureStep = failureStep;
  cleanupLiveSummary.ordinaryRequestAttempted = modelSelectionFacts.ordinaryRequestAttempted === true;
  cleanupLiveSummary.reviewActionAttempted = modelSelectionFacts.reviewActionAttempted === true;
  cleanupLiveSummary.modelSelectionFacts = modelSelectionFacts;
  cleanupLiveSummary.failure = { code: failure.code, message: `Isolated acceptance failed during ${failureStep}`, retryable: failure.retryable === true };
  if (error?.code === 'ENOENT') cleanupLiveSummary.failure.code = 'missing_fixture_input';
  process.exitCode = 1;
};
try {
await mkdir(profile, { recursive: true });
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
let scenario = 'allow';
const requests = [], errors = [];
const server = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
  const body = JSON.parse(text);
  const review = body.tools?.some(tool => tool.function?.name === 'read_file');
  requests.push({ scenario, review, stream: body.stream, sessionId: req.headers['x-session-id'], queryId: req.headers['x-query-id'], model: body.model, toolNames: body.tools?.map(tool => tool.function?.name),
    roles: body.messages?.map(message => message.role),
    denialFeedback: body.messages?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('must not attempt')) });
  if (review && scenario.startsWith('failure')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Acceptance authentication failure","type":"authentication_error"}}'); return; }
  let message;
  if (review) message = { role: 'assistant', content: JSON.stringify({ outcome: scenario === 'deny' ? 'deny' : 'allow',
    risk_level: scenario === 'deny' ? 'high' : 'low', user_authorization: 'high', rationale: `Acceptance ${scenario} decision` }) };
  else if (body.tools?.some(tool => tool.function?.name === 'Bash') && !body.messages.some(item => item.role === 'tool')) {
    const target = path.join(profile, 'workspace', `probe-${scenario}.txt`);
    message = { role: 'assistant', content: '', tool_calls: [{ id: `probe-${scenario}`, type: 'function', function: {
      name: 'Bash', arguments: JSON.stringify({ command: `powershell.exe -NoProfile -Command "Add-Content -LiteralPath '${target}' -Value 'executed'"`, description: `Controlled ${scenario} approval probe` }),
    } }] };
  } else message = { role: 'assistant', content: `E2E_DONE_${scenario}` };
  const base = { id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })); return; }
  if (review) await new Promise(resolve => setTimeout(resolve, 2500));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
  res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
cleanupServer = server;
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { prepareDesktopFixture, inspectDesktopFixture, toggleDesktopFixture, uninstallDesktopFixture, armDesktopFixtureApproval, sanitizeAcceptanceFailure, rekeyDesktopFixtureCredentials, probeNativeAccountCredential } = await import('../artifacts/0.1.3/acceptance/desktop-fixture.bundle.mjs');
safeFailure = sanitizeAcceptanceFailure;
failureStep = 'fixture-setup';
const fixture = await prepareDesktopFixture(root, profile, server.address().port);
if (liveGLM) {
  // Read current native encrypted credentials only into a disposable isolated profile.
  for (const name of ['provider_config.json', 'credentials.json', 'setting.json', 'coding-plan-cache.json']) {
    failureStep = `profile-copy-${name.replace('.json', '')}`;
    await cp(path.join(homedir(), '.zcode/v2', name), path.join(profile, '.zcode/v2', name));
  }
  failureStep = 'isolated-credential-rekey';
  modelSelectionFacts.credentialsRekeyed = await rekeyDesktopFixtureCredentials(profile);

  failureStep = 'native-catalog-copy';
  await cp(path.join(homedir(), '.zcode/v2/runtime/provider'), path.join(profile, '.zcode/v2/runtime/provider'), { recursive: true });
  // The staged source renderer is 3.14.3; preserve the endpoint-scoped public
  // catalog while placing it in the exact version path consumed by its source.
  const nativeCache = path.join(profile, '.zcode/v2/runtime/provider/windows-x86_64');
  try { await access(path.join(nativeCache, '3.14.4')); await cp(path.join(nativeCache, '3.14.4'), path.join(nativeCache, '3.14.3'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  failureStep = 'restore-native-glm-reference';
  const nativeProviderPath = path.join(profile, '.zcode/v2/provider_config.json');
  const nativeProviders = JSON.parse(await readFile(nativeProviderPath, 'utf8'));
  const accountSettings = JSON.parse(await readFile(path.join(profile, '.zcode/v2/setting.json'), 'utf8'));
  const accountFamily = accountSettings.providerFamilyDomain;
  const accountPlanKind = accountSettings.providerFamilyConnectionSelections?.[accountFamily]?.kind;
  const catalogCandidates = [];
  const scanCatalog = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scanCatalog(file);
      else if (entry.name === 'zcode-builtin.json') {
        const release = JSON.parse(await readFile(file, 'utf8'));
        const rule = release.config?.modelConfigRules?.builtinProviderModelRules?.find(item => {
          if (item.modelId?.toLowerCase() !== 'glm-5.3-flash') return false;
          const provider = release.config.providerConfigRules.providerRules.find(value => value.providerId === item.providerId);
          return provider?.config?.access?.type === 'zhipu-account' && provider.config.access.accountType === accountFamily && provider.config.access.mode === accountPlanKind;
        });
        if (rule) catalogCandidates.push({ revision: release.revision, rule });
      }
    }
  };
  await scanCatalog(path.join(nativeCache, '3.14.3'));
  catalogCandidates.sort((a, b) => b.revision - a.revision);
  const glmRule = nativeProviders.config.modelConfigRules.providerModelRules.find(rule => rule.modelId.toLowerCase() === 'glm-5.3-flash') ?? catalogCandidates[0]?.rule;
  modelSelectionFacts.sameNativeAccountSelectionMatched = !!accountFamily && !!accountPlanKind && catalogCandidates.length > 0;
  modelSelectionFacts.compatibleCatalogReferenceFound = catalogCandidates.length > 0;
  modelSelectionFacts.compatibleCatalogRevision = catalogCandidates[0]?.revision ?? 0;

  modelSelectionFacts.nativeGLMReferenceFound = !!glmRule;
  modelSelectionFacts.nativeGLMReferenceEnabled = glmRule?.config?.enabled !== false;
  assert.ok(glmRule, 'Compatible catalog reference for current native account required');
  nativeMainProviderReference = glmRule.providerId;
  failureStep = 'native-read-only-account-key';
  modelSelectionFacts.nativeAuthentication = await probeNativeAccountCredential(profile, nativeMainProviderReference);
  if (glmRule) nativeProviders.config.defaultModelSelection = { providerId: glmRule.providerId, modelId: glmRule.modelId };
  await writeFile(nativeProviderPath, JSON.stringify(nativeProviders));
  const settingsPath = path.join(profile, '.zcode/v2/setting.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.recentProjects = [];
  settings.modelIoFullRetentionEnabled = false;
  await writeFile(settingsPath, JSON.stringify(settings));
  if (independentDeepSeek) {
    const providerPath = path.join(profile, '.zcode/v2/provider_config.json');
    const providers = JSON.parse(await readFile(providerPath, 'utf8'));
    providers.config.providerConfigRules.providerRules.push({ providerId: 'deepseek-live', providerName: 'DeepSeek Live', enabled: true,
      config: { group: 'standard-personal', access: { type: 'api-key', apiKey: process.env.DEEPSEEK_API_KEY },
        api: { type: 'openai-chat-completions', baseUrl: 'https://api.deepseek.com' }, personalModelIds: ['deepseek-flash'] } });
    providers.config.modelConfigRules.providerModelRules.push({ providerId: 'deepseek-live', modelId: 'deepseek-flash', config: {
      enabled: true, properties: { contextWindow: 1000000, supportsToolCall: true, supportsJsonSchemaOutput: false },
      optionSpecs: { maxOutputTokens: { max: 8192, map: '{"max_tokens": maxOutputTokens}' },
        reasoningLevel: { values: ['high'], map: '{"thinking":{"type":"enabled"},"reasoning_effort":reasoningLevel}' } } } });
    await writeFile(providerPath, JSON.stringify(providers));
    const config = JSON.parse(await readFile(fixture.projectConfig, 'utf8'));
    config.plugins.options = { [fixture.pluginId]: { reviewModel: { mode: 'specified', providerId: 'deepseek-live', modelId: 'deepseek-flash', options: { reasoningLevel: 'high' } } } };
    await writeFile(fixture.projectConfig, JSON.stringify(config));
  }

}
if (!liveGLM) await writeFile(path.join(output, 'desktop-e2e-discovery.json'), JSON.stringify(inspectDesktopFixture(fixture), null, 2));
const desktopEnv = { ...process.env,
    USERPROFILE: profile, ZCODE_DESKTOP_USER_DATA_DIR: path.join(profile, 'appdata'), ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DATA_BASE_DIR: profile, ZCODE_STORAGE_DIR: fixture.storage,
    ZCODE_SESSION_DB_PATH: path.join(fixture.storage, 'test-session.sqlite') };
delete desktopEnv.HOME;
delete desktopEnv.ZCODE_DESKTOP_APPLICATION_NAME;
delete desktopEnv.DEEPSEEK_API_KEY;
failureStep = 'desktop-launch';
const app = spawn(path.join(root, 'artifacts/0.1.3/CodexAutoApproval-Windows/ZCode.exe'), ['--remote-debugging-port=9338', '--open-workspace', fixture.workspace], {
  env: desktopEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
cleanupApp = app;
app.on('error', () => {});
let stdout = '', stderr = '', browser, page;
app.stdout.on('data', chunk => { if (!liveGLM) stdout += chunk; });
app.stderr.on('data', chunk => { if (!liveGLM) stderr += chunk; });
try {
  let endpoint;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { endpoint = (await (await fetch('http://127.0.0.1:9338/json/version')).json()).webSocketDebuggerUrl; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(endpoint, 'Desktop acceptance endpoint unavailable');
  const require = createRequire(import.meta.url);
  browser = cleanupBrowser = await require('../host-adapter/upstream/node_modules/playwright-core').chromium.connectOverCDP(endpoint);
  for (let attempt = 0; attempt < 60; attempt++) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => /index\.html/i.test(candidate.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(page, 'Desktop window did not load');
  page.on('pageerror', error => errors.push(liveGLM ? 'page_error' : error.message));
  await page.waitForLoadState('domcontentloaded');
  for (let step = 0; step < 12; step++) {
    await page.waitForTimeout(1000);
    for (const name of ['退出引导', '使用 API key', '暂时跳过']) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.isVisible()) { await button.click(); break; }
    }
    if (await page.getByRole('button', { name: '发送', exact: true }).isVisible()) break;
  }
  if (!liveGLM) await page.screenshot({ path: path.join(output, 'desktop-e2e-ready.png') });
  if (!liveGLM) await writeFile(path.join(output, 'desktop-e2e-ready.json'), JSON.stringify({ body: await page.locator('body').innerText(),
    inputs: await page.locator('input,textarea,[contenteditable="true"]').evaluateAll(items => items.map(item => ({ tag: item.tagName, placeholder: item.getAttribute('placeholder'), role: item.getAttribute('role'), testId: item.getAttribute('data-testid'), class: item.className }))),
    buttons: await page.getByRole('button').allTextContents() }, null, 2));
  if (!process.argv.includes('--run')) { console.log(JSON.stringify({ ready: true, fixture, profile })); }
  else {
    const results = [];
    const modeTrigger = page.getByTestId('chat-mode-select-trigger');
    const selectMode = async value => {
      await page.getByRole('menu').waitFor({ state: 'hidden' });
      await modeTrigger.click();
      const item = page.getByTestId(`chat-mode-select-item-${value}`);
      await item.waitFor();
      await item.click();
      const label = { build: '变更前确认', edit: '自动编辑', yolo: '完全访问', 'codex-auto-approval': 'CodexAutoApproval' }[value];
      if (label) await modeTrigger.getByText(label, { exact: true }).waitFor({ timeout: 30000 });
      await page.getByRole('menu').waitFor({ state: 'hidden' });
      if (label) {
        const expected = value === 'codex-auto-approval';
        for (let attempt = 0; attempt < 300 && inspectDesktopFixture(fixture).plugins.find(plugin => plugin.id === fixture.pluginId).enabled !== expected; attempt++) await page.waitForTimeout(100);
        assert.equal(inspectDesktopFixture(fixture).plugins.find(plugin => plugin.id === fixture.pluginId).enabled, expected);
      }
    };
    for (let attempt = 0; attempt < 100 && !(await modeTrigger.innerText()).includes('CodexAutoApproval'); attempt++) await page.waitForTimeout(100);
    assert.match(await modeTrigger.innerText(), /CodexAutoApproval/);
    await modeTrigger.click();
    assert.equal(await page.getByRole('menuitemradio').count(), 4);
    assert.equal(await page.getByRole('menuitemradio', { name: /CodexAutoApproval/ }).count(), 1);
    if (!liveGLM) await page.screenshot({ path: path.join(output, 'desktop-permission-menu.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    await selectMode('edit');
    for (let attempt = 0; attempt < 100 && (await modeTrigger.innerText()).includes('CodexAutoApproval'); attempt++) await page.waitForTimeout(100);
    assert.equal(inspectDesktopFixture(fixture).plugins.find(plugin => plugin.id === fixture.pluginId).enabled, false);
    assert.ok(!(await modeTrigger.innerText()).includes('CodexAutoApproval'));
    await selectMode('build');
    await page.keyboard.press('Control+Shift+M');
    for (let attempt = 0; attempt < 100 && !(await modeTrigger.innerText()).includes('CodexAutoApproval'); attempt++) await page.waitForTimeout(100);
    assert.match(await modeTrigger.innerText(), /CodexAutoApproval/);
    for (let attempt = 0; attempt < 300 && !inspectDesktopFixture(fixture).plugins.find(plugin => plugin.id === fixture.pluginId).enabled; attempt++) await page.waitForTimeout(100);
    assert.equal(inspectDesktopFixture(fixture).plugins.find(plugin => plugin.id === fixture.pluginId).enabled, true);
    await selectMode('plan');
    await page.getByTestId('v4-composer-plan-marker').waitFor();
    assert.equal(inspectDesktopFixture(fixture).plugins.find(plugin => plugin.id === fixture.pluginId).enabled, true);
    await selectMode('plan');
    results.push({ scenario: 'permission-menu', passed: true, options: 4, keyboardEnable: true, nativeEditDisables: true, planIndependent: true });
    if (liveGLM) {
      const modelTrigger = page.locator('.composer-model-trigger').first();
      modelSelectionFacts.triggerIncludesTarget = isGLMTargetLabel(await modelTrigger.innerText());
      for (let i = 0; i < 100 && !modelSelectionFacts.triggerIncludesTarget; i++) {
        await page.waitForTimeout(100);
        modelSelectionFacts.triggerIncludesTarget = isGLMTargetLabel(await modelTrigger.innerText());
      }
      modelSelectionFacts.selectedIsGLM = modelSelectionFacts.triggerIncludesTarget;
      modelSelectionFacts.selectedIsDeepSeek = /deepseek/i.test(await modelTrigger.innerText());
      if (!modelSelectionFacts.triggerIncludesTarget) {
        failureStep = 'model-menu-open';
        if (!diagnoseGLM) await modelTrigger.click();
        const glmChoice = page.locator('[data-testid^="chat-model-select-item-"][data-testid*="glm-5.3-flash" i]');
        modelSelectionFacts.nativeModelItemCount = await page.locator('[data-testid^="chat-model-select-item-"]').count();
        modelSelectionFacts.nativeProviderTriggerCount = await page.locator('[data-model-provider-key][role="menuitem"]').count();
        modelSelectionFacts.glmProviderDOMPresent = await page.locator('[data-model-provider-key*="bigmodel" i]').count() > 0;
        modelSelectionFacts.noConnectedAccount = /未连接账号|未连接账户|请先登录|No connected account/i.test(await page.locator('body').innerText());
        modelSelectionFacts.nativeRadioItemCount = await page.getByRole('menuitemradio').count();
        failureStep = 'model-provider-submenu';
        if (!diagnoseGLM && !(await glmChoice.count())) {
          for (const provider of await page.locator('[data-model-provider-key][role="menuitem"]').all()) {
            await provider.hover(); await provider.press("ArrowRight"); await page.waitForTimeout(1000);
            if (await glmChoice.count()) break;
          }
        }
        modelSelectionFacts.nativeRadioItemCountAfterSubmenu = await page.getByRole('menuitemradio').count();
        modelSelectionFacts.nativeModelItemCountAfterSubmenu = await page.locator('[data-testid^="chat-model-select-item-"]').count();
        modelSelectionFacts.glmChoiceCount = await glmChoice.count();
        if (!modelSelectionFacts.glmChoiceCount) {
          failureStep = 'native-provider-diagnosis';
          modelSelectionFacts.nativeProvider = await modelTrigger.evaluate(async (node, providerId) => {
            const fiberKey = Object.keys(node).find(key => key.startsWith('__reactFiber$'));
            let fiber = fiberKey ? node[fiberKey] : undefined, service;
            while (fiber) {
              const value = fiber.memoizedProps?.services ?? fiber.memoizedProps?.value;
              if (value?.providerSettingsService) { service = value.providerSettingsService; break; }
              fiber = fiber.return;
            }
            if (!service) return { snapshotAvailable: false };
            try {
              const timedOut = Symbol('native-service-timeout');
              const view = await Promise.race([service.getView(), new Promise(resolve => setTimeout(() => resolve(timedOut), 15000))]);
              if (view === timedOut) return { snapshotAvailable: false, nativeServiceReadTimedOut: true };
              const provider = view.providers.find(value => value.providerId === providerId);
              if (!provider) return { snapshotAvailable: true, providerPresent: false };
              const model = provider.models.find(value => value.modelId.toLowerCase() === 'glm-5.3-flash');
              const allowedReasons = ['not-authenticated', 'not-connected', 'credential-failed', 'not-entitled'];
              const state = provider.accountState;
              return { snapshotAvailable: true, providerPresent: true, providerExecutable: provider.executable,
                providerEnabled: provider.enabled, providerIssueCount: provider.issues.length,
                availability: ['available','pending','unavailable','unknown'].includes(state?.availability) ? state.availability : 'unknown',
                entitled: state?.entitled === true, current: state?.current === true,
                unavailableReason: allowedReasons.includes(state?.unavailableReason) ? state.unavailableReason : 'unknown',
                targetModelPresent: !!model, targetModelExecutable: model?.executable === true,
                targetModelSelectable: model?.selectable === true, targetModelEnabled: model?.enabled === true,
                targetModelIssueCount: model?.issues?.length ?? 0 };
            } catch { return { snapshotAvailable: false, nativeServiceReadFailed: true }; }
          }, nativeMainProviderReference);
        }
        failureStep = 'model-choice-click';
        if (!modelSelectionFacts.glmChoiceCount) failureStep = 'native_glm_unavailable';
        assert.ok(modelSelectionFacts.glmChoiceCount, 'Native GLM not selectable; native provider diagnostics required');
        await glmChoice.first().click();
      }
      failureStep = 'model-trigger-label';
      for (let i = 0; i < 100; i++) {
        modelSelectionFacts.triggerIncludesTarget = isGLMTargetLabel(await modelTrigger.innerText());
        if (modelSelectionFacts.triggerIncludesTarget) break;
        await page.waitForTimeout(100);
      }
      assert.ok(modelSelectionFacts.triggerIncludesTarget, 'Selected native model label must include target');
      if (diagnoseGLM && modelSelectionFacts.triggerIncludesTarget) { failureStep = 'native_authentication_diagnostic_only'; throw new Error('Read-only native diagnostics completed; no model request attempted'); }
      failureStep = 'thought-select';
      const thought = page.locator('[data-testid="chat-thought-level-select-trigger"]');
      await thought.click();
      await page.getByTestId('chat-thought-level-select-item-max').click();
      await thought.getByText('最高', { exact: true }).waitFor();
      failureStep = 'ordinary-main';
      modelSelectionFacts.ordinaryRequestAttempted = true;
      await page.locator('[contenteditable="true"]').first().fill('Do not use tools. Reply exactly ORDINARY_GLM_DONE.');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      let ordinaryGLMCompleted = false;
      for (let poll = 0; poll < 480; poll++) {
        if (await page.locator('[data-testid^="v4-row-"]').getByText('ORDINARY_GLM_DONE', { exact: true }).count()) { ordinaryGLMCompleted = true; break; }
        await page.waitForTimeout(250);
      }
      const ordinaryGLMServiceInterceptionObserved = /unusual activity|blocked|interception/i.test(await page.locator('body').innerText());
      await page.getByTestId('task-new-button').click();
      await armDesktopFixtureApproval(fixture);
      const command = 'for p in "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "/c/Program Files/Microsoft/Edge/Application/msedge.exe" "/c/Program Files/Google/Chrome/Application/chrome.exe"; do [ -f "$p" ] && echo "FOUND: $p"; done';
      failureStep = 'review-action';
      modelSelectionFacts.reviewActionAttempted = true;
      await page.locator('[contenteditable="true"]').first().fill(`只执行一次以下 Bash 命令，检查本机浏览器路径；这是只读操作，已经批准。不要创建或修改文件，不要调用其他工具，不要修改权限规则。执行完回复 LIVE_GLM_DONE。命令：\n${command}`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      let failure, progressSeen = false, done = false;
      for (let poll = 0; poll < 840; poll++) {
        if (!progressSeen && await page.getByTestId('auto-review-progress').isVisible()) {
          progressSeen = true;
          await page.waitForTimeout(500);
          assert.equal(await page.getByRole('button', { name: '确认', exact: true }).count(), 0);
          if (!liveGLM) await page.screenshot({ path: path.join(output, 'live-reviewing.png') });
        }
        if (await page.getByTestId('auto-review-failure').isVisible()) {
          failure = await page.getByTestId('auto-review-failure').innerText();
          if (!liveGLM) await page.screenshot({ path: path.join(output, 'live-failure.png') });
          await page.getByText('拒绝', { exact: true }).click();
          break;
        }
        if (await page.locator('[data-testid^="v4-row-"]').getByText('LIVE_GLM_DONE', { exact: true }).count()) { done = true; break; }
        await page.waitForTimeout(250);
      }
      if (!liveGLM) await page.screenshot({ path: path.join(output, 'live-result.png') });
      await expandCompletedHistory(page);
      const actualResult = page.getByTestId('auto-review-result').last();
      const actualReviewModelObserved = await actualResult.isVisible() && (await actualResult.getAttribute('data-review-model-id')) === (independentDeepSeek ? 'deepseek-flash' : 'GLM-5.3-Flash');
      const reviewAllowedObserved = await actualResult.isVisible() && (await actualResult.getAttribute('data-review-status')) === 'allow';
      const successfulBashCalls = await page.locator('[data-tool-name="Bash"][data-status="completed"]').evaluateAll(nodes =>
        new Set(nodes.map(node => node.getAttribute('data-tool-call-id')).filter(Boolean)).size);
      const boundBashSucceeded = await actualResult.isVisible() && await actualResult.evaluate(node =>
        !!node.closest('[data-row-id]')?.querySelector('[data-tool-name="Bash"][data-status="completed"]'));
      const executedExactlyOnce = successfulBashCalls === 1 && boundBashSucceeded;

      const liveSummary = { mainModel: 'GLM-5.3-Flash', reviewModel: independentDeepSeek ? 'deepseek-flash' : 'GLM-5.3-Flash',
        ordinaryGLMCompleted, ordinaryGLMServiceInterceptionObserved, reviewServiceInterceptionObserved: /unusual activity|blocked|interception/i.test(failure ?? ''), reviewAuthenticationFailureObserved: /authentication|401/i.test(failure ?? ''), reviewProgressSeen: progressSeen, actualReviewModelObserved, reviewAllowedObserved, successfulBashCalls, boundBashSucceeded, executedExactlyOnce, reviewCompleted: progressSeen && actualReviewModelObserved && reviewAllowedObserved && executedExactlyOnce && done && !failure,
        manualFailure: !!failure, reviewAttributionVerified: false,
        sameAccountOrdinaryAndReview: !independentDeepSeek, independentReviewSelection: independentDeepSeek,
        mainSelectionUnchanged: isGLMTargetLabel(await modelTrigger.innerText()),
        fullRetentionDisabled: true, temporaryProfileCleanupScheduled: true };
      cleanupLiveSummary = liveSummary;
      cleanupLiveSummaryPath = path.join(output, independentDeepSeek ? 'glm-main-deepseek-review-result.json' : 'same-account-glm-result.json');
    } else {
    const cases = process.argv.includes('--all') ? ['allow', 'deny', 'failure', 'failure-allow', 'disabled', 'uninstalled'] : ['allow'];
    for (const name of cases) {
      scenario = name;
      if (name === 'disabled') {
        await selectMode('build');
        for (let attempt = 0; attempt < 100 && (await modeTrigger.innerText()).includes('CodexAutoApproval'); attempt++) await page.waitForTimeout(100);
        assert.equal(inspectDesktopFixture(fixture).plugins.find(plugin => plugin.id === fixture.pluginId).enabled, false);
        await modeTrigger.click();
        assert.equal(await page.getByTestId('chat-mode-select-item-codex-auto-approval').isDisabled(), true);
        await page.keyboard.press('Escape');
      }
      if (name === 'uninstalled') { await toggleDesktopFixture(fixture, true); await uninstallDesktopFixture(fixture); }
      if (name !== 'allow') await page.getByTestId('task-new-button').click();
      const input = page.locator('[contenteditable="true"]').first();
      await input.fill(`E2E_${name}: Execute the controlled probe command once in this test workspace.`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const done = page.locator('[data-testid^="v4-row-"]').getByText(`E2E_DONE_${name}`, { exact: true });
      const confirm = page.getByRole('button', { name: '确认', exact: true });
      const manual = ['failure', 'failure-allow', 'disabled', 'uninstalled'].includes(name);
      if (manual) {
        await confirm.waitFor({ timeout: 45000 });
        if (name.startsWith('failure')) {
          for (let attempt = 0; attempt < 100 && !requests.some(request => request.scenario === name && request.review); attempt++) {
            await page.waitForTimeout(100);
          }
          assert.ok(requests.some(request => request.scenario === name && request.review), 'Authentication failure was not exercised');
        }
        if (name.startsWith('failure')) {
          await page.getByText('自动审查失败，需人工确认', { exact: true }).waitFor();
          assert.match(await page.getByTestId('auto-review-failure').innerText(), /authentication failed/i);
          if (!liveGLM) await page.screenshot({ path: path.join(output, `desktop-e2e-${name}-prompt.png`) });
        }
        if (name === 'failure-allow') await confirm.click();
        else await page.getByText('拒绝', { exact: true }).click();
        await done.waitFor({ timeout: 30000 });
      } else {
        await page.getByTestId('auto-review-progress').waitFor({ timeout: 30000 });
        assert.equal(await confirm.count(), 0, 'no manual prompt during automatic review');
        await page.waitForTimeout(500);
        if (!liveGLM) await page.screenshot({ path: path.join(output, `desktop-e2e-${name}-reviewing.png`) });
        await done.waitFor({ timeout: 45000 });
        assert.equal(await confirm.count(), 0, 'automatic allow/deny must never publish a manual prompt');
      }
      const probe = path.join(fixture.workspace, `probe-${name}.txt`);
      if (['allow', 'failure-allow'].includes(name)) assert.equal((await readFile(probe, 'utf8')).trim(), 'executed');
      else await assert.rejects(access(probe), { code: 'ENOENT' });
      const calls = requests.filter(request => request.scenario === name);
      assert.equal(calls.some(request => request.review), !['disabled', 'uninstalled'].includes(name));
      for (const request of calls.filter(request => request.review)) {
        assert.equal(request.stream, true);
        assert.ok(request.sessionId && request.queryId, 'review request must have native session/query headers');
      }
      if (name === 'deny') assert.ok(calls.some(request => request.denialFeedback), 'Main model did not receive corrective denial feedback');
      if (!['disabled', 'uninstalled'].includes(name)) {
        await expandCompletedHistory(page);
        const reviewResult = page.getByTestId('auto-review-result').last();
        await reviewResult.waitFor();
        assert.equal(await reviewResult.getAttribute('data-review-status'), name.startsWith('failure') ? 'failed' : name);
        assert.equal(await reviewResult.getAttribute('data-review-provider-id'), 'acceptance-local');
        assert.equal(await reviewResult.getAttribute('data-review-model-id'), 'acceptance-model');
        assert.match(await reviewResult.getAttribute('data-review-reasoning') ?? '', /^(high|max)$/);
        await reviewResult.hover();
        await page.getByTestId('auto-review-model-details').getByText(/acceptance-local/).first().waitFor();
        await page.getByTestId('auto-review-model-details').getByText(/high|max/).first().waitFor();
        await page.mouse.move(0, 0);
        if (name === 'allow') {
          await page.reload();
          await page.waitForTimeout(1000);
          await expandCompletedHistory(page);
          await page.getByTestId('auto-review-result').last().waitFor({ timeout: 30000 });
          assert.equal(await page.getByTestId('auto-review-result').last().getAttribute('data-review-model-id'), 'acceptance-model', 'Replay must retain actual review model');
        }
      }

      if (!liveGLM) await page.screenshot({ path: path.join(output, `desktop-e2e-${name}.png`) });
      results.push({ scenario: name, passed: true, humanFallback: manual, reviewerCalls: calls.filter(request => request.review).length });
      console.log(JSON.stringify(results.at(-1)));
    }
    // The plugin was uninstalled by the last case; reinstall only in the isolated fixture
    // to verify its visible name through the real marketplace/installed-list UI.
    if (process.argv.includes('--all')) {
      const { reinstallDesktopFixture } = await import('../artifacts/0.1.3/acceptance/desktop-fixture.bundle.mjs');
      await reinstallDesktopFixture(fixture);
      await page.getByTestId('plugin-store-sidebar-open').click();
      await page.getByTestId('plugin-store-manage-open').waitFor({ timeout: 30000 });
      await page.getByTestId('plugin-store-manage-open').click();
      const row = page.locator(`[data-testid="plugin-settings-plugin-row"][data-plugin-id="${fixture.pluginId}"]`);
      await row.getByText('CodexAutoApproval', { exact: true }).waitFor({ timeout: 30000 });
      if (!liveGLM) await page.screenshot({ path: path.join(output, 'desktop-plugin-display-name.png') });
      results.push({ scenario: 'plugin-display-name', passed: true, displayName: 'CodexAutoApproval' });
    }
    }
    if (!liveGLM) await writeFile(path.join(output, 'desktop-e2e-results.json'), JSON.stringify({ fixture, source: 'extracted plugin ZIP',
      directExecutableStartup: true, applicationIdentityOverride: false, results }, null, 2));
  }
} catch (error) {
  if (page && !liveGLM) {
    if (!liveGLM) await page.screenshot({ path: path.join(output, 'desktop-e2e-error.png') });
    await writeFile(path.join(output, 'desktop-e2e-error.json'), JSON.stringify({ error: error.message,
      body: await page.locator('body').innerText(), buttons: await page.getByRole('button').evaluateAll(items => items.map(item => ({ text: item.innerText, label: item.getAttribute('aria-label') }))) }, null, 2));
  }
  if (liveGLM) recordLiveFailure(error);
  else throw error;
} finally {
  await writeFile(path.join(output, 'desktop-e2e-requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(path.join(output, 'desktop-e2e-page-errors.json'), JSON.stringify(liveGLM ? { pageError: errors.length > 0 } : errors));
  if (!liveGLM) await writeFile(path.join(output, 'desktop-e2e-stdout.log'), stdout);
  if (!liveGLM) await writeFile(path.join(output, 'desktop-e2e-stderr.log'), stderr);
}

} catch (error) {
  if (liveGLM) recordLiveFailure(error);
  else throw error;
} finally {
  await cleanupBrowser?.close().catch(() => {});
  if (cleanupApp?.pid) await new Promise(resolve => {
    const stop = spawn('taskkill.exe', ['/PID', String(cleanupApp.pid), '/T', '/F'], { env: childSafeEnv });
    stop.on('exit', resolve); stop.on('error', resolve);
  });
  cleanupServer?.closeAllConnections(); cleanupServer?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  if (liveGLM) {
    cleanupLiveSummary ??= { ordinaryGLMCompleted: false, reviewCompleted: false, setupOrRuntimeFailure: true };
    cleanupLiveSummary.temporaryProfileRemoved = true;
    cleanupLiveSummaryPath ??= path.join(output, independentDeepSeek ? 'glm-main-deepseek-review-result.json' : 'same-account-glm-result.json');
    await writeFile(cleanupLiveSummaryPath, JSON.stringify(cleanupLiveSummary, null, 2));
    console.log(JSON.stringify(cleanupLiveSummary));
    if (!cleanupLiveSummary.reviewCompleted || !cleanupLiveSummary.mainSelectionUnchanged || !cleanupLiveSummary.temporaryProfileRemoved) process.exitCode = 1;
  }
}
