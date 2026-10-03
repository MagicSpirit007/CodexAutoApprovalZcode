import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'host-adapter/zcode-auto-review.patch'), 'utf8');
const groups = ['01-contract', '02-runtime', '03-interface', '04-distribution'];
const bodies = new Map(groups.map(name => [name, '']));
for (const chunk of source.split(/(?=^diff --git )/m).filter(Boolean)) {
  const path = chunk.match(/^diff --git a\/(.*?) b\//)?.[1];
  if (!path) throw new Error('Invalid patch boundary');
  const group = path.startsWith('packages/shared/') ? groups[0]
    : path.startsWith('apps/zcode-cli/') || path.startsWith('packages/services/') || path.startsWith('packages/desktop/src/host/') ? groups[1]
    : path.startsWith('packages/ui/') || path.startsWith('packages/desktop/src/preload/') ? groups[2] : groups[3];
  bodies.set(group, bodies.get(group) + chunk);
}
const directory = resolve(root, 'host-adapter/patches');
await mkdir(directory, { recursive: true });
const files = [];
for (const name of groups) {
  const body = bodies.get(name);
  if (!body) continue;
  await writeFile(resolve(directory, `${name}.patch`), body);
  files.push({ file: `${name}.patch`, sha256: createHash('sha256').update(body).digest('hex') });
}
await writeFile(resolve(directory, 'order.json'), JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n');
