import { ModelError, cancelled, delay } from './util.js';

function textContent(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter(c => ['text', 'output_text'].includes(c.type)).map(c => c.text).join('');
}
export function requestBody(config, messages, tools = [], json = false) {
  if (config.wireApi === 'chat') {
    const body = { model: config.model, messages, max_completion_tokens: config.maxOutputTokens, stream: false };
    if (tools.length) { body.tools = tools.map(t => ({ type: 'function', function: t })); body.parallel_tool_calls = false; }
    if (json) body.response_format = { type: 'json_object' };
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
    return body;
  }
  const input = [];
  for (const m of messages) {
    if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
    else {
      if (m.content) input.push({ role: m.role, content: m.content });
      if (m.responseItems) input.push(...m.responseItems);
      else for (const call of m.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  const body = { model: config.model, input, max_output_tokens: config.maxOutputTokens, store: false, stream: false, include: ['reasoning.encrypted_content'] };
  if (tools.length) { body.tools = tools.map(t => ({ type: 'function', ...t, strict: false })); body.parallel_tool_calls = false; }
  if (json) body.text = { format: { type: 'json_object' } };
  if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort };
  return body;
}
export function parseResponse(config, body) {
  let result;
  if (config.wireApi === 'chat') {
    const choice = body.choices?.[0];
    if (!choice?.message) throw new ModelError('Model returned no message', { retryable: true });
    if (choice.finish_reason === 'length') throw new ModelError('Model output exceeded maxOutputTokens', { code: 'output_limit' });
    const m = choice.message;
    if (m.refusal || choice.finish_reason === 'content_filter') throw new ModelError('Model refused the request', { code: 'refusal' });
    result = { role: 'assistant', content: textContent(m.content), ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
    // Compatible reasoning providers can require this on subsequent tool turns.
    if (typeof m.reasoning_content === 'string') result.reasoning_content = m.reasoning_content;
  } else {
    if (body.status && body.status !== 'completed') throw new ModelError(`Responses request status: ${body.status}`, { code: 'incomplete' });
    if (!Array.isArray(body.output)) throw new ModelError('Responses request returned no output', { retryable: true });
    if (body.output.some(o => o.content?.some(c => c.type === 'refusal'))) throw new ModelError('Model refused the request', { code: 'refusal' });
    const calls = body.output.filter(o => o.type === 'function_call').map(o => ({ id: o.call_id, type: 'function', function: { name: o.name, arguments: o.arguments } }));
    // Replay encrypted reasoning and provider item IDs exactly when required by Responses.
    result = { role: 'assistant', content: body.output.filter(o => o.type === 'message').map(o => textContent(o.content)).join('\n'), responseItems: body.output.filter(o => o.type !== 'message'), ...(calls.length ? { tool_calls: calls } : {}) };
  }
  for (const call of result.tool_calls ?? []) {
    if (!call.id || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') throw new ModelError('Invalid tool call envelope', { retryable: true });
  }
  if (!result.content && !result.tool_calls?.length) throw new ModelError('Model returned an empty answer', { retryable: true });
  return result;
}
export class ModelClient {
  constructor(config, { fetchImpl = fetch, env = process.env } = {}) { this.config = config; this.fetch = fetchImpl; this.env = env; }
  async complete(messages, { tools = [], json = false, signal, deadline = Date.now() + this.config.timeoutMs } = {}) {
    const c = this.config;
    const key = c.apiKeyEnv ? this.env[c.apiKeyEnv] : '';
    if (c.apiKeyEnv && !key) throw new ModelError(`Missing environment variable ${c.apiKeyEnv}`, { code: 'credentials' });
    const remaining = Math.min(c.timeoutMs, deadline - Date.now());
    if (remaining <= 0) throw new ModelError('Model deadline exceeded', { code: 'timeout' });
    cancelled(signal);
    const timed = AbortSignal.timeout(remaining);
    const combined = signal ? AbortSignal.any([signal, timed]) : timed;
    try {
      const response = await this.fetch(`${c.baseUrl.replace(/\/$/, '')}/${c.wireApi === 'chat' ? 'chat/completions' : 'responses'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(requestBody(c, messages, tools, json)), signal: combined
      });
      if (!response.ok) {
        // Never log provider bodies: they may echo credentials, prompts or private data.
        const retry = response.headers.get('retry-after');
        const retryAfterMs = retry ? (Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
        throw new ModelError(`Model HTTP ${response.status}`, { retryable: [408, 429].includes(response.status) || response.status >= 500, retryAfterMs, code: `http_${response.status}` });
      }
      return parseResponse(c, await response.json());
    } catch (e) {
      cancelled(signal);
      if (timed.aborted) throw new ModelError('Model request timed out', { code: 'timeout' });
      if (e instanceof ModelError) throw e;
      throw new ModelError('Model network or JSON response failure', { retryable: true, code: 'transport' });
    }
  }
}
export async function withRetry(operation, { maxAttempts = 3, deadline, signal, onRetry = () => {} }) {
  for (let attempt = 1; ; attempt++) {
    cancelled(signal);
    try { return await operation(deadline); } catch (e) {
      cancelled(signal);
      if (attempt >= maxAttempts || !e.retryable || Date.now() >= deadline) throw e;
      const waitMs = Math.max(e.retryAfterMs || 0, Math.round(200 * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2)));
      if (Date.now() + waitMs >= deadline) throw new ModelError('Retry deadline exceeded', { code: 'timeout' });
      await onRetry({ attempt, code: e.code });
      await delay(waitMs, signal);
    }
  }
}
