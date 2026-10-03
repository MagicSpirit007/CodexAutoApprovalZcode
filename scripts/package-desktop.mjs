import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(await readFile(resolve(root, 'release.config.json'), 'utf8'));
const plugin = resolve(root, 'plugins/codex-auto-approval');
await mkdir(resolve(plugin, 'src'), { recursive: true });
for (const file of ['config.js', 'model.js', 'reviewer.js', 'tools.js', 'util.js', 'desktop-client.js', 'desktop-hook.js']) {
  await cp(resolve(root, 'src', file), resolve(plugin, 'src', file));
}
for (const file of ['prompts', 'LICENSE', 'NOTICE']) await cp(resolve(root, file), resolve(plugin, file), { recursive: true });
await rm(resolve(plugin, 'runtime'), { recursive: true, force: true });
const manifest = JSON.parse(await readFile(resolve(plugin, '.zcode-plugin/plugin.json'), 'utf8'));
await writeFile(resolve(plugin, 'build-info.json'), JSON.stringify({
  pluginVersion: manifest.version, bridgeProtocol: release.bridgeProtocol,
  codexCommit: release.codexCommit, hostCommit: release.upstreamCommit,
  distributionVersion: release.distributionVersion,
  desktopVersion: release.upstreamVersion, agentSourceVersion: release.upstreamVersion,
}, null, 2) + '\n');
console.log(`Plugin staged at ${plugin}; requires Node.js >=22 on PATH.`);
