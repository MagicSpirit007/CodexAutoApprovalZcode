# 贡献说明

欢迎提交安装问题、兼容性反馈与代码改动。请先阅读 [README](README.md)、[功能对照](docs/migration.md)和[宿主构建说明](host-adapter/README.md)。

## 问题反馈

说明 Windows / ZCode / 插件版本、运行原版还是适配桌面、复现步骤、期望与实际行为。区分策略拒绝和认证 / 网络等技术失败。日志只保留与问题有关的片段，删除密钥、个人文件、完整会话与认证信息。

涉及漏洞或绕过审批时，按 [SECURITY.md](SECURITY.md) 处理。

## 修改与验证

1. 在分支上修改，保持既有独立 CLI 接口兼容。
2. 使用 Node 22+ 执行 `npm test` 和 `npm run check`。
3. 修改桌面桥或权限流程时，按宿主说明准备固定源码，执行 `npm run test:desktop`，并补充能证明行为的测试。
4. 修改核心代码后，运行 `npm run package:desktop` 同步插件内运行代码；不要手工维护两份不同实现。
5. 在 Pull Request 中说明触发条件、行为变化、验证结果和未验证范围。

只放行本次动作、拒绝不执行、技术失败转人工、取消不放行、过期答复失效、明确禁止与 Plan 限制保留，是修改审批链路时必须保持的约束。

宿主变更交付为固定提交上的补丁。`host-adapter/upstream/`、本地配置、用户会话、构建缓存和 `artifacts/` 不进入 Git；较大的发行 ZIP 放在 Release。Node 运行时更新时，应同时更新其许可证并复验 Windows Hook。

请保留第三方来源与 Apache-2.0 标注，不把本项目宣称为官方发行或 Codex 的完整复现。
