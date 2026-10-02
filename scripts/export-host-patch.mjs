import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cwd = resolve(root, 'host-adapter/upstream');
const git = args => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
  return result.stdout;
};
let patch = git(['diff', '--binary', '--no-ext-diff']);
for (const file of git(['ls-files', '--others', '--exclude-standard']).trim().split('\n').filter(Boolean)) {
  patch += git(['diff', '--no-index', '--binary', '--', '/dev/null', file]);
}
await writeFile(resolve(process.argv[2] ?? resolve(root, 'host-adapter/zcode-29628c9-auto-review.patch')), patch);
console.log('Complete host patch exported, including new ports, adapters and specification.');
