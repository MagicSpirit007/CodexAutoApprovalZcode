// Run with Windows Node. No raw model traffic, user text or credentials are persisted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectResponsesContinuation, responsesStream, responseMessage } from './responses-acceptance-protocol.mjs';
import { cloneChatReviewConfig } from './clone-chat-review-config.mjs';

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i].startsWith('--') && process.argv[i + 1], 'Expected named arguments with values');
  flags.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const required = name => { assert.ok(flags.has(name), `Missing --${name}`); return path.resolve(flags.get(name)); };
const desktop = required('desktop'), output = required('output'), marketplace = required('marketplace'), fixtureBundle = required('fixture-bundle');
const mode = flags.get('mode') ?? 'fixture';
assert.ok(['fixture', 'live'].includes(mode));
assert.equal(process.platform, 'win32', 'Run with Windows Node');
const debugPort = Number(flags.get('debug-port') ?? 9342);
const currentProfile = mode === 'live' ? required('current-profile') : undefined;
const summary = { mode, completed: false, profileRemoved: false, scenarios: [], stage: 'setup', pageErrors: 0 };
let app, browser, profile, server, active, remote, fixture;
const savedFiles = [], sha = data => createHash('sha256').update(data).digest('hex');
const require = createRequire(import.meta.url);
const helpers = await import(pathToFileURL(fixtureBundle).href);
try {
  await mkdir(output, { recursive: true });
  summary.agentSha256 = sha(await readFile(path.join(desktop, 'resources/glm/zcode.cjs')));
  summary.desktopAsarSha256 = sha(await readFile(path.join(desktop, 'resources/app.asar')));
  profile = await mkdtemp(path.join(output, '.private-responses-profile-'));
  let scenario = 'allow', round = 0;
  server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (!req.url?.endsWith('/responses') && !req.url?.endsWith('/chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const body = JSON.parse(raw);
      const review = body.tools?.some(tool => (tool.name ?? tool.function?.name) === 'read_file');
      let items;
      if (review) {
        active.requests++;
        const chat = req.url.endsWith('/chat/completions');
        const facts = chat ? (() => {
          const calls = body.messages.flatMap(message => message.tool_calls ?? []);
          const outputs = body.messages.filter(message => message.role === 'tool');
          assert.deepEqual(calls.map(call => call.id).sort(), outputs.map(message => message.tool_call_id).sort());
          assert.equal(new Set(calls.map(call => call.id)).size, calls.length);
          active.reasoningPresent ||= body.messages.some(message => message.role === 'assistant' && typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0);
          return { calls: calls.length, outputs: outputs.length, encrypted: 0 };
        })() : inspectResponsesContinuation(body);
        if (facts.outputs > 0) active.continuations++;
        if (facts.calls > 0) active.returnedCalls = Math.max(active.returnedCalls, facts.calls);
        active.encryptedRestored ||= facts.encrypted > 0;
        if (active.requests === 1) assert.equal(facts.calls, 0, 'Reviews must not share private continuation');
        if (mode === 'live') {
          assert.equal(body.model, remote.modelId);
          active.modelMatched = true;
          const response = await fetch(remote.url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${remote.key}` }, body: raw, signal: AbortSignal.timeout(90000) });
          active.httpError ||= !response.ok;
          res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/event-stream' });
          for await (const chunk of response.body) res.write(chunk);
          res.end(); return;
        }
        if (scenario === 'error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Synthetic authentication failure"}}'); return; }
        if (scenario === 'cancel') {
          res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
          const timer = setTimeout(() => res.end(), 90000); res.on('close', () => clearTimeout(timer)); return;
        }
        assert.equal(facts.calls, round * 2);
        if (round > 0) assert.ok(facts.encrypted > 0, 'Encrypted reasoning must be restored');
        items = round < 2 ? [
          { type: 'reasoning', id: `${scenario}-reasoning-${round}`, summary: [], encrypted_content: `synthetic-${scenario}-${round}` },
          ...[0, 1].map(index => ({ type: 'function_call', id: `${scenario}-item-${round}-${index}`, call_id: `${scenario}-call-${round}-${index}`, name: 'read_file', arguments: JSON.stringify({ path: `proof-${scenario}.txt` }), status: 'completed' })),
        ] : [responseMessage(JSON.stringify({ outcome: scenario === 'deny' ? 'deny' : 'allow', risk_level: 'low', user_authorization: 'high', rationale: 'Synthetic acceptance proof verified' }))];
        round++;
      } else {
        if (!active) {
          assert.ok(JSON.stringify(body.input ?? []).includes('ACCEPTANCE_SESSION_BOOTSTRAP'), 'Bootstrap marker required');
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(responsesStream(body.model, [responseMessage('ACCEPTANCE_SESSION_READY')], 'response-bootstrap'));
          return;
        }
        active.mainRequests++;
        const hasResult = body.input?.some(item => item.type === 'function_call_output');
        const target = path.join(fixture.workspace, `proof-${scenario}.ps1`).replaceAll('\\', '/');
        items = hasResult ? [responseMessage(`RESPONSES_DONE_${scenario}`)] : [{ type: 'function_call', id: `main-item-${scenario}`, call_id: `main-call-${scenario}`, name: 'Bash', status: 'completed',
          arguments: JSON.stringify({ command: `powershell.exe -NoProfile -File "${target}"`, description: 'Run the isolated script only after the reviewer has inspected its contents' }) }];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(responsesStream(body.model, items, `response-${scenario}-${active.requests}-${active.mainRequests}`));
    } catch {
      if (active) active.protocolError = true;
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Strict acceptance structure rejected"}}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fixture = await helpers.prepareDesktopFixture(path.resolve('.'), profile, port, { marketplace, protocol: 'openai-responses' });
  const providersPath = path.join(profile, '.zcode/v2/provider_config.json');
  const providers = JSON.parse(await readFile(providersPath, 'utf8'));
  const rules = providers.config;
  for (const rule of rules.modelConfigRules.providerModelRules) rule.config.optionSpecs = { maxOutputTokens: { max: 8192, map: '{"max_output_tokens":maxOutputTokens}' }, reasoningLevel: { values: ['max'], map: '{"reasoning":{"effort":reasoningLevel}}' } };
  const project = JSON.parse(await readFile(fixture.projectConfig, 'utf8'));
  let selection = { mode: 'specified', providerId: 'acceptance-local', modelId: 'acceptance-review-model', options: { reasoningLevel: 'max' } };
  if (mode === 'live') {
    for (const relative of ['cli/config.json', 'v2/provider_config.json']) {
      const file = path.join(currentProfile, relative); savedFiles.push({ file, hash: sha(await readFile(file)) });
    }
    const nativeConfig = JSON.parse(await readFile(path.join(currentProfile, 'cli/config.json'), 'utf8'));
    const native = JSON.parse(await readFile(path.join(currentProfile, 'v2/provider_config.json'), 'utf8'));
    const transformed = cloneChatReviewConfig(native, nativeConfig, fixture.pluginId, 'acceptance-chat-review');
    selection = transformed.selection;
    assert.equal(selection.options?.reasoningLevel, 'max');
    const provider = transformed.provider;
    assert.equal(provider.config.access.type, 'api-key'); assert.ok(provider.config.access.apiKey);
    remote = { url: `${provider.config.api.baseUrl.replace(/\/$/, '')}/chat/completions`, key: provider.config.access.apiKey, modelId: selection.modelId };
    rules.providerConfigRules.providerRules.push({ ...provider, config: { ...provider.config, access: { type: 'api-key', apiKey: 'ISOLATED_PROXY_ONLY' }, api: { ...provider.config.api, baseUrl: `http://127.0.0.1:${port}/v1` } } });
    for (const key of ['providerModelRules', 'manualProviderModelRules']) (rules.modelConfigRules[key] ??= []).push(...(transformed.providers.config.modelConfigRules[key] ?? []).filter(rule => rule.providerId === selection.providerId));
    // Native inherited templates/catalog remain available without copying credentials or sessions.
    await cp(path.join(currentProfile, 'v2/runtime/provider'), path.join(profile, '.zcode/v2/runtime/provider'), { recursive: true });
    summary.reviewModel = selection.modelId; summary.reasoningLevel = selection.options.reasoningLevel;
  }
  project.plugins.options = { [fixture.pluginId]: { reviewModel: selection } };
  await writeFile(fixture.projectConfig, JSON.stringify(project));
  await writeFile(providersPath, JSON.stringify(providers));
  await writeFile(path.join(profile, '.zcode/v2/setting.json'), JSON.stringify({ modelIoFullRetentionEnabled: false, recentProjects: [] }));
  const env = { ...process.env, USERPROFILE: profile, APPDATA: path.join(profile, 'appdata/roaming'), LOCALAPPDATA: path.join(profile, 'appdata/local'), ZCODE_DESKTOP_APPLICATION_NAME: `ZCodeAcceptance-${path.basename(profile)}`, ZCODE_DESKTOP_USER_DATA_DIR: path.join(profile, 'appdata'), ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DATA_BASE_DIR: profile, ZCODE_STORAGE_DIR: fixture.storage, ZCODE_SESSION_DB_PATH: path.join(fixture.storage, 'test-session.sqlite') };
  await mkdir(env.APPDATA, { recursive: true }); await mkdir(env.LOCALAPPDATA, { recursive: true });
  delete env.HOME; delete env.DEEPSEEK_API_KEY;
  summary.stage = 'desktop-launch';
  delete env.ELECTRON_RUN_AS_NODE;
  const release = JSON.parse(await readFile(path.resolve('release.config.json'), 'utf8'));
  app = spawn(path.join(desktop, flags.get('executable') ?? `${release.executableName}.exe`), [`--remote-debugging-port=${debugPort}`, '--open-workspace', fixture.workspace], { env, stdio: 'ignore' });
  app.on('error', error => { summary.launchError = true; summary.launchErrorCode = ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'other'; });
  app.on('exit', (code, signal) => { summary.appExitCode = typeof code === 'number' ? code : null; summary.appExitSignal = signal ? 'signaled' : null; });
  summary.stage = 'endpoint-connect';
  let endpoint;
  for (let i = 0; i < 120; i++) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(endpoint, 'Desktop endpoint unavailable');
  browser = await require(flags.get('playwright') ?? '../host-adapter/upstream/node_modules/playwright-core').chromium.connectOverCDP(endpoint);
  summary.stage = 'page-ready';
  let page;
  for (let i = 0; i < 60; i++) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => /index\.html/i.test(candidate.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(page, 'Desktop window did not load'); page.on('pageerror', () => summary.pageErrors++);
  await page.waitForLoadState('domcontentloaded');
  summary.stage = 'onboarding';
  for (let i = 0; i < 20; i++) {
    for (const name of ['退出引导', '使用 API key', '暂时跳过']) {
      const button = page.getByRole('button', { name, exact: true }); if (await button.isVisible()) await button.click();
    }
    if (await page.getByRole('button', { name: '发送', exact: true }).isVisible()) break;
    await page.waitForTimeout(500);
  }
  summary.stage = 'mode-ready';
  const modeTrigger = page.getByTestId('chat-mode-select-trigger');
  await modeTrigger.waitFor({ timeout: 30000 });
  if (!(await modeTrigger.innerText()).includes('CodexAutoApproval')) {
    await modeTrigger.click(); await page.getByTestId('chat-mode-select-item-codex-auto-approval').click();
  }
  summary.stage = 'session-bootstrap';
  await page.locator('[contenteditable="true"]').first().fill('ACCEPTANCE_SESSION_BOOTSTRAP: Do not use tools. Reply ACCEPTANCE_SESSION_READY only.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('[data-testid^="v4-row-"]').getByText('ACCEPTANCE_SESSION_READY', { exact: true }).waitFor({ timeout: 45000 });
  const scenarios = mode === 'live' ? ['live-one'] : ['allow', 'deny', 'error', 'cancel'];
  for (const [index, name] of scenarios.entries()) {
    scenario = name; round = 0;
    active = { name, requests: 0, mainRequests: 0, continuations: 0, returnedCalls: 0, encryptedRestored: false, protocolError: false, httpError: false, completed: false };
    summary.scenarios.push(active); summary.stage = name;
    await writeFile(path.join(fixture.workspace, `proof-${name}.txt`), 'Synthetic isolated acceptance proof.');
    const marker = path.join(fixture.workspace, `probe-${name}.txt`).replaceAll('\\', '/').replaceAll("'", "''");
    await writeFile(path.join(fixture.workspace, `proof-${name}.ps1`), `Add-Content -LiteralPath '${marker}' -Value 'executed'\n`);
    if (index) await page.getByTestId('task-new-button').click();
    summary.stage = 'approval-arm';
    await helpers.armDesktopFixtureApproval(fixture);
    summary.stage = 'probe-submit';
    await page.locator('[contenteditable="true"]').first().fill(`I authorize executing proof-${name}.ps1 exactly once only if inspection shows it only appends the word executed to probe-${name}.txt in this isolated workspace. The script contents are not provided here and must not be assumed safe. Before deciding, the reviewer MUST use read_file to inspect proof-${name}.ps1; without inspecting it authorization is not granted. No other side effects are authorized.`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    summary.stage = 'probe-wait';
    const done = page.locator('[data-testid^="v4-row-"]').getByText(`RESPONSES_DONE_${name}`, { exact: true });
    if (name === 'error') {
      await page.getByTestId('auto-review-failure').waitFor({ timeout: 60000 });
      await page.getByText('拒绝', { exact: true }).click(); await done.waitFor({ timeout: 30000 });
    } else if (name === 'cancel') {
      await page.getByTestId('auto-review-progress').waitFor({ timeout: 30000 });
      const stop = page.getByRole('button', { name: /停止|Stop/ }).first(); await stop.click();
      await page.getByTestId('auto-review-progress').waitFor({ state: 'hidden', timeout: 30000 });
    } else {
      await done.waitFor({ timeout: mode === 'live' ? 240000 : 60000 });
      assert.equal(await page.getByTestId('auto-review-failure').count(), 0);
      assert.equal(await page.getByRole('button', { name: '确认', exact: true }).count(), 0);
      assert.ok(active.continuations > 0 && active.returnedCalls > 0);
      if (mode === 'fixture') assert.equal(active.requests, 3);
    }
    const probe = path.join(fixture.workspace, `probe-${name}.txt`);
    if (name === 'allow' || name.startsWith('live-')) {
      assert.equal((await readFile(probe, 'utf8')).trim(), 'executed'); active.executions = 1;
    } else { await assert.rejects(access(probe), { code: 'ENOENT' }); active.executions = 0; }
    assert.equal(active.protocolError, false);
    active.completed = true;
  }
  for (const item of savedFiles) assert.equal(sha(await readFile(item.file)), item.hash);
  summary.userConfigUnchanged = true; summary.completed = summary.scenarios.every(item => item.completed) && summary.pageErrors === 0;
} catch (error) {
  summary.failed = true;
  summary.failure = { stage: summary.stage, errorClass: ['Error', 'AssertionError', 'TypeError', 'TimeoutError'].includes(error?.name) ? error.name : 'OtherError' };
  const fixedAssertions = ['Desktop endpoint unavailable', 'Desktop window did not load', 'Current provider API and access required', 'Specified review selection required', 'Dedicated provider ID already exists', 'Reviews must not share private continuation', 'Encrypted reasoning must be restored', 'Isolated native session was not created'];
  if (fixedAssertions.includes(error?.message)) summary.failure.assertion = error.message;
  process.exitCode = 1;
}
finally {
  if (app?.pid) await new Promise(resolve => {
    const stop = spawn('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); stop.on('close', resolve); stop.on('error', resolve);
  });
  await browser?.close().catch(() => {});
  server?.closeAllConnections(); server?.close();
  if (profile) try { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); summary.profileRemoved = true; } catch { summary.cleanupFailed = true; }
  summary.completed &&= summary.profileRemoved;
  if (!summary.completed) process.exitCode = 1;
  await writeFile(path.join(output, 'desktop-responses-result.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
