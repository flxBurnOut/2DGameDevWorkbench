# Agent 工具与任务语义

用于查找接口、理解任务状态和读取结果；连接配置见[客户端接入](agent-clients.md)。运行时 manifest 与工具发现返回的 schema 是实际能力来源，本页不重复字段定义。

## 工具索引

Server 还提供只读资源 `workbench://manifest`。工具数量和版本以当前连接的发现结果为准。

| 工具 | 行为 |
| --- | --- |
| `workbench_list_capabilities` | 发现可用能力、短概览与按需主题索引 |
| `workbench_get_guidance` | 按 topic 读取一份指导正文；省略 topic 返回概览和索引 |
| `workbench_describe_capability` | 读取目标能力完整 schema、输出约定与相关主题入口 |
| `workbench_prepare_task` | 显式输入校验，写准备记录，不运行适配器 |
| `workbench_run_task` | 运行已获授权的操作，写任务及实际产物 |
| `workbench_get_task` | 读取并按需要刷新原异步任务，不新建生成 |
| `workbench_present` | 选择展示目标；WorkBuddy 返回本会话的宿主开页动作 |
| `workbench_get_frontend_context` | 核对本会话页面与步骤到达确认 |
| `workbench_list_game_exports` | 查询游戏项目交付 |
| `workbench_get_game_export` | 检查指定包和目标工程 |
| `workbench_export_to_game` | 交付已有 Godot 包 |
| `workbench_install_game_export` | 校验并安装交付资源 |
| `workbench_complete_game_export` | 记录接入文件与引擎证据 |
| `workbench_get_environment` | 检查运行环境、服务兼容性、前端和 Key 配置状态 |
| `workbench_start_services` | 离线时启动本机 SpritePipeline，不安装或生成 |
| `workbench_start_frontend` | 启动本机 Web 与 Bridge，宿主另行打开预览 |
| `workbench_list_presets` | 查询真实对象与动作 ID 和默认参数；objects 追加对象类型，characters/actions 保留兼容 |
| `workbench_interactable_template` | 返回完整行为模板，不保存或导出 |
| `workbench_list_tasks` | 查最近执行和原生作业，用于追踪操作 |
| `workbench_list_assets` | 按名称、类型、候选条件分页查持久资产 |
| `workbench_get_asset` | 读取单件资产、文件证据及精确详情链接 |
| `workbench_get_asset_manifest` | 返回明确所选资产的交接清单，不复制文件 |
| `workbench_get_result` | 读取 taskId 或 jobId 的结果与精确候选链接，不刷新生成 |
| `workbench_read_artifact` | 读取任务登记图片；GIF 为首帧，不等于完整播放 |
| `workbench_list_documents` | 分页发现共享交互物工程 |
| `workbench_get_document` | 读取当前或历史版本；metadataOnly 可省略素材正文 |
| `workbench_create_document` | 从完整内容或模板创建共享工程 |
| `workbench_save_document` | 按预期版本保存完整内容 |
| `workbench_apply_document_commands` | 单文档类型化事务；需要 expectedRevision 与 commandId |
| `workbench_restore_document` | 将历史快照恢复为新版本，保留原历史 |
| `workbench_validate_document` | 检查保存版本的结构、媒体与诊断 |
| `workbench_simulate_document` | 执行类型化输入事件并检查交互结果，不改文档 |
| `workbench_adopt_document_image` | 使用确切图片任务与 SHA-256，明确采用到指定工程 |
| `workbench_get_motion_bindings` | 只读：各切换状态 / 序列条目绑定的状态图与过渡、来源作品版本与是否仍在使用 |
| `workbench_inspect_image_target` | 发现或读取既有图片目标、源版本和候选 |
| `workbench_resolve_image_region` | 按确切源版本解析区域；可显式保存命名区域 |
| `workbench_prepare_part_context` / `workbench_request_part_suggestion` / `workbench_get_part_suggestion` | 准备并查看三张规划视图，明确请求一次视觉定位，或查询已有部件建议 |
| `workbench_prepare_image_plan` / `workbench_get_image_plan` | 冻结或读取部件属性、授权范围、参考与会话基准；准备计划不生成，每份计划最多提交一个候选 |
| `workbench_record_image_review` | 针对确切候选哈希保存人工或 Agent 判断与缺陷位置，不自动采用或宣称判断独立 |
| `workbench_prepare_candidate_check` / `workbench_request_candidate_check` / `workbench_get_candidate_check` | 冻结候选和原图的独立复核视图，明确请求一次模型判断，或查询原记录。需查缺陷来源时，用首轮 reviewRef 另备原始返回和范围诊断 |
| `workbench_edit_image_region` | 执行本地配方或显式 ai-edit，保存独立候选。recompose-ai 可在原授权范围内复用已保存的生成响应 |
| `workbench_apply_image_candidate` | 按目标版本、源哈希和锁采用确切候选；motion-frame 先保存动画备选，完整播放后另行采用 |
| `workbench_get_image_edit` | 读取持久会话、候选及原任务身份 |

启动工具改变本机进程状态；prepare/run 持久化任务；文档写入维护自己的版本。读取指导不创建任务或调用提供方，get_task 可刷新原有异步记录。读取完整操作语义时按[生产 Skill](../.agents/skills/2d-game-workbench/SKILL.md)选择主题。

## 选择执行入口

首次使用不熟悉的操作时 list/describe，之后可复用已确认的 schema。用户已经要求执行且输入充分时直接 run；需要校验并保存准备记录时可 prepare。讨论、浏览和等待执行授权时无需建立任务。跨能力工作使用各自实际 operation 和任务身份。

共享文档、图片会话和版本化修改经 canonical Bridge 完成，沿用其 revision/hash 与 commandId 契约；详细字段分别见[交互物](interactable-editor.md)和[图片编辑](image-editing.md)。

## 状态与异步任务

- `prepared`：只完成校验和记录。
- `running`：本地适配器或上游任务仍在执行。
- `awaiting_configuration`：缺少指定服务配置；任务没有产物完成声明。
- `completed`：运行时确认完成并记录有效产物。
- `failed`：任务失败，读取其错误并说明恢复路径。
- `attention_required`：序列帧需要检查、审核或恢复；先查看结果和候选状态，不直接重生成。

序列帧异步生成和复核期间，用原 `taskId` 调 `workbench_get_task`。开放动作可跨片段确认继续查询同一任务和版本。`presentation.reviewProgress` 提供候选、片段或完整动画、当前检查项 `phase`、已记录调用数 `callsUsed`、已完成调用数 `callsCompleted` 和单项上限 `maxCalls`。调用发送前即记入账本，发送结果未知也占用额度。复核期间照 `nextActions` 继续查询。片段 `readyForDecision` 或整段 `readyForApproval` 出现后，检查实际画面、注明结论，并按返回状态确认提醒。

Image 2.6 同样先返回已持久化的 running taskId，再由后台进程提交和保存图片。使用同一 get_task/status 查询；进程退出或租约失效时提示 attention_required，不自动重试可能已计费的提交。任务完成后先检查图片，再明确采用；requiresAdoption=true 不代表已经修改交互物。

普通回复先说结果、准确作品链接与下一步；技术详情保留能力、操作、任务 ID、状态、错误或缺失配置及实际输出路径，需要排错时提供。不能把 `prepared`、`running` 或 `awaiting_configuration` 描述为完成。

## 结果与展示数据

`get_result` 接受 `taskId` 或序列帧原生 `jobId`，二选一。`candidateIndex` 定位准确候选并缩小摘要范围。查询只读。本地 `taskId` 读取上次保存的快照，`jobId` 直接读取原生服务当前状态。

`presentation` 由共享运行时生成，包含 `title`、`state`、`summary`、精确 `viewPath/viewUrl`、`actions`、可用的图片/GIF `preview` 和技术详情入口。状态区分已准备、等待配置、处理中、等待检查、已保存和已导出；缺失产物会提示需要处理。它不承诺质量通过，也不编造百分比。

序列帧的文本和 `structuredContent` 默认都返回摘要，包含下一操作、每候选硬错误和提醒计数与首条内容、可用片段 token 及方案版本。设 `detail:true` 读取完整技术资料的第一页。可带 JSON Pointer `section` 直达内容，例如 `/result/orderedFrames`、`/result/stage/review`、`/result/work/plan` 或 `/artifacts`。续页带回相同参数和 `detailPage.nextOffset`、`detailPage.snapshot`。按顺序拼接 `detailPage.json` 并解析，直到 `nextOffset` 为 `null`。快照变化后重读该分区第一页。其他能力沿用原结果格式，`detail:true` 也把完整技术结果放入文本。图像通过 `workbench_read_artifact` 读取。执行详情页面提供预览与操作入口。

WorkBuddy 首次开页、生成前检查、关闭/暂停保护和页面到达确认统一见[预览协议](agent-preview-follow.md)。读取结果、页面到达、实际看图和目标引擎运行是不同证据。
