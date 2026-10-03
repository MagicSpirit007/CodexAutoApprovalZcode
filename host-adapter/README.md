# 宿主适配构建与稳定发行

发行配置唯一入口为仓库根目录 `release.config.json`。首个安装版为 **ZCode AutoReview 0.2.0**，桌面和 Agent 的源码均锁定公开 ZCode **3.14.3** 完整提交；插件仍为 **0.1.3**，审批桥为 **v2**。适配版本用于安装器、Windows PE、`app.getVersion()` 和更新索引，上游版本用于原生协议和来源记录。

Electron 与匹配版本的 Windows 原生模块来自构建记录的运行资源目录；JavaScript、运行依赖闭包、桌面与 Agent 均从锁定源码构建。不能将本发行称为官方 3.14.4 的完整源码重建。公开基线的 Computer Use 模块是 unavailable 占位包，本发行不宣称包含该能力。

## 准备源码和补丁

先阅读上游架构受控上下文和 `docs/specs/autoreview-distribution.md`，再修改发行规格与配置。维护者手动选择稳定 tag；没有匹配的公开源码时停止。

```sh
git clone https://github.com/zai-org/ZCode.git host-adapter/upstream
node scripts/distribution-release.mjs prepare --tag <稳定tag> --version <适配发行版本> --checkout <全新检出目录>
```

`prepare` 解析 tag 的完整提交，核对源码版本，在独立 worktree 中按 `patches/order.json` 的顺序和校验值应用补丁：接口、审查运行时、界面、发行更新。遇到冲突立即停止，保留新检出供维护者处理，不覆盖正在开发的目录。也可多次传入 `--patch` 指定维护者整理的提交补丁。

完整源码补丁为 `zcode-auto-review.patch`。`scripts/export-host-patch.mjs` 和 `scripts/export-distribution-patches.mjs` 分别导出完整补丁与有序分组；`scripts/verify-delivery-source.py` 在干净基线复验源码补丁和 Codex 审查策略。

## 构建与校验

使用所选基线 `mise.toml` 规定的 Node、pnpm 和锁文件，先执行 `pnpm install --frozen-lockfile`。首版为 Node 24.14.0、pnpm 10.33.2。

```sh
node scripts/distribution-release.mjs build --source <检出目录> --config <autoreview-release.json> --electron-assets <Windows运行资源目录> --out <交付目录>
npm test
npm run test:desktop
npm run test:responses
npm run test:approval-ui
npm run test:updates
python scripts/verify-delivery-source.py
```

构建工具依次重建 CLI 工作区、桌面 Agent、Desktop Main/Host/preload 和 renderer，校验编译后的独立产品身份，再生成完整 NSIS 安装器。`SOURCE.json` 记录版本、完整提交、工具链、锁文件、Agent/ASAR 指纹和原生资源来源。打包器验证编译产物的外部模块均可解析，避免仅在开发依赖目录中可启动的成品。

Windows 构建需要 Windows Node 与 electron-builder 的 NSIS/rcedit 工具；WSL 可使用项目缓存中的 Windows Node，工具只作用于交付目录。旧 `stage-windows-desktop.mjs` / `stage-codex-auto-approval-desktop.mjs` 现在转到同一安装器组装入口，默认输出 `artifacts/autoreview/<适配版本>/`，不再覆盖旧便携包。

还须执行上游全量 typecheck、lint、架构检查，并与相同提交的干净基线区分既有诊断；新增问题阻断发布。Windows 成品验证使用独立 acceptance appId 与隔离配置，完成两个测试版本的真实安装、下载、重启升级、数据保留和手动回退。

```sh
node scripts/build-update-acceptance.mjs <Windows运行资源目录>
# 以下命令使用 Windows Node 执行
node scripts/windows-update-acceptance.mjs
node scripts/desktop-e2e.mjs --run --all --desktop <成品EXE> --output <验收目录> --fixture-bundle <新构建的fixture.bundle.mjs> --marketplace <插件marketplace>
node scripts/desktop-responses-e2e.mjs --desktop <成品目录> --output <验收目录> --fixture-bundle <fixture.bundle.mjs> --marketplace <插件marketplace> --mode fixture
```

隔离验收完成后以本机配置进行脱敏验证。实际提供商失败不能当作审查成功；凭据、用户文本和完整模型流量不得进入公开验收记录。

## 安装、升级与发布

运行 `ZCodeAutoReview-<发行版本>-win-x64.exe`，默认安装到 `D:\CodexAutoReview\zcode\runtime\ZCodeAutoReview`。固定入口为 `ZCodeAutoReview.exe`，快捷方式名为 **ZCode AutoReview**。应用、卸载项、Windows 标识和更新缓存均与官方版本隔离，沿用旧适配版用户数据和 `.zcode` 设置。

首次安装后运行 `scripts/migrate-autoreview-shortcuts.ps1`。只重定向精确指向旧适配 EXE 的快捷方式，保存原快捷方式备份和收据；保留旧 `artifacts/0.1.3` 目录。旧版正在运行时须正常退出，再从固定入口启动新版本。

启动异步检查本仓库稳定通道，下载和重启均由用户确认。所有窗口和 Host/Agent 均空闲并停止准入后才能安装。适配版不会访问官方更新源，也不自动降级。每次安装将已验证安装器缓存到安装目录之外，供修复和数据兼容的手动回退。

```sh
node scripts/distribution-release.mjs manifest --config <发行配置> --out <交付目录>
node scripts/distribution-release.mjs publish --config <发行配置> --out <交付目录> --checks <绑定安装器SHA256的验收收据>
```

发布只由维护者手动执行：版本固定资产上传并重新下载校验后，最后推进主分支 `updates/windows-x64/stable/latest.yml`。插件发行与桌面稳定索引独立，测试包禁止发布。首版不进行数据库迁移；后续遇到不兼容数据格式时须先设计迁移和回退。

审批桥包含独立审查模型、快照绑定、allow/deny/ask、调查工具、Chat Completions 和 Responses 私有续接、取消/失效清理与原生权限/Plan 边界。模型凭据留在宿主，不传给插件。首期支持 Windows x64 本地工作区；SSH、WSL 和远程工作区不进入稳定安装验收范围。

安装和维护细节见 [升级说明](../docs/distribution-upgrades.md)，既有审批验收见 [桌面验收记录](../docs/desktop-acceptance.md)。
