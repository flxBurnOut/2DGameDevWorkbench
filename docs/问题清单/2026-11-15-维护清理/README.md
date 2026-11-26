# 维护清理

> 返回[问题清单索引](../README.md)。按[目录指引](../AGENTS.md)记录；当前状态以索引为准。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | 2026-11-15T01:50:05-05:00 |
| 基准 | 工作区基于 `df043c0a4cc8` |
| 提交 | `c992a1668c38` |
| 登记问题 | MAINT-01、PKG-01 |

架构文档冲突、孤立 gitlink、死代码与依赖清理，安装包遗漏模块。

## 问题条目

状态截至本次整理；最新状态以[索引](../README.md)为准，后续变化记在之后的记录目录。

| 编号 | 状态 | 现象与影响 | 验证方法 |
| --- | --- | --- | --- |
| MAINT-01 | 已验证 | 架构文档混入已提交的冲突标记及重复正文，父仓库包含无配置的 gitlink，退役页面还留下无调用代码和过时说明。现合并架构、移除孤立跟踪项并保留本地目录，清理已确认死代码和依赖，更新当前规范。 | 类型、lint、构建与相关 Node 回归通过；本地嵌套目录存在且已排除跟踪及检查；测试、样例和素材无差异。 |
| PKG-01 | 已验证 | setuptools 显式包列表遗漏 `sprite_pipeline.collaboration`，源码运行掩盖安装包缺少核心模块的风险。现按 `sprite_pipeline.*` 发现包。 | 隔离 wheel 包含 51 个 collaboration 文件和 11 个静态文件；离线安装后从目录外导入五个主要模块，54 项 Python 回归及 28 个子测试通过。 |

## 记录

2026-11-15T01:50:05-05:00，分支 `paper-vbyc`，工作区基于 `df043c0a4cc8`，本轮修改尚未提交。登记并修复 MAINT-01、PKG-01。架构冲突合并保留最新实验协议；孤立 `2dgamedevworkbench` gitlink 仅从父仓库索引移除，本地目录保留，并加入忽略、类型检查和 lint 排除范围。

删除 54 个无入口 UI、其独占 hook、四个未使用 Node 文件和旧攻击面板，共 60 个源文件；另清理两个无调用前端符号及已退役宿主的 CSS。移除八项无用直接依赖，同步锁文件。保留六个实际使用的 UI、旧动画工作区、仍有调用的攻击/修补/视觉/迁移流程、所有测试、样例与素材。当前指南同步物品移送、状态链、动画帧备选、文档操作、凭据、平台和服务边界，历史记录与第三方署名保留。

验证通过：`typecheck`、`lint`、`build`；`test:theme`、`test:workbench-shell`、`test:image-assets`、`test:asset-import`、`test:asset-packages`、`test:assets`、`test:mcp`、`test:http`、`test:editor-documents`、`test:preview-follow`、`test:open-motion`、`test:game-export`、`test:engineering`。工具侧隔离构建 wheel、离线安装并核对从安装目录导入 models、cli、collaboration.api、model_config、ui；相关 Python 回归 54 项及 28 个子测试通过。本机打包与 Python 证据保存在 `work/test-runs/tools-cleanup-1794725031521/`。

测试使用模拟提供方、归档帧和隔离目录，没有真实模型调用或生成费用。Windows 测试使用 UTF-8，允许本地回环连接，并让独立测试自行生成工作区身份；首次受默认编码、socket 沙箱及共用测试目录影响的失败已按此复跑通过，未为此改动产品逻辑或测试样例。Godot 4.7.x 运行时因未配置 `GODOT_47_BIN` 跳过，工程 helper 和打包通过不作为引擎验收。

**维护清理实现归档。** 2026-11-15T01:55:48-05:00（提交时间），提交 [c992a1668c38](https://github.com/aaaarthur666-design/2DGameDevWorkbench/commit/c992a1668c38dcb7317a56e60784f4df806a929b) 收录 MAINT-01、PKG-01 的修复、死代码与依赖清理及当前文档更新。提交前核对 94 项跟踪变更，公开仓库检查与差异检查通过；没有带入本地目录、测试产物、测试样例或私人素材，嵌套本地目录仍保留。
