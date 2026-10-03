# ZCode AutoReview 安装与稳定升级

适配发行从 0.2.0 起使用独立 NSIS 安装器。基于 ZCode 3.14.3 完整提交的桌面和 Agent 源码，插件为 0.1.3，审批桥为 v2；官方二进制 3.14.4 不等于已有可适配源码。

公开基线中的 Computer Use 模块为 API 兼容占位包，运行时返回 unavailable；本发行沿用这一边界，不包含完整 Computer Use 能力。Electron 与 Windows 原生模块使用明确记录的运行资源，桌面、Agent 与 JavaScript 依赖均从上述源码基线构建。

安装器默认目录为 `D:\CodexAutoReview\zcode\runtime\ZCodeAutoReview`。入口为 `ZCodeAutoReview.exe`，快捷方式名为 ZCode AutoReview。独立 appId、注册/卸载项、AUMID、Helper 变体和更新缓存与官方版本隔离。已有 `ZCode AutoReview` 用户数据目录及 `.zcode` 业务配置保持沿用，安装器和卸载器均不删除会话数据。

首次迁移运行新安装器，再运行 `scripts/migrate-autoreview-shortcuts.ps1`。该脚本只修改 TargetPath 精确匹配旧 0.1.3 适配 EXE 的桌面、开始菜单和已固定任务栏快捷方式，保存 `.autoreview-backup` 和迁移收据。`-Preview` 可先查看匹配结果。旧便携目录必须保留，旧版不能自行完成首次安装迁移。

启动后异步检查独立稳定索引，菜单保留检查更新。下载与重启安装分别需要用户点击；共享配置中的自动下载选项不会使适配版自动升级。所有窗口先获取安装租约，Host RPC 与 Agent 准入暂停，再由实际运行时确认任务、审批等待、队列、工作流、插件操作和配置请求均已空闲。忙碌、未知协议或缺失响应会取消安装并释放租约。首期只支持本地 Windows x64 工作区；有远程连接时须先断开连接。

更新只能来自本仓库 `autoreview-v<发行版本>` Release 的完整 NSIS 安装器。索引校验独立身份、正式版本、源码提交、补丁 SHA256、审批桥、已验证插件版本、安装器长度及 SHA512。损坏包不会进入可安装状态；网络失败可以重试，不会切到官方源。生产构建不能用环境变量替换更新仓库。

每次上游升级先修改发行规格及 release.config.json，明确选定公开稳定 tag 和适配版本。用手动工具创建隔离 checkout，按指定顺序应用补丁。版本或完整提交不符、只有官方二进制、存在尚未设计的数据迁移时停止。

```sh
node scripts/distribution-release.mjs prepare --tag v3.14.3 --version 0.2.0 --checkout <新目录> --patch <有序补丁1> --patch <有序补丁2>
node scripts/distribution-release.mjs build --source <检出目录> --config <发行配置> --electron-assets <Windows运行资源> --out <交付目录>
node scripts/distribution-release.mjs manifest --config <发行配置> --out <交付目录> --patch <完整源码补丁>
node scripts/distribution-release.mjs publish --config <发行配置> --out <交付目录> --patch <完整源码补丁> --checks <验收收据>
```

构建必须使用该源码 mise.toml 中的 Node、pnpm 和锁文件。发行记录分开记录适配版本、上游版本/提交、插件/桥版本及桌面/Agent 指纹；Windows 运行资源另记来源，JS 运行依赖由源码依赖闭包组装。package.json 与 PE 版本均写适配发行版本，原生模型协议仍使用上游版本。

发布前执行全量 typecheck、lint、CLI 检查、架构检查、审批回归及两个测试发行版本的 Windows 安装升级验收。与同一干净上游基线比较已有问题，新增问题阻断发布。最终收据绑定安装器 SHA256。测试版有独立 acceptance appId 和名称，编译时才可打开本机回环测试通道，禁止发布测试包。

发布工具先上传版本固定的安装器、清单、校验文件、源码补丁和收据，重新下载检查指纹，最后推进主分支 `updates/windows-x64/stable/latest.yml`。没有定时检测或自动发布。插件 Release 不会成为桌面升级候选。

每个成功安装的安装器保留在 `%LOCALAPPDATA%\ZCode AutoReview\installers`，该目录在安装路径之外。安装/启动失败时重新运行已验证安装器修复。数据兼容的旧版可关闭应用后手动安装，更新器禁止自动降级；保留升级后会话，不恢复整份旧配置或覆盖共享数据库。数据格式变化必须先完成迁移与回退设计，才能进入稳定通道。
