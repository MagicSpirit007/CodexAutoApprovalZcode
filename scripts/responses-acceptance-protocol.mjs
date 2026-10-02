import assert from 'node:assert/strict';

// 无状态请求必须携带原生调用本体；仅输出结构计数，不保存请求数据。
export function inspectResponsesContinuation(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const calls = input.filter(item => item.type === 'function_call');
  const outputs = input.filter(item => item.type === 'function_call_output');
  assert.equal(body.store, false, 'Responses review must be stateless');
  assert.ok(body.include?.includes('reasoning.encrypted_content'));
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.conversation, undefined);
  assert.ok(!input.some(item => item.type === 'item_reference'));
  assert.equal(new Set(calls.map(item => item.call_id)).size, calls.length);
  assert.equal(new Set(outputs.map(item => item.call_id)).size, outputs.length);
  assert.deepEqual(calls.map(item => item.call_id).sort(), outputs.map(item => item.call_id).sort());
  assert.ok(calls.every(item => typeof item.arguments === 'string' && item.arguments.length > 0));
  return { calls: calls.length, outputs: outputs.length,
    encrypted: input.filter(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string').length };
}

export function responsesStream(model, output, id) {
  const response = { id, object: 'response', created_at: 1, model, status: 'completed', output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const events = [{ type: 'response.created', response: { ...response, output: [] } }];
  output.forEach((item, output_index) => {
    events.push({ type: 'response.output_item.added', output_index,
      item: item.type === 'function_call' ? { ...item, arguments: '' } : item });
    if (item.type === 'function_call') events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments });
    if (item.type === 'message') events.push({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: item.content[0].text });
    events.push({ type: 'response.output_item.done', output_index, item });
  });
  events.push({ type: 'response.completed', response });
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

export function responseMessage(text, id = 'acceptance-message') {
  return { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
}
