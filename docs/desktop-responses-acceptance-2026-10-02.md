# Windows 修复成品与 Chat Completions 审查验收

2026-10-02 最终修复包已部署到本机原开始菜单指向的 `artifacts/0.1.3/CodexAutoApproval-Windows/`，原入口启动后的进程路径、包内指纹和已安装插件代码均已核对。旧实例退出后完成目录替换，验收通过后删除被替换的旧程序及本次临时备份；用户配置、凭据、会话和工作文件保留。

## 实际行为与范围

自动审查按使用者选择改用专用 Chat Completions 供应商，沿用同一通道的 `deepseek-v4-flash` 和 `max`。原供应商和主会话选择保持原状。配置克隆工具只创建专用供应商并更新审查引用，不向仓库保存个人供应商、地址或凭据。

原始 Responses 工具配对问题的源码修复仍在宿主补丁和包内 Agent 中。严格 Responses 续接回归经过 SDK、运行时审批桥、真实插件子进程及执行器，覆盖多轮、多调用、完整 call/result 配对、审查隔离和错误不执行，见[源码报告](responses-continuation-2026-10-02.md)。最终 Windows 包的真实模型验收采用 Chat Completions；没有完成整套 Windows Responses GUI 场景和复杂业务验收。

## 最小真实成品验收

验收脚本显式接收程序目录、证据目录、marketplace、fixture bundle、当前 profile 和调试端口，使用隔离 profile、真实包内 Agent、实际插件子进程及桌面审批流程。使用合成文件和只追加 marker 的 PowerShell 脚本，授权要求先调查未知脚本再决定。验收过程不改真实用户配置。

最终使用系统 Node 和与已安装插件一致的 `node` Hook 进行复验，收据见 [desktop-chat-result.json](evidence/deployed-responses-2026-10-02/desktop-chat-result.json)：

| 检查 | 结果 |
| --- | --- |
| 实际模型 / 协议 / 推理档位 | deepseek-v4-flash / Chat Completions / max |
| 审查请求 / 调查调用 / 工具结果续接 | 2 / 2 / 1 |
| reasoning_content 恢复 | 已检查 |
| 获准动作执行次数 | 1 |
| 协议错误 / HTTP 错误 / 页面错误 | 0 / 0 / 0 |
| 用户配置未变 / 隔离 profile 已删除 | 是 / 是 |

runner 退出 0；收据 `appExitCode=1` 是 finally 使用 taskkill 清理本次测试进程树的结果，不是审批失败。实际日常入口另核对启动路径与插件一致性；复杂验收由使用者进行，不把入口启动核对写成原快捷方式完整业务审查通过。

成品指纹：

```text
Agent  6e24be474b337b51267e4813dda304411f9696b4efef921e84cafc12923b282e
ASAR   acf9813dcd88bf5b022692ae3103bda4f0071293b70ef4044f32a34805f22ec1
```

## 可重复入口

先在准备好宿主依赖的环境生成 fixture bundle：

```sh
node scripts/bundle-desktop-fixture.mjs artifacts/acceptance/desktop-fixture.bundle.mjs
node --test test/clone-chat-review-config.test.js test/responses-acceptance-protocol.test.js
```

Windows PowerShell 中显式传入自己的目录，不永久修改 PATH：

```powershell
$env:PATH = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
node scripts/desktop-responses-e2e.mjs --desktop artifacts/0.1.3/CodexAutoApproval-Windows --output artifacts/acceptance/chat-review --marketplace artifacts/0.1.3/local-marketplace --fixture-bundle artifacts/acceptance/desktop-fixture.bundle.mjs --mode live --current-profile "$env:USERPROFILE/.zcode" --debug-port 9342
```

脚本历史名称包含 `responses`，`--mode live` 使用隔离克隆的 Chat Completions 审查配置；`--mode fixture` 提供本地严格 Responses 场景。仅有首页加载或首轮文字返回不算链路通过。真实请求、响应、凭据、端点、页面正文与隐藏推理不持久化；收据只保存结构计数、布尔断言和成品指纹。
