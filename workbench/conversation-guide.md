# 对话与工作流决策指南

先结合对话上下文、附件、已选作品和当前工程，判断用户是想讨论、制作、修改还是交付。

## 何时继续，何时询问

- **直接执行**：用户目标明确且已授权时，直接完成相关步骤，名称、路径和常规参数由 Agent 按上下文决定；用户委托检查并选用结果时，看图核对后可直接采用并继续导出或接入。
- **按阶段交付**：用户只要求候选或方案时，交付到该阶段即可；模型报告只是参考依据，采用决定由用户或获授权的主 Agent 作出。
- **只在必要时提问**：仅当目标不明确、存在关键创作分歧、涉及额外费用或超出范围时再提问。提问前先查已有素材，只问需要用户拍板的内容；待答期间继续推进无依赖的工作。

## 按任务读取主题

通过 `workbench_get_guidance({topic})`（CLI/HTTP 对应 `guidance`）按需读取正文；有仓库文件权限的客户端可直接打开链接：

| 任务 | topic 与文档 |
| --- | --- |
| 制作流程、MCP/CLI 工具选择 | `production` · [资产制作 Skill](../.agents/skills/2d-game-workbench/SKILL.md) |
| 角色原图生成、本地导入与移送 | `reference-art` · [角色原图](../docs/reference-art.md) |
| 角色与交互物动作：规划、检查、写回与导出 | `motion` · [开放动作指南](guides/motion.md) |
| 选帧修改、原版与备选对比 | `adjustments` · [选帧调整](../docs/motion-adjustments.md) |
| 透明物品生成与整图编辑；128 px 物品导入与像素化转换 | `image-generation` · [物品原图](../docs/prop-art.md) |
| 已有图片的局部调整与恢复 | `image-editing` · [图片局部调整](../docs/image-editing.md) |
| 交互物行为与共享工程编辑 | `interactables` · [交互物编辑器](../docs/interactable-editor.md) |
| 查找、下载、交接已有资产 | `assets` · [资产目录](../docs/asset-catalog.md) |
| Godot 代码编写与资产接入 | `engineering` / `delivery` · [工程 Skill](../.agents/skills/forge-game-engineering/SKILL.md) / [Godot 交付](../docs/godot-delivery.md) |
| 展示作品、连接预览与页面跟随 | `presentation` · [预览与跟随](../docs/agent-preview-follow.md) |
| 画面视觉评判；复核准确率实验 | `visual-review` · [视觉判断标准](experts/2d-production-expert.md)；`review-evaluation` · [视觉复核与评测](../docs/sprite-review-evaluation.md) |

## 通用执行与反馈

- **查询与校验**：找已有作品先查资产目录，查故障先查任务记录，内部 ID 从查询结果获取。遇到不熟悉的能力先看 schema，会话内可复用已确认 schema；纯讨论和只读查询不建任务。
- **异步与付费恢复**：异步任务持续轮询原 `taskId` / `jobId`。若付费提交结果不明，先查原回执并尝试恢复原作业，避免重复计费。
- **WorkBuddy 预览**：首次用户消息按 [预览协议](../docs/agent-preview-follow.md) 检查环境并打开本会话预览；遇到 `preview_required` 表示任务尚未提交，需先就绪预览或按协议使用 `previewPolicy` 例外。其他客户端可无前端运行。
- **简洁汇报**：完成时说明实际达成的阶段（候选生成、采用、导出或引擎验证）、可用预览或文件，以及尚未验证的关键项；技术 ID、原始日志和完整 JSON 仅在排错或用户需要时展开。
