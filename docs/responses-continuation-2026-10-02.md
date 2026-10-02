# Responses 自动审查工具续接修复

源码验收阶段交付源码、可重复测试与真实通道验收记录，未重新打包或替换桌面。根代理负责规格、框架与审阅，GPT-6.1-Sol 子代理负责实现和测试代码。既有本地改动保留。官家随后授权独立桌面构建，交付与使用方法见[本次构建报告](desktop-build-responses-2026-10-02.md)。

## 问题与设计

现场自动审查首轮返回了工具调用，回传工具结果后的请求收到 HTTP 400：`No tool call found for tool output with call_id`。实际使用的是自定义供应商的 `deepseek-v4-flash`、Responses 协议。它与 GLM 的 unusual-activity 服务端拦截是两个独立问题。

原生 SDK 默认启用服务端存储；带条目 ID 的工具调用可能被转换为 `item_reference`。兼容接口若无法解析该历史引用，工具结果便失去对应调用。此前 Responses 测试只验证首轮文字返回，真实 DeepSeek 验收使用 Chat Completions，均不能证明本次 Responses 续接可用。

修复在宿主原生请求选项边界收敛：仅自动审查的 Responses 请求从首轮起使用 `store=false`，移除本次请求的服务端会话选择器，并请求加密推理元数据。保留既有供应商选项，消息转换与 SDK 调用使用相同最终选项。原生 ApprovalContinuation 继续按审查绑定保存、恢复和清理完整上下文，不通过重编调用 ID 或删除推理来掩盖错误。

主会话、其他协议、持久配置和现有审批策略维持既有行为。错误或取消不能导致自动放行。详细所有者与事件顺序见宿主 `docs/specs/codex-auto-approval.md` 的 “Stateless Responses review continuation” 章节。

## 验收方法

先用严格 HTTP fixture 重现旧行为失败，再验证完整函数调用与结果配对、加密推理续接、多轮和多调用、跨审查隔离及错误结果拒绝。测试必须经过实际 SDK、宿主、审批桥及插件子进程；只验证首轮请求不算通过。

真实验收锁定当前已配置的 `deepseek-v4-flash` Responses 供应商和 `max` 推理档位，使用两个独立临时只读样例及无副作用执行计数器。不会执行用户截图中的删除命令，不改用户配置，不换模型或协议。仅保留计数、布尔断言和脱敏错误，临时私有状态在退出时清理。

## 本次结果

源码修复、本地检查及当前真实 Responses 通道验收均已完成。所有结果来自本轮执行，历史验收不作为本次证据。

| 本轮检查 | 结果 |
| --- | --- |
| 基础审批、CLI、模型、运行时 | 52 通过，0 失败 |
| 新增选项、配对、严格 Responses 续接 | 16 通过，0 失败 |
| 桌面审批桥、宿主执行链、三种协议 | 69 通过，0 失败；既有 90 秒长超时样例未启用 |
| 宿主根类型检查、CLI 全部 15 个包的类型检查 | 全部通过；最终首轮校验改动后另复查 core |
| 根 / CLI lint | 0 错误，分别有 70 / 54 个既有告警；本次三个生产文件为 0 告警 |
| 架构检查 / JavaScript 语法检查 | 通过；架构违规、基线违规、新增违规均为 0 |
| 当前 `deepseek-v4-flash` Responses、`max` | 两个真实只读样例均完成工具续接并得到 `allow`；4 次请求，无人工介入 |

严格流式测试经过真实 SDK、宿主续接、审批桥、实际插件子进程和 ToolExecutor。修复后两个独立审查共发出 6 个本地 HTTP 请求，每次审查调查两轮、每轮两个调用；允许样例执行一次，拒绝样例不执行，不触发人工应答。全部请求都检查无状态选项、完整调用与结果配对、加密推理保留和审查隔离。

本地合计 137 项通过、0 失败、1 项既有长超时样例未启用；新增测试和模块重建记录见 [local-tests.json](evidence/responses-continuation-2026-10-02/local-tests.json)。

旧构建的首次失败记录使用 generate 夹具，显式补入了与流式缓存形状相同的元数据；其限制已写入收据。另保留可重复的原生流式对照：仅在测试注入的 SDK runtime 中恢复旧 `store=true` 行为，即出现第二轮历史引用、HTTP 400、一次人工回退和零执行。该对照没有回滚共享源码，也不声称运行了旧桌面二进制。详见 [baseline.json](evidence/responses-continuation-2026-10-02/baseline.json)。

## 源码与复验入口

- `host-adapter/upstream/apps/zcode-cli/packages/adapters/src/model/approval-responses-options.ts`：审查专用无状态选项合并。
- 同目录 `runner-options.ts`：generate/stream 共同调用，消息转换与 SDK 使用同一最终选项。
- `host-adapter/upstream/apps/zcode-cli/packages/core/src/runtime/helpers/approval-continuation.ts`：拒绝非法首轮、重复或空调用 ID、非只读调用及不匹配结果。
- `test/responses-options.test.js`、`test/responses-continuation.test.js`：选项边界、配置不变性、错误配对和完整链路测试。
- `scripts/responses-live-review.mjs`：从显式 profile 的插件 `reviewModel` 解析供应商和模型，或接收显式覆盖；本次验收保持 `max`，只保存脱敏收据。运行时内置配置按目录发现，不包含个人供应商标识或固定端点缓存路径。

已安装现有宿主依赖时，先在 `host-adapter/upstream` 重建受影响的两个模块，再从本项目根目录测试：

```sh
node node_modules/typescript/bin/tsc -p apps/zcode-cli/packages/adapters/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/zcode-cli/packages/core/tsconfig.json
```

```sh
npm run test:responses
npm test
npm run test:desktop
node --import ./host-adapter/upstream/node_modules/tsx/dist/loader.mjs --test test/approval-protocols.test.js
```

真实通道入口如下；该命令会实际调用已配置模型，目录参数指向已有 `.zcode` 目录：

```sh
npm run test:responses-live -- --execute-reviewed <existing-zcode-directory> <receipt.json>
```

预检将首个参数改为 `--preflight-only`，不发送模型请求。可在收据参数之后显式传入 `--provider-id <provider-id> --model-id <model-id> --reasoning-level max`；不同插件安装标识可加 `--plugin-id <plugin-id>`。覆盖只作用于验收内存绑定，不写用户配置。目标 provider 必须使用 Responses；当前审查若已切换到 Chat Completions，须显式选择仍配置为 Responses 的 provider 才能验证该协议。脚本递归发现 profile 下 `v2/runtime/provider` 的内置 JSON；没有缓存时使用源码内置配置，多个发现结果的目标模型配置不一致则失败。

下述历史收据证明当时的 Responses 源码链路，不能据此宣称发布后任意 profile、端点或最终桌面包已经通过，也不代表后来切换到 Chat Completions 的当前审查协议。

本次使用已有 Linux Node 22.21.1 运行器和挂载的 Windows 工作区。宿主要求的 Node 24.14.0 未在本轮使用；根和 CLI 的检查直接调用已有编译器、linter，与包脚本的检查内容一致。没有安装或升级依赖。详细命令、运行限制及沙箱启动失败见 [checks.json](evidence/responses-continuation-2026-10-02/checks.json)。

## 真实通道状态与交付边界

第一次验收在本地 `native-resolve` 准备阶段失败，未向供应商发请求。原因是验收脚本混用 Provider 类的源码版与编译版，触发私有字段实例校验。统一脚本导入来源后，预检通过：三份内置配置解析结果一致，指定供应商、模型和 `max` 档位正确，配置前后校验一致，见 [preflight.json](evidence/responses-continuation-2026-10-02/preflight.json)。

随后由根代理执行真实验收，进程退出码 0，[live.json](evidence/responses-continuation-2026-10-02/live.json) 记录 `completed=true`：

| 真实样例 | 模型请求 | 返回的调查工具调用 | 结果续接请求 | 结论 | 无副作用执行计数 |
| --- | --- | --- | --- | --- | --- |
| 独立样例一 | 2 | 2 | 1 | allow | 1 |
| 独立样例二 | 2 | 1 | 1 | allow | 1 |

两例均验证实际请求 `store=false`、包含 `reasoning.encrypted_content`、无服务器会话选择器及历史引用、完整调用与结果 ID 唯一配对。供应商实际返回了加密推理，后续请求确实携带了该元数据。宿主原生解析器与模型工厂解析凭据和选项，网络沿用原生模型网络函数及当前宿主设置；插件子进程只得到可见审查内容。收据未写入凭据、端点、私有推理或原始请求正文。

两个真实样例均无人工应答，没有切换供应商、模型或协议。执行器只增加内存计数；临时工作区已清理，用户配置文件前后校验一致。真实拒绝结果未单独触发；拒绝后零执行由严格本地完整执行链测试验证。本轮证据确认重建源码上的当前通道工具续接可用，不代表所有供应商或所有任务都已验证。

源码验收阶段未重新打包、发布、替换桌面或修改用户模型配置；未执行截图中的删除命令。该阶段未验证 Windows 桌面界面和已安装应用；后续独立构建的启动检查另记于[构建报告](desktop-build-responses-2026-10-02.md)。GLM 的服务端 unusual-activity 拦截仍不属于本次修复范围。

## 后续桌面构建授权

官家随后授权构建可直接使用的修复版。构建从已验收源码生成宿主 Agent 与桌面 JavaScript，复用既有 Windows Electron 及原生资源，输出到独立的 `artifacts/0.1.3-responses-fix-20261002/`。原 `0.1.3`、`0.1.2` 产物和已安装应用均保留，用户配置不迁移或改写。

插件版本维持 `0.1.3`，审批桥维持 v2；修复版使用原有应用身份及配置解析路径。打包脚本只增加独立输出目录支持，生产审批行为沿用本报告已验收源码。生成当前源码补丁、构建指纹和本轮检查记录，验证包内 Agent 含有无状态续接逻辑及桌面档案完整性，再提供直接运行入口。构建中的限制及最终结果将在单独的桌面构建报告中记录，不把源码验收等同于新桌面的界面验收。
