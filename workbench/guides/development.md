# 工作台开发导航

按改动范围查找代码位置与针对性测试。文档描述当前实现；用户授权扩展功能时，同步更新实现、契约与对应文档，并验证新行为。

## 模块与检查路由

| 改动领域 | 主要位置 | 针对性检查 |
| --- | --- | --- |
| 能力、适配器、任务状态 | `workbench/manifest.json`、`lib/workbench/runtime.mjs`、`lib/workbench/adapters/` | `test:adapters`、`test:task-isolation` |
| MCP / CLI / HTTP 与 Agent 指导 | `scripts/workbench*.mjs`、`lib/workbench/agent-api.mjs`、`agent-guidance.mjs` | `test:mcp`、`test:http`；涉及制作链加跑 `test:agent-acceptance` |
| 前端外壳、导航与交互 | `components/workbench/`、`components/ui/`、`app/interaction.css`、`lib/workbench/navigation.ts` | `test:workbench-shell`、`test:frontend`；改顶栏或路由加跑 `test:preview-follow`、`test:presentation` |
| 主题配色 | `lib/workbench/theme-palette.json` → `npm run theme:sync` | `theme:check`、`test:theme`（深浅双模式对比度） |
| 预览与页面跟随 | `lib/workbench/*preview*`、前端跟随组件 | `test:preview-follow`、`test:presentation` |
| 图片生成与局部编辑 | `lib/workbench/adapters/image-assets.mjs`、`image-edit*.mjs` | `test:image-assets`、相关 `tests/image-edit/` 用例 |
| 局部编辑诊断与基线采集 | `scripts/image-edit-evaluation.mjs`、`scripts/image-edit-replay.mjs`；[P0 评测](local-edit-evaluation.md) | `test:image-edit-evaluation`；产品基线 `test:image-edit`、`test:image-assets` |
| 部件属性计划与简单换色 | `features/image-edit/attribute-plan.mjs`、`color-map.mjs`；[使用指南](image-attribute-editing.md) | `test:image-attribute-plan`、编辑回归、typecheck、lint、build |
| 单候选视觉复核与诊断 | `lib/workbench/image-edit-critic.mjs`、`components/image-edit/candidate-check.tsx` | `test:image-attribute-plan`、`tests/image-edit/transport.mjs` |
| 交互物共享文档 | `features/interactable-editor/`、`features/editor-documents/`、`lib/workbench/document-*.mjs`、`interactable-document*.mjs` | `test:editor-documents`、`test:interactable` |
| 开放动作 | `Tools/SpritePipeline/sprite_pipeline/collaboration/`、`components/sprite-generator/` | 相关 Python 测试、`test:open-motion` |
| 交互物动画面板 | `components/interactable-motion/`、`features/interactable-motion/`、`derived_assets.py`、`interactable-motion-bindings.mjs` | `test:interactable-motion`、`test_interactable_panel_backend.py`、`test_interactable_state_chain.py`；网页验收 `tests/interactable-motion/browser.mjs` |
| 物品原图导入与像素化转换 | `Tools/PixelProp/`、`sprite_pipeline/pixel_prop_gateway.py`、`prop_reference.py`、`lib/workbench/adapters/reference-art.mjs`、`components/interactable-editor/prop-reference-tools.tsx` | `test:pixel-prop`（改算法须升 `ALGORITHM_VERSION`）、`test_reference_art.py`、`test:reference-art`、`test:prop-art`；网页验收 `tests/prop-art/browser.mjs`（先 build） |
| 游戏交付与工程 helper | `features/godot-export/`、`lib/workbench/game-export*.mjs`、工程 Skill 脚本 | `test:game-export`、`test:engineering` |
| 启动器与平台凭据 | `scripts/dev.mjs`、服务 supervisor、平台凭据模块 | `test:frontend`、`test:dev-supervisor`、`test:desktop-services`、`test:platform-credentials` |

完整脚本见 `package.json`。类型变动跑 `npm run typecheck`，JS/TS 变动跑 `npm run lint`，前端接线或打包变动跑 `npm run build`；纯文档改动核对链接和事实差异，Skill 改动运行宿主 Skill 校验。

## 本地验证环境

- **Node 与 Python**：Node 版本要求见 `package.json`；SpritePipeline 使用独立的 `Tools/SpritePipeline/.venv`。Windows 下运行 Python 测试示例：
  ```powershell
  $env:PYTHONPATH = Join-Path (Get-Location) 'Tools/SpritePipeline'
  & 'Tools/SpritePipeline/.venv/Scripts/python.exe' -X utf8 -m pytest -q Tools/SpritePipeline/tests/<相关测试>.py
  ```
- **测试隔离**：Node 集成测试统一通过 `tests/helpers/runtime-workspace.mjs` 创建独立 `WORKBENCH_TEST_RUN`（各并发测试进程不要共用同一目录）。Windows 运行会起 Python 子进程的 Node 回归前先设 `$env:PYTHONUTF8 = '1'`；临时目录受限时为 pytest 指定 `work/test-runs/` 下唯一 `--basetemp`。
- **费用与引擎**：常规回归使用 fixture 或模拟提供方，仅在任务包含费用授权时跑真实生成。Godot 导出与 helper 基线为 Godot 4.7.x（通过 `GODOT_47_BIN` 指定并核对 `--version`）；缺引擎时运行其余检查并标明未验项。

## 代码边界与 CI

- **核心契约**：共享文档和图片编辑必须走 Bridge 的版本检查与稳定 `commandId`（冲突重读、未知提交查回执恢复）；付费异步作业保留请求意图、上游 ID 与用量；前端草稿、保存版本、生产候选和游戏交付各自独立，跨层修改须带来源与当前版本。模块划分见[系统架构](../../docs/architecture.md)，运维排错见[操作手册](../../docs/operations-manual.md)，指导文档调整见[维护指南](guidance-maintenance.md)。
- **模块导入与压测**：任务执行走 `task-runtime.mjs`，清单与路径走 `workbench-manifest.mjs`，内部按领域导入（`runtime.mjs` 保留公共导出）。
  - 静态依赖环检查：`node tests/task-isolation/dependency-graph.mjs`
  - 任务目录性能基准：`node tests/task-isolation/benchmark.mjs 1000 128 25`（记录数、载荷 KiB、归档占比）
  - 原子替换压力测试：`node tests/task-isolation/history-stress.mjs 128 500 0`（载荷 KiB、轮数、分布秒数；详细参数见脚本内说明）
- **CI 门禁**：推送到 `paper-vbyc` 时，Linux CI 在 Node 22.13.0 与 Node 24 下执行 `npm ci --engine-strict` 与工作台功能门禁，同时跑 Python 3.11 / 3.13 API-only 回归。提交说明含 `[platform-ci]` 或手动触发时，追加 Linux/macOS/Windows 全平台原生测试、Web 启动、代理、离线 Agent 接入与任务历史基准。调整 `package.json` 最低 Node 版本时同步更新 CI 矩阵。
