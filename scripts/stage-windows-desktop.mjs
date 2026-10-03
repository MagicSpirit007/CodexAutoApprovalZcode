// 旧便携组装入口已归一为独立安装器，不再生成混合版本或覆盖历史产物。
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { packageInstalledDesktop } from './package-installed-desktop.mjs';
const root = resolve(import.meta.dirname, '..');
if (!process.argv[2]) throw new Error('Provide the Windows Electron/native runtime asset directory.');
const config = JSON.parse(await readFile(join(root, 'release.config.json'), 'utf8'));
const source = join(root, 'host-adapter/upstream');
const built = JSON.parse(await readFile(join(source, 'packages/desktop/out/metadata/build-meta.json'), 'utf8'));
if (built.autoReview?.applicationId !== config.applicationId || built.distributionVersion !== config.distributionVersion)
  throw new Error('Build the production desktop with release.config.json before packaging.');
await packageInstalledDesktop({ root, source, config, assets: resolve(process.argv[2]),
  out: join(root, 'artifacts/autoreview', config.distributionVersion), env: { ...process.env, ZCODE_AUTOREVIEW_TEST_BUILD: '0' } });
