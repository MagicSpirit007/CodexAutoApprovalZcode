import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectResponsesContinuation, responsesStream, responseMessage } from '../scripts/responses-acceptance-protocol.mjs';
const body = () => ({ store: false, include: ['reasoning.encrypted_content'], input: [
  { type: 'function_call', call_id: 'one', arguments: '{}' }, { type: 'function_call_output', call_id: 'one' },
] });
test('acceptance guard rejects the original missing call body and item-reference failure', () => {
  const missing = body(); missing.input.shift(); assert.throws(() => inspectResponsesContinuation(missing));
  const reference = body(); reference.input.push({ type: 'item_reference', id: 'private' }); assert.throws(() => inspectResponsesContinuation(reference));
});
test('acceptance guard rejects duplicate, mismatched, and stored continuations', () => {
  const duplicate = body(); duplicate.input.push(duplicate.input[0]); assert.throws(() => inspectResponsesContinuation(duplicate));
  const mismatch = body(); mismatch.input[1].call_id = 'two'; assert.throws(() => inspectResponsesContinuation(mismatch));
  const stored = body(); stored.store = true; assert.throws(() => inspectResponsesContinuation(stored));
  assert.deepEqual(inspectResponsesContinuation(body()), { calls: 1, outputs: 1, encrypted: 0 });
});
test('strict fixture exposes completed native output through Responses SSE', () => {
  const text = responsesStream('fixture', [responseMessage('done')], 'response-one');
  assert.match(text, /event: response.output_text.delta/); assert.match(text, /event: response.completed/);
  assert.doesNotMatch(text, /chat.completion/);
});
