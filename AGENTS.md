# Forge 项目任务导航

Forge 论文分支保留序列帧、交互物、图片局部调整与 Godot 交付。按当前任务选择入口，只读涉及的主题，不必通读全部文档。

| 当前任务 | 从这里开始 |
| --- | --- |
| 制作、修改、查看或交付素材 | [资产制作 Skill](.agents/skills/2d-game-workbench/SKILL.md) |
| 把素材接入游戏，或编写 Godot 代码 | [游戏工程 Skill](.agents/skills/forge-game-engineering/SKILL.md)，并结合目标工程自身说明 |
| 修改工作台代码、接口、测试或配置 | [开发导航](workbench/guides/development.md) |
| 修改 Agent 指导或 Skill | [指导文档维护](workbench/guides/guidance-maintenance.md) |
| 记录、跟进或关闭工程问题 | 先读[目录指引](docs/问题清单/AGENTS.md)，在[问题清单](docs/问题清单/README.md)查重并按日期建批记录 |
| MCP 连接、指导读取或宿主工具排错 | [客户端接入](docs/agent-clients.md) |
| 安装、启动、服务排错或数据恢复 | [操作手册](docs/operations-manual.md) |
| 讨论方案、解释功能或梳理需求 | [对话指南](workbench/conversation-guide.md) |
| 讨论论文方向、写论文或安排实验 | `paper-v2` 转向“以交互事件为单位的角色—交互物协同序列帧生成”暂定蓝图，见[暂定论文大纲](docs/论文大纲-事件驱动交互动画生成.md)（原 VBYC 定稿存档于 `paper-vbyc` 分支） |
| 需要用追问检验方案、决策与假设 | [Grill Me Skill](.agents/skills/grill-me/SKILL.md) |

## 基本约定

- **执行范围**：在用户已明确的目标、对象和预算内直接完成常规工作；仅在目标不明、超出授权或出现冲突时询问。纯讨论按讨论回复；获准实施时做到可验证结果。
- **数据与提交边界**：`work/`、`outputs/`、`games/` 存放本地任务、素材与游戏数据，开发验证使用隔离目录，提交时避免带入私人数据或凭据。
- **分支策略**：本分支改动直接提交并推送到 `paper-v2`，不开 Pull Request，也不改动已冻结的 `paper-vbyc` 或合入 `main`（除非用户明确要求）。
- **事实来源**：能力和参数以 `workbench/manifest.json`、接口契约及当前代码为准。若文档与代码不一致，以实现和测试核对，并在本次修改范围内同步修正文档。
