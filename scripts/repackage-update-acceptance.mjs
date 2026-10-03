// 仅复用已记录同一基线且身份一致的编译阶段；用于修复打包规则，不重用其他发行的 JS。
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { packageInstalledDesktop } from './package-installed-desktop.mjs';
const root = resolve(import.meta.dirname, '..');
const source = join(root, 'host-adapter/upstream');
const release = JSON.parse(await readFile(join(root, 'release.config.json'), 'utf8'));
const p = release.distributionVersion.split('.').map(Number);
for (const version of [release.distributionVersion, `${p[0]}.${p[1]}.${p[2]+1}`]) {
  const out = join(root, 'artifacts/autoreview/update-acceptance', version);
  const config = JSON.parse(await readFile(join(out, 'package-staging/package.json'), 'utf8')).zcodeAutoReview;
  if (config.upstreamCommit !== release.upstreamCommit || config.applicationId !== release.applicationId + '.acceptance') throw new Error('Prepared acceptance source mismatch');
  await packageInstalledDesktop({ root, source, out, config, assets: resolve(process.argv[2] ?? '/mnt/d/ZCode'),
    env: { ...process.env, ZCODE_AUTOREVIEW_TEST_BUILD: '1' }, reusePreparedStage: true });
}
await packageInstalledDesktop({ root, source, config: release, assets: resolve(process.argv[2] ?? '/mnt/d/ZCode'),
  out: join(root, 'artifacts/autoreview', release.distributionVersion),
  env: { ...process.env, ZCODE_AUTOREVIEW_TEST_BUILD: '0' }, reusePreparedStage: true });
