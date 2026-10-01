# ZCode 桌面自动审批验收记录

验收日期：2026-10-01（Asia/Shanghai）。版本：CodexAutoApproval 0.1.1。范围：Windows x64 本地桌面插件、宿主补丁及独立适配发行。

## 固定基线与交付

| 项目 | 来源 |
| --- | --- |
| Codex 策略 | `d42056091aded7feb1d88ac7e83972108b2aa478` |
| ZCode Agent / 桌面源码 | `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，3.14.3 |
| Electron / Windows 原生资源 | ZCode 3.14.4 |
| 插件 | CodexAutoApproval，技术 ID codex-auto-approval，0.1.1，桥协议 1 |
| 构建工具 | Node 24.14.0、pnpm 10.33.2 |
| Windows 验证及插件运行时 | Node 22.19.0 |

[Release](https://github.com/MagicSpirit007/CodexAutoApprovalZcode/releases/tag/v0.1.1)提供插件 ZIP、独立 Windows 桌面 ZIP、完整宿主补丁、SHA256SUMS.txt 与 AUTO-REVIEW-BUILD.json。源码与相对路径 marketplace 在仓库中。

桌面发行是混合版本适配，不是官方 3.14.4 完整源码重建；原安装未覆盖。原始 / 适配 Agent 和 app.asar 的指纹见 [build-info.json](evidence/build-info.json)。

## 自动化结果

| 验证 | 结果 |
| --- | --- |
| 原有 CLI | 52/52 通过 |
| Hook 与管道 | 15/15 通过，Linux 与真实 Windows 分别执行 |
| 原生权限链路 | 14/14 通过，Linux 与真实 Windows 分别执行 |
| JavaScript 语法 | 通过 |
| 宿主根类型检查 | 通过 |
| Agent workspace 类型检查 | 27 项任务成功 |
| 宿主根 lint | 0 错误、70 警告 |
| Agent workspace 完整 lint | 未通过；六个未修改文件 max-lines 超限 |
| 改动源码单独 lint | 新增六个 TS 文件 0 错误、0 警告；TSX 由根 lint 覆盖；两个改动文件保留固定基线已有的 max-lines 错误 |
| 架构检查 | 0 违规 |
| 宿主补丁 | 干净固定提交可应用；应用后文件与受测源码一致 |
| Codex 默认策略 | 正文完全一致；比较时统一换行并排除一行新增来源注释 |

81 个不同用例覆盖一次性放行、拒绝反馈、技术失败转人工、取消、熔断、模型 / 推理继承、模型变化、授权变化、会话隔离、明确禁止和 Plan 限制，以及插件安装、停用、卸载。真实 Hook 子进程通过实际 Windows 命名管道与宿主服务连接。

模型为脚本或本机 HTTP 替身；宿主链路使用实际 PermissionService、ToolExecutor、ConfiguredHookRunner 和插件安装器。测试包含原生模型参数校验器与 4096 输出预算上限场景。原生人工 broker 与 Hook 保留竞速和取消语义，人工可以先处理请求。

基线完整 lint 的六处错误位于 telemetry、debug、CLI；改动文件中 bootstrap/create-app 与 contracts/model 的 max-lines 错误在固定提交也存在，不宣称全量 lint 通过。

公开证据：[策略比对](evidence/policy-comparison.json)、[补丁验证](evidence/patch-validation.json)、[桌面场景结果](evidence/desktop-e2e-results.json)。[公开目录复验](evidence/public-checks.json)另记录上传前在 Linux / Windows 各重跑 52 个核心用例、文档链接和密钥扫描。原始开发日志保存在本地交付目录，未上传用户配置、登录信息或真实会话。

## 真实桌面场景

独立 Windows 桌面直接启动 exe，没有 applicationName 环境覆盖。验收仅隔离应用数据、工作区与配置，使用从插件 ZIP 解压的 marketplace 经过原生安装器安装，再操作实际桌面界面。

| 场景 | 结果 |
| --- | --- |
| 独立权限菜单 | 通过：四个权限单选；Ctrl+Shift+M 启用；原生 edit 停用且落盘；Plan 独立；已有会话停用后提示新建会话 |
| 自动放行 | 通过：审查调用一次，探针文件仅写一行，未点击人工允许 |
| 策略拒绝 | 通过：探针不存在，主模型收到禁止绕过指引并继续返回结果 |
| 认证故障 | 通过：审查 HTTP 401，转原生人工审批并人工拒绝，探针未执行 |
| 停用后新会话 | 通过：审查调用零次，原生人工拒绝可操作 |
| 卸载后新会话 | 通过：审查调用零次，原生人工拒绝可操作 |
| 插件列表名称 | 通过：实际显示 CodexAutoApproval |

截图：[权限菜单](images/permission-menu.png)、[插件列表](images/plugin-list.png)。截图来自隔离的验收环境，模型名 Acceptance Local / acceptance-model 为本机替身。

## 安装与复验

从 Release 解压适配桌面并直接运行 ZCode.exe。插件可从 GitHub marketplace 或插件 ZIP 解压目录安装；启用后新建会话，选择权限菜单中的 CodexAutoApproval。工作区有任务运行时锁住切换；启停作用于整个工作区。选择原生权限会停用工作区插件，Plan 保持独立限制。

停用或卸载后新建会话，恢复宿主原生权限流程。原版桌面缺少桥时回人工。官方更新机制保留；升级后须重新核对菜单和桥。

基础复验：`npm test`、`npm run check`。准备固定宿主后执行 `npm run test:desktop`；完整重建步骤见 [宿主说明](../host-adapter/README.md)。CI 自动执行核心测试，不代替 GUI 或真实外部模型验收。

## 未支持与未实测

真实外部模型认证、计费、各提供商返回格式和网络恢复未实测。SSH、WSL、远程工作区与非 Windows 桌面未验证。Cyber 单拒熔断、Codex 专用 reviewer 服务、完整 OS 沙箱、网络代理和全部工具未移植。

详细状态与源码位置见 [迁移对照](migration.md)，不宣称完整复现 Codex。
