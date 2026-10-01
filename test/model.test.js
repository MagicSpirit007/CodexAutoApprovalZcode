import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelClient, requestBody, parseResponse, withRetry } from '../src/model.js';
import { ModelError } from '../src/util.js';
import { config, call, assistant } from './helpers.js';

test('Chat Completions retains tool-call/result pairing', () => {
  const c = config().model;
  const messages = [assistant(call('read_file', { path: 'x' }, 'id')), { role: 'tool', tool_call_id: 'id', content: 'data' }];
  assert.deepEqual(requestBody(c, messages).messages, messages);
});
test('Responses converts tool calls and carries reasoning items with encrypted replay', () => {
  const c = config({ model: { wireApi: 'responses' } }).model;
  const response = parseResponse(c, { status: 'completed', output: [{ type: 'reasoning', id: 'r', encrypted_content: 'encrypted' }, { type: 'function_call', id: 'f', call_id: 'c', name: 'read_file', arguments: '{"path":"x"}' }] });
  const body = requestBody(c, [response, { role: 'tool', tool_call_id: 'c', content: 'x' }]);
  assert.equal(body.input[0].encrypted_content, 'encrypted'); assert.equal(body.input[2].call_id, 'c');
  assert.deepEqual(body.include, ['reasoning.encrypted_content']); assert.equal(body.store, false);
});
test('refusal, empty response, incomplete output and malformed tools are failures', () => {
  const c = config().model;
  for (const response of [{ choices: [] }, { choices: [{ message: { refusal: 'no' } }] }, { choices: [{ message: { content: '' } }] }, { choices: [{ message: { content: 'x', tool_calls: [{ id: 'x' }] } }] }, { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }]) assert.throws(() => parseResponse(c, response), ModelError);
  assert.throws(() => parseResponse({ ...c, wireApi: 'responses' }, { status: 'incomplete', output: [] }), /status/);
});
test('HTTP transient errors retry within one deadline; authentication errors do not', async () => {
  let attempts = 0;
  const c = new ModelClient(config().model, { fetchImpl: async () => { attempts++; return attempts === 1 ? new Response('{}', { status: 503 }) : Response.json({ choices: [{ message: { content: 'ok' } }] }); } });
  const output = await withRetry(deadline => c.complete([{ role: 'user', content: 'test' }], { deadline }), { maxAttempts: 3, deadline: Date.now() + 3000 });
  assert.equal(output.content, 'ok'); assert.equal(attempts, 2);
  attempts = 0;
  const bad = new ModelClient(config().model, { fetchImpl: async () => { attempts++; return new Response('credential-echo', { status: 401 }); } });
  await assert.rejects(withRetry(deadline => bad.complete([], { deadline }), { maxAttempts: 3, deadline: Date.now() + 3000 }), e => e.message === 'Model HTTP 401');
  assert.equal(attempts, 1);
});
test('Retry-After beyond the common deadline escalates instead of waiting indefinitely', async () => {
  let attempts = 0;
  await assert.rejects(withRetry(async () => { attempts++; throw new ModelError('overload', { retryable: true, retryAfterMs: 10000 }); }, { maxAttempts: 3, deadline: Date.now() + 100 }), /deadline/);
  assert.equal(attempts, 1);
});
test('missing key is a technical error without network access', async () => {
  let sent = false;
  const c = new ModelClient(config({ model: { apiKeyEnv: 'NOT_SET' } }).model, { env: {}, fetchImpl: async () => { sent = true; } });
  await assert.rejects(c.complete([]), /NOT_SET/); assert.equal(sent, false);
});
test('retry waits honor cancellation', async () => {
  const controller = new AbortController();
  const result = withRetry(async () => { throw new ModelError('busy', { retryable: true, retryAfterMs: 2000 }); }, { maxAttempts: 3, deadline: Date.now() + 10000, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancelled')), 20);
  await assert.rejects(result, /cancelled/);
});
