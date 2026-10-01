import { reviewDesktopPermission, hookOutput } from '../src/desktop-hook.js';

const controller = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => controller.abort(new Error('Approval cancelled')));
let text = '';
try {
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Hook input exceeds budget');
  }
  const result = await reviewDesktopPermission(JSON.parse(text), { signal: controller.signal });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify(hookOutput({ behavior: 'ask', message: controller.signal.aborted ? 'Approval cancelled' : `Automatic review failed: ${error.message}` })) + '\n');
  if (controller.signal.aborted) process.exitCode = 130;
}
