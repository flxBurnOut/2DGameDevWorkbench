# 工作台开发导航

按改动选择下面的契约与测试。产品流程描述当前实现；用户授权扩展功能时，修改实现和契约，并验证新行为。

| 改动 | 主要位置 | 针对性检查 |
| --- | --- | --- |
| 能力、适配器、任务状态 | `workbench/manifest.json`、`lib/workbench/runtime.mjs`、`lib/workbench/adapters/` | `test:adapters`、`test:task-isolation` |
| MCP / CLI / HTTP 与 Agent 指导 | `scripts/workbench*.mjs`、`lib/workbench/agent-api.mjs`、`agent-guidance.mjs` | `test:mcp`、`test:http`；实际制作链变化再跑 `test:agent-acceptance` |
| 预览和页面跟随 | `lib/workbench/*preview*`、前端跟随组件 | `test:preview-follow`、`test:presentation` |
| 图片生成 / 局部编辑 | `lib/workbench/adapters/image-assets.mjs`、`image-edit*.mjs` | `test:image-assets`、受影响的 `tests/image-edit/` 用例 |
| 局部编辑诊断与基线采集 | `scripts/image-edit-evaluation.mjs`、`scripts/image-edit-replay.mjs`；[P0 评测](local-edit-evaluation.md) | `test:image-edit-evaluation`；隔离 `test:image-edit`、`test:image-assets` |
| 部件属性计划与本地分层 | `features/image-edit/attribute-plan.mjs`、`intrinsic-recolor.mjs`、`lib/workbench/image-edit-intrinsics.mjs`、`Tools/MarigoldAnalysis/`；[使用与安装](image-attribute-editing.md) | `test:image-attribute-plan`；编辑回归、typecheck、lint、build |
| 单候选视觉复核与诊断 | `lib/workbench/image-edit-critic.mjs`、`components/image-edit/candidate-check.tsx`、[使用指南](image-attribute-editing.md#独立复核成品) | `test:image-attribute-plan` 覆盖独立上下文、候选身份与中断恢复，`tests/image-edit/transport.mjs` 验证 MCP 图片输出 |
| 场景 / 交互物共享文档 | `features/scene-composer/`、`features/interactable-editor/`、`lib/workbench/document-*.mjs` | `test:editor-documents`、`test:scene-composer`、`test:interactable`；观察或接线变化加相应测试 |
| 场景地图分层 | `features/scene-composer/map-split.mjs`、`lib/workbench/scene-splits.mjs`、`lib/workbench/map-split-*.mjs`、场景分层面板 | `test:scene-split`、`test:scene-composer`、`test:image-edit`、`test:editor-documents`。浏览器用 `tests/scene-split/browser.mjs`；引擎检查用 `tests/scene-composer/map-split-engine.mjs` 与 Godot 4.7.x。 |
| 场景专家协作 | `lib/workbench/scene-workflow*.mjs`、`features/scene-workflow/`、`components/scene-composer/scene-workflow-panel.tsx` | `test:scene-workflow`；共享保存或图片执行变化加对应回归；[流程与边界](../../docs/scene-collaboration.md) |
| 开放动作 | `Tools/SpritePipeline/sprite_pipeline/collaboration/`、`components/sprite-generator/` | 受影响的 Python 测试、`test:open-motion` |
| 游戏交付 / 工程 helper | `features/godot-export/`、`lib/workbench/game-export*.mjs`、工程 Skill 的脚本 | `test:game-export`、`test:engineering` |
| 启动器与平台支持 | `scripts/dev.mjs`、服务 supervisor、平台凭据模块 | `test:frontend`、`test:dev-supervisor`、`test:desktop-services` 或凭据测试 |

完整命令以 `package.json` 为准。类型相关变更运行 `npm run typecheck`，JS/TS 变更运行 `npm run lint`；打包或前端接线变化运行 `npm run build`。纯文档修改核对引用和差异，Skill 修改运行宿主的 Skill validator。

## 本地验证

Node 版本要求见 `package.json`；SpritePipeline 使用自己的 `.venv`。Python 示例（Windows）从仓库根目录执行：

```powershell
$env:PYTHONPATH = Join-Path (Get-Location) 'Tools/SpritePipeline'
& 'Tools/SpritePipeline/.venv/Scripts/python.exe' -m pytest -q Tools/SpritePipeline/tests/<相关测试>.py
```

临时目录受限时，给 pytest 指定 `work/test-runs/` 下本次新建的唯一 `--basetemp`，并按需禁用缓存插件。系统 Python 缺少 validator 依赖时可复用项目 venv；Windows UTF-8 文件可用 `python -X utf8` 读取。

Node 集成测试通过 `tests/helpers/runtime-workspace.mjs` 创建独立 WORKBENCH_TEST_RUN；新测试沿用该入口。使用 fixture 或模拟提供方验证流程。真实生成只有在任务确实包含相应费用授权时执行，流程测试不代替生成品质判断。

工作台导出与 helper 回归基线是 Godot 4.7.x，使用 `GODOT_47_BIN` 并核对 `--version`。目标游戏使用它自己的实际版本；兼容性不符时报告具体差异。缺少引擎可完成其他检查并标明未运行的项目。

## 实现时保留的契约

共享文档和图片编辑使用 Bridge 的版本检查与稳定 commandId；冲突后重读，未知提交恢复原记录。付费异步作业保留请求意图、上游 ID 与用量。前端草稿、保存版本、生产候选和游戏交付各有身份，跨层修改时使用对应来源及当前版本。

源模块结构见[架构](../../docs/architecture.md)，服务维护见[操作手册](../../docs/operations-manual.md)。涉及指导文档时使用[维护指南](guidance-maintenance.md)。
