# 宿主适配构建

固定来源：[zai-org/ZCode](https://github.com/zai-org/ZCode)，提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，源码版本 3.14.3。发行包使用 ZCode 3.14.4 的 Electron 与 Windows 原生资源，再装入固定源码重建的 Agent 和桌面 JavaScript。它是独立适配发行，不能称为官方 3.14.4 的完整源码重建。

## 准备固定源码

从本仓库根目录执行以下命令；使用 Node 24.14.0、pnpm 10.33.2。补丁包含完整宿主改动及接口规格，不需要复制本项目的私人配置或构建缓存。

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

基础 CI 自动执行不需宿主依赖的 52 个核心用例与语法检查。`test:desktop` 另外执行 15 个 Hook / 管道用例和 24 个常规宿主权限链路用例，依赖上面准备好的固定源码和 tsx。设置 `ZCODE_TEST_REVIEW_DEADLINE=1` 会启用额外的实际 90 秒总时限用例。

Windows 若无法解析 WSL 的依赖符号链接，可在准备依赖的环境中运行 `node scripts/bundle-host-tests.mjs`，再由 Windows Node 执行 `node --test artifacts/acceptance/host-chain.bundle.mjs`。桌面界面自动化脚本在 `scripts/desktop-e2e.mjs`；它只用于开发验收，需要 Playwright 等宿主依赖和可启动的 Windows 构建，模型使用本机 HTTP 替身。

Windows Node 执行 `node scripts/desktop-e2e.mjs --run --all` 验证完整桌面场景。`node scripts/desktop-review-settings.mjs` 验证配置与重启；`node artifacts/0.1.3/acceptance/desktop-live-review.bundle.mjs .` 在 Windows 隔离宿主使用 `DEEPSEEK_API_KEY` 验证官方 deepseek-flash / High 的真实审批和文件调查。`--run --glm-deepseek-review` 验证 GLM 主会话与 DeepSeek 审查；`--run --live-glm` 在临时配置中继承当前 GLM 原生配置并强制测试动作经过审批；退出后删除临时凭据配置，结果只保留脱敏归属信息。真实提供商失败不能当作审查成功。

## 组装独立 Windows 发行

准备一份干净的 ZCode 3.14.4 Windows x64 安装目录，作为 Electron / 原生资源来源。不要将用户配置、登录信息、会话或缓存放入该目录。关闭目标适配桌面后，从本仓库根目录执行：

```sh
node scripts/stage-codex-auto-approval-desktop.mjs "C:/Apps/ZCode"
python scripts/build-release.py
```

路径参数指向资源来源目录，里面应有 `ZCode.exe`、`resources/app.asar` 和 `resources/glm/zcode.cjs`。脚本写入本仓库的 `artifacts/0.1.3/CodexAutoApproval-Windows/`，不覆盖来源目录。也可在 WSL 中把参数换成挂载路径；构建结果仍为 Windows 发行。

重建插件代码时运行 `npm run package:desktop`。插件使用 `PATH` 中的系统 Node.js 22 或以上；打包脚本清理旧的随包运行时，发行 ZIP 不包含 Node。安装者需安装 Windows Node.js 并加入 `PATH`，用 `node --version` 确认版本，随后重启桌面。

`python scripts/build-release.py` 在 `artifacts/0.1.3/` 生成插件 ZIP、桌面 ZIP、补丁副本和 SHA256SUMS.txt。桌面内 `AUTO-REVIEW-BUILD.json` 记录原始 / 适配 Agent 与 app.asar 指纹以及源码来源。

需要重新核对 Codex 策略时，在本仓库同级准备 OpenAI Codex 源码并获取提交 `d42056091aded7feb1d88ac7e83972108b2aa478`，再执行 `python scripts/verify-delivery-source.py`。该脚本比较策略正文，并在临时干净文件中复验完整宿主补丁；不运行 Codex。

## 宿主改动与使用边界

补丁包含私有审批管道、独立审查模型解析与原生适配器、快照绑定、Hook 结果优先级、ask / 中断传播，以及独立 CodexAutoApproval 权限菜单。新版直接启动 `ZCode.exe`，默认应用身份仍是 `ZCode AutoReview`，沿用旧适配版配置目录；启动新版前退出旧版。

0.1.3 显式传递审查所属会话、轮次、query 与工具 TraceContext，并用原生 streamText 收集结果。仅启用的本插件能力实行审查优先：allow/deny 不发布人工请求；技术失败先登记应答，再显示原因和人工窗口。运行时及回放保存审查开始、完成状态和实际审查模型。桥协议为 v2，桌面与插件必须配套。原生插件配置服务保存用户／工作区的模型引用，工作区覆盖用户默认；主会话模型独立。思考内容与供应商续接元数据只保存在当前绑定的私有上下文，取消、重试、失效和完成时清理，自动审查不写完整模型轨迹。

菜单通过原生插件服务写入工作区启停设置；原生权限模式、Plan 约束和更新机制保留。官方更新可能替换适配代码，升级后需重新核对桥和菜单。

公开 [Hooks](https://zcode.z.ai/en/docs/hooks) 不提供完整运行时授权来源及当前模型句柄，因此完整功能需要宿主补丁。[插件规范](https://zcode.z.ai/en/docs/plugin)负责插件安装，不能代替宿主桥。0.1.3 需手动解压插件 ZIP 后添加本地 marketplace；移除随包 Node 后满足 GitHub 归档入口的单文件 50 MiB 限制，仓库地址安装尚未复验。凭据留在宿主，不传入插件。

本次实测与已知限制见 [验收记录](../docs/desktop-acceptance.md)；SSH、WSL、远程工作区和其他桌面系统仍未验证。

0.1.3 仅本地交付；保留 `artifacts/0.1.2/` 供回退，无数据库迁移或公开发布。最终检查与真实模型状态以验收报告为准。
