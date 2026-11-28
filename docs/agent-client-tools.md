# Agent 工具与任务语义

本页按功能分组索引 MCP 工具，并说明异步任务追踪与结果分页读取方式。连接配置见[客户端接入](agent-clients.md)，底层字段与状态契约见[连接器契约](connector-contract.md)。

## 工具索引

Server 同时暴露只读资源 `workbench://manifest`，实际工具版本与参数以当前 discovery 为准。

### 发现、指导与环境

| 工具 | 用途 |
| --- | --- |
| `workbench_list_capabilities` | 列出可用能力、简短概览与按需主题索引 |
| `workbench_get_guidance` | 按 `topic` 读取对应指导正文；省略时返回概览 |
| `workbench_describe_capability` | 获取单个能力的完整 schema、输出约定与关联主题 |
| `workbench_get_environment` | 检查服务状态、兼容性、前端就绪与凭据配置 |
| `workbench_start_services` | 离线时启动本机 SpritePipeline（不安装依赖、不生图） |
| `workbench_start_frontend` | 启动本机 Web 与 Runtime Bridge |
| `workbench_list_presets` | 查询角色/交互物对象 ID（`objects`）与兼容动作预设 |
| `workbench_interactable_template` | 返回交互物行为模板（只读） |

### 任务执行与查询

| 工具 | 用途 |
| --- | --- |
| `workbench_prepare_task` | 仅做输入校验并保存准备记录，不执行适配器 |
| `workbench_run_task` | 执行已授权操作并写入任务与产物 |
| `workbench_get_task` | 查询并按需刷新原异步任务（支持 `taskId` 或 `commandId`） |
| `workbench_list_tasks` | 分页查询最近执行任务与原生作业 |

### 资产、结果与页面展示

| 工具 | 用途 |
| --- | --- |
| `workbench_list_assets` | 按名称、类型、候选条件分页检索持久资产 |
| `workbench_get_asset` | 读取单件资产详情、文件校验信息与精确页面链接 |
| `workbench_get_asset_manifest` | 返回所选资产的交接清单（不复制文件） |
| `workbench_get_result` | 只读查询 `taskId` 或 `jobId` 的结果与精确候选链接 |
| `workbench_read_artifact` | 读取任务登记图片（GIF 仅返回首帧，需完整序列时按帧读取） |
| `workbench_present` | 在前端展示指定作品/任务/能力；WorkBuddy 返回宿主开页动作 |
| `workbench_get_frontend_context` | 只读查询活跃页面状态与展示到达确认 |

### 共享交互物工程

| 工具 | 用途 |
| --- | --- |
| `workbench_list_documents` | 分页列出共享交互物工程 |
| `workbench_get_document` | 读取当前或历史版本（`metadataOnly` 可省去媒体正文） |
| `workbench_create_document` | 从完整内容或模板新建共享工程 |
| `workbench_save_document` | 按 `expectedRevision` 保存完整快照 |
| `workbench_apply_document_commands` | 对单文档执行类型化事务（需 `expectedRevision` 与 `commandId`） |
| `workbench_restore_document` | 将历史快照恢复为新版本（保留原历史） |
| `workbench_validate_document` | 校验已保存版本的结构与媒体 |
| `workbench_simulate_document` | 运行交互事件模拟并验证期望（只读，不改文档） |
| `workbench_adopt_document_image` | 按任务 ID 与 SHA-256 将图片明确采用到指定工程 |
| `workbench_get_motion_bindings` | 只读查询各切换状态/序列条目绑定的状态图与过渡 |

### 图片局部编辑与复核

| 工具 | 用途 |
| --- | --- |
| `workbench_inspect_image_target` | 发现或读取图片目标、源版本、哈希与可用操作 |
| `workbench_resolve_image_region` | 按确切源版本解析选区，可显式保存命名区域 |
| `workbench_prepare_part_context` / `workbench_request_part_suggestion` / `workbench_get_part_suggestion` | 准备定位视图、请求一次视觉部件定位或查询定位回执 |
| `workbench_prepare_image_plan` / `workbench_get_image_plan` | 冻结或读取部件属性策略、授权范围与参考图（每计划限提一候选） |
| `workbench_edit_image_region` | 执行本地配方、`ai-edit` 或本地重合成 `recompose-ai`，保存独立候选 |
| `workbench_apply_image_candidate` | 校验版本、哈希与锁后采用静态图，或为 `motion-frame` 保存动画备选 |
| `workbench_get_image_edit` | 读取持久图片编辑会话、候选与任务关联 |
| `workbench_record_image_review` | 绑定候选哈希记录人工或 Agent 的检查结论与缺陷坐标 |
| `workbench_prepare_candidate_check` / `workbench_request_candidate_check` / `workbench_get_candidate_check` | 准备复核/诊断视图、发起一次独立模型复核或查询原记录 |

### Godot 游戏交付

| 工具 | 用途 |
| --- | --- |
| `workbench_list_game_exports` / `workbench_get_game_export` | 查询已有游戏项目交付记录与指定包详情 |
| `workbench_export_to_game` | 将已有 Godot 包交付到选定目标工程 |
| `workbench_install_game_export` | 校验哈希并安装交付资源 |
| `workbench_complete_game_export` | 记录修改文件与引擎验证结果 |

## 选择执行入口与幂等恢复

- 不熟悉的能力先调 `list` / `describe`，会话内可复用已确认 schema。目标与参数明确时直接 `run`，需要提前校验时用 `prepare`；纯讨论和只读查询不建任务。
- 付费或异步调用前可传入稳定的 `commandId`：相同 `commandId` 与输入可推进同一 `prepared` 任务或找回已提交任务；应答丢失时调 `workbench_get_task({commandId})` 恢复。首次 `plan-motion` 默认用本地任务 ID 作为原生 `request_key`，同样可按原键查询回执。
- 任务查询默认返回精简入参，需查看完整入参时传 `detail: true`。共享文档与图片会话统一通过长驻 Runtime Bridge 执行，遵循 `revision`/`hash` 与 `commandId` 契约，详见[连接器契约](connector-contract.md#2-公共任务模型)。

## 任务状态与异步轮询

完整状态机定义见[连接器契约](connector-contract.md#3-状态机与输出约束)，日常常用含义：

- `prepared`：仅完成校验与保存，未执行；
- `running`：本地适配器或上游作业执行中；
- `awaiting_configuration`：缺少所需服务或凭据，尚未执行；
- `attention_required`：需要检查、审核或恢复原作业（切勿直接重生成）；
- `completed`：操作完成且输出文件校验通过；
- `failed`：执行失败，查看错误信息决定后续动作。

异步任务追踪要点：
- **序列帧复核进度**：持续用原 `taskId` 调 `workbench_get_task`。`presentation.reviewProgress` 提供当前检查阶段 `phase`、已记账调用数 `callsUsed`（发送前记账）、已完成数 `callsCompleted` 与单项上限 `maxCalls`。出现 `readyForDecision` 或 `readyForApproval` 后看图裁决。
- **Image 2.6 后台生成**：先返回 `running` 的 `taskId`，后台落盘后查询刷新；若后台进程退出或租约失效，任务变为 `attention_required`（等待核查，不自动重发）。结果带 `requiresAdoption=true`，需显式采用才会写入交互物。

## 结果与展示数据

- **`workbench_get_result`**：传 `taskId`（读上次保存快照）或原生 `jobId`（直查原生服务），二选一；可配 `candidateIndex` 精确定位候选。
- **`presentation`**：统一返回 `title`、`state`、`summary`、精确 `viewPath`/`viewUrl`、`actions` 与预览图，用于直观展示进展与入口。
- **序列帧结果分页读取**：
  1. 默认返回精简摘要（含下一操作、每候选错误/提醒计数与首条内容、片段 token 与方案版本）。
  2. 需要技术明细时传 `detail: true`，并可用 JSON Pointer `section` 直达子树（如 `/result/orderedFrames`、`/result/stage/review`、`/result/work/plan`、`/artifacts`）。
  3. 若返回非空 `detailPage.nextOffset`，续页时原样带回筛选参数、`nextOffset` 与 `detailPage.snapshot`，顺序拼接 `detailPage.json` 直至 `nextOffset` 为 `null`；快照变更时从第一页重读。

WorkBuddy 开页与页面跟随规则见[预览协议](agent-preview-follow.md)。
