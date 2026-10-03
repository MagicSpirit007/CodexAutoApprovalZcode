import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string', default: resolve(root, 'release.config.json') },
  source: { type: 'string', default: resolve(root, 'host-adapter/upstream') },
  out: { type: 'string' }, tag: { type: 'string' }, version: { type: 'string' },
  checkout: { type: 'string' }, checks: { type: 'string' }, patch: { type: 'string', multiple: true },
  'electron-assets': { type: 'string' }, acceptance: { type: 'boolean', default: false },
} });
const config = JSON.parse(await readFile(values.config, 'utf8'));
const command = positionals[0];
const source = resolve(values.source);
const out = resolve(values.out ?? join(root, 'artifacts', 'autoreview', config.distributionVersion));
const tag = `autoreview-v${config.distributionVersion}`;
const installer = `${config.executableName}-${config.distributionVersion}-win-x64.exe`;
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const run = (program, args, cwd = source, env = process.env, capture = false) => new Promise((done, fail) => {
  const child = spawn(program, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  let text = '';
  if (capture) child.stdout.on('data', bytes => text += bytes);
  child.on('error', fail);
  child.on('exit', code => code === 0 ? done(text.trim()) : fail(new Error(`${program} ${args.join(' ')} exited ${code}`)));
});
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function verifySource() {
  const [head, pkg, tools, plugin] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], source, process.env, true), json(join(source, 'package.json')),
    readFile(join(source, 'mise.toml'), 'utf8'), json(join(root, 'plugins/codex-auto-approval/.zcode-plugin/plugin.json')),
  ]);
  if (head !== config.upstreamCommit || pkg.version !== config.upstreamVersion)
    throw new Error('Source does not match the pinned upstream commit/version; binary-only adaptation is unsupported');
  const nodeVersion = tools.match(/node\s*=\s*"([^"]+)"/)?.[1];
  const pnpmVersion = tools.match(/pnpm\s*=\s*"([^"]+)"/)?.[1];
  if (process.versions.node !== nodeVersion) throw new Error(`Build requires source-pinned Node ${nodeVersion}`);
  if (plugin.version !== config.pluginVersion || !config.supportedPluginVersions.includes(plugin.version))
    throw new Error('Plugin source version is not tested by this release');
  if (await run('pnpm', ['--version'], source, process.env, true) !== pnpmVersion)
    throw new Error(`Build requires source-pinned pnpm ${pnpmVersion}`);
  return { upstreamCommit: head, upstreamVersion: pkg.version, node: nodeVersion, pnpm: pnpmVersion,
    lockfileSha256: hash(await readFile(join(source, 'pnpm-lock.yaml'))) };
}

if (command === 'prepare') {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!values.tag || !values.version || !values.checkout || !stable.test(values.tag.replace(/^v/, '')) || !stable.test(values.version))
    throw new Error('prepare requires --tag <stable upstream tag>, --version <adapted release>, --checkout <new directory>');
  const commit = await run('git', ['rev-parse', `refs/tags/${values.tag}^{commit}`], source, process.env, true);
  const pkg = JSON.parse(await run('git', ['show', `${commit}:package.json`], source, process.env, true));
  if (pkg.version !== values.tag.replace(/^v/, '')) throw new Error('Stable tag and source version disagree');
  const { default: semver } = await import('../host-adapter/upstream/node_modules/semver/index.js');
  const changedBaseline = commit !== config.upstreamCommit || pkg.version !== config.upstreamVersion;
  if (semver.lt(values.version, config.distributionVersion) || changedBaseline &&
      (semver.major(values.version) < semver.major(config.distributionVersion) ||
       semver.major(values.version) === semver.major(config.distributionVersion) && semver.minor(values.version) <= semver.minor(config.distributionVersion)))
    throw new Error('A changed upstream baseline requires a higher minor distribution version; adaptation-only fixes use patch releases');
  const checkout = resolve(values.checkout);
  await run('git', ['worktree', 'add', '--detach', checkout, commit]);
  // 有序补丁由维护者明确给出；冲突立即停止并保留新 checkout 供维护者处理。
  const order = values.patch ? null : await json(resolve(root, 'host-adapter/patches/order.json'));
  const ordered = values.patch ?? order.files.map(entry => resolve(root, 'host-adapter/patches', entry.file));
  for (const [index, patch] of ordered.entries()) {
    if (order && hash(await readFile(patch)) !== order.files[index].sha256) throw new Error(`Ordered patch checksum mismatch: ${patch}`);
    await run('git', ['apply', '--check', resolve(patch)], checkout);
    await run('git', ['apply', resolve(patch)], checkout);
  }
  const next = { ...config, distributionVersion: values.version, upstreamVersion: pkg.version,
    upstreamCommit: commit, upstreamTag: values.tag };
  await writeFile(join(checkout, 'autoreview-release.json'), JSON.stringify(next, null, 2) + '\n');
  console.log(JSON.stringify({ checkout, config: join(checkout, 'autoreview-release.json'), upstreamCommit: commit }));
} else if (command === 'build') {
  const provenance = await verifySource();
  if (!values['electron-assets']) throw new Error('build requires --electron-assets with Electron/native runtime assets');
  await mkdir(out, { recursive: true });
  const env = { ...process.env, NODE_ENV: 'production', ZCODE_ENV: 'production',
    ZCODE_AUTOREVIEW_RELEASE_FILE: resolve(values.config), ZCODE_AUTOREVIEW_TEST_BUILD: values.acceptance ? '1' : '0' };
  const cli = join(source, 'apps/zcode-cli');
  // 先构建 Agent 所有源码依赖，避免旧 dist 隐藏 bootstrap 修改。
  await run('pnpm', ['--dir', cli, 'build'], source, env);
  await run(process.execPath, ['packages/cli/scripts/build.mjs', '--desktop-agent'], cli, env);
  await run(process.execPath, ['scripts/build-metadata.mjs'], join(source, 'packages/desktop'), env);
  await run(process.execPath, ['scripts/run-production-build.mjs'], join(source, 'packages/desktop'), env);
  await writeFile(join(out, 'SOURCE.json'), JSON.stringify({ ...provenance, distributionVersion: config.distributionVersion,
    pluginVersion: config.pluginVersion, bridgeProtocol: config.bridgeProtocol, testBuild: values.acceptance }, null, 2) + '\n');
  const { packageInstalledDesktop } = await import('./package-installed-desktop.mjs');
  await packageInstalledDesktop({ root, source, out, config, env, assets: resolve(values['electron-assets']) });
} else if (command === 'manifest') {
  await mkdir(out, { recursive: true });
  const pkg = await readFile(join(out, installer));
  const sourceRecord = await json(join(out, 'SOURCE.json'));
  if (sourceRecord.testBuild || sourceRecord.upstreamCommit !== config.upstreamCommit || sourceRecord.distributionVersion !== config.distributionVersion)
    throw new Error('Manifest requires a matching production build record');
  const patchFile = values.patch?.[0] ?? resolve(root, 'host-adapter/zcode-auto-review.patch');
  const manifest = { version: config.distributionVersion, files: [{ url: `https://github.com/${config.repository}/releases/download/${tag}/${installer}`,
    sha512: hash(pkg, 'sha512', 'base64'), size: pkg.length }], releaseDate: sourceRecord.builtAt,
    autoReview: { schemaVersion: 1, applicationId: config.applicationId, upstreamVersion: config.upstreamVersion,
      upstreamCommit: config.upstreamCommit, patchSha256: hash(await readFile(patchFile)),
      patchSummary: ['Approval bridge v2', 'Native review model settings and Responses continuation', 'Independent NSIS identity and confirmed stable updates'],
      bridgeProtocol: config.bridgeProtocol, supportedPluginVersions: config.supportedPluginVersions, dataSchemaChanged: false } };
  const { stringify } = await import('../host-adapter/upstream/node_modules/yaml/dist/index.js');
  await writeFile(join(out, 'latest.yml'), stringify(manifest));
  await writeFile(join(out, 'SHA256SUMS.txt'), `${hash(pkg)}  ${installer}\n${hash(await readFile(patchFile))}  ${basename(patchFile)}\n`);
} else if (command === 'publish') {
  if (!values.checks) throw new Error('publish requires explicit --checks acceptance receipt');
  const checks = await json(values.checks);
  const sourceRecord = await json(join(out, 'SOURCE.json'));
  if (sourceRecord.testBuild || sourceRecord.distributionVersion !== config.distributionVersion ||
      checks.distributionVersion !== config.distributionVersion || checks.upstreamCommit !== config.upstreamCommit ||
      checks.artifactSha256 !== hash(await readFile(join(out, installer))) ||
      !['sourceReplay', 'typecheck', 'lint', 'architecture', 'regressions', 'windowsUpgrade', 'dataRetention', 'rollback'].every(key => checks[key] === 'passed'))
    throw new Error('Release gates are incomplete or receipts do not belong to this installer');
  const manifest = await readFile(join(out, 'latest.yml'), 'utf8');
  const { parse } = await import('../host-adapter/upstream/node_modules/yaml/dist/index.js');
  const selected = parse(manifest);
  if (selected.version !== config.distributionVersion || selected.autoReview.applicationId !== config.applicationId ||
      selected.autoReview.upstreamCommit !== config.upstreamCommit || selected.files[0].sha512 !== hash(await readFile(join(out, installer)), 'sha512', 'base64'))
    throw new Error('Stable manifest does not belong to the verified release');
  // 发布顺序是协议的一部分：固定版本资产先验证远端下载，再提交稳定索引。
  const patchFile = values.patch?.[0] ?? resolve(root, 'host-adapter/zcode-auto-review.patch');
  const assets = [join(out, installer), join(out, 'latest.yml'), join(out, 'SOURCE.json'), resolve(patchFile), resolve(values.checks), join(out, 'ACCEPTANCE.md')];
  await writeFile(join(out, 'SHA256SUMS.txt'), (await Promise.all(assets.map(async file =>
    `${hash(await readFile(file))}  ${basename(file)}\n`))).join(''));
  assets.push(join(out, 'SHA256SUMS.txt'));
  const { publishStableRelease } = await import('./publish-stable-release.mjs');
  const { default: semver } = await import('../host-adapter/upstream/node_modules/semver/index.js');
  await publishStableRelease({ config, root, out, assets, manifest, parse, semver, repositoryCommit: checks.repositoryCommit });
} else {
  throw new Error('Usage: distribution-release.mjs prepare|build|manifest|publish [--config file] [--out directory]');
}
