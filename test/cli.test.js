import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, temp, call } from './helpers.js';

const bin = fileURLToPath(new URL('../bin/zcode.js', import.meta.url));
async function cli(dir, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args, '--cwd', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function provider(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    try {
      let data = ''; for await (const part of req) data += part;
      const body = JSON.parse(data); seen.push({ url: req.url, body });
      const result = await handler(body, req.url);
      if (result === null) return;
      res.writeHead(typeof result.status === 'number' ? result.status : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body ?? result));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, seen };
}
const chat = message => ({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] });
function reviewAction(body) {
  const text = body.messages?.[1]?.content ?? body.input?.[1]?.content;
  if (!text?.startsWith('The following JSON is evidence')) return null;
  return JSON.parse(text.slice(text.indexOf('\n') + 1)).planned_action;
}
async function writeConfig(dir, baseUrl, extra = {}) {
  const c = config({ ...extra, model: { ...extra.model, baseUrl, apiKeyEnv: '', maxAttempts: 1 } });
  await fs.writeFile(path.join(dir, 'zcode.config.json'), JSON.stringify(c)); return c;
}

test('CLI init and help work without a model or Codex installed', async t => {
  const dir = await temp(t);
  assert.equal((await cli(dir, '--help')).code, 0);
  assert.equal((await cli(dir, 'init')).code, 0);
  assert.equal((await cli(dir, 'init')).code, 1); // No silent overwrite.
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'zcode.config.json'), 'utf8')).approval.model, null);
});
test('real CLI + HTTP: denial goes back to main, safer action executes, session finishes', async t => {
  const dir = await temp(t); let main = 0;
  const p = await provider(t, body => {
    const action = reviewAction(body);
    if (action) return chat({ content: JSON.stringify(action.name === 'shell' ? { outcome: 'deny', rationale: 'No authorization for destruction' } : { outcome: 'allow' }) });
    if (++main === 1) return chat({ content: 'Inspecting task', tool_calls: [call('shell', { command: 'must-never-execute', justification: 'proposal' }, 'deny-call')] });
    if (main === 2) {
      assert.match(body.messages.at(-1).content, /approval_denied/);
      return chat({ content: 'Taking a safer direction', tool_calls: [call('write_file', { path: 'safe-report.txt', content: 'safe report' }, 'safe-call')] });
    }
    return chat({ content: 'Created and verified the report' });
  });
  await writeConfig(dir, p.baseUrl);
  const result = await cli(dir, 'run', 'Create a local report', '--json', '--no-interactive');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(dir, 'safe-report.txt'), 'utf8'), 'safe report');
  assert.equal(p.seen.length, 5);
  const id = JSON.parse(result.stdout.split('\n')[0]).id;
  const status = await cli(dir, 'status', id); assert.equal(JSON.parse(status.stdout).status, 'complete');
});
test('real CLI: model timeout persists approval, approve and resume execute exactly once', async t => {
  const dir = await temp(t); let main = 0;
  const p = await provider(t, body => {
    if (reviewAction(body)) return null; // Keep socket open to exercise real fetch abort.
    if (++main === 1) return chat({ tool_calls: [call('write_file', { path: 'approved.txt', content: 'one exact write' })], content: '' });
    return chat({ content: 'done' });
  });
  await writeConfig(dir, p.baseUrl, { approval: { timeoutMs: 70, maxAttempts: 1 } });
  const result = await cli(dir, 'run', 'Create report', '--json', '--no-interactive');
  assert.equal(result.code, 3, result.stderr);
  const id = JSON.parse(result.stdout.split('\n')[0]).id;
  const s = JSON.parse((await cli(dir, 'status', id)).stdout); assert.equal(s.status, 'waiting_approval');
  await assert.rejects(fs.stat(path.join(dir, 'approved.txt')));
  assert.equal((await cli(dir, 'approve', id, s.pending.id, 'Approve exactly this report write')).code, 0);
  assert.equal((await cli(dir, 'resume', id, '--no-interactive')).code, 0);
  assert.equal(await fs.readFile(path.join(dir, 'approved.txt'), 'utf8'), 'one exact write');
  assert.equal(p.seen.filter(v => reviewAction(v.body)).length, 1);
  assert.equal((await cli(dir, 'resume', id)).code, 0); assert.equal(main, 2);
});
test('independent reviewer uses separate HTTP provider; main model retains its own route', async t => {
  const dir = await temp(t); let main = 0;
  const r = await provider(t, body => { assert.equal(body.model, 'review-only-model'); return chat({ content: '{"outcome":"allow"}' }); });
  const p = await provider(t, body => { assert.equal(body.model, 'test-model'); return ++main === 1 ? chat({ tool_calls: [call('write_file', { path: 'separate.txt', content: 'x' })], content: '' }) : chat({ content: 'done' }); });
  await writeConfig(dir, p.baseUrl, { approval: { model: { model: 'review-only-model', baseUrl: r.baseUrl, apiKeyEnv: '' } } });
  assert.equal((await cli(dir, 'run', 'Write local file', '--no-interactive')).code, 0);
  assert.equal(p.seen.length, 2); assert.equal(r.seen.length, 1);
});
test('Responses API works end-to-end with paired call outputs and the same reviewer', async t => {
  const dir = await temp(t); let main = 0;
  const p = await provider(t, (body, url) => {
    assert.equal(url, '/v1/responses');
    if (reviewAction(body)) return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"outcome":"allow"}' }] }] };
    if (++main === 1) return { status: 'completed', output: [{ type: 'function_call', id: 'fc1', call_id: 'c1', name: 'write_file', arguments: '{"path":"responses.txt","content":"created"}' }] };
    assert.ok(body.input.some(v => v.type === 'function_call_output' && v.call_id === 'c1'));
    return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] };
  });
  await writeConfig(dir, p.baseUrl, { model: { wireApi: 'responses' } });
  const result = await cli(dir, 'run', 'Write local file', '--no-interactive');
  assert.equal(result.code, 0, result.stderr); assert.equal(await fs.readFile(path.join(dir, 'responses.txt'), 'utf8'), 'created');
});
