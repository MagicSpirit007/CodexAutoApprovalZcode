# 审批核心迁移与桌面功能对照

核对基线为 Codex `d42056091aded7feb1d88ac7e83972108b2aa478`、官方 ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。下表只比较这两个固定提交。交付的是审批核心移植和桌面宿主适配，不能称为完整复现 Codex。

桌面外壳取自本机已安装的 ZCode 3.14.4；适配 Agent 和桌面 JavaScript 由官方固定提交的 3.14.3 源码构建，保留原安装的 Electron 与原生资源。独立目录中的 `AUTO-REVIEW-BUILD.json` 记录原 Agent、适配 Agent、桌面 app.asar 的 SHA-256。这是混合版本的本地适配发行，原安装未被覆盖。

源码路径中，`host/` 表示 `host-adapter/upstream/apps/zcode-cli/packages/`，`codex/` 表示同级固定提交的 Codex 源码。测试记录见 [桌面验收说明](desktop-acceptance.md)。

| 功能 | 标注 | 实现与差异 | 源码和验证证据 |
| --- | --- | --- | --- |
| 默认风险策略 | 与 Codex 一致 | 策略正文保留；只增加来源注释、统一换行 | `codex/codex-rs/prompts/templates/guardian/policy.md` → `prompts/policy.md`；`policy-comparison.json` |
| 授权评分、证据信任、放行阈值 | 宿主适配 | 保留规则；用户授权来源与执行环境改为 ZCode 原生会话记录 | `prompts/review-template.md`、`src/reviewer.js`；CLI 和宿主授权测试 |
| 评估解析与 deny 纠正指引 | 与 Codex 一致 | allow/deny、风险、授权、理由；拒绝返回理由与禁止绕过指引 | `codex/codex-rs/ext/guardian-reviewer/src/assessment.rs`、`codex/codex-rs/prompts/src/model_messages/guardian.rs` → `src/reviewer.js`；解析及原生拒绝测试 |
| 独立审查模型与推理设置 | 宿主适配 | 旧配置继承会话；可经原生插件配置单独指定模型引用与推理档位，workspace 覆盖 user；由原生适配器调用，不改主模型、不换供应商，凭据不进入插件；真实会话/query/TraceContext 与 auto_review 归属保留 | `host/core/src/runtime/helpers/approval-bridge.ts`、`runtime/methods/turn-model.ts`；请求归属、切换模型、选项继承测试 |
| 桌面审批入口 | 宿主适配 | 只处理正常权限流程实际要求审批的 PermissionRequest；明确禁止、Plan 限制、工具校验仍先行 | `host/core/src/hooks/configured-runner-callback.ts`、`tool/executor/permission-flow.ts`；Plan、禁止规则、执行次数测试 |
| 独立权限选项与显示名称 | 宿主适配 | CodexAutoApproval 单选项通过原生插件服务写入 workspace 启停设置；保留原生权限和 Plan；无需新增 auto 枚举 | `host-adapter/upstream/packages/ui/src/hooks/useCodexAutoApprovalMode.ts`、`v4/composer/V4ComposerModeControls.tsx`、`marketplace.json`；八项桌面 E2E、菜单与插件列表截图 |
| allow 作用范围 | 与 Codex 一致 | 仅放行当前动作；丢弃权限规则更新和修改参数，不缓存许可 | `host/adapters/src/exec/approval-bridge.ts`；一次性消费与执行一次测试 |
| deny 与主模型反馈 | 与 Codex 一致 | 动作不执行；工具结果含具体理由及纠正指引，可继续其他已授权工作 | `host/core/src/tool/executor/hook-flow.ts`；原生拒绝链路测试 |
| 审查进度及审批顺序 | 宿主适配 | 仅已加载且启用的插件能力审查优先；运行时保存开始/完成事件，桌面与回放展示进度，allow/deny 不发布人工请求 | `host/core/src/tool/executor/permission-review-flow.ts`、`bootstrap/src/zcode-protocol-v4/product-projection-permission-review.ts`；实际 Hook 链路及回放测试 |
| 技术失败与人工回退 | 宿主适配 | 认证、网络、流式错误、缺失结束、无效输出、预算和桥故障归为 ask；先登记应答，再发布带脱敏 code/message 及可选业务码、HTTP 状态、请求编号与重试信息的人工请求。Codex 部分故障采用 fail-closed | `src/desktop-hook.js`、`host/bootstrap/src/zcode-protocol/interaction-response-race.ts`；技术故障、首次点击、重复应答、无桥回退测试 |
| 取消与过期答复 | 宿主适配 | 取消停止模型及 Hook；会话、轮次、调用、完整参数、主会话模型、实际审查模型、配置版本与授权快照绑定，旧结果失效后重审 | `host/adapters/src/exec/approval-bridge.ts`；取消、并行会话、过期授权和模型变化测试 |
| 总时限与重试 | 宿主适配 | 默认总时限 90 秒，最多三次审查尝试；只读调查可继续同一审查，受调查步数和总时限限制。原生模型内层使用 SingleAttempt，避免叠加重试 | `src/reviewer.js`、`src/desktop-client.js`、`host/adapters/src/model/retry-budget.ts`；预算与超时测试 |
| 标准拒绝熔断 | 与 Codex 一致 | 每个宿主轮次连续三拒，或最近五十次审查累计十拒，停止当前轮并保留会话；新轮重置计数，拒绝动作记录保留 | `host/core/src/runtime/helpers/approval-bridge.ts`、`tool/executor/permission-flow.ts`；三连拒、窗口计数、下一轮恢复测试 |
| Cyber 单拒熔断与 Codex 专用流程 | 未支持 | 首版只实现标准熔断；未移植 Cyber 专用模式、Codex 专用授权 UI 和 reviewer 服务 | 固定范围；不宣称等价 |
| 私有多轮续接上下文 | 宿主适配 | 宿主按 binding / attempt 保存思考内容及供应商元数据，只用于同一审查的原生后续调用；visible prefix 校验防混用，重试／取消／失效／完成清理，不进入插件、主模型、界面或完整模型轨迹 | `host/core/src/runtime/helpers/approval-continuation.ts`；原生多轮隔离与真实 DeepSeek 文件调查 |
| 审批模型调查工具 | 宿主适配 | 只开放工作区文件读取、目录调查；无 shell、写入和网络工具。工具集合小于 Codex | `src/tools.js`、`host/core/src/runtime/helpers/approval-bridge.ts`；边界读取与拒绝写工具测试 |
| 独立安装、停用、卸载 | 宿主适配 | 标准 manifest、hooks、相对路径 marketplace；随包 Node、代码、策略，安装后无需源码目录；停用、卸载恢复原生审批 | `plugins/codex-auto-approval/`；原生 marketplace 干净安装及发现测试 |
| 真实外部提供商 | 分路径验收 | 官方 DeepSeek Flash / High、GLM 主会话配合 DeepSeek 审查及 GLM 自身审查分别记录；本机替身、人工点击与其他供应商成功不证明 GLM 解除拦截 | [0.1.3 验收报告](desktop-acceptance.md)；0.1.2 历史证据保留 |
| SSH、WSL、远程工作区 | 未实测 | 首版交付范围为本地 Windows 桌面；不自动同步插件到远端 | 固定范围 |
| Codex OS 沙箱、网络代理、全部工具 | 未支持 | 使用 ZCode 宿主权限与工具边界；模型审批不提供 OS 隔离 | 固定范围 |

桌面「自动编辑」是原生 edit 权限模式，不是本插件；「计划模式」「变更前确认」「完全访问」同样属于原生功能。本插件通过 PermissionRequest 接入；适配桌面新增独立的 CodexAutoApproval 权限菜单选项，插件列表也同名。选择它在本工作区启用插件并使用正常 build 审批入口；选择原生权限会停用本工作区插件。有任务运行时锁住切换，已有会话从停用变为启用需要新会话。源码中的 auto 枚举尚未实现，与界面的「自动编辑」不同。公开规范：[ZCode Hooks](https://zcode.z.ai/en/docs/hooks)、[ZCode 插件](https://zcode.z.ai/en/docs/plugin)。

## 独立 CLI 的补充说明

核对时使用同级 `codex` 工作树，固定 HEAD 为 `d42056091aded7feb1d88ac7e83972108b2aa478`。zcode 不链接、不运行、不动态读取该仓库；策略文件和所需语义已移入本项目。

| Codex 来源 | zcode 对应 | 行为 |
| --- | --- | --- |
| `codex-rs/prompts/templates/guardian/policy.md` | `prompts/policy.md` | 保留默认风险、外发、凭证、安全弱化和破坏性操作规则 |
| `prompts/templates/guardian/policy_template.md` | `prompts/review-template.md` | 保留授权打分、证据信任和结果阈值；执行环境与授权来源改为独立宿主真实记录，文件不能自行扩大授权 |
| `ext/guardian-reviewer/src/assessment.rs` | `src/reviewer.js` | allow/deny、风险、授权、理由；裸 allow/deny 默认值及 JSON 包装恢复 |
| `ext/guardian-reviewer/src/model.rs` | `src/config.js` | 按要求默认继承当前模型；可独立配置整个模型提供商，且无隐式换路由 |
| `ext/guardian-reviewer/src/retry.rs` | `src/model.js` | 只重试可恢复故障，共享截止时间、退避、Retry-After 与取消 |
| `ext/guardian-reviewer/src/completion.rs` | `src/reviewer.js` | 区分策略拒绝和技术失败；技术故障按本任务要求转人工 |
| `prompts/src/model_messages/guardian.rs` | `src/reviewer.js` 的 rejectionInstructions | 返回拒绝原因，禁止绕过，允许有实质风险下降的替代动作 |
| `core/src/tools/approvals.rs` 的 into_tool_result | `src/agent.js` 的 drainQueue/output | 拒绝变为主模型可见的工具结果；取消独立处理 |
| 拒绝熔断与显式批准重试 | `src/agent.js`、`src/store.js` | 3 连拒/50 内 10 拒时保存并等待人工；精确授权只消费一次，仍经过模型审查 |
| reviewer 独立会话、只读调查 | `src/reviewer.js`、`src/tools.js` | 每次审查隔离会话；宿主只暴露 read_file/list_files，无写入和网络工具 |

重要差异：当前来源中的部分技术失败是 failed-closed 拒绝或超时结果，输入预算不足在可选审查时可回人工。zcode 按本项目设计，将最终技术失败统一挂起并交给人工，不标成危险动作；显式 deny 仍直接反馈给主模型。Codex 的熔断会中断当前 turn，zcode 保留现场、请求指导后继续同一会话。两者都不会把被拒动作自动执行。

独立运行需要自有模型接口和认证，zcode 没有继承 Codex 的账户权限或专用 auto-review 模型。CLI、API 适配、持久化恢复和运行循环由 zcode 实现，非 Codex 全量 fork。`src/index.js` 暴露 Agent、Reviewer、ModelClient、Tools、Store 和配置接口，供其他宿主复用审批核心。

官方材料：[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)、[Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)。原始文本采用 Apache-2.0，见根目录 LICENSE 与 NOTICE。
