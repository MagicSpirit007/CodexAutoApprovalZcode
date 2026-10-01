import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addMarketplace, installMarketplacePlugin, uninstallMarketplacePlugin } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/plugins/marketplace.js';
import { createConfig } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/config/index.js';
import { discoverNodePluginsSync } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/plugins/index.js';

export function inspectDesktopFixture(fixture) {
  const config = createConfig({ workingDirectory: fixture.workspace, env: { ...process.env, ZCODE_STORAGE_DIR: fixture.storage } });
  const outcome = discoverNodePluginsSync({ config: config.config.plugins, storageRoot: fixture.storageRoot,
    workingDirectory: fixture.workspace, officialPluginRoots: [] });
  return { configPlugins: config.config.plugins, configSources: config.sources.project.paths,
    diagnostics: outcome.diagnostics, plugins: outcome.plugins.map(plugin => ({ id: plugin.id, enabled: plugin.enabled })),
    hooks: outcome.hooks };
}

export async function prepareDesktopFixture(root, profile, port) {
  const workspace = path.join(profile, 'workspace');
  const storage = path.join(profile, 'agent-storage');
  const storageRoot = path.join(storage, 'cli/plugins');
  const marketplace = path.join(profile, 'marketplace');
  await mkdir(path.join(workspace, '.zcode'), { recursive: true });
  // Acceptance installs the ZIP's extracted payload, with no source-tree dependency.
  const zipMarket = path.join(root, 'artifacts/acceptance/zip-marketplace');
  await cp(path.join(zipMarket, 'marketplace.json'), path.join(marketplace, 'marketplace.json'));
  await cp(path.join(zipMarket, 'plugins/codex-auto-approval'), path.join(marketplace, 'plugins/codex-auto-approval'), { recursive: true });
  await addMarketplace({ source: { source: 'directory', path: marketplace }, storageRoot });
  const { installed } = await installMarketplacePlugin({ marketplace: 'codex-auto-review-local', name: 'codex-auto-approval', storageRoot });
  const pluginId = installed[0].id;
  const projectConfig = path.join(workspace, '.zcode/config.json');
  await writeFile(projectConfig, JSON.stringify({ mode: 'build', storage: { dir: storage, sessionDbPath: path.join(storage, 'test-session.sqlite') },
    plugins: { enabled: true, enabledPlugins: { [pluginId]: true } } }, null, 2));
  await mkdir(path.join(profile, '.zcode/v2'), { recursive: true });
  await writeFile(path.join(profile, '.zcode/v2/provider_config.json'), JSON.stringify({ schemaVersion: 1, config: {
    providerOrder: ['acceptance-local'],
    providerConfigRules: { providerRules: [{ providerId: 'acceptance-local', providerName: 'Acceptance Local', enabled: true,
      config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'LOCAL_ONLY_TEST_VALUE' },
        api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${port}/v1` }, personalModelIds: ['acceptance-model'] } }] },
    modelConfigRules: { providerModelRules: [{ providerId: 'acceptance-local', modelId: 'acceptance-model', config: {
      enabled: true, properties: { contextWindow: 64000, supportsToolCall: true, supportsJsonSchemaOutput: false },
    } }], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: 'acceptance-local', modelId: 'acceptance-model' },
  } }));
  return { workspace, storage, storageRoot, pluginId, projectConfig };
}

export async function toggleDesktopFixture(fixture, enabled) {
  const config = JSON.parse(await readFile(fixture.projectConfig, 'utf8'));
  config.plugins.enabledPlugins[fixture.pluginId] = enabled;
  await writeFile(fixture.projectConfig, JSON.stringify(config, null, 2));
}
export async function uninstallDesktopFixture(fixture) {
  await uninstallMarketplacePlugin({ pluginId: fixture.pluginId, storageRoot: fixture.storageRoot, removeCache: true });
}
export async function reinstallDesktopFixture(fixture) {
  await installMarketplacePlugin({ marketplace: 'codex-auto-review-local', name: 'codex-auto-approval', storageRoot: fixture.storageRoot });
}
