import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw new Error('Run with Windows Node');
const root = path.resolve('.'), output = path.join(root, 'artifacts/acceptance/windows');
const profile = path.join(output, `e2e-profile-${Date.now()}`);
await mkdir(profile, { recursive: true });
let scenario = 'allow';
const requests = [], errors = [];
const server = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
  const body = JSON.parse(text);
  const review = body.tools?.some(tool => tool.function?.name === 'read_file');
  requests.push({ scenario, review, model: body.model, toolNames: body.tools?.map(tool => tool.function?.name),
    roles: body.messages?.map(message => message.role),
    denialFeedback: body.messages?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('must not attempt')) });
  if (review && scenario === 'failure') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Acceptance authentication failure","type":"authentication_error"}}'); return; }
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
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
  res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { prepareDesktopFixture, inspectDesktopFixture, toggleDesktopFixture, uninstallDesktopFixture } = await import('../artifacts/acceptance/desktop-fixture.bundle.mjs');
const fixture = await prepareDesktopFixture(root, profile, server.address().port);
await writeFile(path.join(output, 'desktop-e2e-discovery.json'), JSON.stringify(inspectDesktopFixture(fixture), null, 2));
const desktopEnv = { ...process.env,
    ZCODE_DESKTOP_USER_DATA_DIR: path.join(profile, 'appdata'), ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DATA_BASE_DIR: profile, ZCODE_STORAGE_DIR: fixture.storage,
    ZCODE_SESSION_DB_PATH: path.join(fixture.storage, 'test-session.sqlite') };
delete desktopEnv.ZCODE_DESKTOP_APPLICATION_NAME;
const app = spawn(path.join(root, 'artifacts/CodexAutoApproval-Windows/ZCode.exe'), ['--remote-debugging-port=9338', '--open-workspace', fixture.workspace], {
  env: desktopEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '', browser, page;
app.stdout.on('data', chunk => stdout += chunk);
app.stderr.on('data', chunk => stderr += chunk);
try {
  let endpoint;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { endpoint = (await (await fetch('http://127.0.0.1:9338/json/version')).json()).webSocketDebuggerUrl; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(endpoint, 'Desktop acceptance endpoint unavailable');
  const require = createRequire(import.meta.url);
  browser = await require('../host-adapter/upstream/node_modules/playwright-core').chromium.connectOverCDP(endpoint);
  for (let attempt = 0; attempt < 60; attempt++) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => /index\.html/i.test(candidate.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(page, 'Desktop window did not load');
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  for (let step = 0; step < 12; step++) {
    await page.waitForTimeout(1000);
    for (const name of ['退出引导', '使用 API key', '暂时跳过']) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.isVisible()) { await button.click(); break; }
    }
    if (await page.getByRole('button', { name: '发送', exact: true }).isVisible()) break;
  }
  await page.screenshot({ path: path.join(output, 'desktop-e2e-ready.png') });
  await writeFile(path.join(output, 'desktop-e2e-ready.json'), JSON.stringify({ body: await page.locator('body').innerText(),
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
    await page.screenshot({ path: path.join(output, 'desktop-permission-menu.png') });
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
    const cases = process.argv.includes('--all') ? ['allow', 'deny', 'failure', 'disabled', 'uninstalled'] : ['allow'];
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
      const manual = ['failure', 'disabled', 'uninstalled'].includes(name);
      if (manual) {
        await confirm.waitFor({ timeout: 45000 });
        if (name === 'failure') {
          for (let attempt = 0; attempt < 100 && !requests.some(request => request.scenario === name && request.review); attempt++) {
            await page.waitForTimeout(100);
          }
          assert.ok(requests.some(request => request.scenario === name && request.review), 'Authentication failure was not exercised');
        }
        await page.getByText('拒绝', { exact: true }).click();
        await done.waitFor({ timeout: 30000 });
      } else {
        // Native PermissionRequest runs the human broker concurrently. Its transient
        // dialog is expected until the automatic decision wins and cancels it.
        await done.waitFor({ timeout: 45000 });
      }
      const probe = path.join(fixture.workspace, `probe-${name}.txt`);
      if (name === 'allow') assert.equal((await readFile(probe, 'utf8')).trim(), 'executed');
      else await assert.rejects(access(probe), { code: 'ENOENT' });
      const calls = requests.filter(request => request.scenario === name);
      assert.equal(calls.some(request => request.review), !['disabled', 'uninstalled'].includes(name));
      if (name === 'deny') assert.ok(calls.some(request => request.denialFeedback), 'Main model did not receive corrective denial feedback');
      await page.screenshot({ path: path.join(output, `desktop-e2e-${name}.png`) });
      results.push({ scenario: name, passed: true, humanFallback: manual, reviewerCalls: calls.filter(request => request.review).length });
      console.log(JSON.stringify(results.at(-1)));
    }
    // The plugin was uninstalled by the last case; reinstall only in the isolated fixture
    // to verify its visible name through the real marketplace/installed-list UI.
    if (process.argv.includes('--all')) {
      const { reinstallDesktopFixture } = await import('../artifacts/acceptance/desktop-fixture.bundle.mjs');
      await reinstallDesktopFixture(fixture);
      await page.getByTestId('plugin-store-sidebar-open').click();
      await page.getByTestId('plugin-store-manage-open').waitFor({ timeout: 30000 });
      await page.getByTestId('plugin-store-manage-open').click();
      const row = page.locator(`[data-testid="plugin-settings-plugin-row"][data-plugin-id="${fixture.pluginId}"]`);
      await row.getByText('CodexAutoApproval', { exact: true }).waitFor({ timeout: 30000 });
      await page.screenshot({ path: path.join(output, 'desktop-plugin-display-name.png') });
      results.push({ scenario: 'plugin-display-name', passed: true, displayName: 'CodexAutoApproval' });
    }
    await writeFile(path.join(output, 'desktop-e2e-results.json'), JSON.stringify({ fixture, source: 'extracted plugin ZIP',
      directExecutableStartup: true, applicationIdentityOverride: false, results }, null, 2));
  }
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'desktop-e2e-error.png') });
    await writeFile(path.join(output, 'desktop-e2e-error.json'), JSON.stringify({ error: error.message,
      body: await page.locator('body').innerText(), buttons: await page.getByRole('button').evaluateAll(items => items.map(item => ({ text: item.innerText, label: item.getAttribute('aria-label') }))) }, null, 2));
  }
  throw error;
} finally {
  await browser?.close();
  await writeFile(path.join(output, 'desktop-e2e-requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(path.join(output, 'desktop-e2e-page-errors.json'), JSON.stringify(errors));
  await writeFile(path.join(output, 'desktop-e2e-stdout.log'), stdout);
  await writeFile(path.join(output, 'desktop-e2e-stderr.log'), stderr);
  await new Promise(resolve => { const stop = spawn('taskkill.exe', ['/PID', String(app.pid), '/T', '/F']); stop.on('exit', resolve); stop.on('error', resolve); });
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
