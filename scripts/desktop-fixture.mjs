import { createHostApiNetworkTransport } from '../host-adapter/upstream/packages/services/src/providers/api/nodeApiNetwork.ts';
import { accountProviderCredentialKey } from '../host-adapter/upstream/packages/services/src/model-provider/accountProviderCredentialKey.ts';
import { resolveBigModelApiOrigin } from '../host-adapter/upstream/packages/shared/src/zcodeEndpoint.ts';
import { pickOrgAndProject } from '../host-adapter/upstream/packages/services/src/model-provider/accountProviderApiKeyResolver.ts';
import { createCredentialCipherProvider } from '../host-adapter/upstream/packages/services/src/credential/providers/credentialCipherProvider.ts';
import { platform, userInfo } from 'node:os';
export { approvalReviewFailure as sanitizeAcceptanceFailure } from '../host-adapter/upstream/apps/zcode-cli/packages/contracts/dist/index.js';
import { createSqliteSessionStore } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/storage/session-store.js';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addMarketplace, installMarketplacePlugin, uninstallMarketplacePlugin } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/plugins/marketplace.js';
import { createConfig } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/config/index.js';
import { discoverNodePluginsSync } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/plugins/index.js';

export function inspectDesktopFixture(fixture) {
  const config = createConfig({ workingDirectory: fixture.workspace, userConfigPath: path.join(fixture.profile, ".zcode/cli/config.json"), env: { ...process.env, ZCODE_STORAGE_DIR: fixture.storage } });
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
  const zipMarket = path.join(root, 'artifacts/0.1.3/acceptance/zip-marketplace');
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
        api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${port}/v1` }, personalModelIds: ['acceptance-model', 'acceptance-review-model'] } }] },
    modelConfigRules: { providerModelRules: ['acceptance-model', 'acceptance-review-model'].map(modelId => ({ providerId: 'acceptance-local', modelId, config: {
      enabled: true, properties: { contextWindow: 64000, supportsToolCall: true, supportsJsonSchemaOutput: false },
      optionSpecs: { maxOutputTokens: { max: 8192, map: '{"max_tokens": maxOutputTokens}' }, reasoningLevel: { values: ['high', 'max'], map: '{"reasoning_effort":reasoningLevel}' } },
    } })), manualProviderModelRules: [] },
    defaultModelSelection: { providerId: 'acceptance-local', modelId: 'acceptance-model' },
  } }));
  return { profile, workspace, storage, storageRoot, pluginId, projectConfig };
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

export async function armDesktopFixtureApproval(fixture) {
  const store = createSqliteSessionStore({ dbPath: path.join(fixture.storage, 'test-session.sqlite') });
  try {
    for (let poll = 0; poll < 100; poll++) {
      const sessions = await store.listSessions();
      const session = sessions.find(candidate => candidate.projectID);
      if (session) {
        await store.saveProjectPermission({ projectID: session.projectID, permission: { version: 1, ask: [{ toolName: 'Bash' }] } });
        return { sessionId: session.id, projectId: session.projectID };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Isolated native session was not created');
  } finally { store.close(); }
}

export async function rekeyDesktopFixtureCredentials(profile) {
  const credentialFile = path.join(profile, '.zcode/v2/credentials.json');
  const credentials = JSON.parse(await readFile(credentialFile, 'utf8'));
  const originalCipher = createCredentialCipherProvider();
  const isolatedCipher = createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: `zcode-credential-fallback:${platform()}:${profile}:${userInfo().username}` } });
  for (const key of Object.keys(credentials)) credentials[key] = isolatedCipher.encrypt(originalCipher.decrypt(credentials[key]));
  await writeFile(credentialFile, JSON.stringify(credentials));
  return true;
}

export async function probeNativeAccountCredential(profile, providerId) {
  const settings = JSON.parse(await readFile(path.join(profile, '.zcode/v2/setting.json'), 'utf8'));
  const transport = createHostApiNetworkTransport(async () => ({ httpProxy: settings.httpProxy, noProxy: settings.httpProxyNoProxy, caCertPath: settings.httpProxyCaCertPath }));
  const summary = { readOnlyAuthenticationProbe: true, customerInfoAttempted: false, customerInfoSucceeded: false,
    accountLocationPresent: false, existingKeyListAttempted: false, existingNamedApiKeyPresent: false };
  try {
    const credentials = JSON.parse(await readFile(path.join(profile, '.zcode/v2/credentials.json'), 'utf8'));
    const cipher = createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: `zcode-credential-fallback:${platform()}:${profile}:${userInfo().username}` } });
    const token = credentials['oauth:bigmodel:access_token'] ? cipher.decrypt(credentials['oauth:bigmodel:access_token']) : '';
    summary.nativeOAuthTokenPresent = !!token;
    if (!token) return summary;
    const get = async url => {
      const response = await transport.fetch(url, { method: 'GET', headers: { Authorization: token, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
      const body = await response.json().catch(() => null);
      const code = body?.code;
      const businessSucceeded = code === undefined || code === null || code === 0 || code === 200 || code === '0' || code === '200';
      const succeeded = response.status >= 200 && response.status < 300 && !!body && businessSucceeded;
      return { status: response.status, succeeded, code: typeof code === 'number' ? code : typeof code === 'string' && /^-?\d+$/.test(code) ? Number(code) : undefined, data: succeeded ? body.data : undefined };
    };
    const origin = resolveBigModelApiOrigin(process.env);
    summary.customerInfoAttempted = true;
    const customer = await get(`${origin}/api/biz/customer/getCustomerInfo`);
    summary.customerInfoHttpStatus = customer.status;
    if (customer.code !== undefined) summary.customerInfoBusinessCode = customer.code;
    summary.customerInfoSucceeded = customer.succeeded && !!customer.data;
    const location = customer.data ? pickOrgAndProject(customer.data) : null;
    summary.accountLocationPresent = !!location;
    if (!location) return summary;
    summary.existingKeyListAttempted = true;
    const keys = await get(`${origin}/api/biz/v1/organization/${location.organizationId}/projects/${location.projectId}/api_keys`);
    summary.existingKeyListHttpStatus = keys.status;
    if (keys.code !== undefined) summary.existingKeyListBusinessCode = keys.code;
    const keyEntry = Array.isArray(keys.data) ? keys.data.find(item => item.name === 'zcode-api-key' && !!item.apiKey) : undefined;
    summary.existingNamedApiKeyPresent = !!keyEntry;
    if (keyEntry && providerId) {
      const profileRecord = credentials['oauth:bigmodel:user_info'] ? JSON.parse(cipher.decrypt(credentials['oauth:bigmodel:user_info'])) : null;
      summary.nativeAccountIdentityPresent = !!profileRecord?.id;
      if (profileRecord?.id) {
        summary.existingKeyCopyAttempted = true;
        const copied = await get(`${origin}/api/biz/v1/organization/${location.organizationId}/projects/${location.projectId}/api_keys/copy/${encodeURIComponent(keyEntry.apiKey)}`);
        summary.existingKeyCopyHttpStatus = copied.status;
        summary.existingKeyCopySucceeded = copied.succeeded;
        if (copied.code !== undefined) summary.existingKeyCopyBusinessCode = copied.code;
        const secret = copied.data?.secretKey?.trim();
        summary.existingKeySecretPresent = !!secret;
        if (copied.succeeded) {
          const credentialKey = accountProviderCredentialKey({ providerId, planKind: 'individual-coding-plan', accountIdentity: profileRecord.id });
          credentials[credentialKey] = cipher.encrypt(secret ? `${keyEntry.apiKey}.${secret}` : keyEntry.apiKey);
          await writeFile(path.join(profile, '.zcode/v2/credentials.json'), JSON.stringify(credentials));
          summary.originalNamedKeyRestoredIntoIsolatedEncryptedStore = true;
        }
      }
    }
  } catch { summary.nativeReadOnlyProbeFailed = true; }
  finally { await transport.disposeAndWait(); }
  return summary;
}
