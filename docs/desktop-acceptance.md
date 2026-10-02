# CodexAutoApproval 0.1.3 本地验收

日期：2026-10-02。范围为独立 Windows x64 桌面与配套插件，不涉及数据库迁移或公开发布。主代理负责设计、审阅与验收，`gpt-6.1-sol` 子代理编写实现、测试及构建脚本；实现前先更新宿主 spec。既有本地改动和 0.1.2 回退产物保留。

真实 Windows 宿主调用官方 `deepseek-flash`、High 推理，已通过低风险放行、受控拒绝及文件调查后续接，自动审批恢复可用。DeepSeek 成功不能证明 GLM 原审查通道解除拦截；GLM 两条路径单列记录。

## 配置与行为

在“设置 → 插件 → CodexAutoApproval → 高级 → 审查模型”选择“跟随会话”，或指定供应商、模型与其支持的推理档位，然后保存。旧配置默认跟随会话。原生插件配置服务保存用户默认与工作区覆盖；“恢复继承值”删除工作区覆盖。保存后下一次审查生效，在途配置变化使旧结果失效。审查模型切换不改变主会话模型。

模型菜单中的“管理模型”进入原生供应商配置，填写自定义 Base URL、Chat Completions / Responses / Anthropic 协议及 API Key。凭据由宿主管理，插件仅保存受校验的模型引用和推理选项。指定后只调用该模型，技术失败转人工，不换供应商。供应商或模型删除、缺少凭据、推理或工具能力不兼容时给出明确原因。桌面和插件成对使用桥协议 v2；不匹配转人工。

快照绑定完整动作、真实用户授权、会话及分支、主模型、实际审查模型与配置版本。执行前重新校验，allow 只执行一次，deny 不执行。技术失败不累计策略拒绝，明确不可重试的服务端拦截立即转人工。保留单次原生调用、最多三次审查尝试及共用 90 秒总截止时间，保留 Codex 策略、只读调查、Plan、硬禁止与一次性授权语义。

Runtime 按绑定和尝试保留完整模型思考及供应商元数据，校验可见消息前缀和只读工具续接后缀；只供同一次审查的原生模型续接，重试、取消、失效和完成时清理。它们不进入插件响应、主模型、界面或原生模型 I/O 留存。此处理遵循 [DeepSeek 思考模式工具调用说明](https://api-docs.deepseek.com/guides/thinking_mode/)。进度、完成记录、提示及回放显示实际审查模型。失败附统一脱敏、长度受限的可选业务码、HTTP 状态、请求编号及重试信息。

## 最终检查

| 检查 | 结果 |
| --- | --- |
| 独立审批核心 | Linux、Windows 各 52/52 通过 |
| Windows 桥接与实际插件子进程 | 17/17 通过 |
| Windows 协议及隐私 | 5/5 通过 |
| Windows 宿主链路 | 常规 38 项通过，真实 90 秒用例另行通过，共 39 项 |
| Windows 原生回归合计 | 61 个不同用例全部通过；常规的 1 个 deadline skip 由真实时限运行补齐 |
| 真实 90 秒截止时间 | 通过，用例约 91.93 秒，包含清理时间 |
| 真实 DeepSeek | allow、deny、只读文件调查及续接全部通过 |
| Windows 桌面界面 | 8/8 场景通过，完成记录与回放显示实际审查模型 |
| Windows 审查配置界面 | 默认继承、指定模型、推理、用户默认、工作区覆盖、恢复继承、重启持久化、主模型隔离、原生供应商管理全部通过 |
| 原生供应商解析 | 实际 ProviderRegistryService / ProviderConfigResolver / ProviderRegistry 覆盖缺密钥、供应商或模型删除、不兼容推理及有效指定选择，通过 |
| 插件配置与最终授权边界 | 配置 3 项、最终授权 6 项通过 |
| 最终 JavaScript / Python 脚本语法 | 通过，见 final-syntax-checks 收据 |
| 根类型检查 | 通过 |
| CLI 完整类型检查 | 等价 Node 调用 27/27 任务通过 |
| 根 lint | 0 错误，70 个既有警告 |
| CLI 完整 lint | 已有诊断，未通过，见下文 |
| 架构检查 | 0 新增、0 基线、0 违规 |
| 原生包、Agent、桌面 main / host / preload / renderer 构建 | 通过 |

审批回归覆盖认证失败、不可重试服务端拦截、断流、缺失结束、无效输出、真实超时、取消，审查中模型、配置或用户授权变化，过期结果、重复人工应答及插件停用。人工兜底先登记应答再发布弹窗，首次应答有效，重复应答不重复执行；兜底不接受修改参数或永久许可。技术失败与策略拒绝分开计数，Plan、硬禁止、只读工具和熔断均有回归。

Windows 界面从实际插件 ZIP 解压 marketplace，经原生安装器安装，直接启动交付 exe，不覆盖 applicationName。隔离配置、工作区及会话数据库。本地 HTTP 模型仅用于界面与故障回归：allow 无人工窗口且探针一次，deny 探针零次；401 转人工，分别通过人工拒绝和首次允许一次；停用、卸载审查调用为零并恢复原生流程。权限菜单、快捷键、Plan 和插件显示名通过。

CLI 原始 pnpm 命令遇到 turbo 可执行权限错误，原日志保留，改用等价 Node 入口。完整 CLI lint 报出 telemetry / debug / CLI 的 6 个既有错误与 2 个警告后停止，此计数不是全工作区全部诊断。单独检查 71 个改动文件，12 个 max-lines 错误；固定 HEAD 的 54 文件与保存的 0.1.2 本地补丁重建的 64 文件均有相同的 12 个错误身份，本次新增错误为零。7 个本次新增文件和 17 个未跟踪文件各为 0 错误、0 警告。详见 [lint-comparison.json](evidence/0.1.3/lint-comparison.json) 和 [checks-summary.json](evidence/0.1.3/checks-summary.json)。

## 真实 DeepSeek

Windows 隔离宿主使用 DEEPSEEK_API_KEY，经原生 SDK → Runtime → 桥 → 实际插件 → 执行器调用官方 deepseek-flash、High。低风险 allow 执行器仅递增无副作用计数器且恰好一次；受控 deny 的执行器同为无副作用探针且调用零次。强制触发只读文件工具后续接，验证真实临时文件、完整思考上下文恢复、不同审查互不混用与主模型选择不变。

密钥仅在测试宿主配置及内存中使用，不注入插件环境，临时配置退出后删除。续接完整性在宿主内存比较，证据只存布尔结果，不保存思考内容、密钥或其摘要。真实模型不是本地替身，人工点击不计成功。[live-deepseek.json](evidence/0.1.3/live-deepseek.json) 中验收条件全部为 true，transportOrProviderFailure 为 false。

## GLM 两条路径

分别执行 GLM 主会话配 DeepSeek 独立审查，以及同账号 GLM 普通会话 / GLM 审查两条隔离路径。两条路径最终均在 `native_glm_unavailable` 阶段停止：ordinaryRequestAttempted 和 reviewActionAttempted 均为 false，临时配置清理为 true。因此 **GLM 联动及原审查通道本轮未完成真实模型验收**，没有拿替身、错误的主模型或人工点击代替成功。

原生目录中 GLM-5.3-Flash 的实际模型引用存在，并匹配原账号与套餐选择。原生 providerSettingsService 返回 provider / model 存在且 enabled、current 为 true，配置 issue 为零；availability 为 unknown、entitled 为 false，模型 executable / selectable 均为 false。宿主没有找到该账号对应的原生 API Key 缓存；原生校验在缺 key 且无既有可用快照时返回 unknown 并不发布模型。这不能证明账号没有套餐、OAuth 已失效或服务端正在拦截。

只读诊断复用宿主网络代理与 TLS 设置，使用原账号 OAuth GET customerInfo，两条路径均收到 HTTP 200，但没有得到宿主可用的业务数据或组织 / 项目位置；因此未进入已有密钥列表或复制步骤，未创建新账号密钥，也未绕过原生可用性校验。原生选择器回落到可用模型后，测试在发消息前停止，避免把它误记为 GLM 主会话成功。收据见 [GLM 主会话 / DeepSeek 审查尝试](evidence/0.1.3/glm-main-deepseek-review.json)、[同账号 GLM 尝试](evidence/0.1.3/same-account-glm.json) 与 [GLM 状态](evidence/0.1.3/glm-status.json)。

0.1.2 曾真实记录 GLM unusual activity 服务端拦截；0.1.3 本轮未抵达 GLM 模型端，无法确认该拦截是否解除。请求身份保持原生归属，未更改 querySource / sessionType；本轮没有实际 GLM 模型请求头捕获。DeepSeek 审批成功只证明自动审批恢复可用。

## 测试隔离与失败历史

此前失败日志保留，最终通过结果有独立收据，不把失败改写为通过。准备阶段修正过菜单导航、原生标签可见性、折叠历史记录与提示定位；标签修复已进入最终构建并通过界面复验。

早期配置界面测试发现 CLI 用户配置依赖 os.homedir()，只设置桌面数据目录未能完全隔离，曾写入真实用户插件配置中的精确测试 reviewModel 选项。已核对并仅删除该测试选项，其他属性保留，重新读取确认不存在，见 [test-isolation-cleanup.json](evidence/0.1.3/test-isolation-cleanup.json)。最终测试对子进程设置一次性 USERPROFILE、删除继承 HOME，fixture 显式指定临时 userConfigPath；首次继承、用户路径位于临时目录、工作区恢复及重启继承重新通过。未修改系统环境变量。

GLM 测试通过宿主原生 cipher 在内存解密，再按临时用户目录重新加密；原公共模型目录由宿主 source 自行解析。测试不改变账号或请求归属标签。真实测试不留存原始模型文本、页面正文、凭据或模型 I/O，退出清理临时目录。

## 构建、补丁与交付

Codex 策略固定 d42056091aded7feb1d88ac7e83972108b2aa478，策略正文比较一致。ZCode 源码固定 29628c9acdb81b703bbd4080c207a0e7ce5e276e（3.14.3），使用原版 3.14.4 的 Electron 与原生资源，替换重建的桌面 JavaScript 和 Agent，属于混合版本适配发行。Linux Node 24.14.0、pnpm 10.33.2 构建；实际 Windows 验收 Node 22.19.0、Windows 10.0.26200。上游更新检查因本机代理不可达未完成，仍用固定提交。

完整宿主补丁包含 spec、实现、原生测试和既有本地适配，共 72 文件。在固定提交干净树 git apply --check 通过，应用后所有补丁文件与工作区逐字节一致。补丁 SHA256：2384515fd52ecfb64fa09637d06a9f3aa684e4edce3c872900c3b80dc11d503a。最终验收 app.asar：37bfaf4643d6fc8292afd8d6011155144fa1b7a1a61c848c0849f3e0d999b539；Agent：ba47955a192dd0f7692379bedb1bc48ef903692d5c5bf4ec52a576e63d98cf8b。收据见 [tested-artifacts.json](evidence/0.1.3/tested-artifacts.json) 与 [patch-validation.json](evidence/0.1.3/patch-validation.json)。

交付目录 artifacts/0.1.3/ 包含 CodexAutoApproval-Windows-0.1.3.zip、CodexAutoApproval-plugin-0.1.3.zip、zcode-29628c9-auto-review.patch、SHA256SUMS.txt、ACCEPTANCE.md 与 CHECKS.json。解压桌面后直接运行 ZCode.exe，再按 README 添加插件 ZIP 解压出的 marketplace。原版安装未覆盖；0.1.2 的桌面、插件、补丁、验收与校验文件五项 SHA256 保持不变，见 [rollback-preservation.json](evidence/0.1.3/rollback-preservation.json)。

本次权威收据位于 docs/evidence/0.1.3/；artifacts/0.1.3/acceptance/ 保留详细本地构建、回归和失败历史。旧报告和历史截图不作为 0.1.3 新证据。SSH、WSL 与远程工作区未验收。
