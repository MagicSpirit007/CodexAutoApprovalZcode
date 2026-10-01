#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { defaults, loadConfig } from '../src/config.js';
import { ModelClient } from '../src/model.js';
import { Tools } from '../src/tools.js';
import { Reviewer } from '../src/reviewer.js';
import { Store } from '../src/store.js';
import { Agent } from '../src/agent.js';

function args(argv) {
  const positional = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--no-interactive' || a === '--help') options[a.slice(2)] = true;
    else if (a.startsWith('--')) { if (!['--cwd', '--config', '--message'].includes(a) || !argv[i + 1]) throw new Error(`Invalid option ${a}`); options[a.slice(2)] = argv[++i]; }
    else positional.push(a);
  }
  return { positional, options };
}
const help = `zcode — standalone coding agent, Node.js 22+, no Codex dependency

  zcode init [--cwd PATH]
  zcode run "TASK" [--cwd PATH] [--config FILE] [--json] [--no-interactive]
  zcode resume SESSION [--cwd PATH] [--config FILE] [--message "FOLLOW-UP"]
  zcode status SESSION [--cwd PATH]
  zcode approve SESSION REQUEST ["REASON"] [--cwd PATH]
  zcode deny SESSION REQUEST ["REASON"] [--cwd PATH]
  zcode respond SESSION REQUEST "ANSWER" [--cwd PATH]
  zcode recover SESSION REQUEST retry|skip [--cwd PATH]
  zcode override SESSION DENIAL "RISK-INFORMED APPROVAL" [--cwd PATH]

Review failures pause for a human decision. Denials return to the model and continue.
Use status to inspect the exact pending action; approve/deny never execute it.
Use resume to continue after a recorded human decision. Ctrl+C saves a checkpoint.
`;
async function main() {
  const { positional: pos, options: opts } = args(process.argv.slice(2));
  const [command, ...rest] = pos;
  const workspace = await fs.realpath(path.resolve(opts.cwd ?? process.cwd()));
  if (!command || opts.help || ['help', '-h'].includes(command)) { console.log(help); return; }
  if (command === 'init') {
    const file = path.join(workspace, 'zcode.config.json');
    await fs.writeFile(file, JSON.stringify({ ...defaults, model: { ...defaults.model, model: process.env.ZCODE_MODEL ?? 'YOUR_MODEL_ID' } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Created ${file}. Set model.model/baseUrl/apiKeyEnv. approval.model=null reuses the main model.`); return;
  }
  if (command === 'status') { console.log(JSON.stringify(await new Store(workspace, rest[0]).load(), null, 2)); return; }
  if (command === 'override') {
    if (rest.length < 3) throw new Error('SESSION, DENIAL and explicit approval text are required');
    const store = new Store(workspace, rest[0]);
    await store.lock();
    try { await store.override(rest[1], rest.slice(2).join(' ')); } finally { await store.unlock(); }
    console.log('Exact-action approval recorded for one retry; auto-review will still run. Resume the session.'); return;
  }
  if (['approve', 'deny', 'respond', 'recover'].includes(command)) {
    if (rest.length < 2) throw new Error('SESSION and REQUEST are required');
    const decision = command === 'approve' ? 'allow' : command === 'respond' ? 'respond' : command === 'recover' ? rest[2] : 'deny';
    const text = command === 'recover' ? rest.slice(3).join(' ') : rest.slice(2).join(' ');
    if (command === 'respond' && !text.trim()) throw new Error('ANSWER is required');
    await new Store(workspace, rest[0]).submit(rest[1], decision, text);
    console.log('Human decision recorded. Resume the session to continue.'); return;
  }
  if (!['run', 'resume'].includes(command) || !rest[0]) throw new Error('Use run TASK or resume SESSION; see help');
  const config = await loadConfig(opts.config, workspace);
  const store = new Store(workspace, command === 'resume' ? rest[0] : undefined);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Interrupted by user'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const print = event => {
    if (opts.json) console.log(JSON.stringify(event));
    else if (event.type === 'assistant_message' && event.message.content) console.log(event.message.content);
    else if (['human_required', 'review_completed', 'review_failed', 'context_compacted'].includes(event.type)) console.error(`[${event.type}] ${event.reason ?? event.rationale ?? ''}`);
  };
  const human = !opts['no-interactive'] && process.stdin.isTTY ? async (request, signal) => {
    console.error(JSON.stringify(request, null, 2));
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      if (['question', 'guidance'].includes(request.kind)) {
        const text = await rl.question(`${request.question}\nAnswer: `, { signal });
        return text.trim() ? { decision: 'respond', text } : null;
      }
      const choices = request.kind === 'approval' ? ['allow', 'deny'] : request.kind === 'recovery' ? ['retry', 'skip'] : ['retry'];
      const answer = (await rl.question(`Decision (${choices.join('/')}), empty to pause: `, { signal })).trim();
      const [decision, ...text] = answer.split(/\s+/);
      return choices.includes(decision) ? { decision, text: text.join(' ') } : null;
    } finally { rl.close(); }
  } : null;
  await store.lock();
  try {
    const tools = await new Tools(workspace, config).initialize();
    const reviewer = new Reviewer(config.approval, new ModelClient(config.approval.model), tools, async (type, data) => { await store.event(type, data); print({ type, ...data }); });
    const agent = new Agent({ config, client: new ModelClient(config.model), reviewer, tools, store, human, signal: controller.signal, notify: print });
    print({ type: 'session', id: store.id, workspace });
    if (!opts.json) console.error(`Session: ${store.id}`);
    const wasComplete = command === 'resume' && !opts.message && (await store.load()).status === 'complete';
    const state = command === 'run' ? await agent.start(rest.join(' ')) : await agent.resume(opts.message);
    if (opts.json) print({ type: 'result', id: state.id, status: state.status, ...(state.status === 'complete' ? { final: state.final } : {}) });
    if (state.status === 'complete') { if (wasComplete && !opts.json) console.log(state.final); }
    else { console.error(`Session ${store.id}: ${state.status}. Inspect with status, then resume.`); process.exitCode = 3; }
  } finally { await store.unlock(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
main().catch(e => { console.error(`zcode: ${e.message}`); process.exitCode = 1; });
