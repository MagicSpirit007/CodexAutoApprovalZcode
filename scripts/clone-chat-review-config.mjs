import assert from 'node:assert/strict';

// 独立审查使用专用 provider，避免改动主会话协议或覆盖其他插件选项。
export function cloneChatReviewConfig(providerFile, cliConfig, pluginId, newProviderId) {
  const providers = structuredClone(providerFile), cli = structuredClone(cliConfig);
  const selection = cli.plugins?.options?.[pluginId]?.reviewModel;
  assert.equal(selection?.mode, 'specified', 'Specified review selection required');
  assert.ok(newProviderId && newProviderId !== selection.providerId);
  const config = providers.config;
  assert.ok(!config.providerConfigRules.providerRules.some(rule => rule.providerId === newProviderId), 'Dedicated provider ID already exists');
  const source = config.providerConfigRules.providerRules.find(rule => rule.providerId === selection.providerId);
  assert.ok(source?.config?.api && source.config.access, 'Current provider API and access required');
  const copy = structuredClone(source);
  copy.providerId = newProviderId;
  copy.providerName = 'Chat Completions 自动审查';
  copy.config.api.type = 'openai-chat-completions';
  copy.config.personalModelIds = [selection.modelId];
  config.providerConfigRules.providerRules.push(copy);
  for (const key of ['providerModelRules', 'manualProviderModelRules']) {
    const rules = config.modelConfigRules[key] ??= [];
    rules.push(...rules.filter(rule => rule.providerId === selection.providerId && rule.modelId === selection.modelId)
      .map(rule => ({ ...structuredClone(rule), providerId: newProviderId })));
  }
  if (Array.isArray(config.providerOrder)) config.providerOrder.push(newProviderId);
  selection.providerId = newProviderId;
  return { providers, cli, selection: structuredClone(selection), provider: copy };
}
