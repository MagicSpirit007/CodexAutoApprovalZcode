import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = await import(pathToFileURL(resolve(root, 'host-adapter/upstream/node_modules/esbuild/lib/main.js')));
await build({
  entryPoints: [resolve(root, 'test/host-chain.test.js')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: resolve(root, 'artifacts/acceptance/host-chain.bundle.mjs'),
  external: ['playwright-core', 'koffi', '@zcode/tui'],
  banner: { js: 'import { createRequire as _createRequire } from "node:module"; import { fileURLToPath as _fileURLToPath } from "node:url"; import { dirname as _dirname } from "node:path"; const require = _createRequire(import.meta.url); const __filename = _fileURLToPath(import.meta.url); const __dirname = _dirname(__filename);' },
});
console.log('Native chain tests bundled for Windows without WSL workspace symlinks.');
await build({
  entryPoints: [resolve(root, 'scripts/desktop-fixture.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: resolve(root, 'artifacts/acceptance/desktop-fixture.bundle.mjs'),
  banner: { js: 'import { createRequire as _createRequire } from "node:module"; import { fileURLToPath as _fileURLToPath } from "node:url"; import { dirname as _dirname } from "node:path"; const require = _createRequire(import.meta.url); const __filename = _fileURLToPath(import.meta.url); const __dirname = _dirname(__filename);' },
});
await build({
  entryPoints: [resolve(root, 'scripts/stage-codex-auto-approval-desktop.mjs')],
  outfile: resolve(root, 'artifacts/acceptance/stage-desktop.bundle.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['original-fs'],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
