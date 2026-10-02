import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.argv[2], 'Provide explicit fixture bundle output path');
const { build } = await import(pathToFileURL(resolve(root, 'host-adapter/upstream/node_modules/esbuild/lib/main.js')));
await build({ entryPoints: [resolve(root, 'scripts/desktop-fixture.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: resolve(process.argv[2]),
  banner: { js: 'import { createRequire as _createRequire } from "node:module"; import { fileURLToPath as _fileURLToPath } from "node:url"; import { dirname as _dirname } from "node:path"; const require = _createRequire(import.meta.url); const __filename = _fileURLToPath(import.meta.url); const __dirname = _dirname(__filename);' },
});
