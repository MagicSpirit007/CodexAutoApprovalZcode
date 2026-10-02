import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AiSdkModelAdapter } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/model/index.js';
import { runWithModelInvocationContext, ModelRetryBudget, approvalReviewFailure } from '../host-adapter/upstream/apps/zcode-cli/packages/contracts/dist/index.js';
import { recordGenerateTextDebug, recordStreamTextDebug } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/dist/model/runner-debug.js';

const sse = (event, data) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
function responseStream(protocol) {
  if (protocol === 'openai-chat-completions') return [
    sse('', { id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'review', choices: [{ index: 0, delta: { content: 'visible' }, finish_reason: null }] }),
    sse('', { id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'review', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), 'data: [DONE]\n\n',
  ].join('');
  if (protocol === 'anthropic-messages') return [
    sse('message_start', { type: 'message_start', message: { id: 'ant', type: 'message', role: 'assistant', model: 'review', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'visible' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('');
  const message = { id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'visible', annotations: [] }] };
  const response = { id: 'response', object: 'response', created_at: 1, model: 'review', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  return [sse('response.created', { type: 'response.created', response }),
    sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } }),
    sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'message', output_index: 0, content_index: 0, delta: 'visible' }),
    sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: message }),
    sse('response.completed', { type: 'response.completed', response }),
  ].join('');
}

for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages']) test(`native ${protocol} review uses selected adapter and one attributed request`, async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: JSON.parse(body), type: req.headers['x-zcode-session-type'], session: req.headers['x-session-id'] });
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(responseStream(protocol));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new AiSdkModelAdapter({ env: {}, modelIoFullRetentionEnabled: true });
  const model = adapter.createModel({ providerId: `custom-${protocol}`, modelId: 'review', options: { reasoningLevel: 'high' },
    providerConfig: { access: { type: 'api-key', apiKey: 'test-only-placeholder' }, api: { type: protocol, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } },
    modelConfig: { properties: { contextWindow: 20000, supportsToolCall: true, supportsJsonSchemaOutput: false },
      optionSpecs: { reasoningLevel: { values: ['high'], map: '{}' }, maxOutputTokens: { max: 8192, map: '{"max_tokens":maxOutputTokens}' } } } });
  let visible = '', finished = false;
  await runWithModelInvocationContext({ modelRetryBudget: ModelRetryBudget.SingleAttempt,
    traceContext: { traceId: 'trace-protocol', sessionId: 'session-protocol', queryId: 'query-protocol' },
    metadata: { querySource: 'auto_review', sessionId: 'session-protocol', queryId: 'query-protocol', traceId: 'trace-protocol' }, modelRequestSessionType: 'other' }, async () => {
    for await (const event of model.streamText({ messages: [{ role: 'user', content: 'Return visible' }], options: { maxOutputTokens: 1024 } })) {
      if (event.type === 'error') throw event.error;
      if (event.type === 'text_delta') visible += event.text;
      if (event.type === 'finish') finished = true;
    }
  });
  assert.equal(visible, 'visible'); assert.equal(finished, true); assert.equal(requests.length, 1);
  assert.equal(model.providerId, `custom-${protocol}`); assert.equal(model.options.reasoningLevel, 'high');
  assert.equal(requests[0].type, 'other'); assert.equal(requests[0].session, 'session-protocol');
  assert.match(requests[0].path, protocol === 'anthropic-messages' ? /messages/ : protocol === 'openai-responses' ? /responses/ : /chat\/completions/);
});

test('auto_review never writes private model IO even with full retention enabled', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-private-io-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = { recordModelIO: true, modelIoFullRetentionEnabled: true, debugDir: directory,
    request: { metadata: { querySource: 'auto_review' }, messages: [{ role: 'assistant', content: 'PRIVATE_REASONING' }] },
    result: { reasoningText: 'PRIVATE_REASONING', providerMetadata: { private: 'PRIVATE_METADATA' } } };
  recordGenerateTextDebug(input); await recordStreamTextDebug(input);
  assert.deepEqual(await readdir(directory), []);
});

test('all diagnostic string fields redact bare credentials endpoints multiline and oversized values', () => {
  const failure = approvalReviewFailure({ code: 'sk-CODE_SECRET', message: `sk-MESSAGE_SECRET https://private.example/?token=secret\nstack${'a'.repeat(4000)}`,
    businessCode: 'sk-BUSINESS_SECRET', requestId: 'sk-REQUEST_SECRET', httpStatus: 401, retryAfterMs: 200000 });
  assert.doesNotMatch(JSON.stringify(failure), /CODE_SECRET|MESSAGE_SECRET|BUSINESS_SECRET|REQUEST_SECRET|private.example|stack/);
  assert.equal(failure.httpStatus, 401); assert.equal(failure.retryAfterMs, 90000);
});
