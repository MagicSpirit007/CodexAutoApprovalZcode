import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import asar from '../host-adapter/upstream/node_modules/@electron/asar/lib/asar.js';

const root = resolve(process.argv[3] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const upstream = resolve(root, 'host-adapter/upstream');
if (!process.argv[2]) throw new Error('Provide the original ZCode 3.14.4 Windows installation directory.');
const original = resolve(process.argv[2]);
const output = resolve(process.argv[4] ?? resolve(root, 'artifacts/0.1.3/CodexAutoApproval-Windows'));
const staging = resolve(root, 'artifacts/0.1.3/acceptance/asar-staging');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
await mkdir(staging, { recursive: true });
console.log('Extracting original desktop archive');
asar.extractAll(resolve(original, 'resources/app.asar'), staging);
await rm(resolve(staging, 'out'), { recursive: true, force: true });
await cp(resolve(upstream, 'packages/desktop/out'), resolve(staging, 'out'), { recursive: true });
const packaged = JSON.parse(await readFile(resolve(staging, 'package.json'), 'utf8'));
packaged.productName = 'ZCode AutoReview';
packaged.version = '3.14.3';
await writeFile(resolve(staging, 'package.json'), JSON.stringify(packaged, null, 2));
if (!existsSync(resolve(output, 'AUTO-REVIEW-BUILD.json'))) {
  console.log('Copying original Electron/native assets into independent directory');
  await cp(original, output, { recursive: true });
}
console.log('Packing rebuilt desktop archive');
await asar.createPackageWithOptions(staging, resolve(output, 'resources/app.asar.next'), {
  unpack: '*.{node,dll,dylib,exe}', unpackDir: 'node_modules/node-pty/prebuilds/win32-x64',
});
await rm(resolve(output, 'resources/app.asar.unpacked'), { recursive: true, force: true });
await cp(resolve(output, 'resources/app.asar.next'), resolve(output, 'resources/app.asar'));
await cp(resolve(output, 'resources/app.asar.next.unpacked'), resolve(output, 'resources/app.asar.unpacked'), { recursive: true });
await rm(resolve(output, 'resources/app.asar.next'), { force: true });
await rm(resolve(output, 'resources/app.asar.next.unpacked'), { recursive: true, force: true });
const agent = resolve(upstream, 'apps/zcode-cli/packages/cli/dist/zcode.cjs');
await cp(agent, resolve(output, 'resources/glm/zcode.cjs'));
const version = JSON.parse(await readFile(resolve(root, 'plugins/codex-auto-approval/.zcode-plugin/plugin.json'), 'utf8')).version;
const metadata = {
  distribution: 'CodexAutoApproval-local-portable-host-adapter', pluginVersion: version,
  electronAssetSourceVersion: '3.14.4', desktopSourceVersion: '3.14.3', agentSourceVersion: '3.14.3',
  upstreamCommit: '29628c9acdb81b703bbd4080c207a0e7ce5e276e',
  codexCommit: 'd42056091aded7feb1d88ac7e83972108b2aa478', bridgeProtocol: 2,
  applicationIdentity: 'ZCode AutoReview', permissionOption: 'CodexAutoApproval',
  originalAgentSha256: await digest(resolve(original, 'resources/glm/zcode.cjs')),
  adaptedAgentSha256: await digest(agent), originalDesktopAsarSha256: await digest(resolve(original, 'resources/app.asar')),
  adaptedDesktopAsarSha256: await digest(resolve(output, 'resources/app.asar')),
  changes: ['Bridge v2 with independently configured native review model and private tool continuation', 'PermissionRequest ask/interrupt',
    'CodexAutoApproval permission radio option using native workspace plugin settings', 'Direct exe startup with independent application identity'],
};
await writeFile(resolve(output, 'AUTO-REVIEW-BUILD.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(resolve(output, 'README-CodexAutoApproval.txt'),
  'Run ZCode.exe directly. Install CodexAutoApproval from the supplied marketplace, then open a new local workspace session.\r\n' +
  'Configure follow-session or a specified review model in native plugin settings. Provider settings own credentials.\r\n' +
  'Select CodexAutoApproval in the permission menu. Native modes disable the plugin for this workspace. Plan remains an independent restriction.\r\n' +
  'Electron/native assets from installed 3.14.4; patched desktop and Agent source 3.14.3. See AUTO-REVIEW-BUILD.json.\r\n' +
  'This independent distribution does not replace the official installation. Source and installation instructions: https://github.com/MagicSpirit007/CodexAutoApprovalZcode\r\n');
console.log(JSON.stringify(metadata));
