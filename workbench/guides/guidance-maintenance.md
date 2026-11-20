# Agent 指导的维护与拆分

## 入口分工

- 根 [AGENTS.md](../../AGENTS.md) 负责项目任务导航和少量跨模块事实。
- 项目 `.agents/skills/` 下的 `SKILL.md` 负责各自能力的选择、核心操作和相关主题路由；`grill-me` 提供用户明确要求的方案追问流程。
- [conversation-guide.md](../conversation-guide.md) 提供简短共用决策方式，并作为 MCP 默认指南。
- 主题正文放在 `workbench/guides/`、Skill 的 `references/` 或现有 `docs/`。每项知识选一个维护位置；其他入口只说明何时读取。
- 专家指南负责视觉判断；MCP 初始化说明负责发现入口；工具 schema 负责字段和数值范围。

精简、搬移和改写指导时，保留当前功能及业务流程。发现流程本身值得改进时，作为单独建议提出；文档整理不隐含运行时行为变更。

新增规则前先确定它会改变什么决策。已有 schema、代码或主题正文能表达的内容，就在对应位置维护。常见合理路径给默认做法；固定顺序和绝对措辞用于具体的正确性或授权问题，并说明适用条件。

长文件出现多个独立任务、重复定义或大段条件说明时，按任务拆分。主入口提供“任务 → 主题”链接；正文保持完成该任务所需的上下文。避免让入口要求读取所有子文档，也避免拆出只有一两句话且没有独立用途的文件。

## 新主题如何到达客户端

在 `workbench/manifest.json` 的 `agentAssets.guidanceTopics` 登记稳定 topic、标题和仓库相对 source。按需加入 capabilityId，使能力描述返回相应入口。

`workbench_get_guidance({topic})`、CLI `agent guidance --input <json-file>` 和 HTTP `POST /v1/agent/guidance` 共用 `getConversationGuidance`。省略 topic 返回简短 overview；请求主题才读取其正文。MCP-only 客户端同样能获得正文。

旧 `agentAssets.skill`、`engineering.skill`、`expert` 和 `conversationGuide` 路径保留兼容。Skill 的 UI 元数据描述用户任务；自动发现策略保持原设置，`grill-me` 保留仅显式调用。根 AGENTS 是共享导航，其他本地宿主指导和工作记录继续按 `.gitignore` 管理。

## 验证

核对注册主题能读到真实文件，相对链接有效，未知 topic 和任意文件路径被拒绝，读取指南不产生任务或模型调用。修改加载方式后运行 MCP / HTTP 相关回归；Skill 正文或元数据调整后运行 `quick_validate.py`。

用具体请求检验决策：已有授权的单动作接入、委托 Agent 检查选用的动画、明确网页操作、只讨论方案、未知付费请求恢复。复杂调整可以做独立只读推演，比较是否多问、读入无关文档或越过任务范围。检查可观察行为；不要用某个固定词是否出现代替行为验收。

需跟进的工程问题和相关试验报告归入[问题清单](../../docs/问题清单/README.md)，本机原始运行记录沿用原位置。可复用的操作事实进入主题指南，并清理已被新实现取代的说明。
