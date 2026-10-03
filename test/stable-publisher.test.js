import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { publishStableRelease } from '../scripts/publish-stable-release.mjs';

for (const corrupt of [false, true]) test(`stable promotion waits for every immutable asset download (corrupt=${corrupt})`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'autoreview-publish-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs/distribution-release-notes.md'), 'Test release');
  const bytes = Buffer.from('synthetic NSIS'), file = join(root, 'installer.exe'); await writeFile(file, bytes);
  const config = { repository: 'owner/repo', distributionVersion: '0.2.0', updateFeedUrl: 'https://raw.githubusercontent.com/owner/repo/main/updates/windows-x64/stable/' };
  const calls = [], uploaded = [];
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const release = { id: 7, tag_name: 'autoreview-v0.2.0', draft: true, prerelease: false, upload_url: 'https://uploads.github.com/repos/owner/repo/releases/7/assets{?name,label}', html_url: 'https://github.com/owner/repo/releases/tag/autoreview-v0.2.0' };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input); calls.push([options.method ?? 'GET', url.pathname]);
    if (url.hostname === 'uploads.github.com') {
      let body = Buffer.alloc(0); for await (const chunk of options.body) body = Buffer.concat([body, chunk]);
      const asset = { name: url.searchParams.get('name'), state: 'uploaded', size: body.length, digest: 'sha256:' + createHash('sha256').update(body).digest('hex') };
      uploaded.push(asset); return response(asset, 201);
    }
    if (url.hostname === 'github.com') return new Response(corrupt ? Buffer.from('corrupt package') : bytes);
    if (url.pathname.endsWith('/git/ref/tags/autoreview-v0.2.0') || url.pathname.endsWith('/releases/tags/autoreview-v0.2.0')) return response({}, 404);
    if (url.pathname.endsWith('/commits/main')) return response({ sha: 'a'.repeat(40) });
    if (url.pathname.endsWith('/releases/7/assets')) return response(uploaded);
    if (url.pathname.endsWith('/releases/7')) { release.draft = false; return response(release); }
    if (url.pathname.endsWith('/releases')) return response(release, 201);
    if (url.pathname.includes('/contents/')) return options.method === 'PUT' ? response({ commit: { sha: 'b'.repeat(40) } }, 201) : response({}, 404);
    return response({ full_name: 'owner/repo' });
  };
  const work = publishStableRelease({ config, root, out: root, assets: [file], manifest: 'version: 0.2.0\n', parse: () => ({ version: '0.1.9' }), semver: { lt: () => true }, token: 'SYNTHETIC_TEST_ONLY', fetchImpl });
  if (corrupt) await assert.rejects(work, /length|differs|equal/);
  else assert.equal((await work).promoted, true);
  const puts = calls.filter(([method]) => method === 'PUT'); assert.equal(puts.length, corrupt ? 0 : 1);
  const downloadIndex = calls.findIndex(([, path]) => path.includes('/releases/download/'));
  assert.ok(downloadIndex > calls.findIndex(([method]) => method === 'PATCH'));
  if (!corrupt) assert.ok(calls.findIndex(([method]) => method === 'PUT') > downloadIndex);
});
