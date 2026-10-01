import { cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'artifacts/ZCode-AutoReview-Windows');
const builtAgent = resolve(root, 'host-adapter/upstream/apps/zcode-cli/packages/cli/dist/zcode.cjs');
if (!process.argv[2]) throw new Error('Provide the original ZCode Windows installation directory.');
const originalAgent = resolve(process.argv[2], 'resources/glm/zcode.cjs');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const metadata = {
  distribution: 'local-portable-host-adapter', desktopVersion: '3.14.4', agentSourceVersion: '3.14.3',
  upstreamCommit: '29628c9acdb81b703bbd4080c207a0e7ce5e276e',
  codexCommit: 'd42056091aded7feb1d88ac7e83972108b2aa478', bridgeProtocol: 1,
  originalAgentSha256: await digest(originalAgent), adaptedAgentSha256: await digest(builtAgent),
  desktopAsarSha256: await digest(resolve(output, 'resources/app.asar')),
  changes: ['Agent approval bridge', 'PermissionRequest ask', 'Deny interrupt propagation', 'Hook result precedence'],
};
await cp(builtAgent, resolve(output, 'resources/glm/zcode.cjs'));
await writeFile(resolve(output, 'AUTO-REVIEW-BUILD.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(resolve(output, 'Launch-AutoReview.cmd'), '@echo off\r\nsetlocal\r\nset "ZCODE_DESKTOP_APPLICATION_NAME=ZCode AutoReview"\r\nstart "" "%~dp0ZCode.exe"\r\nendlocal\r\n');
await writeFile(resolve(output, 'README-AutoReview.txt'),
  'Local Windows adapted desktop: launch Launch-AutoReview.cmd.\r\n' +
  'Desktop shell 3.14.4 + patched official Agent source 3.14.3. See AUTO-REVIEW-BUILD.json.\r\n' +
  'Install codex-auto-approval from the supplied local marketplace and enable it; start a new local session.\r\n' +
  'Use normal Build permission mode. Auto mode is not implemented by this upstream version.\r\n' +
  'Stop/uninstall the plugin to use native human approval. The original installation is not changed.\r\n');
console.log(JSON.stringify(metadata));
