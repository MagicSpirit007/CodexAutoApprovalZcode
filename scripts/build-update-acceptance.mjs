import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { packageInstalledDesktop } from './package-installed-desktop.mjs';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'host-adapter/upstream');
const config = JSON.parse(await readFile(join(root, 'release.config.json'), 'utf8'));
const directory = join(root, 'artifacts/autoreview/update-acceptance');
const desktop = join(source, 'packages/desktop');
const assets = resolve(process.argv[2] ?? '/mnt/d/ZCode');
const refreshCompiled = process.argv.includes('--refresh-compiled');
async function refreshStage(out, config) {
  if (!refreshCompiled) return;
  const previous = JSON.parse(await readFile(join(out, 'SOURCE.json'), 'utf8'));
  const identity = JSON.parse(await readFile(join(out, 'package-staging/package.json'), 'utf8')).zcodeAutoReview;
  const lock = createHash('sha256').update(await readFile(join(source, 'pnpm-lock.yaml'))).digest('hex');
  if (previous.upstreamCommit !== config.upstreamCommit || previous.lockfileSha256 !== lock || JSON.stringify(identity) !== JSON.stringify(config))
    throw new Error('Reusing dependencies requires identical source baseline, lockfile and product identity');
  for (const name of ['main', 'host', 'scheduler', 'preload']) {
    const target = join(out, 'package-staging/out', name);
    await rm(target, { recursive: true, force: true });
    await cp(join(desktop, 'out', name), target, { recursive: true });
  }
}
const run = (args, env, cwd = desktop) => new Promise((done, fail) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
  child.on('error', fail); child.on('exit', code => code === 0 ? done() : fail(new Error(`Build exited ${code}`)));
});
await mkdir(directory, { recursive: true });
// 测试包与生产安装注册完全隔离；只复用已完成同基线构建的 Agent 和 renderer。
const parts = config.distributionVersion.split('.').map(Number);
const nextTestVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
for (const version of [config.distributionVersion, nextTestVersion]) {
  const testConfig = { ...config, distributionVersion: version,
    applicationId: config.applicationId + '.acceptance', productName: config.productName + ' Acceptance' };
  const file = join(directory, `release-${version}.json`);
  await writeFile(file, JSON.stringify(testConfig, null, 2) + '\n');
  const env = { ...process.env, NODE_ENV: 'production', ZCODE_ENV: 'production',
    ZCODE_AUTOREVIEW_RELEASE_FILE: file, ZCODE_AUTOREVIEW_TEST_BUILD: '1' };
  for (const name of ['main', 'host', 'scheduler', 'preload']) await rm(join(desktop, 'out', name), { recursive: true, force: true });
  await run(['scripts/build-metadata.mjs'], env);
  await run(['../../node_modules/tsup/dist/cli-default.js'], env);
  await refreshStage(join(directory, version), testConfig);
  await packageInstalledDesktop({ root, source, config: testConfig, env, assets, out: join(directory, version), reusePreparedStage: refreshCompiled });
}
// 后续生产打包重新编译，测试通道不会进入正式程序。
const env = { ...process.env, NODE_ENV: 'production', ZCODE_ENV: 'production',
  ZCODE_AUTOREVIEW_RELEASE_FILE: join(root, 'release.config.json'), ZCODE_AUTOREVIEW_TEST_BUILD: '0' };
for (const name of ['main', 'host', 'scheduler', 'preload']) await rm(join(desktop, 'out', name), { recursive: true, force: true });
await run(['scripts/build-metadata.mjs'], env);
await run(['../../node_modules/tsup/dist/cli-default.js'], env);
const productionOut = join(root, 'artifacts/autoreview', config.distributionVersion);
await refreshStage(productionOut, config);
await packageInstalledDesktop({ root, source, config, env, assets, out: productionOut, reusePreparedStage: refreshCompiled });
