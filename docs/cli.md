# 独立 CLI 用法

以下为独立 CLI 用法。CLI 需要 Node.js 22+，没有 npm 运行依赖；直接调用配置的模型 HTTP API，不启动 Codex、不调用 Codex CLI/app-server、不读取 Codex 登录信息。

## Windows 启动

```powershell
cd C:\Projects\CodexAutoApprovalZcode
.\zcode.cmd init
# 编辑 zcode.config.json 的 model.model、baseUrl、apiKeyEnv、wireApi
$env:OPENAI_API_KEY = '你的接口密钥'
.\zcode.cmd run "检查项目，修复问题并运行相关测试"
```

密钥仅从指定环境变量读取，不写入配置或审批日志。`init` 不覆盖现有配置。也可复制 `zcode.config.example.json` 为 `zcode.config.json`。在任意目录调用 `node C:\Projects\CodexAutoApprovalZcode\bin\zcode.js` 即可运行；`--cwd D:\目标项目` 指定工作区，`--config FILE` 指定独立配置。Linux/WSL 使用 `node bin/zcode.js`。

`ZCODE_MODEL` 和 `ZCODE_BASE_URL` 可覆盖主模型配置。主模型指 zcode 自己的当前模型；不会继承正在运行的 Codex 会话，也不需要它提供认证。提供商需要兼容 Chat Completions 或 Responses 的函数工具协议。配置 `wireApi: "chat"` 或 `"responses"`；需要推理强度时设置 `reasoningEffort`，保持提供商实际支持的值。

## 审批模型

默认 `approval.model: null` 完整复用主模型的模型 ID、接口、密钥环境变量、协议和推理设置，但审批使用隔离的会话、系统策略和工具权限。

只换模型可设 `"approval": { "model": { "model": "你的审查模型" } }`。使用另一个提供商时：

```json
{
  "approval": {
    "reviewer": "auto_review",
    "model": {
      "model": "独立审查模型ID",
      "baseUrl": "https://你的审查接口/v1",
      "apiKeyEnv": "ZCODE_REVIEW_KEY",
      "wireApi": "chat",
      "reasoningEffort": "high"
    }
  }
}
```

跨接口域名或端口必须显式填写 `apiKeyEnv`，防止把主模型密钥误发到审查提供商。不需要认证的本地接口可填空字符串。不会自动换模型、降推理强度或切换提供商。`approval.reviewer: "user"` 切换为人工审批。`extraPolicy` 增补策略，完整默认策略保留在 `prompts/policy.md`。

## 执行与恢复

文件读取和目录检查由受限的只读工具执行。每次 shell 命令和文件写入都先审查，主模型无法在工具参数里关闭审批。审批收到完整动作、工作区、原文件哈希、真实用户消息、先前拒绝和近期工具证据；超出预算会转人工，动作本身不会截断后放行。审批模型可以只读查看本地文件，不能执行 shell、写文件或调用网络工具，也不会收到主模型隐藏推理。

| 结果 | 行为 |
| --- | --- |
| allow | 仅执行本次具体动作；写文件前再校验目标和原文件哈希 |
| deny | 不执行；把理由及更安全替代路径指令作为工具结果交回主模型，继续任务 |
| 可恢复错误 | 在同一个截止时间内进行有限指数退避重试，尊重 Retry-After |
| 最终超时、认证/模型错误、无效输出、审查预算不足 | 记录技术失败，暂停该动作并转人工；不计入策略拒绝、不默认放行 |
| 用户取消 | 保存检查点；不转换为审批失败或自动执行 |
| 连续 3 次拒绝或最近 50 次审查有 10 次拒绝 | 保存现场并请用户给出安全方向；恢复后继续原会话 |
| 进程在副作用执行期间崩溃 | 标记执行结果不明，请人工选择 retry/skip，避免重复写入或重复外部操作 |

交互终端直接显示人工审批。非交互环境或 `--no-interactive` 下保留请求和现场，以退出码 `3` 暂停。`--json` 输出 JSONL 事件，便于外部监控。状态和事件保存在目标工作区 `.zcode/sessions/<SESSION>/`；启动时会输出会话 ID。

```powershell
.\zcode.cmd status SESSION
# 阅读 pending.id、reason 和完整 action 后，只批准该次动作
.\zcode.cmd approve SESSION REQUEST "已看过失败原因，批准这个具体动作"
# 或拒绝该次动作
.\zcode.cmd deny SESSION REQUEST "请采用更安全的办法"
.\zcode.cmd resume SESSION
```

`approve/deny` 只记录人的决定，不执行命令；`resume` 才继续。请求 ID 与动作指纹必须匹配，审批答复不能覆盖。问题或拒绝熔断使用 `respond SESSION REQUEST "具体指导"`；主模型服务出错后使用 `recover SESSION REQUEST retry`。中途崩溃的操作使用 `recover SESSION REQUEST skip` 或 `retry`；选择 retry 会重新审查，并仍校验动作证据。

显式授权被拒动作一次：先用 `status` 阅读 `denials`，找到最近 10 条中的某个 `id`，然后运行：

```powershell
.\zcode.cmd override SESSION DENIAL "已了解上述具体风险，批准这个动作重试一次"
.\zcode.cmd resume SESSION
```

此授权仅在主模型再次提出相同动作时消费一次，重试仍经过审批模型；不会覆盖策略的绝对拒绝规则，也不会授权类似动作。若会话在 `request_user_input` 等待，还需用 `respond` 回答该问题。已完成任务可用 `resume SESSION --message "后续要求"` 继续。

## 长任务

默认 `maxTurns: 0`、`maxRuntimeMs: 0`，不设任务总轮数或总时长上限。任务在工具失败或单次拒绝后继续，只有需要人的事件才暂停。上下文达到 `contextMaxChars` 时会压缩已完成的历史，并保留工具调用/结果的成对关系、原始用户授权及拒绝记录；摘要不能新增授权。单个 shell 默认 120 秒，可由工具参数 `timeout_ms` 或 `runtime.shellTimeoutMs` 调大，适用于长构建。

Ctrl+C 取消活动模型请求和 shell 进程树，并保存现场。配置或审查策略改变后恢复会使排队的旧审批失效并重新审查，允许人工修复失效的模型接口。运行中的策略使用启动时的快照。

这里移植的是审批与独立任务运行核心，没有移植 Codex 的操作系统沙箱、网络代理、MCP、GUI 或全部编码工具。文件工具检查工作区边界、符号链接和受保护元数据；审批后的 shell 以当前 OS 用户权限运行，模型审查不是 OS 隔离。文件哈希复核缩小了审批与执行之间的变化窗口，并不提供面对恶意并发进程的原子沙箱保证。使用隔离账号、容器或 OS 沙箱时，应在 zcode 进程外配置。

## 验证与来源

```powershell
npm test
npm run check
# 无需安装依赖，也可直接运行
node --test test/approval.test.js test/cli.test.js test/model.test.js test/runtime.test.js
node scripts/check.js
```

测试使用脚本模型与本机 HTTP 模型替身，覆盖真实 CLI 的拒绝继续、超时转人工后恢复、独立提供商和 Responses 协议。不会消耗真实模型额度。120 步模拟任务验证压缩与持续执行，未宣称实际运行数小时或验证了真实提供商行为。

参考官方 [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) 及同级 Codex 源码。具体移植对应关系与差异见 [迁移说明](migration.md)。保留 Apache-2.0 许可与 OpenAI 来源标注。
