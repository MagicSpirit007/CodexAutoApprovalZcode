> 本文保留初次构建阶段的证据与限制。随后最终成品已部署回 `artifacts/0.1.3/CodexAutoApproval-Windows/` 并完成真实 Chat Completions 最小插件链路复验，旧程序及临时备份已清理。当前交付状态以[最终成品验收](desktop-responses-acceptance-2026-10-02.md)为准；下文“旧版保留”“未替换”等描述仅指初次构建阶段。

# Responses 修复版桌面构建

官家在源码与真实通道验收通过后授权构建可直接使用的 Windows 桌面。根代理负责规格与产物审阅，GPT-6.1-Sol 子代理负责构建、打包及验收脚本。

## 交付范围

输出目录为 `artifacts/0.1.3-responses-fix-20261002/`。其中 `CodexAutoApproval-Windows/ZCode.exe` 是直接运行入口；ZIP 用于复制到其他目录后解压运行。插件版本保持 0.1.3，审批桥保持 v2。

本次从已验收源码重新构建宿主 Agent 与桌面 main、host、preload、renderer，使用本机原版 ZCode 3.14.4 的 Windows Electron 与原生资源组装独立发行。它沿用适配桌面的应用身份及配置路径。旧版交付目录和已安装应用保留，不修改用户模型配置，不升级依赖，不发布。

## 验收要求

- 确认新包的 Agent 由本轮源码重建，包含自动审查 Responses 的无状态选项与完整私有续接校验。
- 校验桌面档案和相邻原生资源完整，包内构建指纹与生成文件一致。
- 使用 Windows 运行器检查包内 Agent 启动，在隔离配置目录中启动新桌面进行页面冒烟检查，仅终止验收脚本启动的进程。
- 验证当前完整源码补丁可应用、旧版指纹保持、ZIP 完整并生成校验和。环境限制单独记录。

源码阶段的 137 项本地测试与两个真实 DeepSeek Responses 续接样例见 [源码修复报告](responses-continuation-2026-10-02.md)。这些结果作为修复依据；最终包的构建和启动结果另列，不把历史截图或旧包记录视为本次成品验收。

## 构建与检查结果

宿主 Agent 与桌面 main、host、preload、renderer 的生产构建均已通过。Windows x64 相邻 Agent 资源沿用上游准备链生成，内置供应商资源与新 bundle 一起组装；完整源码补丁已在固定基线通过干净应用并逐文件比对。

实际构建使用 WSL/Linux Node 22.21.1，Windows 系统 Node 为 22.19.0，新桌面内置 Electron 41.0.3 与 Node 24.14.0。上游固定 Node 24.14.0 未用于编译；为遵守不安装或升级依赖的范围，直接运行已安装 TypeScript、esbuild、tsup、Vite 的工具入口，并在当前进程临时修正 PATH。普通沙箱创建进程失败、初始工具路径错误与 PATH 中 Node 无法执行的环境问题，经修正后构建通过，没有把环境失败记为代码测试失败。命令及限制见 [build-commands.json](evidence/build-responses-2026-10-02/build-commands.json)。

新包的 Agent 与本轮新构建 bundle 的 SHA256 一致；桌面 ASAR 可解析，main、host、preload、renderer 入口字节与本轮输出一致，内置供应商资源匹配。包内 Agent 与 ASAR 指纹分别为：

```text
Agent  6e24be474b337b51267e4813dda304411f9696b4efef921e84cafc12923b282e
ASAR   acf9813dcd88bf5b022692ae3103bda4f0071293b70ef4044f32a34805f22ec1
```

Windows 系统 Node 加载包内 Agent `--help`、Electron 内置运行器版本检查和 Electron 加载 Agent `--help` 均退出 0，临时配置已清理。见 [artifact-integrity.json](evidence/build-responses-2026-10-02/artifact-integrity.json) 与 [windows-agent-start.json](evidence/build-responses-2026-10-02/windows-agent-start.json)。修复字符串用于确认打包包含对应代码，行为结论来自上述源码严格测试与真实通道记录。

隔离配置下的新桌面首页加载通过，正文非空，页面错误为零；根代理审阅了本次截图。因验收未复制真实用户配置，首页显示尚未配置模型，这是隔离样例的预期状态。首次清理遇到 SQLite 文件占用，调整为先终止验收进程树、再断开调试连接并短暂重试删除后，复验通过；只终止本次启动的进程树，临时配置目录实际已删除。见 [界面收据](evidence/build-responses-2026-10-02/windows/desktop-smoke.json)、[清理收据](evidence/build-responses-2026-10-02/windows/profile-cleanup.json)。

旧 `0.1.3` 的桌面 ASAR、Agent、构建元数据、ZIP 及原宿主补丁 SHA256 与构建前一致，见 [old-artifact-preservation.json](evidence/build-responses-2026-10-02/old-artifact-preservation.json)。`0.1.2` 目录和原安装保留。

交付目录提供桌面 ZIP、插件 ZIP、完整宿主源码补丁、`ACCEPTANCE.md`、`CHECKS.json` 与 `SHA256SUMS.txt`。归档完成后的 CRC、关键条目及文档一致性结果另存 `archive-validation.json`，无需把归档自身的校验结果写回 ZIP 内。

## 验证边界

源码阶段的严格 HTTP 复现、协议回归和当前 DeepSeek Responses 实网续接已经通过；本次构建阶段核验了文件一致性、Windows Agent 启动和隔离首页加载。未再次以 Windows 成品执行真实模型请求，未重走完整插件安装流程，未验证官方自动更新、安装器或卸载器。现有用户配置和已安装应用没有替换。GLM 的服务端 `unusual activity` 拦截仍不在本次修复范围内。

## 使用步骤

退出正在运行的旧适配桌面，打开 `artifacts/0.1.3-responses-fix-20261002/CodexAutoApproval-Windows/ZCode.exe`。也可解压同目录的 `CodexAutoApproval-Windows-0.1.3.zip`，运行其中的 `ZCode.exe`。已安装并启用 0.1.3 插件时可继续沿用；打开工作区后新建会话，选择权限菜单中的 **CodexAutoApproval**。独立审查模型保持原有配置。

首次安装时解压同目录的插件 ZIP，在 **设置 → 插件 → 创建 → 添加 marketplace** 中选择含 `marketplace.json` 的目录，安装并启用插件，再新建会话。

需要回退时退出新版本，再启动保留的旧版本。不要让两个相同应用身份的适配版本同时运行。
