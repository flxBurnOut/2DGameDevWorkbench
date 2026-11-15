# 从需求选择工作流

先利用对话、附件、已选作品和当前工程判断用户要讨论、制作、修改还是交付。已有授权适用于同一目标和预算内的后续步骤；名称、路径和常规参数由 Agent 根据实际上下文决定。

## 何时继续，何时询问

- 用户已要求执行且目标明确，就完成相关工作。用户委托检查、选择和交付时，Agent 查看实际结果后可作出采用决定并继续导出或接入。
- 用户要候选或方案时，交付到该阶段。模型报告提供判断依据，实际检查和操作决定由用户或获授权的主 Agent 完成。
- 只有无法确定的目标、会影响结果的关键创作选择、额外费用或范围变化才需要补充信息。先检查已有素材；问题集中在用户能决定的内容。
- 提问使用宿主当前可用的工具或简短对话。已明确委托的默认选择可直接使用；需要用户决定的问题保持待答，期间继续独立工作。

## 按任务读取

下列 topic 可通过 `workbench_get_guidance` 读取正文；CLI / HTTP 使用同一 `guidance` 操作。文件客户端可直接打开链接，只读当前任务需要的主题。

| 任务 | topic 与入口 |
| --- | --- |
| 制作流程、工具选择 | `production` · [资产制作 Skill](../.agents/skills/2d-game-workbench/SKILL.md) |
| 角色原图生成、已有图片导入与移送 | `reference-art` · [角色原图](../docs/reference-art.md) |
| 角色与动作：规划、分段检查、导出 | `motion` · [开放动作](guides/motion.md) |
| 选帧修改、原版与备选比较 | `adjustments` · [动画调整](../docs/motion-adjustments.md) |
| 透明物品生成与整图编辑 | `image-generation` · [图片素材](../docs/prop-art.md) |
| 已有图片的局部编辑与恢复 | `image-editing` · [图片编辑](../docs/image-editing.md) |
| 交互物与共享工程 | `interactables` · [交互物](../docs/interactable-editor.md) |
| 查找、下载、交接已有资产 | `assets` · [资产目录](../docs/asset-catalog.md) |
| Godot 代码与资源接入 | `engineering` / `delivery` · [工程 Skill](../.agents/skills/forge-game-engineering/SKILL.md) / [交付](../docs/godot-delivery.md) |
| 展示作品、连接预览或页面跟随 | `presentation` · [预览协议](../docs/agent-preview-follow.md) |
| 美术判断；专门研究复核准确率 | `visual-review` · [判断维度](experts/2d-production-expert.md)；`review-evaluation` · [评测](../docs/sprite-review-evaluation.md) |

已有作品优先按资产查找，执行故障按任务查找。多个合理目标才需要用户选择；内部 ID 从结果中获取。角色图片可通过 `reference-art import` 导入，随后 transfer 为动画参考。

## 执行与交付

新能力或不确定的操作先发现 schema，已确认的 schema 可在会话内复用。`prepare` 可用于已授权工作的输入校验并保存准备记录；讨论和只读查询无需建立制作任务。

异步执行继续查询原 task/job。未知付费提交先查原回执或恢复原作业，避免重复收费；确定失败后的下一步依据原因、剩余额度和现有授权选择。

WorkBuddy 首条用户消息按[预览协议](../docs/agent-preview-follow.md)检查环境并打开本会话预览，制作前确认页面；`preview_required` 表示尚未提交任务。用户明确拒绝或关闭、或已确认宿主工具不可用时，沿用协议中的 `previewPolicy` 例外。其他客户端可无前端运行。复用已连接页面，保留暂停、关闭和未保存内容；页面到达确认与实际看图检查分别处理。

完成时说明实际结果、可用预览或文件，以及影响使用的验证缺口。按请求区分候选、已采用、已导出和引擎验证；技术 ID、原始日志和完整 JSON 只在排错或用户需要时展开。
