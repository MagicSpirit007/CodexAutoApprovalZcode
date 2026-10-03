import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyAutoReviewInstallerIntegrity } from '../host-adapter/upstream/packages/desktop/src/main/autoReviewInstallerIntegrity.ts';
import { EventEmitter } from 'node:events';
import { validateAutoReviewUpdate } from '../host-adapter/upstream/packages/shared/src/auto-review-distribution.ts';
import { UpdateInstallLease } from '../host-adapter/upstream/packages/shared/src/update-install-lease.ts';
import { prepareAutoReviewHosts } from '../host-adapter/upstream/packages/desktop/src/main/autoReviewInstallPreparation.ts';
import { readAutoReviewRelease } from '../host-adapter/upstream/packages/desktop/scripts/auto-review-release.mjs';
import { ProtocolUpdateInstallAdmission } from '../host-adapter/upstream/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/update-install-admission.ts';
import { assertPluginStorageCompatible } from '../host-adapter/upstream/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/update-install-compatibility.ts';

const release = JSON.parse(await readFile(new URL('../release.config.json', import.meta.url)));
const manifest = () => ({ version: '0.2.1', files: [{ url: 'https://github.com/MagicSpirit007/CodexAutoApprovalZcode/releases/download/autoreview-v0.2.1/ZCodeAutoReview-0.2.1-win-x64.exe',
  size: 100, sha512: Buffer.alloc(64, 1).toString('base64') }], autoReview: { schemaVersion: 1,
    applicationId: release.applicationId, upstreamVersion: release.upstreamVersion, upstreamCommit: release.upstreamCommit,
    patchSha256: 'a'.repeat(64), patchSummary: ['Verified adaptation'], bridgeProtocol: 2, supportedPluginVersions: ['0.1.3'], dataSchemaChanged: false } });

test('stable release preserves independent app, upstream, plugin and bridge versions', () => {
  assert.equal(readAutoReviewRelease({ ZCODE_AUTOREVIEW_RELEASE_FILE: new URL('../release.config.json', import.meta.url).pathname }).distributionVersion, '0.2.0');
  validateAutoReviewUpdate(manifest(), release, ['0.1.3']);
});
for (const [name, mutate] of [
  ['missing metadata', m => delete m.autoReview],
  ['wrong app identity', m => m.autoReview.applicationId = 'dev.zcode.app'],
  ['missing plugin compatibility', m => m.autoReview.supportedPluginVersions = []],
  ['wrong bridge', m => m.autoReview.bridgeProtocol = 1],
  ['schema migration', m => m.autoReview.dataSchemaChanged = true],
  ['prerelease', m => m.version = '0.3.0-beta.1'],
  ['short source commit', m => m.autoReview.upstreamCommit = '29628c9'],
  ['unverified patch', m => delete m.autoReview.patchSha256],
  ['missing patch summary', m => delete m.autoReview.patchSummary],
  ['hash missing', m => delete m.files[0].sha512],
  ['official installer', m => m.files[0].url = 'https://download.z.ai/ZCode.exe'],
  ['other release version', m => m.files[0].url = m.files[0].url.replaceAll('0.2.1', '0.2.2')],
  ['extra installer', m => m.files.push(m.files[0])],
]) test(`rejects ${name} before update becomes downloadable`, () => {
  const m = manifest(); mutate(m); assert.throws(() => validateAutoReviewUpdate(m, release));
});
test('installed incompatible plugin blocks update, including disabled installations', () => {
  assert.throws(() => validateAutoReviewUpdate(manifest(), release, ['0.1.2']), /incompatible/);
});
test('installer cached bytes are rechecked before shutdown and reject later corruption or removal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-update-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'installer.exe');
  const data = Buffer.from('test installer bytes');
  const expected = { size: data.length, sha512: createHash('sha512').update(data).digest('base64') };
  await writeFile(file, data); await verifyAutoReviewInstallerIntegrity(file, expected);
  await writeFile(file, Buffer.alloc(data.length));
  await assert.rejects(verifyAutoReviewInstallerIntegrity(file, expected), /checksum/);
  await writeFile(file, Buffer.alloc(1));
  await assert.rejects(verifyAutoReviewInstallerIntegrity(file, expected), /size/);
  await rm(file); await assert.rejects(verifyAutoReviewInstallerIntegrity(file, expected), /ENOENT/);
});
test('lease freezes admission, refuses in-flight requests, is idempotent and resumes after failure', () => {
  const gate = new UpdateInstallLease();
  const done = gate.enter();
  assert.throws(() => gate.acquire('install', () => false), /running/);
  assert.equal(gate.preparing, false); done(); done();
  assert.throws(() => gate.acquire('install', () => true), /running/);
  gate.acquire('install', () => false);
  gate.acquire('install', () => true);
  assert.throws(() => gate.enter(), /preparing/);
  gate.release('other'); assert.equal(gate.preparing, true);
  gate.release('install'); gate.enter()();
});
for (const reason of ['runtime', 'finalization', 'legacy', 'interaction', 'queue', 'control']) {
  test(`native update admission blocks ${reason} work and resumes after release`, () => {
    let busy = true;
    const record = { get activeAbortController() { return reason === 'legacy' && busy ? new AbortController() : undefined; },
      get residencyFinalizationCount() { return reason === 'finalization' && busy ? 1 : 0; },
      app: { runtime: { hasResidencyBlockingWork: () => reason === 'runtime' && busy } } };
    const gate = new ProtocolUpdateInstallAdmission(() => ({ sessions: new Map([['test', record]]),
      v4Interactions: { hasPendingForSession: () => reason === 'interaction' && busy },
      v4Gateway: { hasResidencyBlockingCommands: () => reason === 'queue' && busy } }), () => reason === 'control' && busy, () => {});
    assert.throws(() => gate.handle('runtime/updateInstall/prepare', { requestId: 'one', compatiblePluginVersions: ['0.1.3'] }), /running/);
    busy = false;
    assert.deepEqual(gate.handle('runtime/updateInstall/prepare', { requestId: 'one', compatiblePluginVersions: ['0.1.3'] }), { idle: true });
    assert.throws(() => gate.enter(), /preparing/);
    gate.handle('runtime/updateInstall/release', { requestId: 'one' }); gate.enter()();
    assert.throws(() => gate.handle('runtime/updateInstall/prepare', { requestId: '' }));
  });
}

function host(idle = true, delay = 0) {
  const h = new EventEmitter(); h.messages = [];
  h.postMessage = m => {
    h.messages.push(m);
    if (m.type === 'update-install-prepare') setTimeout(() => h.emit('message', {
      type: 'update-install-prepared', requestId: m.requestId, idle,
      ...(!idle ? { error: 'Task or review still running' } : {}),
    }), delay);
  };
  return h;
}
test('all windows must acknowledge idle before shutdown; repeated requests share their own lease', async () => {
  const a = host(), b = host(true, 20);
  const releaseLease = await prepareAutoReviewHosts([a, b], release.supportedPluginVersions);
  assert.equal(a.messages.length, 1); assert.equal(b.messages.length, 1);
  releaseLease(); assert.equal(a.messages.at(-1).type, 'update-install-release');
});
test('busy Host releases every window, including late successful acknowledgement, without disposing resources', async () => {
  const a = host(false), b = host(true, 20);
  await assert.rejects(prepareAutoReviewHosts([a, b], release.supportedPluginVersions), /still running/);
  for (const h of [a, b]) {
    assert.equal(h.messages.at(-1).type, 'update-install-release');
    assert.equal(h.messages.some(m => m.type === 'dispose'), false);
    assert.equal(h.listenerCount('message'), 0);
  }
});
test('Host exiting during readiness refuses update and releases other leases', async () => {
  const a = host(true, 25), b = host(true, 30);
  const ready = prepareAutoReviewHosts([a, b], release.supportedPluginVersions); b.emit('exit');
  await assert.rejects(ready, /exited/);
  assert.equal(a.messages.at(-1).type, 'update-install-release');
});
test('custom workspace stores include disabled plugins and malformed registries fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-custom-plugins-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'installed_plugins.json');
  await writeFile(file, JSON.stringify({ plugins: [{ name: 'codex-auto-approval', version: '99.0.0', enabled: false }] }));
  assert.throws(() => assertPluginStorageCompatible([root], ['0.1.3']), /incompatible/);
  await writeFile(file, JSON.stringify({ plugins: [{ name: 'codex-auto-approval', version: '0.1.3', enabled: false }] }));
  assertPluginStorageCompatible([root, root], ['0.1.3']);
  await writeFile(file, '{"plugins":null}'); assert.throws(() => assertPluginStorageCompatible([root], ['0.1.3']), /verify/);
  await writeFile(file, '{'); assert.throws(() => assertPluginStorageCompatible([root], ['0.1.3']));
});
