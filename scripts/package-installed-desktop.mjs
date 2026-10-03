import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, rename, writeFile, readdir, access } from 'node:fs/promises';
import { resolve, join, basename, relative, sep } from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import asar from '../host-adapter/upstream/node_modules/@electron/asar/lib/asar.js';
import { collectRuntimeModuleClosureEntries } from '../host-adapter/upstream/packages/desktop/scripts/runtime-dependency-closure.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const run = (program, args, options) => new Promise((done, fail) => {
  const child = spawn(program, args, { ...options, stdio: 'inherit' });
  child.on('error', fail); child.on('exit', code => code === 0 ? done() : fail(new Error(`${program} exited ${code}`)));
});
function windowsPath(path) {
  if (/^[A-Za-z]:[\\/]/.test(path)) return path;
  const match = path.match(/^\/mnt\/([a-z])\/(.*)/);
  if (!match) throw new Error('Windows packaging from WSL requires a Windows-mounted path');
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}`;
}
async function copyWindowsTree(from, to, args = []) {
  if (process.platform === 'win32' || !from.startsWith('/mnt/')) return cp(from, to, { recursive: true });
  // 成千上万的图标文件在 WSL DrvFS 下逐个复制极慢，交由 Windows 原生复制。
  await new Promise((done, fail) => {
    const child = spawn('/mnt/c/Windows/System32/robocopy.exe', [windowsPath(from), windowsPath(to), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', ...args], { stdio: 'inherit' });
    child.on('error', fail); child.on('exit', code => code < 8 ? done() : fail(new Error(`robocopy exited ${code}`)));
  });
}
async function removeStaging(path) {
  try { await access(path); } catch { return; }
  if (process.platform !== 'win32' && path.startsWith('/mnt/')) {
    await run('/mnt/c/Windows/System32/cmd.exe', ['/d', '/c', 'rmdir', '/s', '/q', windowsPath(path)]);
  } else await rm(path, { recursive: true, force: true });
}

export async function packageInstalledDesktop({ root, source, out, assets, config, env, reusePreparedStage = false }) {
  const stage = join(out, 'package-staging');
  const app = join(out, 'win-unpacked');
  const desktop = join(source, 'packages/desktop');
  const tools = await readFile(join(source, 'mise.toml'), 'utf8');
  const nodeVersion = tools.match(/node\s*=\s*"([^"]+)"/)?.[1];
  const pnpmVersion = tools.match(/pnpm\s*=\s*"([^"]+)"/)?.[1];
  const desktopPackage = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
  const electronVersion = desktopPackage.devDependencies.electron;
  if (!nodeVersion || !pnpmVersion || !/^\d+\.\d+\.\d+$/.test(electronVersion)) throw new Error('Source must pin Node, pnpm and Electron versions');
  const windowsNode = env.ZCODE_WINDOWS_NODE ?? join(root, `host-adapter/.build-tools/node-v${nodeVersion}-win-x64/node.exe`);
  if (reusePreparedStage) {
    const previous = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
    if (JSON.stringify(previous.zcodeAutoReview) !== JSON.stringify(config)) throw new Error('Prepared stage release identity differs');
  } else await removeStaging(stage);
  await mkdir(stage, { recursive: true });
  await mkdir(app, { recursive: true });
  // Electron/Windows 原生运行资源可以复用；桌面、Agent、JS 依赖均从同一固定源码重建。
  const originalArchive = join(assets, 'resources/app.asar');
  // 不展开随后就会丢弃的旧桌面和全部 JS 依赖，只取必要的 Windows 原生模块。
  for (const entry of reusePreparedStage ? [] : asar.listPackage(originalArchive)) {
    const relative = entry.replace(/^[/\\]+/, '').replaceAll('\\', '/');
    if (!['node-pty', 'koffi'].some(name => relative.startsWith(`node_modules/${name}/`))) continue;
    const info = asar.statFile(originalArchive, relative);
    if (info.files) continue;
    const target = join(stage, relative);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, asar.extractFile(originalArchive, relative));
  }
  const nativePackages = {};
  for (const name of ['node-pty', 'koffi']) {
    try { nativePackages[name] = JSON.parse(await readFile(join(stage, 'node_modules', name, 'package.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const nativeStage = join(out, 'native-runtime-staging');
  for (const name of Object.keys(nativePackages)) await cp(join(stage, 'node_modules', name), join(nativeStage, name), { recursive: true });
  if (!reusePreparedStage) {
    await rm(join(stage, 'out'), { recursive: true, force: true });
    await rm(join(stage, 'node_modules'), { recursive: true, force: true });
    await copyWindowsTree(join(desktop, 'out'), join(stage, 'out'));
  }
  const requireSource = createRequire(join(source, 'package.json'));
  const ts = requireSource('typescript');
  const bareImports = new Set();
  async function importsIn(dir) {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, file.name);
      if (file.isDirectory()) await importsIn(path);
      else if (/\.(?:js|cjs)$/.test(file.name)) {
        const code = await readFile(path, 'utf8');
        function collect(node) {
          const literal = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
            : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && ['require','__require'].includes(node.expression.text)) ? node.arguments[0] : null;
          const spec = literal && ts.isStringLiteral(literal) ? literal.text : null;
          if (spec && !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:') && spec !== 'electron' && !builtinModules.includes(spec)) bareImports.add(spec);
          ts.forEachChild(node, collect);
        }
        collect(ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
      }
    }
  }
  for (const name of ['main', 'host', 'scheduler', 'preload']) await importsIn(join(stage, 'out', name));
  const importedRoots = [...bareImports].map(spec => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  // tsup 默认也外置 package.json 中声明的依赖；仅列显式 external 会漏掉 ARMS 等启动模块。
  const declared = Object.entries(desktopPackage.dependencies).filter(([name, version]) =>
    !String(version).startsWith('workspace:') && !name.startsWith('@lydell/node-pty-linux')).map(([name]) => name);
  const roots = [...new Set([...declared, ...importedRoots, 'node-pty', 'ssh2', 'undici', '@larksuiteoapi/node-sdk', 'yaml', 'node-forge', 'yauzl',
    'module-details-from-path', '@opentelemetry/api-logs', '@opentelemetry/sdk-metrics',
    '@opentelemetry/exporter-trace-otlp-proto', '@opentelemetry/exporter-metrics-otlp-proto', 'pngjs', 'yazl', 'ms', 'koffi'])];
  const entries = collectRuntimeModuleClosureEntries(roots, [desktop, source]);
  const dependencies = [];
  for (const entry of entries) {
    if (!entry.sourceModulePath) throw new Error(`Required runtime module is missing: ${entry.moduleName}`);
    const pkg = JSON.parse(await readFile(entry.packageJsonPath, 'utf8'));
    const native = nativePackages[entry.moduleName];
    if (native && native.version !== pkg.version) throw new Error(`Native ${entry.moduleName} version does not match pinned source dependencies`);
    const packageRoot = native ? join(nativeStage, entry.moduleName) : entry.sourceModulePath;
    // pnpm 包内的 node_modules 是依赖链接；依赖闭包已单独收集，不能递归展开链接树。
    let alreadyPrepared = false;
    if (reusePreparedStage) {
      try { alreadyPrepared = JSON.parse(await readFile(join(stage, 'node_modules', entry.moduleName, 'package.json'), 'utf8')).version === pkg.version; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (alreadyPrepared) { dependencies.push({ name: entry.moduleName, version: pkg.version }); continue; }
    if (process.platform !== 'win32' && packageRoot.startsWith('/mnt/')) {
      await copyWindowsTree(packageRoot, join(stage, 'node_modules', entry.moduleName), ['/XD', 'node_modules', '.git']);
    } else await cp(packageRoot, join(stage, 'node_modules', entry.moduleName), {
      recursive: true, dereference: true,
      filter: file => !relative(packageRoot, file).split(sep).some(part => part === 'node_modules' || part === '.git'),
    });
    dependencies.push({ name: entry.moduleName, version: pkg.version });
  }
  const packaged = { name: env.ZCODE_AUTOREVIEW_TEST_BUILD === '1' ? 'zcode-autoreview-acceptance' : 'zcode-autoreview',
    version: config.distributionVersion, productName: config.productName, type: 'module',
    main: 'out/main/index.js', zcodeAutoReview: config };
  await writeFile(join(stage, 'package.json'), JSON.stringify(packaged, null, 2));
  const requireStaged = createRequire(join(stage, 'package.json'));
  for (const spec of bareImports) requireStaged.resolve(spec);
  if (process.platform !== 'win32' && assets.startsWith('/mnt/')) {
    await copyWindowsTree(assets, app, ['/XF', 'app.asar', 'app-update.yml', 'Uninstall*.exe', 'uninstallerIcon.ico', '.zcode-install-manifest', 'AUTO-REVIEW-BUILD.json', '/XD', 'app.asar.unpacked']);
  } else await cp(assets, app, { recursive: true, filter: path => {
    const name = basename(path).toLowerCase();
    return !['app.asar', 'app.asar.unpacked', 'app-update.yml', 'uninstall zcode.exe', 'uninstallericon.ico',
      '.zcode-install-manifest', 'auto-review-build.json'].includes(name);
  } });
  for (const name of await readdir(app)) {
    if (/^uninstall.*\.exe$/i.test(name)) await rm(join(app, name));
  }
  const originalExe = join(app, 'ZCode.exe');
  await rename(originalExe, join(app, `${config.executableName}.exe`));
  const archiveOptions = { unpack: '*.{node,dll,dylib,exe}', unpackDir: 'node_modules/node-pty/prebuilds/win32-x64' };
  if (process.platform !== 'win32' && stage.startsWith('/mnt/')) {
    const archiveScript = join(out, 'build-asar.cjs');
    const archivePS = join(out, 'build-asar.ps1');
    await writeFile(archiveScript, `const asar = require(${JSON.stringify(windowsPath(join(source, 'node_modules/@electron/asar/lib/asar.js')))});\nconsole.log('Packing ASAR');\nasar.createPackageWithOptions(${JSON.stringify(windowsPath(stage).replaceAll('\\', '/'))}, ${JSON.stringify(windowsPath(join(app, 'resources/app.asar')))}, ${JSON.stringify(archiveOptions)}).then(()=>console.log('ASAR ready')).catch(e => {console.error(e); process.exitCode=1;});\n`);
    await writeFile(archivePS, `& '${windowsPath(windowsNode).replaceAll("'", "''")}' '${windowsPath(archiveScript).replaceAll("'", "''")}'\nexit $LASTEXITCODE\n`);
    await run(windowsNode, [windowsPath(archiveScript)]);
  } else await asar.createPackageWithOptions(stage, join(app, 'resources/app.asar'), archiveOptions);
  const agent = join(source, 'apps/zcode-cli/packages/cli/dist/zcode.cjs');
  await cp(agent, join(app, 'resources/glm/zcode.cjs'));
  await cp(join(desktop, 'bundled-agents/win32-x64/glm/packages'), join(app, 'resources/glm/packages'), { recursive: true });
  await cp(join(source, 'apps/zcode-cli/packages/cli/dist/provider'), join(app, 'resources/glm/provider'), { recursive: true });
  const metadata = { ...config, distribution: 'independent-nsis', builtAt: new Date().toISOString(),
    agentSha256: sha(await readFile(agent)), asarSha256: sha(await readFile(join(app, 'resources/app.asar'))),
    electronVersion, windowsRuntimeAssetSource: assets, runtimeDependencies: dependencies };
  await writeFile(join(app, 'AUTO-REVIEW-BUILD.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(join(out, 'SOURCE.json'), JSON.stringify({ ...metadata, node: nodeVersion, pnpm: pnpmVersion,
    lockfileSha256: sha(await readFile(join(source, 'pnpm-lock.yaml'))),
    testBuild: env.ZCODE_AUTOREVIEW_TEST_BUILD === '1' }, null, 2) + '\n');
  await writeFile(join(app, 'resources/app-update.yml'), `provider: generic\nurl: ${config.updateFeedUrl}\nupdaterCacheDirName: ${packaged.name}-updater\n`);
  const nsisConfig = { appId: config.applicationId, productName: config.productName,
    electronVersion, directories: { output: out, buildResources: join(desktop, 'build') },
    extraMetadata: packaged, npmRebuild: false, compression: 'normal',
    win: { target: ['nsis'], executableName: config.executableName,
      artifactName: `${config.executableName}-\${version}-win-x64.exe`, signAndEditExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      include: join(desktop, 'build/autoreview-installer.nsh'), shortcutName: config.productName,
      uninstallDisplayName: config.productName, deleteAppDataOnUninstall: false,
      installerIcon: join(desktop, 'build/icon_installer.ico'), uninstallerIcon: join(desktop, 'build/icon_installer.ico') },
    publish: { provider: 'generic', url: config.updateFeedUrl } };
  const receipt = join(out, 'package-config.json');
  const builder = join(out, 'build-nsis.cjs');
  await writeFile(receipt, JSON.stringify(nsisConfig, null, 2));
  await writeFile(builder, `const fs = require('node:fs');\nconst builder = require(${JSON.stringify(windowsPath(join(source, 'node_modules/electron-builder')))});\nconst config = JSON.parse(fs.readFileSync(${JSON.stringify(windowsPath(receipt))}, 'utf8'));\nconst win = v => typeof v === 'string' && /^\\/mnt\\/[a-z]\\//.test(v) ? v[5].toUpperCase() + ':\\\\' + v.slice(7).replaceAll('/', '\\\\') : v;\nfunction paths(v) { if (Array.isArray(v)) return v.map(paths); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,paths(x)])); return win(v); }\nbuilder.build({projectDir: ${JSON.stringify(windowsPath(desktop))}, targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64), prepackaged: ${JSON.stringify(windowsPath(app))}, config: paths(config), publish: 'never'}).catch(e => { console.error(e); process.exitCode = 1; });\n`);
  // 使用源码基线指定的 Windows Node 打包；不依赖本机旧 Node。
  const exe = join(app, `${config.executableName}.exe`);
  const ps = join(out, 'build-nsis.ps1');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  await writeFile(ps, `$ErrorActionPreference = 'Stop'\n$env:ELECTRON_RUN_AS_NODE = '1'\n$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'\n` +
    `$env:CSC_LINK = $null\n$env:WIN_CSC_LINK = $null\n` +
    `$cache = Join-Path $env:LOCALAPPDATA 'electron-builder\\Cache\\winCodeSign'\n` +
    `$rcedit = Get-ChildItem -LiteralPath $cache -Recurse -Filter rcedit-x64.exe | Select-Object -First 1 -ExpandProperty FullName\n` +
    `if (-not $rcedit) { throw 'Prepare the electron-builder Windows code editing tools before packaging' }\n` +
    `& $rcedit ${quote(windowsPath(exe))} --set-file-version ${quote(config.distributionVersion)} --set-product-version ${quote(config.distributionVersion)} --set-version-string ProductName ${quote(config.productName)} --set-version-string FileDescription ${quote(config.productName)} --set-version-string OriginalFilename ${quote(config.executableName + '.exe')}\n` +
    `if ($LASTEXITCODE -ne 0) { throw 'Executable metadata editing failed' }\n` +
    `$signature = Get-AuthenticodeSignature -LiteralPath ${quote(windowsPath(exe))}\n` +
    `if ($signature.SignerCertificate) {\n$signTool = Get-ChildItem -LiteralPath $cache -Recurse -Filter signtool.exe | Where-Object { $_.FullName -like '*windows-10*x64*' } | Select-Object -First 1 -ExpandProperty FullName\nif (-not $signTool) { throw 'Prepare signtool to remove the upstream signature from the adapted executable' }\n& $signTool remove /s ${quote(windowsPath(exe))}\nif ($LASTEXITCODE -ne 0) { throw 'Removing the upstream executable signature failed' }\n}\n` +
    `Set-Location -LiteralPath ${quote(windowsPath(source))}\n& ${quote(windowsPath(windowsNode))} ${quote(windowsPath(builder))}\nexit $LASTEXITCODE\n`);
  const editScript = join(out, 'edit-executable.cjs');
  await writeFile(editScript, `const fs = require('node:fs'); const path = require('node:path'); const {spawnSync} = require('node:child_process');
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign');
function all(dir) {return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?all(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const entries=all(cache); const rcedit=entries.find(f=>f.endsWith('rcedit-x64.exe')); const signTool=entries.find(f=>/windows-10.*x64.*signtool.exe/i.test(f));
function run(file,args) {const r=spawnSync(file,args,{stdio:'inherit'}); if(r.error) throw r.error; if(r.status!==0) throw new Error(file+' exited '+r.status);}
if(!rcedit||!signTool) throw new Error('Prepare cached Windows executable editing tools');
const exe=${JSON.stringify(windowsPath(exe))};
run(rcedit,[exe,'--set-file-version',${JSON.stringify(config.distributionVersion)},'--set-product-version',${JSON.stringify(config.distributionVersion)},'--set-version-string','ProductName',${JSON.stringify(config.productName)},'--set-version-string','FileDescription',${JSON.stringify(config.productName)},'--set-version-string','OriginalFilename',${JSON.stringify(config.executableName + '.exe')}]);
const signature=spawnSync('powershell.exe',['-NoProfile','-Command',"(Get-AuthenticodeSignature -LiteralPath '"+exe.replaceAll("'","''")+"').SignerCertificate -ne $null"],{encoding:'utf8'});
if(signature.status!==0) throw new Error('Cannot inspect upstream executable signature'); if(signature.stdout.trim()==='True') run(signTool,['remove','/s',exe]);
`);
  const nativeNode = process.platform === 'win32' ? process.execPath : windowsNode;
  await run(nativeNode, [process.platform === 'win32' ? editScript : windowsPath(editScript)], { cwd: source });
  await run(nativeNode, [process.platform === 'win32' ? builder : windowsPath(builder)], { cwd: source,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_LINK: '', WIN_CSC_LINK: '' } });
}
