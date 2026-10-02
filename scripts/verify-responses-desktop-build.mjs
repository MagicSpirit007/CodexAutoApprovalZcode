import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import asar from '../host-adapter/upstream/node_modules/@electron/asar/lib/asar.js';
const root = path.resolve('.');
const desktop = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
const hash = data => createHash('sha256').update(data).digest('hex');
const metadata = JSON.parse(await readFile(path.join(desktop, 'AUTO-REVIEW-BUILD.json')));
const bundle = await readFile(path.join(desktop, 'resources/glm/zcode.cjs'));
const source = await readFile(path.join(root, 'host-adapter/upstream/apps/zcode-cli/packages/cli/dist/zcode.cjs'));
assert.equal(hash(bundle), hash(source));
assert.equal(hash(bundle), metadata.adaptedAgentSha256);
const bundleText = bundle.toString();
for (const marker of ['reasoning.encrypted_content', 'querySource', 'auto_review', 'ApprovalContinuation', 'store']) assert(bundleText.includes(marker), marker);
const archive = path.join(desktop, 'resources/app.asar');
assert.equal(hash(await readFile(archive)), metadata.adaptedDesktopAsarSha256);
for (const entry of ['out/main/index.js','out/host/index.js','out/preload/index.cjs','out/renderer/index.html']) {
  assert.equal(hash(asar.extractFile(archive, entry)), hash(await readFile(path.join(root,'host-adapter/upstream/packages/desktop',entry))));
}
const builtin = 'resources/glm/provider/zcode-builtin.json';
assert.equal(hash(await readFile(path.join(desktop,builtin))),hash(await readFile(path.join(root,'host-adapter/upstream/apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json'))));
const result = { date: new Date().toISOString(), verification: 'artifact-integrity-and-current-build-fingerprints', bundleMatchesFreshBuild: true, metadataHashesMatch: true, archiveParses: true, desktopEntrypointsMatchFreshBuild: true, responsesMarkersPresent: true, builtinProviderMatches: true, agentSha256: hash(bundle), desktopAsarSha256: metadata.adaptedDesktopAsarSha256, limitation: 'String fingerprints verify inclusion; behavioral continuation is covered by current source regression and live receipts, separately from desktop GUI smoke.' };
await mkdir(evidence,{recursive:true});
await writeFile(path.join(evidence,'artifact-integrity.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
