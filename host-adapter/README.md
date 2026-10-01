# 宿主适配构建

固定来源：[zai-org/ZCode](https://github.com/zai-org/ZCode)，提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，源码版本 3.14.3。发行包使用 ZCode 3.14.4 的 Electron 与 Windows 原生资源，再装入固定源码重建的 Agent 和桌面 JavaScript。它是独立适配发行，不能称为官方 3.14.4 的完整源码重建。

## 准备固定源码

从本仓库根目录执行以下命令；使用 Node 24.14.0、pnpm 10.33.2。补丁包含 28 个文件的改动及新增接口规格，不需要复制本项目的私人配置或构建缓存。

```sh
git clone https://github.com/zai-org/ZCode.git host-adapter/upstream
git -C host-adapter/upstream checkout --detach 29628c9acdb81b703bbd4080c207a0e7ce5e276e
cd host-adapter/upstream
git apply --check ../zcode-29628c9-auto-review.patch
git apply ../zcode-29628c9-auto-review.patch
pnpm install --frozen-lockfile
node scripts/build-desktop-agent-cli.mjs
```

桌面构建需生产环境变量。在 Linux / WSL 中执行：

```sh
ZCODE_ENV=production pnpm --filter @zcode/desktop build:no-runtime-assets
```

在 PowerShell 中执行：

```powershell
$env:ZCODE_ENV = 'production'
pnpm --filter @zcode/desktop build:no-runtime-assets
```

Agent 产物为 `apps/zcode-cli/packages/cli/dist/zcode.cjs`；桌面产物为 `packages/desktop/out`。

## 复验审批链路

回到本仓库根目录执行：

```sh
npm test
npm run check
npm run test:desktop
```

基础 CI 自动执行不需宿主依赖的 52 个核心用例与语法检查。`test:desktop` 另外执行 15 个 Hook / 管道用例和 14 个宿主权限链路用例，依赖上面准备好的固定源码和 tsx。

Windows 若无法解析 WSL 的依赖符号链接，可在准备依赖的环境中运行 `node scripts/bundle-host-tests.mjs`，再由 Windows Node 执行 `node --test artifacts/acceptance/host-chain.bundle.mjs`。桌面界面自动化脚本在 `scripts/desktop-e2e.mjs`；它只用于开发验收，需要 Playwright 等宿主依赖和可启动的 Windows 构建，模型使用本机 HTTP 替身。

## 组装独立 Windows 发行

准备一份干净的 ZCode 3.14.4 Windows x64 安装目录，作为 Electron / 原生资源来源。不要将用户配置、登录信息、会话或缓存放入该目录。关闭目标适配桌面后，从本仓库根目录执行：

```sh
node scripts/stage-codex-auto-approval-desktop.mjs "C:/Apps/ZCode"
python scripts/build-release.py
```

路径参数指向资源来源目录，里面应有 `ZCode.exe`、`resources/app.asar` 和 `resources/glm/zcode.cjs`。脚本写入本仓库的 `artifacts/CodexAutoApproval-Windows/`，不覆盖来源目录。也可在 WSL 中把参数换成挂载路径；构建结果仍为 Windows 发行。

重建插件代码时运行 `npm run package:desktop`；已有运行时保留。首次替换 Node 运行时可执行 `node scripts/package-desktop.mjs /path/to/node.exe`，并手动核对相应 `runtime/LICENSE-node.txt`。发行包含 Node 22.19.0 Windows x64；安装者不需要另装 Node。

`python scripts/build-release.py` 生成插件 ZIP、桌面 ZIP、补丁副本和 SHA256SUMS.txt。桌面内 `AUTO-REVIEW-BUILD.json` 记录原始 / 适配 Agent 与 app.asar 指纹以及源码来源。

需要重新核对 Codex 策略时，在本仓库同级准备 OpenAI Codex 源码并获取提交 `d42056091aded7feb1d88ac7e83972108b2aa478`，再执行 `python scripts/verify-delivery-source.py`。该脚本比较策略正文，并在临时干净文件中复验完整宿主补丁；不运行 Codex。

## 宿主改动与使用边界

补丁包含私有审批管道、当前会话模型适配器、快照绑定、Hook 结果优先级、ask / 中断传播，以及独立 CodexAutoApproval 权限菜单。新版直接启动 `ZCode.exe`，默认应用身份仍是 `ZCode AutoReview`，沿用旧适配版配置目录；启动新版前退出旧版。

菜单通过原生插件服务写入工作区启停设置；原生权限模式、Plan 约束和更新机制保留。官方更新可能替换适配代码，升级后需重新核对桥和菜单。

公开 [Hooks](https://zcode.z.ai/en/docs/hooks) 不提供完整运行时授权来源及当前模型句柄，因此完整功能需要宿主补丁。[插件规范](https://zcode.z.ai/en/docs/plugin)负责插件安装，不能代替宿主桥。凭据留在宿主，不传入插件。

本次实测与已知限制见 [验收记录](../docs/desktop-acceptance.md)；SSH、WSL、远程工作区和其他桌面系统仍未验证。
