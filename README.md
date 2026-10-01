# CodexAutoApproval for ZCode

让 ZCode 桌面在执行需要审批的动作前，用**当前会话模型**做一次独立风险审查。风险策略来自固定版本的 OpenAI Codex；通过 ZCode 的原生审批流程放行、拒绝或转人工。

权限菜单中的独立选项和插件列表均叫 **CodexAutoApproval**。「自动编辑」仍是 ZCode 原生功能。

**当前发行：0.1.1 · Windows x64 本地桌面会话 · 第三方适配项目。** 完整功能需要本项目配套的适配桌面；只在官方桌面安装插件，会因缺少审批桥而回到人工审批。这里移植的是审批核心，不是 Codex 全量复现，也不是 OpenAI 或 ZCode 官方发行。

[下载 Release](https://github.com/MagicSpirit007/CodexAutoApprovalZcode/releases/tag/v0.1.1) · [功能对照](docs/migration.md) · [验收记录](docs/desktop-acceptance.md) · [源码构建](host-adapter/README.md)

## 安装：无需源码或另装 Node

### 1. 下载并启动适配桌面

下载 [CodexAutoApproval-Windows-0.1.1.zip](https://github.com/MagicSpirit007/CodexAutoApprovalZcode/releases/download/v0.1.1/CodexAutoApproval-Windows-0.1.1.zip)，解压到独立目录，直接双击其中的 **ZCode.exe**。

适配桌面使用独立应用身份 `ZCode AutoReview`，可以与原版并存。已有旧适配版运行时，先退出旧版再启动新版；无需 `.cmd` 启动包装。按 ZCode 正常流程配置模型，并打开本地工作区。

### 2. 安装插件 ZIP

下载 [CodexAutoApproval-plugin-0.1.1.zip](https://github.com/MagicSpirit007/CodexAutoApprovalZcode/releases/download/v0.1.1/CodexAutoApproval-plugin-0.1.1.zip)，解压到任意目录。

在桌面 **设置 → 插件 → 创建 → 添加 marketplace** 中，选择**包含 marketplace.json 的解压目录**，然后安装并启用 **CodexAutoApproval**。不要直接选择 ZIP 文件，也不要选择其内部的插件子目录。

插件包提供相对路径 marketplace、Windows Node 运行时、审批代码和策略；安装后不依赖解压目录或源码，也无需另装 Node。[ZCode 官方安装规范](https://zcode.z.ai/en/docs/plugin)支持本地 marketplace。

插件技术安装 ID 为 `codex-auto-approval@codex-auto-review-local`；保留它是为了兼容已有安装，显示名称为 CodexAutoApproval。

**0.1.1 请使用上述本地安装方式。** 此版本宿主的 GitHub 归档安装器限制单文件 50 MiB，插件自带 node.exe 约 81 MiB，因此直接输入 GitHub 仓库地址的安装路线不适用于本版。仓库用于分发源码和 Release；不会要求用户自行构建。

### 3. 新建会话并选择权限选项

**安装或重新启用后新建会话**，在输入框旁的权限菜单选择 **CodexAutoApproval**。该选项会启用当前工作区的插件，并进入正常审批流程；`Ctrl+Shift+M` 可在可用权限选项间切换。

![适配桌面中的 CodexAutoApproval 独立权限选项](docs/images/permission-menu.png)

![插件列表中的 CodexAutoApproval](docs/images/plugin-list.png)

工作区有任务运行时，权限切换会锁住。已有会话停用后重新启用，需要新建会话，菜单会提示原因；ZCode 的 PermissionRequest Hook 在创建会话时加载。

### 校验下载

Release 同时提供 [SHA256SUMS.txt](https://github.com/MagicSpirit007/CodexAutoApprovalZcode/releases/download/v0.1.1/SHA256SUMS.txt)，可用 PowerShell 校验下载文件：

```powershell
Get-FileHash .\CodexAutoApproval-Windows-0.1.1.zip -Algorithm SHA256
Get-FileHash .\CodexAutoApproval-plugin-0.1.1.zip -Algorithm SHA256
```

## 选项与审批行为

| 权限选项 | 所属功能 | 在适配桌面中的效果 |
| --- | --- | --- |
| 变更前确认 | ZCode 原生 | 在当前工作区停用本插件，使用原生 build 权限流程 |
| 自动编辑 | ZCode 原生 | 在当前工作区停用本插件，使用原生 edit 权限流程 |
| 完全访问 | ZCode 原生 | 在当前工作区停用本插件，使用原生 yolo 权限流程 |
| **CodexAutoApproval** | 本项目 | 启用当前工作区插件，审查原生流程实际要求审批的动作 |
| 计划模式 | ZCode 原生独立约束 | 保留 Plan 限制，不因自动审批而解除 |

启停作用于整个工作区。明确禁止规则、Plan 限制和工具参数校验仍由宿主执行；插件只接入实际到达 `PermissionRequest` 的动作，不添加永久许可规则。

| 审查结果 | 后续行为 |
| --- | --- |
| `allow` | 只放行本次绑定的动作；不缓存许可，不添加永久权限规则 |
| `deny` | 不执行；把具体理由与禁止绕过指引反馈给主模型，可继续独立的已授权工作 |
| 认证、网络、无效输出、预算不足、桥故障或超时 | 回到原生人工审批；不会默认放行，也不计为策略拒绝 |
| 用户取消 | 终止在途请求，不执行动作 |
| 连续 3 次拒绝，或最近 50 次审查中累计 10 次拒绝 | 按宿主轮次熔断，停止当前轮，保留会话 |

默认总审查时限 **90 秒**，最多 **3 次尝试**。审批模型继承桌面当前会话的模型与推理设置，凭据留在宿主，由原生模型适配器调用。它只可读取工作区文件、调查目录，不能执行 shell、写文件或使用网络工具。审查请求包含真实用户授权、近期工具证据及拒绝记录，排除主模型隐藏推理。

每次审查绑定会话、轮次、工具调用、完整参数指纹、模型和授权快照。模型或授权发生变化时，旧结果失效并重新审查。

## 停用与卸载

在权限菜单选择任一原生权限选项，会停用当前工作区插件；也可在插件设置中停用或卸载 **CodexAutoApproval**。随后新建会话，使用宿主原生权限流程。

如果看不到 CodexAutoApproval 权限选项，先确认运行的是 Release 中的适配桌面，再检查插件是否安装并启用。插件在官方原版桌面中的技术故障回退为人工审批，无法仅靠 marketplace 给原版增加模型桥和菜单。

## 与 Codex 的关系及验证范围

| 项目 | 固定基线 / 状态 |
| --- | --- |
| Codex 审批策略来源 | [`d42056091aded7feb1d88ac7e83972108b2aa478`](https://github.com/openai/codex/tree/d42056091aded7feb1d88ac7e83972108b2aa478) |
| ZCode 宿主源码 | [`29628c9acdb81b703bbd4080c207a0e7ce5e276e`](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，版本 3.14.3 |
| Windows 发行外壳 | 已安装 ZCode 3.14.4 的 Electron 与原生资源，替换为固定源码重建的桌面 JavaScript 和 Agent |
| 原有核心测试 | 52/52 通过 |
| Hook 与桥测试 | 15/15 通过；Linux 与真实 Windows 分别执行 |
| 原生宿主权限链路 | 14/14 通过；Linux 与真实 Windows 分别执行 |
| 真实 Windows 桌面界面 | 7/7 场景通过：菜单、放行、拒绝、认证故障转人工、停用、卸载、插件显示名称 |

这个 Windows 包是**混合版本的适配发行**，不是官方 3.14.4 源码的完整重建。桌面包内 `AUTO-REVIEW-BUILD.json` 记录来源和原始 / 适配产物指纹。官方更新机制保留；官方更新可能替换适配代码，升级后需要重新核对菜单和审批桥。

测试使用本机 HTTP 模型替身，不证明所有真实外部提供商、认证和计费行为都兼容。首版仅交付 Windows x64 本地桌面会话；SSH、WSL、远程工作区、其他桌面系统未验证。未移植 Codex 的 OS 沙箱、网络代理、全部工具、专用 reviewer 服务或 Cyber 单拒熔断；模型审批本身不提供 OS 隔离。

[迁移对照](docs/migration.md)逐项标注「与 Codex 一致 / 宿主适配 / 未支持 / 未实测」并给出源码位置。[验收记录](docs/desktop-acceptance.md)包含测试说明、已知 lint 基线问题和实测证据。

## 开发与目录

```text
marketplace.json             本地安装入口（与插件 ZIP 一同提供）
plugins/codex-auto-approval/  自包含 Windows 插件、Hook、运行时和策略
src/                        可复用审批核心与桌面客户端
prompts/                    默认风险策略与评估模板
host-adapter/               固定 ZCode 提交的完整源码补丁与构建说明
test/                      CLI、真实 Hook 子进程、宿主链路测试
docs/                      功能对照、验收记录、截图与独立 CLI 用法
scripts/                    打包、构建分发及验证工具
```

基础测试需要 Node.js 22+，不需要 npm 依赖安装，也不访问真实模型：

```sh
git clone https://github.com/MagicSpirit007/CodexAutoApprovalZcode.git
cd CodexAutoApprovalZcode
npm test
npm run check
```

宿主链路测试和桌面重建需要检出、应用补丁并安装固定 ZCode 源码依赖，详见 [host-adapter/README.md](host-adapter/README.md)。仓库还保留兼容的独立 CLI，用法见 [docs/cli.md](docs/cli.md)；它使用自己的模型配置，不读取 Codex 登录信息。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题处理见 [SECURITY.md](SECURITY.md)。

## 许可证与致谢

本项目源码按 [Apache-2.0](LICENSE) 发布，保留 [NOTICE](NOTICE) 中的 OpenAI Codex 与 ZCode 来源说明。Windows 包中的 Electron、Chromium、Node 和其他第三方组件保留各自许可证；插件随包附有 Node 许可证。

感谢 [OpenAI Codex](https://github.com/openai/codex)、[ZCode](https://github.com/zai-org/ZCode) 及其贡献者。
