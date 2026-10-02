import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalResponsesOptions } from '../host-adapter/upstream/apps/zcode-cli/packages/adapters/src/model/approval-responses-options.ts';
import { ApprovalContinuation } from '../host-adapter/upstream/apps/zcode-cli/packages/core/src/runtime/helpers/approval-continuation.ts';

test('review stateless options preserve namespace fields without mutating configuration', () => {
  const base = { apiFormat: 'openai-responses', openai: { store: true, previousResponseId: 'private', include: ['message.output_text.logprobs'], reasoningEffort: 'high' } };
  const override = { apiFormat: 'anthropic-messages', openai: { conversation: 'private', include: ['message.output_text.logprobs', 'file_search_call.results'], serviceTier: 'auto' } };
  for (const object of [base.openai.include, base.openai, base, override.openai.include, override.openai, override]) Object.freeze(object);
  const before = JSON.stringify({ base, override });
  const actual = approvalResponsesOptions({ base, override, merged: { ...base, ...override }, providerKind: 'openai', querySource: 'auto_review' });
  assert.deepEqual(actual, { apiFormat: 'openai-responses', openai: { store: false, include: ['message.output_text.logprobs', 'file_search_call.results', 'reasoning.encrypted_content'], reasoningEffort: 'high', serviceTier: 'auto' } });
  assert.equal(JSON.stringify({ base, override }), before);
});
for (const [providerKind, apiFormat, querySource] of [['openai', 'openai-responses', 'main_turn'], ['openai-compatible', 'openai-chat-completions', 'auto_review'], ['anthropic', 'anthropic-messages', 'auto_review']]) test(`options negative control ${apiFormat}/${querySource}`, () => {
  const merged = { openai: { store: true }, apiFormat };
  assert.equal(approvalResponsesOptions({ providerKind, querySource, base: { apiFormat }, override: {}, merged }), merged);
});
test('malformed include fails closed', () => {
  assert.throws(() => approvalResponsesOptions({ providerKind: 'openai', querySource: 'auto_review', base: { apiFormat: 'openai-responses', openai: { include: { secret: 'private' } } } }), /include must/);
});
for (const results of [[], ['wrong'], ['read', 'read']]) test(`continuation rejects invalid result IDs ${JSON.stringify(results)}`, () => {
  const state = new ApprovalContinuation();
  state.save('binding', 1, ['system', 'initial'], [{ role: 'system', content: 'review' }, { role: 'user', content: 'review' }], 'assistant', { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', input: {} }] });
  assert.throws(() => state.restore('binding', 1, ['system', 'initial', 'assistant', ...results.map(id => ({ id }))], [{}, {}, {}, ...results.map(id => ({ role: 'tool', toolCallId: id, content: 'read' }))]), /missing|pending|transcript/);
  assert.throws(() => state.restore('binding', 1, ['system', 'initial', 'assistant', 'result'], [{}, {}, {}, { role: 'tool', toolCallId: 'read', content: 'read' }]), /transcript/);
});

test('request protocol spoof cannot turn Chat Completions into review Responses', () => {
  const merged = { apiFormat: 'openai-responses', openai: { store: true } };
  assert.equal(approvalResponsesOptions({ querySource: 'auto_review', providerKind: 'openai-compatible', base: { apiFormat: 'openai-chat-completions' }, override: merged, merged }), merged);
});
for (const call of [{ id: '', name: 'read_file', input: {} }, { id: 'read', name: 'write_file', input: {} }]) test(`native continuation rejects malformed call ${call.name}/${call.id}`, () => {
  const state = new ApprovalContinuation();
  state.save('binding', 1, ['system', 'initial'], [{}, {}], 'assistant', { role: 'assistant', content: '', toolCalls: [call] });
  assert.throws(() => state.restore('binding', 1, ['system', 'initial', 'assistant', 'result'], [{}, {}, {}, { role: 'tool', toolCallId: call.id, content: 'read' }]), /invalid pending/);
});
test('duplicate native call IDs fail closed', () => {
  const state = new ApprovalContinuation();
  state.save('binding', 1, ['initial'], [], 'assistant', { role: 'assistant', content: '', toolCalls: [1, 2].map(() => ({ id: 'same', name: 'read_file', input: {} })) });
  assert.throws(() => state.restore('binding', 1, ['initial', 'assistant', 'result'], [{}, {}, { role: 'tool', toolCallId: 'same', content: 'read' }]), /invalid pending/);
});

test('initial two messages cannot disguise orphaned tool results', () => {
  const state = new ApprovalContinuation();
  assert.throws(() => state.restore('binding', 1, ['tool', 'tool'], [{ role: 'tool', toolCallId: 'foreign', content: 'result' }, { role: 'user', content: 'review' }]), /initial transcript/);
});
