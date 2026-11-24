# Forge 文档中心

本目录收录 Forge 论文分支（`paper-vbyc`）的安装运维、功能模块、Agent 接入、系统架构与论文文档；开发测试路由见[开发导航](../workbench/guides/development.md)，Agent 入口导航见[根 AGENTS](../AGENTS.md)。

## 入门、运维与界面

| 文档 | 内容 |
| --- | --- |
| [使用与操作手册](operations-manual.md) | 安装启动、密钥配置、日常制作、备份与排错 |
| [工作台界面说明](workbench-interface.md) | 页面入口、顶栏导航、制作记录与本地草稿 |
| [桌面兼容性](desktop-compatibility.md) | Windows / macOS 凭据、启动与跨平台注意项 |
| [安全策略](../SECURITY.md) | 凭据隔离、本地文件与服务安全边界 |
| [第三方声明](../THIRD_PARTY_NOTICES.md) | 代码来源、上游同步基线与许可说明 |

## 资产制作与模块参考

| 文档 | 内容 |
| --- | --- |
| [角色原图](reference-art.md) | PixelLab 角色原图生成、本地导入与动画移送 |
| [序列帧生成](sprite-generator.md) | 五阶段开放动作、对象预设、MCP 操作与 Godot 导出 |
| [交互物动画面板](交互物动画独立面板方案.md) | 状态图独立面板、专用帧工具（T1–T10）、派生素材与槽位写回 |
| [选帧修改与备选版本](motion-adjustments.md) | 局部选帧调整、区域保护、帧数与额度限制、确定性帧编辑 |
| [视觉复核与离线评估](sprite-review-evaluation.md) | 独立多视角复核、可见性核对、确定性探针守卫与离线评测 CLI |
| [角色视觉结构与规划策略](visual-structures.md) | 原图结构解析、SAM 2.1 追踪、结构辅助制作与策略 6 规划规则 |
| [交互物编辑器](interactable-editor.md) | 行为与触发配置、共享文档事务、模拟与 Godot 资源包导出 |
| [交互物品原图与转换](prop-art.md) | GPT Image 透明物品生成、本地处理、128 px 导入与 PixelProp 转换 |
| [物品原图导入与像素化转换方案](物品原图导入与像素化转换方案.md) | PixelProp 转换算法设计、配方核验与实施说明 |
| [图片局部调整](image-editing.md) | 共用画布工作区、本地像素工具、AI 局部修改与版本恢复 |
| [资产目录与交接清单](asset-catalog.md) | 资产检索、打包下载、交接清单与可恢复回收站 |
| [Forge 素材包导入合同](asset-packages.md) | 素材包格式、安全解包与原子提交 API |
| [内部素材导入与联用](internal-imports.md) | 资产库跨模块复用与状态链写回协议 |
| [Godot 交付](godot-delivery.md) | 项目选择、交付包安装、并发锁与 WorkBuddy 接入流程 |
| [游戏工程 Skill 说明](game-engineering.md) | SpriteFrames 合并、交互物接入与工程 helper 验证 |

## Agent 接入、架构与契约

| 文档 | 内容 |
| --- | --- |
| [Agent 客户端接入](agent-clients.md) | MCP / CLI 配置、按需指导读取与 WorkBuddy 重信任 |
| [Agent 工具与任务语义](agent-client-tools.md) | 分组 MCP 工具索引、任务状态与结果分页协议 |
| [Agent 预览与页面跟随](agent-preview-follow.md) | WorkBuddy 首次开页、预览策略与页面跟随协议 |
| [Agent 客户端验收](agent-client-validation.md) | 对话范围、开页与页面跟随回归场景 |
| [系统架构](architecture.md) | 服务拓扑、模块分层、数据持久化与核心数据流 |
| [连接器与任务契约](connector-contract.md) | 任务模型、状态机、HTTP Bridge 与各适配器协议 |

## 论文与工程追踪

| 文档 | 内容 |
| --- | --- |
| [论文方向与方法](论文方向与方法.md) | v8 定位边界、已定决策、方向演变、模块归属与当前进度路线图 |
| [论文：先验证，再接续](论文-序列帧长动作生成.md) | 8 页 IEEE CoG 论文主大纲、VBYC 方法与三层实验设计 |
| [序列帧实验支撑](motion-experiments.md) | 冻结协议、五组对照回放、2×2 消融、回顾导出与匿名盲评包 |
| [工程问题清单](问题清单/README.md) | 待处理与已关闭问题总索引及按日期划分的批次记录 |
