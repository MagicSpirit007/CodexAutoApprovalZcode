import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
for (const dir of ['src', 'bin', 'scripts', 'test']) {
  for (const file of await fs.readdir(new URL(`${dir}/`, root))) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(fileURLToPath(new URL(`${dir}/`, root)), file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('All JavaScript syntax checks passed.');
