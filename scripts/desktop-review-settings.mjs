// Native Windows plugin settings acceptance in a disposable profile.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const childSafeEnv = { ...process.env };
delete childSafeEnv.DEEPSEEK_API_KEY;
const root = path.resolve('.');
if (process.platform !== 'win32') throw new Error('Windows Node required; scenario unverified');
const output = path.join(root, 'artifacts/0.1.3/acceptance/review-settings');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, '.private-settings-'));
const summary = { inheritLabelVisible: false, specifiedModelSaved: false, supportedReasoningSaved: false, userDefault: false,
  workspaceOverride: false, restoredInheritance: false, mainSelectionUnchanged: false,
  restartPersistence: false, nativeProviderManagement: false, profileRemoved: false, passed: false };
let app, browser, page, step = 'setup';
let sanitizeFailure = () => ({ code: 'settings_acceptance_error', message: 'Failed during isolated setup' });
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
const stop = async () => {
  await browser?.close().catch(() => {}); browser = undefined;
  if (app?.pid) await new Promise(resolve => { const child = spawn('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { env: childSafeEnv }); child.on('exit', resolve); child.on('error', resolve); });
  app = undefined;
};
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { prepareDesktopFixture, sanitizeAcceptanceFailure } = await import('../artifacts/0.1.3/acceptance/desktop-fixture.bundle.mjs');
  sanitizeFailure = sanitizeAcceptanceFailure;
  const fixture = await prepareDesktopFixture(root, profile, server.address().port);
  const env = { ...process.env, USERPROFILE: profile, ZCODE_DESKTOP_USER_DATA_DIR: path.join(profile, 'appdata'), ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DATA_BASE_DIR: profile, ZCODE_STORAGE_DIR: fixture.storage, ZCODE_SESSION_DB_PATH: path.join(fixture.storage, 'test-session.sqlite') };
  delete env.HOME; delete env.DEEPSEEK_API_KEY; delete env.ZCODE_DESKTOP_APPLICATION_NAME;
  const launch = async () => {
    app = spawn(path.join(root, 'artifacts/0.1.3/CodexAutoApproval-Windows/ZCode.exe'),
      ['--remote-debugging-port=9339', '--open-workspace', fixture.workspace], { env, stdio: 'ignore' });
    app.on('error', () => {});
    let endpoint;
    for (let i = 0; i < 100; i++) {
      try { endpoint = (await (await fetch('http://127.0.0.1:9339/json/version')).json()).webSocketDebuggerUrl; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(endpoint, 'Desktop launch failed');
    const require = createRequire(import.meta.url);
    browser = await require('../host-adapter/upstream/node_modules/playwright-core').chromium.connectOverCDP(endpoint);
    let page;
    for (let i = 0; i < 100; i++) {
      page = browser.contexts().flatMap(context => context.pages()).find(candidate => /index\.html/.test(candidate.url()));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(page, 'Desktop page missing');
    await page.waitForLoadState('domcontentloaded');
    for (let i = 0; i < 15; i++) {
      for (const name of ['退出引导', '使用 API key', '暂时跳过']) {
        const button = page.getByRole('button', { name, exact: true });
        if (await button.isVisible()) { await button.click(); break; }
      }
      if (await page.getByTestId('plugin-store-sidebar-open').isVisible()) break;
      await page.waitForTimeout(500);
    }
    const back = page.getByRole('button', { name: '返回工作区', exact: true });
    if (await back.isVisible()) await back.click();
    return page;
  };
  step = 'launch'; page = await launch();
  const mainBefore = await page.locator('.composer-model-trigger').first().innerText();
  const openList = async () => {
    step = 'open-plugin-list';
    if (await page.getByTestId('codex-review-model-config').isVisible()) {
      await page.getByTestId('settings-breadcrumb-item').click();
      await page.getByTestId('plugin-settings-scope-trigger').waitFor();
      return;
    }
    await page.getByTestId('plugin-store-sidebar-open').click();
    await page.getByTestId('plugin-store-manage-open').waitFor({ timeout: 30000 });
    await page.getByTestId('plugin-store-manage-open').click();
    await page.getByTestId('plugin-settings-scope-trigger').waitFor({ timeout: 30000 });
  };
  const selectScope = async scope => {
    step = `scope-${scope}`;
    await page.getByTestId('plugin-settings-scope-trigger').click();
    if (scope === 'user') await page.getByTestId('plugin-settings-scope-user-option').click();
    else await page.locator('[data-testid^="plugin-settings-scope-option-"]').first().click();
    await page.getByRole('menu').waitFor({ state: 'hidden' });
  };
  const openControls = async () => {
    step = 'open-plugin-controls';
    const row = page.locator(`[data-testid="plugin-settings-plugin-row"][data-plugin-id="${fixture.pluginId}"]`);
    await row.getByText('CodexAutoApproval', { exact: true }).waitFor();
    await row.locator('button').first().click();
    const advanced = page.getByTestId('plugin-store-advanced');
    await advanced.locator('summary').click();
    await page.getByTestId('codex-review-model-config').waitFor();
    const controls = page.getByTestId('codex-review-model-config');
    await controls.scrollIntoViewIfNeeded();
    return controls;
  };
  const chooseModel = async (controls, model) => {
    step = `choose-${model}`;
    await controls.getByTestId('chat-model-select-trigger').click();
    await page.getByRole('menuitem', { name: /Acceptance Local/ }).hover();
    await page.getByRole('menuitemradio').filter({ hasText: new RegExp(`^${model}\\b`) }).click();
    await controls.getByTestId('chat-model-select-trigger').getByText(model, { exact: true }).waitFor({ state: 'visible' });
  };
  const save = async controls => {
    step = 'save-plugin-config';
    const button = controls.getByTestId('codex-review-model-save');
    await button.click(); await button.waitFor({ state: 'visible' });
    await page.waitForTimeout(500); assert.equal(await button.isDisabled(), true, 'Save must commit through native configure');
  };
  const readWorkspaceSelection = async () => JSON.parse(await readFile(fixture.projectConfig, 'utf8')).plugins.options?.[fixture.pluginId]?.reviewModel;
  step = 'user-default'; await openList(); await selectScope('user');
  let controls = await openControls();
  assert.equal(await controls.getAttribute('data-review-model-mode'), 'inherit', 'Fresh isolated user config must inherit');
  step = 'inherit-label-visible';
  await controls.getByTestId('chat-model-select-trigger').getByText('跟随会话', { exact: true }).waitFor({ state: 'visible' });
  summary.inheritLabelVisible = true;
  await chooseModel(controls, 'acceptance-model'); await save(controls);
  const userConfigPath = path.join(profile, '.zcode/cli/config.json');
  summary.userConfigPathWithinProfile = !path.relative(profile, userConfigPath).startsWith('..');
  const userSelection = JSON.parse(await readFile(userConfigPath, 'utf8')).plugins.options?.[fixture.pluginId]?.reviewModel;
  summary.userDefault = summary.userConfigPathWithinProfile && userSelection?.mode === 'specified' && userSelection?.providerId === 'acceptance-local' && userSelection?.modelId === 'acceptance-model';
  assert.ok(summary.userDefault, 'Native user save must persist inside isolated profile');
  step = 'workspace-config'; await openList(); await selectScope('workspace'); controls = await openControls();
  await chooseModel(controls, 'acceptance-review-model');
  step = 'choose-reasoning'; await controls.getByTestId('chat-thought-level-select-trigger').click();
  await page.getByTestId('chat-thought-level-select-item-high').click();
  await save(controls);
  let persisted = await readWorkspaceSelection();
  summary.specifiedModelSaved = persisted?.mode === 'specified' && persisted.providerId === 'acceptance-local' && persisted.modelId === 'acceptance-review-model';
  summary.supportedReasoningSaved = persisted?.options?.reasoningLevel === 'high';
  assert.ok(summary.specifiedModelSaved && summary.supportedReasoningSaved);
  summary.workspaceOverride = true;
  step = 'restore-inheritance'; await controls.getByTestId('codex-review-model-restore').click();
  for (let i = 0; i < 100 && await readWorkspaceSelection(); i++) await page.waitForTimeout(100);
  assert.equal(await readWorkspaceSelection(), undefined);
  await controls.getByTestId('chat-model-select-trigger').getByText('acceptance-model', { exact: true }).waitFor();
  summary.restoredInheritance = true;
  await chooseModel(controls, 'acceptance-review-model');
  step = 'persist-high-for-restart';
  await controls.getByTestId('chat-thought-level-select-trigger').click();
  await page.getByTestId('chat-thought-level-select-item-high').click();
  await save(controls);
  // The existing model picker must open the native provider management view.
  await controls.getByTestId('chat-model-select-trigger').click();
  step = 'native-provider-management'; await page.getByRole('menuitem', { name: '管理模型', exact: true }).click();
  step = 'select-native-custom-provider';
  await page.locator('[data-testid^="model-provider-nav-item"]').filter({ hasText: 'Acceptance Local' }).click();
  await page.getByTestId('model-provider-header').first().waitFor({ timeout: 30000 });
  await page.getByTestId('model-provider-base-url-input').first().waitFor();
  await page.getByTestId('model-provider-api-format-trigger').first().waitFor();
  await page.getByTestId('model-provider-api-key-input').first().waitFor();
  summary.nativeProviderManagement = true;
  step = 'restart'; await stop();
  page = await launch();
  assert.equal(await page.locator('.composer-model-trigger').first().innerText(), mainBefore);
  summary.mainSelectionUnchanged = true;
  await openList(); await selectScope('workspace'); controls = await openControls();
  await controls.getByTestId('chat-model-select-trigger').getByText('acceptance-review-model', { exact: true }).waitFor();
  persisted = await readWorkspaceSelection();
  summary.restartPersistence = persisted?.modelId === 'acceptance-review-model' && persisted?.options?.reasoningLevel === 'high';
  step = 'restart-restore-user-inheritance';
  await controls.getByTestId('codex-review-model-restore').click();
  for (let i = 0; i < 100 && await readWorkspaceSelection(); i++) await page.waitForTimeout(100);
  assert.equal(await readWorkspaceSelection(), undefined);
  await controls.getByTestId('chat-model-select-trigger').getByText('acceptance-model', { exact: true }).waitFor({ state: 'visible' });
  summary.restartUserInheritance = JSON.parse(await readFile(path.join(profile, '.zcode/cli/config.json'), 'utf8')).plugins.options?.[fixture.pluginId]?.reviewModel?.modelId === 'acceptance-model';
  await page.screenshot({ path: path.join(output, 'review-model-restarted.png') });
  summary.passed = Object.entries(summary).filter(([key]) => key !== 'passed' && key !== 'profileRemoved').every(([, value]) => value === true);
} catch (error) { summary.passed = false; summary.failureStep = step; summary.failure = sanitizeFailure(error); if (page) {
    const controls = page.getByTestId('codex-review-model-config');
    if (await controls.count()) {
      await controls.scrollIntoViewIfNeeded().catch(() => {});
      summary.mockDom = await controls.evaluate(node => {
        const trigger = node.querySelector('[data-testid="chat-model-select-trigger"]');
        const label = trigger?.querySelector('span[title]');
        const geometry = element => { if (!element) return null; const style = getComputedStyle(element), box = element.getBoundingClientRect(); return { display: style.display, visibility: style.visibility, opacity: style.opacity, width: box.width, height: box.height }; };
        return { scope: node.getAttribute('data-config-scope'), mode: node.getAttribute('data-review-model-mode'), triggerText: trigger?.innerText, triggerAria: trigger?.getAttribute('aria-label'), labelText: label?.textContent, triggerGeometry: geometry(trigger), labelGeometry: geometry(label), detailsOpen: node.closest('details')?.open };
      }).catch(() => ({ inspectionFailed: true }));
    }
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  } }
finally {
  await stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); summary.profileRemoved = true;
  await writeFile(path.join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary));
}
if (!summary.passed) process.exitCode = 1;
