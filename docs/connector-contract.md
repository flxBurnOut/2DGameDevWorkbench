# 连接器与任务契约

本文说明 MCP、CLI、HTTP Bridge 与能力适配器共享的任务模型、接口路由与协议约束。机器权威 schema 见 `workbench/manifest.json`、`lib/workbench/document-contract.mjs` 与 `lib/workbench/image-edit-contract.mjs`。

## 1. 注册能力与适配器

当前注册 4 项 `local-adapter`，由 `lib/workbench/task-runtime.mjs` 统一执行输入校验、任务持久化、状态维护与输出核验；适配器只做协议转换：

| 能力 | 适配器 | 依赖服务 |
| --- | --- | --- |
| `image-assets` | `image-assets` | GPT Image 2.6（透明物品生成与蒙版编辑；`process-image` 纯本地） |
| `reference-art` | `reference-art` | PixelLab（经 SpritePipeline 共享凭据；导入与 PixelProp 转换纯本地） |
| `sprite-generator` | `sprite-pipeline` | 本地或自管 SpritePipeline 服务 |
| `interactable-editor` | `interactable-editor` | 纯本地校验与 Godot 打包 |

CLI、HTTP 与 MCP 均校验完整 JSON 对象；无效分页或 JSON 返回 `400`，过期分页快照返回 `409`。

## 2. 公共任务模型

准备或运行任务的请求结构：

```json
{
  "capabilityId": "reference-art",
  "commandId": "reference:take-1",
  "input": { "operation": "generate", "prompt": "透明背景的侧视像素骑士" }
}
```

持久化记录位于 `work/tasks/<task-id>.json`（含 `schemaVersion`、`id`、`capabilityId`、`status`、`createdAt`、`updatedAt`、`input`、`outputs`，执行后按需追加 `adapter`、`requiredEnvironment`、`error`）。对外摘要返回 `taskId`、`status`、`taskPath`、`outputs`、`adapter`，调用方应原样保留返回路径。

- **幂等键（`commandId`）**：可选。提供时在调用适配器前落盘请求 SHA-256（忽略键顺序）与唯一 `taskId`；同 `commandId` 同载荷可推进 `prepared` 任务或返回原任务（摘要带 `replayed: true`），同 `commandId` 不同能力或入参返回 `COMMAND_ID_REUSED`。
- **明细读取**：`workbench_get_task` 支持 `taskId` 或 `commandId`（CLI 支持 `--command-id`）。默认返回精简入参；传 `detail: true`（CLI `--detail` / HTTP `detail=true`）读取完整保存入参。后台租约与执行者令牌仅存内部恢复记录，不对外暴露。

### 任务历史分页

- **Agent `tasks` 分页**：支持 `query`、`capabilityId`、`status`、`limit`（1–200）、`offset`、`snapshot` 与 `detail`，搜索全部未归档任务（工作台任务与原生作业独立分页，返回 `totalTasks`、`totalNativeJobs`、`searchedTasks`、`nextOffset`、`snapshot`）。续页传回同一筛选条件、`snapshot` 与 `nextOffset` 直至 `null`；集合或顺序变动时返回 `409`。以 `detail: true` 翻页时若单条正文已被改写，返回 `detailChanged: true`。已归档记录仍可按原 ID 精确读取。
- **Web `GET /v1/tasks`**：支持 `refresh` 与 `since`（传回上次 `revision`，未变时返回 `unchanged: true` 与空 `tasks`）。同时传 `refresh=true` 与 `status` 时，先刷新范围内活动任务再按有效状态过滤分页。

## 3. 状态机与输出约束

```text
prepare ───────────────→ prepared
run ─→ running ────────→ completed
           ├───────────→ attention_required
           ├───────────→ failed
           └───────────→ awaiting_configuration
get/status: running ───→ 刷新同一上游任务后保持或进入终态
```

- `prepared`：输入通过校验并保存，未调用适配器。
- `running`：执行中（可含上游 `jobId`）；刷新遇短暂网络异常时保持 `running` 并附 `refreshError`，绝不重发计费请求。
- `awaiting_configuration`：缺少所需环境或凭据。
- `attention_required`：需人工或 Agent 检查、审核或恢复（例如后台进程退出或租约失效后的 Image 2.6 任务，原结果迟到仍可落入原记录）。
- `completed`：本次操作成功且声明产物均通过核验。
- `failed`：执行失败并保留错误信息。

**输出目录约束**：每次运行独占 `outputs/<task-id>/`。运行时写出 `result.json`，逐一校验声明文件位于该目录内且真实存在后写入 `outputs`；源素材不原地修改，UI 下载经受限 artifact 端点完成。

## 4. Runtime HTTP Bridge 与付费配对

默认监听 `http://127.0.0.1:8790`（`npm run workbench:http`），供本机 Web（经 `/api/workbench/**` 同源代理）、CLI 与 MCP 共用：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 返回服务名、协议版本与工作区指纹 |
| `GET /v1/tasks` / `GET /v1/tasks/<id>` | 任务列表与单条查询（支持 `refresh`、`detail`、`commandId`、`since`） |
| `POST /v1/tasks/prepare` / `POST /v1/tasks` | 准备或运行任务 |
| `GET /v1/artifacts?path=outputs/...` | 下载 `outputs/` 内的受控文件 |
| `GET/POST /v1/image-assets/settings` | 查询图片服务公开状态 / 写入本机受保护凭据 |
| `GET/POST /v1/interactable-assets` | 预览或上传交互物本地图像/音频（单文件上限 64 MiB） |
| `GET/POST /v1/documents` / `/v1/documents/<id>` | 列出、创建或读取共享交互物文档（支持 `revision`、`metadataOnly`） |
| `POST /v1/documents/<id>/apply\|save\|restore` | 类型化事务、快照保存与历史恢复 |
| `POST /v1/documents/<id>/validate\|simulate\|adopt-image` | 文档校验、事件模拟与图片采用 |
| `GET /v1/documents/<id>/motion-bindings` | 只读查询切换状态/序列条目的动画资产绑定 |
| `POST /v1/reference-art/convert-prop/preview` | 经 SpritePipeline 计算 PixelProp 转换预览（不建任务、不写文件） |

请求体上限：通用 JSON 50 MiB、任务提交 120 MiB（容纳 80 MiB 源图及 base64）、文档请求 350 MiB（媒体总计 256 MiB）、Web 交互物项目导入 256 MiB。

### 浏览器付费工作区配对

- 浏览器提交付费任务前先调 `GET /api/workbench/paid-tasks` 获取 64 位十六进制 `workspaceId`（同时绑定 Bridge 工作区、任务目录与图片编辑目录中的 `.paid-workspace-id`），连同原载荷与 `commandId` 存入本地日志；恢复数据目录时须连同该标识一并恢复。
- 提交与查询（`POST/GET /api/workbench/paid-tasks`）在 `x-forge-workspace` 头携带该标识；Web 代理经 `GET /v1/paid-workspace` 校验后，向 `/paired/v1/paid/v1/...` 同时发送公共工作区头与 `x-forge-paid-workspace` 二次校验。旧浏览器经通用任务入口提交带 `commandId` 的付费请求返回 `409`。
- 升级前缺少工作区标识的旧日志仅做只读回执核对（`commandId` 与载荷 SHA-256 匹配且已启动才恢复），动画规划草稿另绑定原生工作区 ID。

## 5. SpritePipeline 适配器

默认连接 `http://127.0.0.1:7860`（可通过 `SPRITE_PIPELINE_API_URL` 与 `SPRITE_PIPELINE_API_TOKEN` 连接受保护部署）。适配器将 manifest 的 camelCase 转换为 Python API 的 snake_case。

### 基础作业操作与 `request_key` 恢复

- `create`（建作业）、`create-and-generate`（建作业并生成）、`generate-existing`（按 `jobId` 生成）、`get`（查询）、`export`（导出候选帧与 Godot 包）。
- 标准化输出键：`jobRecord`、`orderedFrames`、`spriteSheet`、`godotPackage`、`preview`、`metadata`，均复制校验到 `outputs/<task-id>/` 后发布。
- **生成命令幂等恢复**：`create-and-generate` 与 `generate-existing` 默认把本地 `taskId` 传入 `request_key`。原生服务依次落盘 `received` → `progress`（写入提交次数/上游 ID/用量与 job revision）→ `returned` / `interrupted` / `rejected`（`submission_created: false`）/ `unknown`。同参数重试返回原回执，改候选或 `wait` 返回 `409`。响应丢失时经 `GET /v1/jobs/{job_id}/generation-requests/{request_key}` 核对参数与快照恢复。
- `plan-motion` 带 `commandId` 时默认以本地任务 ID 作为原生请求键，断连后可按该键找回原作品。

### 开放动作与对象模型

- **核心操作**：`plan-motion`、`revise-motion`、`get-motion`、`generate-motion`（绑定 `expectedRevision` 与 `planSha256`）、`pause-motion`、`resume-motion`、`get-motion-stage`、`review-motion-stage`（绑定 `stageToken` 与 `expectedRevision`）、`target-motion-stage`、`repair-motion-stage`、`review-motion-repair`。仅首次 `plan-motion` 且获连续授权时可设 `autoExecute=true`；`revise-motion` 不得自动执行。
- **对象标识**：新请求使用 `motionSpec.object_id` 与 `object_type`（`character` / `interactable`，省略按 `character`；兼容旧 `character_id`，同传须相等）。`GET /v1/presets` 与 `/v1/open-motion/references` 均提供 `objects` 并保留旧 `characters` 兼容；交互物固定 128×128，不带 `facing`/`weapon_hand`，清单行含 `provenance`。详见[序列帧对象与预设](sprite-generator.md#对象与预设)。
- **Web 代理白名单**：`/api/workbench/open-motion` 仅转发列明的工作区、帧图、导出以及交互物动画面板专用的 `edit-source/<帧>`（须带 64 位 `token`）、`local-frame-edits`、`derived` 路由。
- **质量与冻结兼容**：新方案与模型配置随 Work/Job 冻结；`motionSpec.timing_mode`（`auto`/`fixed`）与 `budget.max_review_calls` 控制复核额度（历史旧版本任务按原冻结版本与哈希读取）。

### 序列帧 Godot 交付

`export` 同步产出单动作 Godot 包，工作台结果以 `godotPackage` 指向 `sprite-frames.godot.zip`（原生字段 `job.export.godot_package_path`，仅存在时拉取 `/v1/jobs/{job_id}/exports/godot` 以兼容旧记录）。详见[Godot SpriteFrames 包导出](sprite-generator.md#godot-spriteframes-包导出)。

## 6. 原图连接器（角色与物品）

`reference-art` 支持四种操作：
- `generate`：调 SpritePipeline `/v1/reference-art/jobs` 异步生成 PixelLab Pixflux 角色（64/128 px）或物品（128 px）透明原图；`/v1/reference-art/settings` 查公开状态并写入受保护 Key。
- `import`：本地导入角色 PNG 或 128×128 物品 PNG（`subject=prop`）。
- `convert-prop`：调 `/v1/reference-art/convert-prop`（及其 `/preview`）经 `pixel_prop` 确定性转换物品大图，产出 `reference.png`、`compare.png`、`recipe.json`、`report.json`。
- `transfer`：按源任务 `subject` 分别调 `/v1/reference-art/import`（角色）或 `/transfer-prop`（物品）幂等创建动画预设；导入与转换来源必须附 `confirmation.note`，转换来源按配方重算并以解码像素哈希比对。

详见[角色原图](reference-art.md)与[物品原图](prop-art.md#导入与转换为动画原图)。

## 7. `image-assets` 与用量证据

- **外部操作**：`generate-prop` 与 `edit-image` 使用 `gpt-image-2.6`（`prompt` 必填，上限 12,000 字）。`edit-image` 带蒙版时仅 `Alpha=0` 区域采用生成结果、`Alpha=1–255` 恢复源图 RGBA8，且支持可选布尔项 `preserveAlpha`；尺寸变动在付费前拦截。显式 `width`/`height` 须成对提供且为 16 的倍数；单张源图上限 40 MiB、总计 80 MiB。
- **本地操作**：`process-image` 必填 `image`（可选成对 `preserveFrom`/`mask`、`alphaCleanupThreshold` 0–16，prop 默认 1、background 默认 0），不联网、不接受 `prompt`/`provider`。
- **产物与用量**：同时保留 `rawImage`/`rawSha256`、`image`/`sha256` 与 `processingEvidence`，结果带 `requiresAdoption=true`。外部调用先落盘白名单用量文件 `provider-usage.json`（含 token/耗时/HTTP/请求 ID/返回档位，`billingAmount: null`）再校验图片，避免校验失败丢掉用量证据。

## 8. 交互物适配器与共享文档

- **离线导出适配器（`interactable-editor`）**：支持 `save-project`（保存完整 `InteractableProject`）与 `export-godot`（支持 `selectedDefinitionIds` 与 `targetProfile: "generic"`，纯本地打包 GDScript runtime、`.tres`、`.tscn`、素材与源码为 `interactables.zip`）。素材路径须在工作区内（MCP/CLI 也支持 data URL）。
- **共享文档事务（Bridge）**：文档 `kind` 为 `interactable`（`id` 即 `projectId`）。单次 `apply` 最多 100 条类型化命令，写入必填 `expectedRevision` 与 `commandId`（冲突返回 `409 / REVISION_CONFLICT`，同命令重试返回原提交版本并附 `currentRevision`）。历史快照不可变，`restore` 产生新版本。
- **动作资产写回**：`import-motion-asset` 将状态图、已接受过渡或派生素材写入切换状态/序列条目（过渡支持 `durations` 与 `playback: ping_pong`），`document-motion-bindings` 据此只读汇总绑定。
- **校验与模拟**：`validate` 检查模型与媒体；`simulate` 确定性回放最多 200 个类型化事件并核对 `expectEvents`/`expectStates`（只读）。详见[交互物编辑器](interactable-editor.md)。

## 9. 图片编辑会话与局部修改

- **统一入口**：全部 `image-*` 操作（含刷新候选读取）由 MCP/CLI 经 `POST /v1/agent/<operation>` 转发至唯一写入 Bridge；支持 `interactable`（文档+物件+静态槽）、`image-task` 与 `motion-frame`（`workId`/`workRevision`/`candidateIndex`/可选 `stageIndex`/`frameIndex`）三类目标。
- **版本与哈希边界**：源文件字节用 `sha256`，规范解码后的 straight-alpha sRGB/RGBA8 用 `rgbaSha256`（两者不可互换）。写入要求 `expectedRevision`、`expectedSha256`、`commandId`（续会话另需 `expectedEditRevision` 与 `baseCandidateVersion`）。内部选区 `1` 可改、`0` 保护；PNG 蒙版 `Alpha=0` 可改、其余保护。
- **本地与 AI 编辑**：
  - 本地工具含 Alpha 清理、精确替色、填充、擦除、矩形移动、`pixel-patch`、`restore-region` 与 `apply candidateVersion="source"`（按当前锁与绑定恢复单图为新版本）；`motion-frame` 采用返回 `saved_variant`，在动画页播放后再正式采用，详见[确定性帧编辑](motion-adjustments.md#确定性帧编辑)。
  - 显式 `ai-edit` 冻结基准、描述、最多 8 张参考图与 `mask-runs` 硬边蒙版（最多 65,536 段）后走 `image-assets/edit-image`，支持 `constraints.preserveAlpha`（未传默认 `false`），输出经本地合成与编码后像素校验。
  - 部件定位、属性计划与独立复核接口见[部件属性计划与复核](../workbench/guides/image-attribute-editing.md#5-接口与恢复)，完整功能见[图片局部调整](image-editing.md)。

## 10. Agent 共享操作、通用 HTTP 与安全

- **`agentRequest` 操作分组**：覆盖发现/结果、展示/交付、共享文档、图片局部编辑、部件计划与复核以及资产目录（`assets` / `asset` / `asset-manifest`，涵盖 `character`、`prop`、`animation`、`interactable` 四类）。完整 MCP 工具名与结果分页协议见[工具索引](agent-client-tools.md#工具索引)和[结果与展示数据](agent-client-tools.md#结果与展示数据)。
- **兼容通用 HTTP Connector**：运行时保留 manifest `http` 兼容路径（从 `urlEnv` 读地址、以可选 Bearer token 发 `{taskId, capabilityId, input}`，缺地址入 `awaiting_configuration`）；新能力优先实现本地适配器。
- **安全约束**：凭据仅从服务端环境或受保护配置读取，严禁写入入参、日志或浏览器存储；本地输入输出路径须解析至受控目录；远程部署 Bridge 须独立加认证、TLS、限流与审计；导入数据与上游错误一律视为不可信数据。
