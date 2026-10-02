import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = resolve(root, 'plugins/codex-auto-approval');
await mkdir(resolve(plugin, 'src'), { recursive: true });
for (const file of ['config.js', 'model.js', 'reviewer.js', 'tools.js', 'util.js', 'desktop-client.js', 'desktop-hook.js']) {
  await cp(resolve(root, 'src', file), resolve(plugin, 'src', file));
}
for (const file of ['prompts', 'LICENSE', 'NOTICE']) await cp(resolve(root, file), resolve(plugin, file), { recursive: true });
await rm(resolve(plugin, 'runtime'), { recursive: true, force: true });
const manifest = JSON.parse(await readFile(resolve(plugin, '.zcode-plugin/plugin.json'), 'utf8'));
await writeFile(resolve(plugin, 'build-info.json'), JSON.stringify({
  pluginVersion: manifest.version, bridgeProtocol: 2,
  codexCommit: 'd42056091aded7feb1d88ac7e83972108b2aa478',
  hostCommit: '29628c9acdb81b703bbd4080c207a0e7ce5e276e',
  desktopVersion: '3.14.4', agentSourceVersion: '3.14.3',
}, null, 2) + '\n');
console.log(`Plugin staged at ${plugin}; requires Node.js >=22 on PATH.`);
