# 工作台开发导航

按改动选择下面的契约与测试。产品流程描述当前实现；用户授权扩展功能时，修改实现和契约，并验证新行为。

| 改动 | 主要位置 | 针对性检查 |
| --- | --- | --- |
| 能力、适配器、任务状态 | `workbench/manifest.json`、`lib/workbench/runtime.mjs`、`lib/workbench/adapters/` | `test:adapters`、`test:task-isolation` |
| MCP / CLI / HTTP 与 Agent 指导 | `scripts/workbench*.mjs`、`lib/workbench/agent-api.mjs`、`agent-guidance.mjs` | `test:mcp`、`test:http`；实际制作链变化再跑 `test:agent-acceptance` |
| 前端外壳、导航与交互状态 | `components/workbench/`、`components/ui/`、`app/interaction.css`、`lib/workbench/navigation.ts` | `test:workbench-shell`、`test:frontend`；改顶栏或路由时加 `test:preview-follow`、`test:presentation` |
| 主题配色 | `lib/workbench/theme-palette.json` → `npm run theme:sync` | `theme:check`、`test:theme`（两种模式的对比度） |
| 预览和页面跟随 | `lib/workbench/*preview*`、前端跟随组件 | `test:preview-follow`、`test:presentation` |
| 图片生成 / 局部编辑 | `lib/workbench/adapters/image-assets.mjs`、`image-edit*.mjs` | `test:image-assets`、受影响的 `tests/image-edit/` 用例 |
| 局部编辑诊断与基线采集 | `scripts/image-edit-evaluation.mjs`、`scripts/image-edit-replay.mjs`；[P0 评测](local-edit-evaluation.md) | `test:image-edit-evaluation`；隔离 `test:image-edit`、`test:image-assets` |
| 部件属性计划与简单换色 | `features/image-edit/attribute-plan.mjs`、`color-map.mjs`、图片编辑服务；[使用指南](image-attribute-editing.md) | `test:image-attribute-plan`；编辑回归、typecheck、lint、build |
| 单候选视觉复核与诊断 | `lib/workbench/image-edit-critic.mjs`、`components/image-edit/candidate-check.tsx`、[使用指南](image-attribute-editing.md#独立复核成品) | `test:image-attribute-plan` 覆盖独立上下文、候选身份与中断恢复，`tests/image-edit/transport.mjs` 验证 MCP 图片输出 |
| 交互物共享文档 | `features/interactable-editor/`、`features/editor-documents/`、`lib/workbench/document-*.mjs`、`interactable-document*.mjs` | `test:editor-documents`、`test:interactable`；保存与模拟变化加相应测试 |
| 开放动作 | `Tools/SpritePipeline/sprite_pipeline/collaboration/`、`components/sprite-generator/` | 受影响的 Python 测试、`test:open-motion` |
| 交互物动画面板 | `components/interactable-motion/`、`features/interactable-motion/`、`derived_assets.py`、`interactable-motion-bindings.mjs` | `test:interactable-motion`、`test_interactable_panel_backend.py`、`test_interactable_state_chain.py`（含跨服务写回）；网页验收 `tests/interactable-motion/browser.mjs` |
| 物品原图导入与像素化转换 | `Tools/PixelProp/`、`sprite_pipeline/pixel_prop_gateway.py`、`prop_reference.py`、`lib/workbench/adapters/reference-art.mjs`、`components/interactable-editor/prop-reference-tools.tsx` | `test:pixel-prop`（黄金样例按 `pixelSha256` 固定，改算法须升 `ALGORITHM_VERSION`）、`tests/test_reference_art.py`、`test:reference-art`、`test:prop-art`；网页验收 `tests/prop-art/browser.mjs`（先 `npm run build`） |
| 游戏交付 / 工程 helper | `features/godot-export/`、`lib/workbench/game-export*.mjs`、工程 Skill 的脚本 | `test:game-export`、`test:engineering` |
| 启动器与平台支持 | `scripts/dev.mjs`、服务 supervisor、平台凭据模块 | `test:frontend`、`test:dev-supervisor`、`test:desktop-services` 或凭据测试 |

完整命令以 `package.json` 为准。类型相关变更运行 `npm run typecheck`，JS/TS 变更运行 `npm run lint`；打包或前端接线变化运行 `npm run build`。纯文档修改核对引用和差异，Skill 修改运行宿主的 Skill validator。

## 本地验证

Node 版本要求见 `package.json`；SpritePipeline 使用自己的 `.venv`。Python 示例（Windows）从仓库根目录执行：

```powershell
$env:PYTHONPATH = Join-Path (Get-Location) 'Tools/SpritePipeline'
& 'Tools/SpritePipeline/.venv/Scripts/python.exe' -X utf8 -m pytest -q Tools/SpritePipeline/tests/<相关测试>.py
```

临时目录受限时，给 pytest 指定 `work/test-runs/` 下本次新建的唯一 `--basetemp`，并按需禁用缓存插件。系统 Python 缺少 validator 依赖时可复用项目 venv；Windows UTF-8 文件可用 `python -X utf8` 读取。

Node 集成测试通过 `tests/helpers/runtime-workspace.mjs` 创建独立 WORKBENCH_TEST_RUN；新测试沿用该入口。使用 fixture 或模拟提供方验证流程。真实生成只有在任务确实包含相应费用授权时执行，流程测试不代替生成品质判断。

Windows 上运行会启动 Python 子进程的 Node 回归前，设置 `$env:PYTHONUTF8 = '1'`，使子进程按 UTF-8 读取协议和归档 JSON。通常让各测试进程自行生成 `WORKBENCH_TEST_RUN`；不要给多个独立测试共用同一个目录，否则历史计数和媒体数量会相互污染。需要回环连接的集成测试应在允许本地 socket 的执行环境中运行。

工作台导出与 helper 回归基线是 Godot 4.7.x，使用 `GODOT_47_BIN` 并核对 `--version`。目标游戏使用它自己的实际版本；兼容性不符时报告具体差异。缺少引擎可完成其他检查并标明未运行的项目。

## 实现时保留的契约

共享文档和图片编辑使用 Bridge 的版本检查与稳定 commandId；冲突后重读，未知提交恢复原记录。付费异步作业保留请求意图、上游 ID 与用量。前端草稿、保存版本、生产候选和游戏交付各有身份，跨层修改时使用对应来源及当前版本。

源模块结构见[架构](../../docs/architecture.md)，服务维护见[操作手册](../../docs/operations-manual.md)。涉及指导文档时使用[维护指南](guidance-maintenance.md)。

任务执行使用 `task-runtime.mjs`，清单与路径使用 `workbench-manifest.mjs`。内部调用按领域导入；`runtime.mjs` 保留公共导出。运行 `node tests/task-isolation/dependency-graph.mjs` 检查生产静态依赖环。任务目录性能可用 `node tests/task-isolation/benchmark.mjs 1000 128 25` 重测，参数依次为记录数、每条载荷 KiB、归档百分比。

运行 `node tests/task-isolation/history-stress.mjs 128 500 0` 可复测任务记录原子替换时的列表覆盖率和归档预检。三个参数可省略，默认依次为 128 KiB 载荷、500 轮和 0 秒。每轮执行一次列表查询和一次归档预检。0 秒表示连续查询，指定正数时会把调用分布在该时长内，执行较慢时继续完成指定轮数。脚本使用系统临时目录和独立写入进程，输出原子替换总数、查询期间的替换数、两类调用次数、覆盖不完整次数和归档拒绝次数。未观测到查询期间的替换、覆盖不完整或预检拒绝时，脚本返回非零状态。

向论文分支推送时，Linux CI 使用最低支持版本 Node 22.13.0 和 Node 24，分别通过 `npm ci --engine-strict` 安装锁定依赖并运行工作台功能门禁。调整 `package.json` 的最低 Node 版本时同步更新 CI 矩阵。

每次推送也会运行 Python 3.11 / 3.13 API-only 回归。在推送顶端提交说明中加入 `[platform-ci]` 或手动运行 CI，可追加 Linux、macOS、Windows 的完整原生测试、Web 启动、代理、离线 Agent 接入和任务历史基准。
