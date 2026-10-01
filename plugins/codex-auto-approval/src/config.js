import fs from 'node:fs/promises';
import path from 'node:path';

export const defaults = {
  model: { model: '', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', wireApi: 'chat', timeoutMs: 120000, maxAttempts: 3, maxOutputTokens: 8192 },
  approval: { reviewer: 'auto_review', model: null, timeoutMs: 90000, maxAttempts: 3, maxInvestigationCalls: 12, inputMaxChars: 180000, extraPolicy: '', consecutiveDenialLimit: 3, rollingDenialLimit: 10, rollingWindow: 50 },
  runtime: { maxTurns: 0, maxRuntimeMs: 0, contextMaxChars: 160000, keepRecentMessages: 16, shellTimeoutMs: 120000, maxToolOutputChars: 16000 }
};
function positive(value, name, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`${name} must be a ${zero ? 'non-negative' : 'positive'} integer`);
}
function modelConfig(model, name) {
  if (typeof model.model !== 'string' || !model.model.trim()) throw new Error(`${name}.model is required; configure it or set ZCODE_MODEL`);
  if (!['chat', 'responses'].includes(model.wireApi)) throw new Error(`${name}.wireApi must be chat or responses`);
  const url = new URL(model.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name}.baseUrl must be an HTTP(S) base URL without credentials, query or fragment`);
  if (typeof model.apiKeyEnv !== 'string') throw new Error(`${name}.apiKeyEnv must be an environment variable name`);
  for (const key of ['timeoutMs', 'maxAttempts', 'maxOutputTokens']) positive(model[key], `${name}.${key}`);
  if (Object.hasOwn(model, 'apiKey')) throw new Error('Use apiKeyEnv; literal API keys are not supported');
  return model;
}
export function resolveConfig(raw = {}, env = process.env) {
  const model = modelConfig({ ...defaults.model, ...raw.model, ...(env.ZCODE_MODEL ? { model: env.ZCODE_MODEL } : {}), ...(env.ZCODE_BASE_URL ? { baseUrl: env.ZCODE_BASE_URL } : {}) }, 'model');
  const approval = { ...defaults.approval, ...raw.approval };
  if (!['auto_review', 'user'].includes(approval.reviewer)) throw new Error('approval.reviewer must be auto_review or user');
  // A provider override must explicitly select its credentials; never send the main key to a new host.
  if (approval.model?.baseUrl && new URL(approval.model.baseUrl).origin !== new URL(model.baseUrl).origin && !Object.hasOwn(approval.model, 'apiKeyEnv')) throw new Error('An independent approval provider requires its own explicit apiKeyEnv');
  approval.model = approval.model === null ? { ...model } : modelConfig({ ...model, ...approval.model }, 'approval.model');
  if (typeof approval.extraPolicy !== 'string') throw new Error('approval.extraPolicy must be a string');
  for (const key of ['timeoutMs', 'maxAttempts', 'maxInvestigationCalls', 'inputMaxChars', 'consecutiveDenialLimit', 'rollingDenialLimit', 'rollingWindow']) positive(approval[key], `approval.${key}`);
  const runtime = { ...defaults.runtime, ...raw.runtime };
  for (const key of ['maxTurns', 'maxRuntimeMs']) positive(runtime[key], `runtime.${key}`, true);
  for (const key of ['contextMaxChars', 'keepRecentMessages', 'shellTimeoutMs', 'maxToolOutputChars']) positive(runtime[key], `runtime.${key}`);
  return { model, approval, runtime };
}
export async function loadConfig(filename, workspace, env = process.env) {
  const location = path.resolve(filename ?? path.join(workspace, 'zcode.config.json'));
  let raw = {};
  try { raw = JSON.parse(await fs.readFile(location, 'utf8')); } catch (e) { if (e.code !== 'ENOENT' || filename) throw e; }
  let configPath = location;
  try { configPath = await fs.realpath(location); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { ...resolveConfig(raw, env), configPath };
}
