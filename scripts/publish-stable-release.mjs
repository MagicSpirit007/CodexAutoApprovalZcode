import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

const sha = data => createHash('sha256').update(data).digest('hex');
function credential(repository, cwd) {
  const available = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (available) return available;
  const git = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/cmd/git.exe') : 'git';
  const result = spawnSync(git, ['credential', 'fill'], { cwd, encoding: 'utf8', timeout: 15000,
    input: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  const token = result.status === 0 ? result.stdout.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9) : undefined;
  if (!token) throw new Error('No existing GitHub credential. Run with authenticated Windows Git or supply GH_TOKEN in this process.');
  return token;
}

/** 手动调用。凭据仅在内存中；固定资产下载核验全部成功才推进稳定索引。 */
export async function publishStableRelease({ config, root, out, assets, manifest, parse, semver, repositoryCommit,
  fetchImpl = fetch, token = credential(config.repository, root) }) {
  const tag = `autoreview-v${config.distributionVersion}`;
  const base = `https://api.github.com/repos/${config.repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function api(path, method = 'GET', body, missing = false) {
    const response = await fetchImpl(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  const repo = await api('');
  assert.equal(repo.full_name.toLowerCase(), config.repository.toLowerCase());
  const commit = repositoryCommit ?? (await api('/commits/main')).sha;
  assert.match(commit, /^[0-9a-f]{40}$/);
  const existingTag = await api(`/git/ref/tags/${tag}`, 'GET', undefined, true);
  if (existingTag) assert.equal((await api(`/commits/${tag}`)).sha, commit, 'Release tag points to different reviewed source');
  let release = await api(`/releases/tags/${tag}`, 'GET', undefined, true);
  if (!release) release = await api('/releases', 'POST', { tag_name: tag, target_commitish: commit,
    name: `ZCode AutoReview ${config.distributionVersion}`, draft: true, prerelease: false,
    body: await readFile(join(root, 'docs/distribution-release-notes.md'), 'utf8') });
  assert.equal(release.tag_name, tag); assert.equal(release.prerelease, false);
  const proofs = [];
  for (const file of assets) {
    const name = basename(file), bytes = (await stat(file)).size, digest = sha(await readFile(file));
    let asset = (await api(`/releases/${release.id}/assets?per_page=100`)).find(item => item.name === name);
    if (asset?.state === 'starter' && release.draft) {
      await api(`/releases/assets/${asset.id}`, 'DELETE'); asset = undefined;
    }
    if (asset) {
      assert.equal(asset.state, 'uploaded'); assert.equal(asset.size, bytes);
      assert.equal(asset.digest, `sha256:${digest}`, `Immutable asset differs: ${name}`);
    } else {
      assert.equal(release.draft, true, 'Published release assets are immutable; a missing asset requires a new version');
      const upload = new URL(release.upload_url.replace(/\{.*$/, ''));
      assert.equal(upload.origin, 'https://uploads.github.com');
      assert.equal(upload.pathname, `/repos/${config.repository}/releases/${release.id}/assets`);
      upload.searchParams.set('name', name);
      console.log(JSON.stringify({ uploading: name, bytes }));
      async function* stream() {
        let sent = 0, last = Date.now();
        for await (const chunk of createReadStream(file)) {
          sent += chunk.length;
          if (Date.now() - last > 20000) { last = Date.now(); console.log(JSON.stringify({ uploading: name, percent: Math.round(sent / bytes * 100) })); }
          yield chunk;
        }
      }
      const response = await fetchImpl(upload, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(bytes) },
        body: stream(), duplex: 'half', signal: AbortSignal.timeout(900000) });
      if (!response.ok) throw new Error(`Asset upload failed: ${name}, HTTP ${response.status}`);
      asset = await response.json(); assert.equal(asset.state, 'uploaded'); assert.equal(asset.size, bytes);
      assert.equal(asset.digest, `sha256:${digest}`);
    }
    proofs.push({ name, bytes, sha256: digest, url: `https://github.com/${config.repository}/releases/download/${tag}/${name}` });
  }
  if (release.draft) release = await api(`/releases/${release.id}`, 'PATCH', { draft: false, prerelease: false, make_latest: 'false' });
  assert.equal(release.draft, false);
  for (const proof of proofs) {
    const response = await fetchImpl(proof.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Published asset download failed: ${proof.name}, HTTP ${response.status}`);
    const hash = createHash('sha256'); let length = 0;
    for await (const chunk of response.body) { hash.update(chunk); length += chunk.length; }
    assert.equal(length, proof.bytes); assert.equal(hash.digest('hex'), proof.sha256, `Published asset download differs: ${proof.name}`);
  }
  const indexPath = 'updates/windows-x64/stable/latest.yml';
  const previous = await api(`/contents/${indexPath}?ref=main`, 'GET', undefined, true);
  let promotion;
  if (previous) {
    const old = Buffer.from(previous.content.replaceAll('\n', ''), 'base64').toString();
    if (old === manifest) promotion = { alreadyCurrent: true };
    else {
      const oldVersion = parse(old).version;
      assert.ok(semver.lt(oldVersion, config.distributionVersion), 'Stable promotion cannot downgrade or rewrite the same version');
      await writeFile(join(out, `previous-${oldVersion}.yml`), old);
    }
  }
  if (!promotion) promotion = await api(`/contents/${indexPath}`, 'PUT', {
    message: `Promote ZCode AutoReview ${config.distributionVersion} stable`, branch: 'main', ...(previous ? { sha: previous.sha } : {}),
    content: Buffer.from(manifest).toString('base64') });
  const result = { tag, repositoryCommit: commit, releaseUrl: release.html_url, assets: proofs,
    stableIndexUrl: `${config.updateFeedUrl}latest.yml`, promoted: true, alreadyCurrent: promotion.alreadyCurrent === true };
  await writeFile(join(out, 'PUBLISHED.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  return result;
}
