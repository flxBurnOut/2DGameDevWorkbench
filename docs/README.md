# 使用文档

Forge 的公开文档面向安装、制作资产、MCP 接入与游戏项目交付。开发导航和指导维护说明随源码维护；本机工作记录与私人作品不随源码分发。

| 文档 | 内容 |
| --- | --- |
| [使用与操作手册](operations-manual.md) | 安装、制作、导出、备份与排错 |
| [Agent 任务导航](../AGENTS.md) | 按任务选择 Skill、开发和维护入口 |
| [Agent 客户端接入](agent-clients.md) | MCP 配置、按需指导与宿主排错 |
| [工具与任务语义](agent-client-tools.md) | 工具索引、状态和结果数据 |
| [客户端验收](agent-client-validation.md) | 宿主行为场景与历史验证记录 |
| [角色原图](reference-art.md) | 原图生成、导入与动画参考移送 |
| [序列帧生成](sprite-generator.md) | 候选、检查、修补与导出 |
| [视觉专家与争议复核](sprite-review-evaluation.md) | 独立意见、争议复核、实际画面对比与调用边界 |
| [选帧修改与备选版本](motion-adjustments.md) | 用户范围与意图、独立额度、对比采用与原版保护 |
| [角色视觉结构](visual-structures.md) | 原图部件、时序追踪、结构辅助复核、独立分割环境与版本化纠正 |
| [交互物编辑器](interactable-editor.md) | 外观、交互行为与 Godot 资源 |
| [交互物原图](prop-art.md) | 物品原图生成与采用 |
| [图片局部调整](image-editing.md) | 精确源图、区域配方、本地候选与版本保护 |
| [资产目录](asset-catalog.md) | 查找、下载、回收站与恢复 |
| [Forge 素材包导入](asset-packages.md) | 下载包、源工程、检查确认与恢复合同 |
| [内部素材导入](internal-imports.md) | 已有素材在编辑器之间复用 |
| [页面跟随](agent-preview-follow.md) | Agent 执行时的页面展示 |
| [Godot 交付](godot-delivery.md) | 选择目标游戏项目与资源接入 |
| [游戏工程 Skill](game-engineering.md) | SpriteFrames、交互物和脚本接入 |
| [桌面兼容性](desktop-compatibility.md) | Windows/macOS 配置与操作 |
| [系统架构](architecture.md) | 工作台各组件及数据流 |
| [连接器契约](connector-contract.md) | 任务协议、文件与服务接口 |
| [界面说明](workbench-interface.md) | 页面入口与数据范围 |
| [前端优化方案](前端优化方案.md) | 前端性能、排版与视觉一致性的评估结果和分步方案，已实施 |
| [交互物动画独立面板方案](交互物动画独立面板方案.md) | 当前交互物动画的界面逻辑与已实现工具汇总，以状态图为中心的独立面板、交互物专用编辑工具与实施记录（已实施） |
| [前端界面与交互优化方案](前端界面与交互优化方案.md) | 首页布局、导航菜单、图标、按钮状态与操作反馈的走查结果、分步方案与实施记录，已实施 |
| [论文方向与方法](论文方向与方法.md) | 论文方向、已定决策、进度与后续素材 |
| [论文：先验证，再接续](论文-序列帧长动作生成.md) | 论文主张、方法、研究问题与实验草案 |
| [论文分支执行计划](论文分支执行计划.md) | 面向论文的新分支：合并与未实现清单、删除范围、执行顺序与当前验证状态 |
| [工程问题清单与工作记录](问题清单/README.md) | 按 Git 提交和记录时间跟进工程问题，查阅 N2 小测报告、解决方案与复测证据 |
| [安全策略](../SECURITY.md) | 凭据、文件与本机服务边界 |
| [第三方声明](../THIRD_PARTY_NOTICES.md) | 代码来源与许可 |

产品 Skills 保留在 `.agents/skills/`，由 `workbench/manifest.json` 登记。它们用于实际资产生产与工程交付，不依赖开发者本机的规则或工作记录。
