// Windows 本机首次迁移：安装独立产品，保留旧便携目录与用户数据。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import asar from '../host-adapter/upstream/node_modules/@electron/asar/lib/asar.js';
assert.equal(process.platform, 'win32');
const root = path.resolve(import.meta.dirname, '..');
const release = JSON.parse(await readFile(path.join(root, 'release.config.json')));
const out = path.join(root, 'artifacts/autoreview', release.distributionVersion);
const source = JSON.parse(await readFile(path.join(out, 'SOURCE.json')));
assert.equal(source.testBuild, false);
assert.equal(source.applicationId, release.applicationId);
assert.equal(source.distributionVersion, release.distributionVersion);
const installer = path.join(out, `${release.executableName}-${release.distributionVersion}-win-x64.exe`);
const target = path.normalize(release.defaultInstallDirectory);
const old = path.join(root, 'artifacts/0.1.3/CodexAutoApproval-Windows/ZCode.exe');
const sha = data => createHash('sha256').update(data).digest('hex');
const oldHash = sha(await readFile(old));
const observed = ['cli/config.json', 'v2/provider_config.json'].map(file => path.join(process.env.USERPROFILE, '.zcode', file));
const before = await Promise.all(observed.map(async file => sha(await readFile(file))));
const run = (file, args) => new Promise((done, fail) => {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => output += bytes);
  child.stderr.on('data', bytes => output += bytes);
  child.on('error', fail); child.on('exit', code => code === 0 ? done(output) : fail(new Error(`${path.basename(file)} exited ${code}: ${output}`)));
});
if (!process.argv.includes('--migrate-only')) await run(installer, ['/S', `/D=${target}`]);
const identity = JSON.parse(asar.extractFile(path.join(target, 'resources/app.asar'), 'package.json'));
assert.equal(identity.version, release.distributionVersion);
assert.equal(identity.zcodeAutoReview.applicationId, release.applicationId);
assert.equal(sha(await readFile(old)), oldHash);
const after = await Promise.all(observed.map(async file => sha(await readFile(file))));
assert.deepEqual(after, before, 'First installation must preserve current model/plugin configuration');
await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/migrate-autoreview-shortcuts.ps1')]);
const migrated = JSON.parse((await readFile(path.join(root, 'runtime/shortcut-migration.json'), 'utf8')).replace(/^\uFEFF/, ''));
const result = { distributionVersion: release.distributionVersion, upstreamVersion: release.upstreamVersion,
  installed: true, defaultDirectory: true, oldPortableUnchanged: true, currentConfigurationUnchanged: true,
  migratedShortcutCount: migrated.shortcuts.length, completedAt: new Date().toISOString() };
await mkdir(path.join(out, 'acceptance'), { recursive: true });
await writeFile(path.join(out, 'acceptance/local-install.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
