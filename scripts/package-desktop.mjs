import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = resolve(root, 'plugins/codex-auto-approval');
await mkdir(resolve(plugin, 'src'), { recursive: true });
for (const file of ['config.js', 'model.js', 'reviewer.js', 'tools.js', 'util.js', 'desktop-client.js', 'desktop-hook.js']) {
  await cp(resolve(root, 'src', file), resolve(plugin, 'src', file));
}
for (const file of ['prompts', 'LICENSE', 'NOTICE']) await cp(resolve(root, file), resolve(plugin, file), { recursive: true });
const windowsNode = process.argv[2];
if (windowsNode) {
  await mkdir(resolve(plugin, 'runtime'), { recursive: true });
  await cp(resolve(windowsNode), resolve(plugin, 'runtime/node.exe'));
}
const manifest = JSON.parse(await readFile(resolve(plugin, '.zcode-plugin/plugin.json'), 'utf8'));
await writeFile(resolve(plugin, 'build-info.json'), JSON.stringify({
  pluginVersion: manifest.version, bridgeProtocol: 1,
  codexCommit: 'd42056091aded7feb1d88ac7e83972108b2aa478',
  hostCommit: '29628c9acdb81b703bbd4080c207a0e7ce5e276e',
  desktopVersion: '3.14.4', agentSourceVersion: '3.14.3',
}, null, 2) + '\n');
console.log(`Self-contained plugin staged at ${plugin}`);
