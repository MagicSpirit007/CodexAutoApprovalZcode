# CodexAutoApproval 0.1.2 本地验收

日期：2026-10-01，Windows x64 本地桌面。当前版本仅在本地交付，未发布新的 GitHub Release。

## 实现与交付

审查期间只显示“正在自动审查”。自动 allow 不发布人工审批事件，执行一次；deny 不执行并向主模型返回拒绝理由。技术失败显示“自动审查失败，需人工确认”，附脱敏 code/message。人工应答登记先于弹窗发布，首次应答有效，重复应答不会重复执行。

原生审批桥显式传入会话、轮次、query 与工具 TraceContext，原生适配器生成归属请求头。审查改用 streamText，继承当前模型、提供商和推理档位；输出最多 8192 Token 且受模型上限约束，最多三次尝试，共用 90 秒总时限。缺失 finish、流式错误、无效 JSON、模型或授权变化均有明确处理。已停用的能力恢复原生流程。

运行时拥有决策状态，桌面、会话投影与回放仅展示事实。Codex 风险策略、硬禁止、Plan 限制及自动授权的一次性语义保持。

交付目录：`artifacts/0.1.2/`。包含独立 Windows 桌面、插件 marketplace ZIP、完整宿主补丁、SHA256SUMS.txt 与验收日志。原版 `D:\ZCode` 和旧适配目录未覆盖。安装：关闭旧适配版后启动新目录下的 `ZCode.exe`；将新版 `local-marketplace` 目录作为插件来源，安装或更新插件到 0.1.2，新建本地会话选择 CodexAutoApproval。

构建基线：Codex `d42056091aded7feb1d88ac7e83972108b2aa478`，ZCode 源码 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（3.14.3），原版 Electron/原生资源 3.14.4。Linux Node 24.14.0、pnpm 10.33.2 构建；Windows Node 24.19.0 验收，插件自带原有 Node 运行时。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| 独立核心回归 | 52/52 通过 |
| 桥接与实际插件子进程 | 15/15 通过 |
| 宿主链路 | 24 项常规通过；实际 90 秒总时限另行通过，共 25 项 |
| Windows 命名管道链路 | 常规 24 项通过，90 秒用例由独立实际时限验收覆盖 |
| 源码 / JavaScript 语法 | 通过 |
| 根类型检查 | 通过 |
| CLI 完整类型检查 | 27 项任务通过 |
| 架构检查 | 0 新增、0 基线违规 |
| 根 lint | 0 错误，70 个既有警告 |
| CLI 完整 lint | 未通过：telemetry/debug/CLI 六处原有 max-lines 错误 |
| 改动源码 lint | 新增 TS 文件 0 错误；六处改动大文件的 max-lines 在固定提交中同样存在 |

完整日志和基线对比放在版本目录的 acceptance 中。实际 90 秒回归曾发现超时原因被进程包装覆盖，已修复并单独通过复验；不会将之前失败日志冒充通过结果。

## 隔离 Windows 交互

从新版插件 ZIP 解压 marketplace，经原生安装器安装。隔离应用数据、工作区和会话数据库，直接启动新版 exe，无 applicationName 覆盖。

自动 allow/deny 期间没有人工弹窗，有进度截图；allow 探针仅执行一次，deny 探针不存在并向主模型反馈。原生服务商认证错误显示具体失败类别和原因；首次人工允许执行一次，人工拒绝不执行。停用和卸载审查调用为零并恢复原生窗口。权限菜单、键盘切换、Plan 独立和插件名称也已通过。

覆盖流式服务商错误、缺失结束、无效评估、真正 90 秒超时、取消、重复应答、模型切换、真实用户授权变化、过期决定、插件停用、熔断、硬禁止与 Plan。技术失败不累计为策略拒绝。

## 当前 GLM 真实接口

使用原生 Windows 临时配置继承当前 GLM-5.3-Flash、提供商及最高推理，验证截图中的浏览器路径只读命令。在隔离会话通过原生 SessionStore 设置 Bash ask 测试规则，以确保该低风险动作实际触发审批；不修改全局风险规则。临时凭据文件在退出后删除。

真实审查已经触发并显示进度；服务商仍返回 `request has been blocked due to unusual activity.`，界面正确显示原因并回退人工。服务端拦截尚未解决，不能把本机替身或只读命令直接放行当作真实审查成功。原因的脱敏请求归属证据和截图见 acceptance/live-glm。

## 参考流程

借鉴 [OpenHands 审查后确认](https://github.com/OpenHands/software-agent-sdk/blob/fad63774459171b08f889b12fd3b4d6346168c3e/openhands-sdk/openhands/sdk/agent/agent.py#L1113) 与 [OpenCode 先注册后通知](https://github.com/anomalyco/opencode/blob/0112a92c416f5ad833d96e7a8308441f0a875d94/packages/core/src/permission.ts#L176) 的时序，继续使用 Codex 策略。
