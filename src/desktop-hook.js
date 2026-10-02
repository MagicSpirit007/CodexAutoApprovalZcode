import { DesktopBridgeClient, DesktopModelClient } from './desktop-client.js';
import { defaults } from './config.js';
import { Reviewer, rejectionInstructions } from './reviewer.js';
import { Tools } from './tools.js';
import { cancelled, hash, reviewFailure } from './util.js';

export const hookOutput = decision => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
export async function reviewDesktopPermission(input, { env = process.env, signal } = {}) {
  if ((input.hook_event_name ?? input.hookEventName) !== 'PermissionRequest') {
    return hookOutput({ behavior: 'ask', message: 'Unsupported approval event' });
  }
  const deadline = Date.now() + defaults.approval.timeoutMs;
  try {
    const bridge = new DesktopBridgeClient(env);
    const budget = { attempts: 0 };
    for (let attempt = 0; attempt < defaults.approval.maxAttempts; attempt++) {
      cancelled(signal);
      const context = await bridge.context({ signal, deadline });
      const name = input.tool_name ?? input.toolName;
      const parameters = input.tool_input ?? input.toolInput;
      if (context.action.tool !== name || hash(context.action.arguments) !== hash(parameters) || context.sessionId !== (input.session_id ?? input.sessionId)) {
        return hookOutput({ behavior: 'ask', message: 'Approval action does not match the host binding' });
      }
      const tools = new Tools(context.workspace, { runtime: defaults.runtime });
      await tools.initialize();
      const remaining = Math.min(deadline, context.deadline) - Date.now();
      if (remaining <= 0) throw new Error('Automatic review deadline expired');
      const reviewer = new Reviewer({ ...defaults.approval, timeoutMs: remaining }, new DesktopModelClient(bridge, context, budget), tools);
      const result = await reviewer.decide(context.action, context.state, signal);
      // A new snapshot is required after a model or authorization change.
      if (result.status === 'human_required' && result.reason.includes('(stale_context)') && attempt + 1 < defaults.approval.maxAttempts) continue;
      if (result.status === 'human_required') return hookOutput({ behavior: 'ask', message: result.reason, reviewFailure: result.reviewFailure });
      return hookOutput({ behavior: result.status, bindingId: context.bindingId, assessment: result.assessment,
        ...(result.status === 'deny' ? { message: `${result.assessment.rationale}\n\n${rejectionInstructions}` } : {}) });
    }
    return hookOutput({ behavior: 'ask', message: 'Approval context kept changing; manual approval required' });
  } catch (error) {
    cancelled(signal);
    return hookOutput({ behavior: 'ask', message: 'Automatic review unavailable', reviewFailure: reviewFailure(error) });
  }
}
