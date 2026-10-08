# 使用文档

Forge 的公开文档面向安装、制作资产、MCP 接入与游戏项目交付。内部开发说明、工作记录与私人作品不随源码分发。

| 文档 | 内容 |
| --- | --- |
| [使用与操作手册](operations-manual.md) | 安装、制作、导出、备份与排错 |
| [Agent 客户端接入](agent-clients.md) | MCP 配置与产品 Skills |
| [角色原图](reference-art.md) | 原图生成、导入与动画参考移送 |
| [序列帧生成](sprite-generator.md) | 候选、检查、修补与导出 |
| [地图拼接](map-stitcher.md) | 手动原图、扩展、碰撞和导出 |
| [交互物编辑器](interactable-editor.md) | 外观、交互行为与 Godot 资源 |
| [交互物原图](prop-art.md) | 物品原图生成与采用 |
| [场景组装](scene-composer.md) | 地图与交互物组装 |
| [资产目录](asset-catalog.md) | 查找、下载、回收站与恢复 |
| [内部素材导入](internal-imports.md) | 已有素材在编辑器之间复用 |
| [页面跟随](agent-preview-follow.md) | Agent 执行时的页面展示 |
| [Godot 交付](godot-delivery.md) | 选择目标游戏项目与资源接入 |
| [游戏工程 Skill](game-engineering.md) | SpriteFrames、地图和脚本接入 |
| [桌面兼容性](desktop-compatibility.md) | Windows/macOS 配置与操作 |
| [系统架构](architecture.md) | 工作台各组件及数据流 |
| [连接器契约](connector-contract.md) | 任务协议、文件与服务接口 |
| [界面说明](workbench-interface.md) | 页面入口与数据范围 |
| [地图格式](MAP_STITCHER_ARCHITECTURE.md) | 地图组件与导出兼容 |
| [安全策略](../SECURITY.md) | 凭据、文件与本机服务边界 |
| [第三方声明](../THIRD_PARTY_NOTICES.md) | 代码来源与许可 |

产品 Skills 保留在 `.agents/skills/`，由 `workbench/manifest.json` 登记。它们用于实际资产生产与工程交付，不依赖开发者本机的规则或工作记录。
