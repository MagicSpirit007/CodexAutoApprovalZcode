import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

if (process.platform !== 'win32') throw new Error('Run this acceptance with Windows Node 24');
const root = resolve(import.meta.dirname, '..');
const directory = join(root, 'artifacts/autoreview/update-acceptance');
const smoke = process.argv.includes('--smoke');
const release = JSON.parse(await readFile(join(root, 'release.config.json'), 'utf8'));
const parts = release.distributionVersion.split('.').map(Number);
const next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
const config = { ...release, applicationId: release.applicationId + '.acceptance' };
const install = join(directory, 'installed');
const profile = join(directory, `profile-${Date.now()}`);
const evidence = join(directory, smoke ? 'windows-smoke.json' : 'windows-result.json');
const require = createRequire(import.meta.url);
const { chromium } = require('../host-adapter/upstream/node_modules/playwright-core');
const asar = require('../host-adapter/upstream/node_modules/@electron/asar/lib/asar.js');
const { prepareDesktopFixture, armDesktopFixtureApproval } = await import('../artifacts/autoreview/update-acceptance/desktop-fixture.bundle.mjs');
const sha = (b, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(b).digest(encoding);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const wait = async (fn, label, timeout = 90000) => {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (e) { last = e; } await sleep(250); }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
};
const run = (file, args, env = process.env) => new Promise((done, fail) => {
  const child = spawn(file, args, { env, stdio: 'pipe' }); let text = '';
  child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b);
  child.on('error', fail); child.on('exit', code => code === 0 ? done(text.trim()) : fail(new Error(`${file} exited ${code}: ${text.slice(-2000)}`)));
});
const ps = code => run('powershell.exe', ['-NoProfile', '-Command', code]);
await mkdir(profile, { recursive: true });
let app, browser, page, holdResponse, holdModel = false, pendingModel = 0;
let manifest, feedOffline = false, corrupt = false, downloads = 0;
const results = { distributionVersion: release.distributionVersion, targetVersion: next, upstreamCommit: release.upstreamCommit,
  isolated: true, stages: [], startedAt: new Date().toISOString() };
const record = (name, details = {}) => { results.stages.push({ name, passed: true, ...details }); console.log(name); };
const bytes = smoke ? Buffer.from('isolated-smoke-placeholder-never-downloaded') : await readFile(join(directory, next, `ZCodeAutoReview-${next}-win-x64.exe`));
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/feed/')) {
    if (feedOffline) { res.writeHead(503); res.end('Offline acceptance'); return; }
    res.writeHead(200, { 'content-type': 'application/yaml' }); res.end(JSON.stringify(manifest)); return;
  }
  if (req.url.startsWith('/releases/')) {
    downloads++;
    const body = corrupt ? Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([bytes.at(-1) ^ 255])]) : bytes;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }); res.end(body); return;
  }
  let input = ''; for await (const b of req) input += b;
  if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
  const body = JSON.parse(input);
  results.modelRequests ??= [];
  results.modelRequests.push({ model: body.model, review: body.tools?.some(t => t.function?.name === 'read_file') === true, held: holdModel });
  if (holdModel) { pendingModel++; await new Promise(done => { holdResponse = done; }); }
  const review = body.tools?.some(t => t.function?.name === 'read_file');
  let message;
  if (review) message = { role: 'assistant', content: JSON.stringify({ outcome: 'allow', risk_level: 'low', user_authorization: 'high', rationale: 'Isolated update retention probe' }) };
  else if (String(body.messages.filter(m => m.role === 'user').at(-1)?.content).startsWith('ACCEPTANCE_SESSION_BOOTSTRAP')) message = { role: 'assistant', content: 'ACCEPTANCE_SESSION_READY' };
  else if (body.tools?.some(t => t.function?.name === 'Bash') && !body.messages.some(m => m.role === 'tool')) {
    message = { role: 'assistant', content: '', tool_calls: [{ id: 'upgrade-history', type: 'function', function: {
      name: 'Bash', arguments: JSON.stringify({ command: 'powershell.exe -NoProfile -Command "Write-Output UPGRADE_KEEP_HISTORY"', description: 'Isolated update probe' }) } }] };
  } else message = { role: 'assistant', content: 'UPGRADE_KEEP_HISTORY_DONE' };
  const base = { id: `chatcmpl-${Date.now()}`, created: Math.floor(Date.now()/1000), model: body.model };
  const finish = message.tool_calls ? 'tool_calls' : 'stop';
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
  for (const item of [{ delta, finish_reason: null }, { delta: {}, finish_reason: finish }]) res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, ...item }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
manifest = { version: next, files: [{ url: `${origin}/releases/download/autoreview-v${next}/ZCodeAutoReview-${next}-win-x64.exe`, sha512: sha(bytes, 'sha512', 'base64'), size: bytes.length }], releaseDate: new Date().toISOString(),
  autoReview: { schemaVersion: 1, applicationId: config.applicationId, upstreamVersion: release.upstreamVersion, upstreamCommit: release.upstreamCommit,
    patchSha256: '1'.repeat(64), patchSummary: ['Isolated real NSIS upgrade acceptance'], bridgeProtocol: release.bridgeProtocol,
    supportedPluginVersions: release.supportedPluginVersions, dataSchemaChanged: false } };
const fixture = await prepareDesktopFixture(root, profile, server.address().port, { marketplace: root });
const pluginState = join(profile, '.zcode/cli/plugins/installed_plugins.json');
await mkdir(join(profile, '.zcode/cli/plugins'), { recursive: true });
await cp(join(fixture.storageRoot, 'installed_plugins.json'), pluginState);
const project = JSON.parse(await readFile(fixture.projectConfig, 'utf8'));
project.plugins.options = { [fixture.pluginId]: { reviewModel: { mode: 'specified', providerId: 'acceptance-local', modelId: 'acceptance-review-model', options: { reasoningLevel: 'high' } } } };
await writeFile(fixture.projectConfig, JSON.stringify(project, null, 2));
const desktopEnv = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: join(profile, 'Roaming'), LOCALAPPDATA: join(profile, 'Local'),
  ZCODE_DESKTOP_USER_DATA_DIR: join(profile, 'appdata'), ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DATA_BASE_DIR: profile,
  ZCODE_STORAGE_DIR: fixture.storage, ZCODE_SESSION_DB_PATH: join(fixture.storage, 'test-session.sqlite'), ZCODE_AUTOREVIEW_TEST_FEED_URL: origin + '/feed/' };
delete desktopEnv.ELECTRON_RUN_AS_NODE;
delete desktopEnv.ZCODE_DESKTOP_APPLICATION_NAME;
const executable = join(install, 'ZCodeAutoReview.exe');
let logs = '';
async function launch() {
  app = spawn(executable, ['--remote-debugging-port=9343', '--open-workspace', fixture.workspace], { env: desktopEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  app.on('exit', (code, signal) => { results.appExits ??= []; results.appExits.push({ code, signal }); });
  console.log(`isolated desktop PID ${app.pid}`);
  app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b); app.on('error', e => { logs += e.message; });
  const endpoint = await wait(async () => (await (await fetch('http://127.0.0.1:9343/json/version')).json()).webSocketDebuggerUrl, 'desktop CDP');
  browser = await chromium.connectOverCDP(endpoint);
  page = await wait(() => browser.contexts().flatMap(c => c.pages()).find(p => /index\.html/i.test(p.url())), 'desktop window');
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => {
    window.__acceptanceUpdateResults = [];
    window.zcode.onUpdateCheckResult(result => window.__acceptanceUpdateResults.push(result));
  });
  for (let step = 0; step < 20; step++) {
    await sleep(500);
    if (await page.getByRole('button', { name: '发送', exact: true }).isVisible()) break;
    for (const name of ['退出引导', '使用 API key', '暂时跳过']) {
      const b = page.getByRole('button', { name, exact: true }); if (await b.isVisible()) { await b.click(); break; }
    }
  }
}
const state = () => page.evaluate(() => window.zcode.getUpdateState());
async function check() {
  // 原生菜单在 available/ready 状态展示已有结果或执行安装；测试显式跳过再查新。
  if ((await state()).kind === 'update-available') {
    await page.evaluate(async () => window.zcode.skipUpdateVersion((await window.zcode.getUpdateState()).version));
  }
  await page.evaluate(() => { window.__acceptanceUpdateResults.length = 0; });
  return page.evaluate(() => window.zcode.executeDesktopCommand('checkForUpdates'));
}
const checkError = label => wait(async () => (await page.evaluate(() => window.__acceptanceUpdateResults)).find(r => r.kind === 'error'), label);
const refusedInstall = () => page.evaluate(async () => {
  try { await window.zcode.quitAndInstallUpdate(); return null; }
  catch (error) { return error.message; }
});
async function stopOwnedApp() {
  await browser?.close().catch(() => {}); browser = undefined;
  if (app?.pid) await run('taskkill.exe', ['/PID', String(app.pid), '/T', '/F']).catch(() => {});
  app = undefined; await sleep(500);
}
function installedVersion() { const archive = join(install, 'resources/app.asar'); asar.uncache(archive); return JSON.parse(asar.extractFile(archive, 'package.json').toString()).version; }
async function findFiles(dir) { const out = []; for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
  const p = join(dir, e.name); if (e.isDirectory()) out.push(...await findFiles(p)); else out.push(p);
} return out; }
function sessionSnapshot() {
  const db = new DatabaseSync(join(fixture.storage, 'test-session.sqlite'), { readOnly: true });
  try { const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all();
    const rows = Object.fromEntries(tables.map(({name}) => [name, db.prepare(`select * from "${name.replaceAll('"','""')}"`).all()]));
    assert.match(JSON.stringify(rows), /UPGRADE_KEEP_HISTORY/); return rows;
  } finally { db.close(); }
}
try {
  await run(join(directory, release.distributionVersion, `ZCodeAutoReview-${release.distributionVersion}-win-x64.exe`), ['/S', `/D=${install}`]);
  assert.equal(installedVersion(), release.distributionVersion); record('first-install');
  const shortcut = await ps("$w = New-Object -ComObject WScript.Shell; $p = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ZCode AutoReview Acceptance.lnk'; if (!(Test-Path -LiteralPath $p)) { $p = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\ZCode AutoReview Acceptance.lnk' }; $s=$w.CreateShortcut($p); @{path=$p;target=$s.TargetPath}|ConvertTo-Json -Compress");
  const shortcutBefore = JSON.parse(shortcut); assert.equal(shortcutBefore.target.toLowerCase(), executable.toLowerCase());
  await launch();
  await wait(async () => (await state()).kind === 'update-available', 'startup check');
  await sleep(1000); assert.equal(downloads, 0);
  assert.equal((await page.evaluate(() => window.zcode.getAutoUpdatePreferences())).autoDownloadAndInstallUpdates, false);
  record('startup-confirmation-no-auto-download');
  if (smoke) {
    await page.screenshot({ path: join(directory, 'windows-smoke.png') });
    record('isolated-desktop-smoke');
  } else {
  const modeTrigger = page.getByTestId('chat-mode-select-trigger');
  if (!(await modeTrigger.innerText()).includes('CodexAutoApproval')) {
    await modeTrigger.click(); await page.getByTestId('chat-mode-select-item-codex-auto-approval').click();
  }
  await page.locator('[contenteditable="true"]').first().fill('ACCEPTANCE_SESSION_BOOTSTRAP: Do not use tools. Reply ACCEPTANCE_SESSION_READY.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await wait(async () => (await page.locator('body').innerText()).includes('ACCEPTANCE_SESSION_READY'), 'create native session');
  const original = structuredClone(manifest);
  manifest = { ...original, autoReview: { ...original.autoReview, applicationId: 'official.wrong' } };
  await check(); assert.match((await checkError('wrong identity')).message, /identity/i); record('wrong-identity-refused');
  manifest = original; const pluginOriginal = await readFile(pluginState);
  const badPlugins = JSON.parse(pluginOriginal); for (const p of badPlugins.plugins) if (p.name === 'codex-auto-approval') p.version = '99.0.0';
  await writeFile(pluginState, JSON.stringify(badPlugins)); await check(); assert.match((await checkError('incompatible plugin')).message, /plugin/i); record('incompatible-plugin-refused');
  await writeFile(pluginState, pluginOriginal);
  feedOffline = true; await check(); await checkError('offline'); assert.equal(installedVersion(), release.distributionVersion); record('offline-keeps-version');
  feedOffline = false; await check(); await wait(async () => (await state()).kind === 'update-available', 'retry');
  corrupt = true; const corruptLogStart = logs.length; await page.evaluate(() => window.zcode.downloadUpdate());
  await wait(() => /checksum mismatch/i.test(logs.slice(corruptLogStart)), 'corrupt download', 180000);
  assert.notEqual((await state()).kind, 'update-downloaded'); record('corrupt-installer-refused');
  corrupt = false; await check(); await wait(async () => (await state()).kind === 'update-available', 'retry after corrupt');
  const beforeDownloads = downloads;
  await page.evaluate(() => Promise.all([window.zcode.downloadUpdate(), window.zcode.downloadUpdate(), window.zcode.downloadUpdate()]));
  await wait(async () => (await state()).kind === 'update-downloaded', 'verified download', 180000);
  assert.equal(downloads - beforeDownloads, 1); record('duplicate-download-single-owner');
  const customPluginState = join(fixture.storageRoot, 'installed_plugins.json');
  const customOriginal = await readFile(customPluginState);
  const customBad = JSON.parse(customOriginal);
  for (const plugin of customBad.plugins) if (plugin.name === 'codex-auto-approval') plugin.version = '99.0.0';
  await writeFile(customPluginState, JSON.stringify(customBad));
  assert.match(await refusedInstall(), /plugin.*incompatible/i); assert.equal(app.exitCode, null); record('custom-workspace-plugin-blocks-install');
  await writeFile(customPluginState, customOriginal);
  await check(); await wait(async () => (await state()).kind === 'update-available', 'retry after custom plugin refusal');
  await page.evaluate(() => window.zcode.downloadUpdate());
  await wait(async () => (await state()).kind === 'update-downloaded', 'cache ready after compatibility repair');
  const cached = (await findFiles(desktopEnv.LOCALAPPDATA)).find(p => /pending[\\/].*\.exe$/i.test(p));
  assert.ok(cached, 'Updater cached installer'); const cacheBytes = await readFile(cached);
  const bad = Buffer.from(cacheBytes); bad[0] ^= 255; await writeFile(cached, bad);
  assert.match(await refusedInstall(), /checksum/i); assert.equal(app.exitCode, null); record('cache-tamper-keeps-app');
  await writeFile(cached, cacheBytes);
  await check(); await wait(async () => ['update-available','update-downloaded'].includes((await state()).kind), 'recover verified cache');
  if ((await state()).kind !== 'update-downloaded') await page.evaluate(() => window.zcode.downloadUpdate());
  await wait(async () => (await state()).kind === 'update-downloaded', 'cached package ready');
  await armDesktopFixtureApproval(fixture);
  holdModel = true;
  await page.locator('[contenteditable="true"]').first().fill('UPGRADE_KEEP_HISTORY 请执行隔离验收命令并保存本轮会话');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await wait(() => pendingModel > 0, 'running task');
  assert.match(await refusedInstall(), /busy|active|running|任务|停止/i); assert.equal(app.exitCode, null); record('running-task-blocks-install');
  holdModel = false; holdResponse?.();
  await wait(async () => (await page.locator('body').innerText()).includes('UPGRADE_KEEP_HISTORY_DONE'), 'native review completion', 180000);
  const beforeHistory = sessionSnapshot();
  const beforeProject = JSON.parse(await readFile(fixture.projectConfig, 'utf8'));
  const beforeProviders = sha(await readFile(join(profile, '.zcode/v2/provider_config.json')));
  record('native-approval-and-history-created');
  await check(); await wait(async () => ['update-available','update-downloaded'].includes((await state()).kind), 'final retry');
  if ((await state()).kind !== 'update-downloaded') await page.evaluate(() => window.zcode.downloadUpdate());
  await wait(async () => (await state()).kind === 'update-downloaded', 'final verified download');
  await page.screenshot({ path: join(directory, 'before-upgrade.png') });
  await page.evaluate(() => window.zcode.quitAndInstallUpdate()).catch(() => {});
  await wait(() => installedVersion() === next, 'real NSIS updater install', 180000);
  await browser?.close().catch(() => {}); browser = undefined;
  await sleep(3000);
  // 安装器的 force-run 可能已重启：仅关闭隔离测试安装路径下的进程，再用固定入口验收。
  await ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${executable.replaceAll("'", "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  const shortcutAfter = JSON.parse(await ps(`$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('${shortcutBefore.path.replaceAll("'", "''")}'); @{target=$s.TargetPath}|ConvertTo-Json -Compress`));
  assert.equal(shortcutAfter.target, shortcutBefore.target); record('real-upgrade-fixed-shortcut', { installedVersion: installedVersion(), shortcutUnchanged: true });
  await launch();
  await wait(async () => (await state()).kind === 'idle', 'new version sees no upgrade');
  const afterHistory = sessionSnapshot();
  for (const [table, rows] of Object.entries(beforeHistory)) for (const row of rows) {
    if (/^(session|message)/i.test(table) && row.id) assert.ok(afterHistory[table].some(other => other.id === row.id), `History retained: ${table}`);
  }
  const afterProject = JSON.parse(await readFile(fixture.projectConfig, 'utf8'));
  assert.deepEqual(afterProject.plugins, beforeProject.plugins);
  assert.equal(sha(await readFile(join(profile, '.zcode/v2/provider_config.json'))), beforeProviders);
  await page.screenshot({ path: join(directory, 'after-upgrade.png') }); record('sessions-plugin-and-review-settings-retained');
  await stopOwnedApp();
  await run(join(directory, release.distributionVersion, `ZCodeAutoReview-${release.distributionVersion}-win-x64.exe`), ['/S', `/D=${install}`]);
  assert.equal(installedVersion(), release.distributionVersion); sessionSnapshot(); record('manual-data-compatible-rollback');
  await run(join(directory, next, `ZCodeAutoReview-${next}-win-x64.exe`), ['/S', `/D=${install}`]);
  assert.equal(installedVersion(), next); sessionSnapshot(); record('cached-installer-repair');
  }
  results.passed = true;
} catch (error) { results.passed = false; results.failure = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: join(directory, 'update-acceptance-error.png') }).catch(() => {});
    await writeFile(join(directory, 'update-acceptance-error.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {});
  }
}
finally {
  holdModel = false; holdResponse?.(); await stopOwnedApp(); server.closeAllConnections(); await new Promise(done => server.close(done));
  results.completedAt = new Date().toISOString();
  await writeFile(evidence, JSON.stringify(results, null, 2) + '\n');
  await writeFile(join(directory, 'desktop.log'), logs);
  console.log(evidence);
}
