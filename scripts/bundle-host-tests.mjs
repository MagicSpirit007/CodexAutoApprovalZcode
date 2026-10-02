import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = await import(pathToFileURL(resolve(root, 'host-adapter/upstream/node_modules/esbuild/lib/main.js')));
await build({
  entryPoints: [resolve(root, 'test/host-chain.test.js')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: resolve(root, 'artifacts/0.1.3/acceptance/host-chain.bundle.mjs'),
  external: ['playwright-core', 'koffi', '@zcode/tui'],
  banner: { js: 'import { createRequire as _createRequire } from "node:module"; import { fileURLToPath as _fileURLToPath } from "node:url"; import { dirname as _dirname } from "node:path"; const require = _createRequire(import.meta.url); const __filename = _fileURLToPath(import.meta.url); const __dirname = _dirname(__filename);' },
});
console.log('Native chain tests bundled for Windows without WSL workspace symlinks.');
await build({
  entryPoints: [resolve(root, 'scripts/desktop-fixture.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: resolve(root, 'artifacts/0.1.3/acceptance/desktop-fixture.bundle.mjs'),
  banner: { js: 'import { createRequire as _createRequire } from "node:module"; import { fileURLToPath as _fileURLToPath } from "node:url"; import { dirname as _dirname } from "node:path"; const require = _createRequire(import.meta.url); const __filename = _fileURLToPath(import.meta.url); const __dirname = _dirname(__filename);' },
});
await build({
  entryPoints: [resolve(root, 'scripts/stage-codex-auto-approval-desktop.mjs')],
  outfile: resolve(root, 'artifacts/0.1.3/acceptance/stage-desktop.bundle.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['original-fs'],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

await build({
  entryPoints: [resolve(root, 'scripts/desktop-live-review.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: resolve(root, 'artifacts/0.1.3/acceptance/desktop-live-review.bundle.mjs'),
  external: ['koffi', '@zcode/tui'],
  banner: { js: 'import { createRequire as _createRequire } from "node:module"; import { fileURLToPath as _fileURLToPath } from "node:url"; import { dirname as _dirname } from "node:path"; const require = _createRequire(import.meta.url); const __filename = _fileURLToPath(import.meta.url); const __dirname = _dirname(__filename);' },
});
await build({
  entryPoints: [resolve(root, 'test/approval-protocols.test.js')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: resolve(root, 'artifacts/0.1.3/acceptance/approval-protocols.bundle.mjs'),
  external: ['koffi', '@zcode/tui'],
  banner: { js: 'import { createRequire as _createRequire } from "node:module"; import { fileURLToPath as _fileURLToPath } from "node:url"; import { dirname as _dirname } from "node:path"; const require = _createRequire(import.meta.url); const __filename = _fileURLToPath(import.meta.url); const __dirname = _dirname(__filename);' },
});
await build({
  entryPoints: [resolve(root, 'test/desktop.test.js')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: resolve(root, 'artifacts/0.1.3/acceptance/desktop-bridge.bundle.mjs'),
  external: ['koffi', '@zcode/tui'],
  banner: { js: 'import { createRequire as _createRequire } from "node:module"; import { fileURLToPath as _fileURLToPath } from "node:url"; import { dirname as _dirname } from "node:path"; const require = _createRequire(import.meta.url); const __filename = _fileURLToPath(import.meta.url); const __dirname = _dirname(__filename);' },
});
