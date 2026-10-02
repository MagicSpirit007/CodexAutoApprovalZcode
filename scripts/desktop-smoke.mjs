import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') throw new Error('Run with Windows Node');
const root = path.resolve('.');
const output = path.join(root, 'artifacts/0.1.3/acceptance/windows');
await mkdir(output, { recursive: true });
const profile = path.join(output, 'profile');
const app = spawn(path.join(root, 'artifacts/0.1.3/CodexAutoApproval-Windows/ZCode.exe'), ['--remote-debugging-port=9337'], {
  env: { ...process.env, ZCODE_DESKTOP_APPLICATION_NAME: 'ZCode AutoReview Acceptance',
    ZCODE_DESKTOP_USER_DATA_DIR: path.join(profile, 'appdata'), ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DATA_BASE_DIR: profile }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
app.stdout.on('data', chunk => stdout += chunk);
app.stderr.on('data', chunk => stderr += chunk);
let browser;
const pageErrors = [];
try {
  const deadline = Date.now() + 60000;
  let endpoint;
  while (Date.now() < deadline) {
    try { endpoint = (await (await fetch('http://127.0.0.1:9337/json/version')).json()).webSocketDebuggerUrl; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!endpoint) throw new Error('Adapted desktop did not expose its acceptance endpoint');
  const require = createRequire(import.meta.url);
  const { chromium } = require('../host-adapter/upstream/node_modules/playwright-core');
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap(context => context.pages()).find(page => /index\.html|zcode/i.test(page.url()));
  if (!page) throw new Error('Adapted desktop window did not load');
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);
  if (process.argv.includes('--inspect')) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2000);
    const apiKey = page.getByRole('button', { name: '使用 API key', exact: true });
    if (await apiKey.isVisible()) { await apiKey.click(); await page.waitForTimeout(2500); }
    const skip = page.getByRole('button', { name: '暂时跳过', exact: true });
    if (await skip.isVisible()) { await skip.click(); await page.waitForTimeout(5000); }
    const exitOnboarding = page.getByRole('button', { name: '退出引导', exact: true });
    if (await exitOnboarding.isVisible()) { await exitOnboarding.click(); await page.waitForTimeout(5000); }
    await page.waitForFunction(() => document.body.innerText.trim().length > 0, { timeout: 30000 });
    console.log(JSON.stringify({ buttons: await page.getByRole('button').evaluateAll(buttons => buttons.map(button => ({
      text: button.innerText, title: button.getAttribute('title'), label: button.getAttribute('aria-label'),
    }))), inputs: await page.locator('input').evaluateAll(inputs => inputs.map(input => ({ placeholder: input.placeholder, type: input.type }))) }));
  }
  const text = await page.locator('body').innerText();
  await page.screenshot({ path: path.join(output, 'desktop-launch.png') });
  await writeFile(path.join(output, 'desktop-smoke.json'), JSON.stringify({ pid: app.pid, title: await page.title(), url: page.url(),
    bodyText: text.slice(0, 15000), pageErrors, adapterBuild: JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'artifacts/0.1.3/CodexAutoApproval-Windows/AUTO-REVIEW-BUILD.json'), 'utf8')) }, null, 2));
  console.log(JSON.stringify({ launched: true, pid: app.pid, title: await page.title(), visibleText: text.slice(0, 1500) }));
} finally {
  await browser?.close();
  await writeFile(path.join(output, 'desktop-stdout.log'), stdout);
  await writeFile(path.join(output, 'desktop-stderr.log'), stderr);
  await writeFile(path.join(output, 'desktop-page-errors.json'), JSON.stringify(pageErrors));
  // Stop only the process tree that this acceptance script started.
  await new Promise(resolve => { const stop = spawn('taskkill.exe', ['/PID', String(app.pid), '/T', '/F']); stop.on('exit', resolve); stop.on('error', resolve); });
}
