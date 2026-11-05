# 连接器与任务契约

v4 增加 `target-motion-stage`（制作前本地绑定真实末图）、`repair-motion-stage`（已授权窗口修复）和 `review-motion-repair`（按预览 token 与人工依据采用/拒绝）。`get-motion-stage` 同时提供 `repairPreviews` 的完整有序图片。详情与索引约定见 [序列帧工作区](sprite-generator.md)。修复的源 token、请求编号、原始帧、失败回执和采用映射永久保留；未知提交不重发，生成预算为剩余正常分段预留调用，视觉预算包含历史复核与采用后的再次复核。

开放动作质量合同使用 `motionSpec.timing_mode=auto|fixed` 和 `budget.max_review_calls`。v3 每候选需 `2 × 分段数 + 2` 次视觉调用，覆盖分段与最终动画，不得超过授权预算。新方案与模型配置冻结在原生 job 绑定中；v1/v2 方案验证旧哈希并使用旧语义。真实 API 请求使用编译后的完整提示词，原始帧与交付时间线各自有来源映射。最终视觉报告在 `plan_execution.quality_review`，分段报告与接受快照在各 `stages[].review/accepted`，保留回执、帧摘要和人工依据。模型报告不能自动采用。

`get-motion-stage` 取指定候选与零基阶段的有序 PNG、目标和 token。`review-motion-stage` 绑定 `expectedRevision`、`stageToken`，携带 `stageDecision=accept|reject`、`reviewNote` 与必要的 `acknowledgeWarnings`；与 Web `POST /v1/open-motion/{work}/review-stage` 共用检查。接受冻结实际帧与末帧锚点，拒绝停止后续请求；重复接受不重新启用已暂停任务。只有已确认的真实快照可进入下一段。`pendingCheckpoints` 表示需要实际检查，不是生成失败。GET 不调用模型。

## 1. 范围

本文描述 MCP、CLI、Web HTTP bridge 与能力适配器共享的任务和文档语义。生产输入以 `workbench/manifest.json` 为机器权威；共享文档命令以 `lib/workbench/document-contract.mjs`、图片会话以 `lib/workbench/image-edit-contract.mjs` 及实际 MCP schema 为准。本文解释跨能力约束和协议转换，不复制完整 JSON Schema。

开放动作使用 `sprite-generator` 的 `plan-motion` / `revise-motion` / `get-motion` / `generate-motion` / `pause-motion` / `resume-motion`。`motionSpec` 含原始描述、角色、终态、播放设置和调用上限；嵌套字段在任务持久化前按 manifest 校验，不能夹带 Key 或未知控制字段。规划明确授权 `planningAuthorized`，异步轮询沿用原 taskId；结果含 `openWorkId`、`work` 及精确 `?work=` 链接。确认生成绑定 `expectedRevision` 和 `planSha256`，禁止执行旧方案。只有用户已授权直接制作时才设置 `autoExecute`。本机页面的 `/api/workbench/open-motion` 仅代理列明的工作区、帧图及已保存导出路径；不能作任意 HTTP 代理。

当前注册五项 `local-adapter`，其中 Agent 开放 image-assets、原图、序列帧和交互物四项。legacy map-stitcher 的底层契约供手动前端使用；共享场景编辑另走文档工具：

| 能力 | 适配器 | 是否依赖外部服务 |
| --- | --- | --- |
| `image-assets` | `image-assets` | GPT Image 2.6；独立背景、透明 prop 与参考图/蒙版编辑 |
| `reference-art` | `reference-art` | PixelLab，经 SpritePipeline 共享凭据 |
| `sprite-generator` | `sprite-pipeline` | 连接本地或自管 SpritePipeline；其生成提供方由该工具配置 |
| `map-stitcher` | `map-stitcher` | `compose` 本地；`generate-origin` / `generate-layer` 调用所选 Gemini、OpenAI 或混元 |
| `interactable-editor` | `interactable-editor` | 完全本地导出 |

`lib/workbench/runtime.mjs` 负责统一校验、任务记录、调度、状态和输出验证；适配器只负责能力协议转换。

## 2. 公共任务模型

准备或运行任务时，调用方提供：

```json
{
  "capabilityId": "reference-art",
  "input": {
    "operation": "generate",
    "prompt": "透明背景的侧视像素骑士"
  }
}
```

持久化任务位于 `work/tasks/<task-id>.json`，核心字段为：

```json
{
  "schemaVersion": 1,
  "id": "reference-art-...",
  "capabilityId": "reference-art",
  "status": "prepared",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "input": {},
  "outputs": []
}
```

执行后可以增加 `adapter`、`requiredEnvironment` 或 `error`。任务摘要统一返回：

```json
{
  "taskId": "reference-art-...",
  "status": "completed",
  "taskPath": "work/tasks/reference-art-....json",
  "outputs": ["outputs/reference-art-.../result.json"],
  "adapter": {}
}
```

字段只在有值时出现。调用方必须保留原始字符串，不自行推导文件名或把缺失输出补齐。

## 3. 状态机

```text
prepare ───────────────→ prepared
run ─→ running ────────→ completed
           ├───────────→ attention_required
           ├───────────→ failed
           └───────────→ awaiting_configuration
get/status: running ───→ 刷新同一上游任务后保持或进入终态
```

- `prepared`：输入通过 schema 校验，但没有调用适配器。
- `running`：能力已开始，可能包含上游 job ID。
- `awaiting_configuration`：缺少当前 operation 所需的环境或 provider key；不是成功。
- `attention_required`：原生作业需要检查、审核或恢复，不能当作导出完成。
- `completed`：本次操作完成，运行时已验证其输出文件；检查/保存完成与作品导出分别判断。
- `failed`：运行或适配器结果失败；任务记录保存错误。

刷新运行中任务发生短暂异常时，原任务保持 `running`，读取结果可以附带 `refreshError`。轮询不得重新提交计费请求。

Image 2.6 先持久化 running 任务和执行进程租约，再提交后台请求，前端不必等待模型响应才获得 taskId。查询只观察原执行与产物；执行进程退出或租约失效时转为 attention_required，提示结果可能未知，不自动重新提交。已保存输入、原始返回图和诊断文件用于检查；running 不代表已经收到图片。

## 4. 输出与路径约束

每次执行使用 `outputs/<task-id>/`。运行时：

1. 把适配器结构化结果写为 `result.json`；
2. 解析每个声明的生成文件；
3. 拒绝任务输出目录之外的路径；
4. 确认路径指向真实文件；
5. 去重后写入任务的 `outputs`。

源素材不得原地修改。任务路径均以仓库相对路径报告，UI 下载通过受限 artifact endpoint 完成。

## 5. Runtime HTTP bridge

默认地址为 `http://127.0.0.1:8790`，由 `npm run workbench:http` 启动。它是 Web 服务端到 Node 文件系统运行时的回环桥，不是面向公网的公共 API。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /health` | 返回服务名称与协议版本 |
| `GET /v1/tasks?limit=30&refresh=false` | 按更新时间列出任务；`refresh=true` 刷新运行中适配器任务 |
| `POST /v1/tasks` | 接收 `{capabilityId,input}` 并直接运行授权任务 |
| `GET /v1/artifacts?path=outputs/...` | 下载 `outputs/` 内的真实文件 |
| `GET /v1/map-stitcher/settings` | 返回不含 key 的 provider 就绪状态 |
| `POST /v1/map-stitcher/settings` | 持久保存本机地图 provider/key 与启用状态，响应仅含公开配置状态 |
| `GET/POST /v1/image-assets/settings` | Image 2.6 公开配置状态 / 专用受保护配置写入；共用 canonical provider 配置，不返回 key |
| `GET /v1/interactable-assets?path=...` | 预览允许的本地交互物素材 |
| `POST /v1/interactable-assets` | 上传交互物图像或音频到受控目录 |
| `GET/POST /v1/documents` | 分页列共享工程 / 创建场景或交互物文档 |
| `GET /v1/documents/<id>` | 读取当前或 `revision=N` 版本；`metadataOnly=true` / `metadata=true` 仅返回摘要 |
| `POST /v1/documents/<id>/apply|save|restore` | 类型化事务、人工完整快照保存、历史恢复；带 expectedRevision 与 commandId |
| `POST /v1/documents/<id>/validate|simulate|observe` | 保存版本的校验、事件模拟和场景视觉证据 |
| `POST /v1/documents/<id>/adopt-image` | 校验已完成图片任务的 ID / SHA-256 后明确采用 |
| `POST /v1/documents/<id>/export` | 导出明确 revision 的共享场景，建立独立资产导出记录 |

通用 JSON 请求上限为 50 MiB；任务提交为 120 MiB，以容纳最多 80 MiB 图片源及 base64 开销；文档请求为 350 MiB，文档媒体仍限制总计 256 MiB。交互物上传端点另按素材契约限制单文件 64 MiB；交互物项目导入由 Web 编辑器限制为 256 MiB。`/v1/artifacts` 只接受以 `outputs/` 开头、解析后仍位于真实输出根目录内的文件。

`app/api/workbench/**` 是 Web 同源代理：它转发到 `WORKBENCH_RUNTIME_URL`，不把密钥返回浏览器。当前 HTTP bridge 没有通用 `prepare` endpoint；需要只准备任务时使用 MCP 或 CLI。

## 6. SpritePipeline 适配器

### 操作映射

| Manifest operation | 上游行为 |
| --- | --- |
| `create` | `POST /v1/jobs`，只创建持久作业 |
| `create-and-generate` | 创建后调用 `/v1/jobs/{job_id}/generate` |
| `generate-existing` | 对给定 `jobId` 开始生成 |
| `get` | 查询给定 `jobId` |
| `export` | 导出给定作业与候选帧 |

Manifest 使用 camelCase；适配器转换为 Python API 的 snake_case。创建请求示例：

```json
{
  "schema_version": 1,
  "character_id": "player_cyber",
  "action_id": "idle",
  "provider": "pixellab",
  "candidate_count": 1,
  "frame_count": 8,
  "action_description": "保持轮廓一致的待机动作",
  "loop": true,
  "request_key": "sprite-generator-20260904000000-abcd"
}
```

本地任务 ID 用作默认幂等键，避免不明确重试创建第二个可能计费的作业。`wait` 默认 false；生成异步返回时，任务保存上游 job ID，后续 `get`/`status` 刷新同一 job。

标准化输出类型为 `jobRecord`、`orderedFrames`、`spriteSheet`、`godotPackage`、`preview` 和 `metadata`。需要交付的帧与导出文件被复制到当前任务输出目录，不暴露上游私有路径。

默认 API 是 `http://127.0.0.1:7860`。仅连接另一个可信部署时设置 `SPRITE_PIPELINE_API_URL`；受保护部署可使用 `SPRITE_PIPELINE_API_TOKEN`。详细使用见 [序列帧生成](sprite-generator.md)。

## 7. 地图适配器

以下 compose / generate-origin / generate-layer 均指 legacy map-stitcher 手动前端契约，不限制独立开放的 image-assets 背景与透明物品生成。

### 本地 `compose`

`images` 接受仓库内路径或 `data:image` URL，按行优先顺序排列。`columns`、可选 `rows` 和 `tileSize` 定义画布；适配器采用 nearest-neighbor 缩放，并可执行边缘检查、区域写入与引擎导出。

可能生成：

- `stitched-map.png`
- `seam-report.json`
- `region-annotations.json`
- `pixelwork-state.zip`
- 请求 Godot target 时的 `godot-package.zip`

Pixelwork v2 包可由地图编辑器恢复。新 Godot 包内嵌同一份可编辑 `source_state.zip`；旧包没有源状态时只能恢复其实际包含的图片和元数据。

### 外部 `generate-layer`

```json
{
  "operation": "generate-layer",
  "image": "data:image/png;base64,...",
  "prompt": "整体层生成提示词",
  "provider": "nano-banana",
  "tile": { "key": "1,0", "x": 1, "y": 0, "w": 1, "h": 1 },
  "layer": "overall",
  "mask_mode": "white"
}
```

- `nano-banana` 使用 Gemini Generate Content 协议与 `gemini-3.1-flash-image`。
- `gpt-image-2.6` 使用共享 OpenAI 图片协议与 `gpt-image-2.6`；独立素材生成见下文 image-assets。
- `gpt-image-2` 使用 OpenAI Images Edits 协议与 `gpt-image-2`。

返回图像统一解码并规范为 `generated-layer.png`。输入 PNG 的 alpha 通道定义可编辑区：只有 alpha 为 0 的像素可替换；服务端恢复模板中全部非透明 RGBA 像素，包括半透明边缘。明显不同的宽高比会被拒绝。`mask_mode` 只是旧客户端兼容字段，不按黑白颜色建立 provider mask。

key 只来自 runtime 进程内设置或 `GEMINI_API_KEY`/`OPENAI_API_KEY`/`TOKENHUB_API_KEY`。缺少 key 时原图与扩图进入 `awaiting_configuration`，本地 compose 仍可运行。详见 [地图拼接](map-stitcher.md)。

## 8. 交互物适配器

`interactable-editor` 接受：

- `operation: "save-project"` 或 `"export-godot"`；
- `project`：完整 `InteractableProject`；
- 可选 `selectedDefinitionIds`：只导出选中定义；
- 可选外层 `targetProfile` 选择 `generic` 或 `copyworms`。

字段默认值和详细约束以 `features/interactable-editor/contract.mjs` 为编辑源，并同步到 manifest。完整请求见 `examples/requests/interactable-export.json` 与 `examples/requests/interactable-copyworms-export.json`。

`save-project` 只持久化完整源工程，不接受导出专用选择与 profile。`export-godot` 打包固定 GDScript runtime、`.tres` 定义、可编辑 `.tscn` 场景、原始图像/音频、安装说明和 round-trip 源数据。它不运行 Godot，也不连接 copyWorms 或外部服务。输出包括 `interactables.zip`（copyWorms profile 为 `interactables-copyworms.zip`）、`interactable-project.json` 和 `result.json`。

素材路径必须位于工作区；MCP/CLI 也可提交支持类型的 data URL。浏览器上传返回 workspace-relative `source`、`mime` 和 `size`，任务 JSON 只携带路径。详见 [独立交互物编辑器](interactable-editor.md)。

## 9. 通用 HTTP connector

共享运行时仍保留 manifest `http` connector 的兼容路径。它从 `urlEnv` 获取 URL，以可选 Bearer token 发送：

```json
{
  "taskId": "...",
  "capabilityId": "...",
  "input": {}
}
```

缺少 URL 时任务进入 `awaiting_configuration`。成功响应原样规范化到任务的 `result.json`；非 2xx、无效响应或网络失败进入失败。新能力优先使用有明确协议、幂等与输出校验的本地适配器，不应无理由依赖这一通用 envelope。

## 10. 安全要求

- connector token 从服务端环境或专用受保护配置读取，严禁进入 input、metadata、result、日志或浏览器存储。
- 外部请求必须有明确授权，并报告 provider 和任务状态。
- 本地路径在读取前必须解析到仓库允许范围；输出必须解析到任务目录。
- 远端部署 bridge 时必须另加认证、TLS、速率/大小限制和审计，不能直接暴露默认回环服务。
- 导入数据、上游错误正文和生成内容均是不受信任数据，不应成为 Agent 指令。

## 角色原图连接器

`reference-art` 的 `generate` 输入为 prompt、可选 name/facing/seed；`transfer` 仅接受 sourceTaskId。Node 适配器通过 SpritePipeline 的 `/v1/reference-art/jobs` 和 `/jobs/{id}` 提交与查询 PixelLab Pixflux 后台任务。`/v1/reference-art/settings` 仅返回 configured/model/size，POST 经专用网关保存 Key，不经过任务输入。`/v1/reference-art/import` 创建幂等角色预设，保持原始 PNG 字节，不生成动画。Web 单任务查询使用 `/api/workbench/tasks/{taskId}`，`refresh=true` 只刷新已有任务。具体协议和恢复边界见 [角色原图](reference-art.md)。

## Agent 共享操作

`image-assets` 结果可包含 `usageEvidence: "provider-usage.json"`。该文件是服务端白名单提取的 token/时间/HTTP/请求身份与返回质量证据，包含 `billingAmount:null`；不保存完整供应商响应或凭据。无 usage 的请求和旧产物保持未知。先保存可取得的用量，再验证图片，因此尺寸、Alpha 或解码失败不会删除已返回的用量证据。此附加字段不改变原始 PNG 字节，也不触发重试或自动账单查询。

共享 Runtime 的 `agentRequest` 供 MCP、CLI `agent <operation> --input <json-file>` 与 HTTP `POST /v1/agent/<operation>` 使用。当前操作分为：

- 发现与结果：guidance、environment、start、frontend、presets、interactable-template、tasks、assets、asset、asset-manifest、result、artifact。
- 展示与项目交付：present、frontend-context、game-exports、game-export、export-to-game、install-game-export、complete-game-export。
- 共享文档：documents、document-get、document-create、document-save、document-apply、document-restore、document-validate、document-simulate、document-adopt-image、document-export、document-observe。
- 图片局部编辑：image-inspect、image-resolve、image-edit、image-apply、image-session-get；内部 image-session-create 复用同一会话服务，不是第六个 MCP 工具。

参数均通过 JSON 传递，未知字段和越界产物被拒绝。文档操作从 MCP / CLI 转发至长驻 Bridge，保持网页与 Agent 共用唯一写入端，不在各客户端进程直接写文档文件。artifact 在 HTTP/CLI 返回预览 base64；场景 observe 返回带路径的图像证据，MCP 转为原生 image 内容并从结构化图片元数据移除 base64。原始产物不被修改。具体工具名见 [Agent 客户端接入](agent-clients.md)。

### 共享文档事务

文档 id 对应 scene.id 或交互物 projectId。create/get/list 与 apply/save/restore 共用验证器；单个 apply 最多 100 条已声明命令，事务只作用于一个文档。写入要求 expectedRevision 与 commandId；版本冲突为 409 / REVISION_CONFLICT，相同命令重试返回原提交版本，currentRevision 另指出当前头版本。复用同一 commandId 提交不同请求会失败。快照内嵌媒体，历史版本不可变，restore 新增版本而不删除历史。

validate 检查模型、媒体与 scene.links 依赖；simulate 使用确定性交互模拟器，最多 200 个类型化输入事件，返回状态、联动诊断和 expectEvents/expectStates 检查；截断或联动错误令 passed=false。场景支持 set-links/add-link/update-link/remove-links 类型化命令，最多 256 条联动，拒绝启用的有向循环。observe 只支持保存场景，可选 region、maxWidth/maxHeight、time、mode、overlay，或 events 回放后渲染；events 与 time 互斥，时间推进使用 tick，回放不完整会失败。export 也只支持明确 revision 的场景。它们不读取浏览器未保存内容，不代表 Godot 引擎验证。字段与锁定规则见 [场景组装](scene-composer.md) 和 [交互物](interactable-editor.md)。

### Image 2.6 独立素材

image-assets 的外部操作为 generate-background、generate-prop、edit-image，使用gpt-image-2.6且prompt必填，最多12000字。edit-image带mask时，本地处理器仅在Alpha=0处采用候选，Alpha=1–255恢复源图RGBA8；尺寸改变在付费调用前拒绝。process-image为本地操作，image必填，preserveFrom/mask成对可选，不接受prompt/provider/references/width/height，不访问图片服务。alphaCleanupThreshold为0–16，prop默认1、background默认0；有蒙版只清理可编辑区。rawImage/rawSha256与image/sha256分别记录原始候选和交付图，processingEvidence保存处理及编码后保护区校验。local结果不包含虚构的model/usageEvidence。旧地图扩图契约不变。

默认尺寸由适配器规划；显式 width/height 必须成对提供、为 16 的倍数且满足机器 schema 的尺寸、像素数和比例限制。图片源每张最多 40 MiB、总计最多 80 MiB。任务保存规范 PNG、原始返回图片、输入副本与来源哈希，结果 requiresAdoption=true；完成不修改任何编辑器。document-adopt-image 仅在 sourceTaskId 和 sha256 重校验后，按预期文档版本采用图片。

### 已有图片会话（7A）

五个注册工具分别是 `workbench_inspect_image_target`、`workbench_resolve_image_region`、`workbench_edit_image_region`、`workbench_apply_image_candidate` 和 `workbench_get_image_edit`。前四个是主流程，第五个读取会话、候选与原任务身份。MCP/CLI 的全部 `image-*` 操作经 `POST /v1/agent/<operation>` 转发 canonical Bridge；刷新读取也可能保存候选状态，不能在另一个进程执行。Bridge 离线时明确失败，无直写 fallback；同一数据目录仅支持一个权威 Bridge。

精确目标来自既有图片任务、保存地图的 tileKey＋真实图片层，或共享交互物的 definitionId＋外观槽位；场景层须先验证源包映射；场景物件目标用明确的 instanceId 和槽位。resolve 不建立生成任务；显式命名区域需 commandId。edit 使用 expectedRevision、expectedSha256 和 regionRef；继续会话另需 expectedEditRevision 与明确的 baseCandidateVersion。候选完成不自动采用，apply 再检查目标版本、真实图片、尺寸和锁，并保留非目标源图与工程结构。局部编辑不开放 legacy 地图原图生产、拼接或扩展。

同 commandId 同载荷读取持久记录，不同载荷报冲突。执行前保存提交意图，在适配器执行前记录 taskId；响应丢失或重启后先读取原会话与任务。未知提交不会自动新建任务，也不能改 commandId 掩盖未知状态。源 PNG/JPEG/WebP 的文件字节与 sha256 保留；规范 sRGB/RGBA8 straight-alpha 字节另有 rgbaSha256，二者不能互换。手工 pixel-patch 另校验其基准 RGBA 哈希及 before 字节。内部选区 1 可改、0 保护；图片编辑 PNG 蒙版则 Alpha=0 可改，其余保护，二者不可混用。

高层本地操作包括清理、精确替色、填充、擦除、矩形移动、pixel-patch 和 restore-region，不调用模型。7B 的 apply candidateVersion=source 以当前 guard 和已知绑定恢复单图为新版本；宿主持久保存与准确采用版本协调保留其他内容。

7C 支持显式 `{type:"ai-edit",prompt,references?}`；`references` 最多 8 项，区域可用 `mask-runs` 的有序不重叠 `{startPixel,length}` spans，最多 65,536 段。基准、区域、描述和参考字节冻结后走 `image-assets/edit-image`，原 taskId / commandId 用于断连重试，不自动重复模型。AI 要求合法原尺寸；constraints.preserveAlpha=true 会在本地将所选编辑基准的全部 Alpha 复制到输出、跳过低 Alpha 清理，并验证最终 PNG 的 Alpha 哈希。未提供时默认 false。image-assets/edit-image 同时接受 preserveAlpha 布尔字段；其他操作不接受该字段。processingEvidence.alphaPreservation 返回基准哈希、预期/实际 Alpha 哈希及 changedAlphaPixels；本步保护区 RGBA 仍独立校验。透明度保持不等于纹理或语义正确。`workbench_present({editId,candidateVersion})` 或任务 presentation 使用准确会话 / 候选深链，不把不可写历史当成新来源。7C 初始实现的模拟验证与后续实际素材验收分别记录；7D 已接指定状态槽及场景引用：选中实例使用独立派生素材，其他共享实例保留；地图快照仅在验证单源像素映射后开放，图层 PNG 与嵌入源 ZIP 同一事务保存。不能确认映射的派生或合成层只读，使用源地图入口继续。独立 image-assets/edit-image 不能当作本地失败后的自动付费替代。详情见[图片局部编辑](image-editing.md)；mock 和像素保护证据不等于真实模型品质或引擎通过。

### 只读作品结果与展示

`POST /v1/agent/result` 使用 `{ taskId }` 或 `{ jobId, candidateIndex? }`，可加布尔 `detail`；两个身份不能同时传入。task 查询也可指定已存在的序列帧 `candidateIndex`。此操作读取已有记录，不创建执行任务、不刷新收费生成、不操作浏览器。

前端代理为 `GET /api/workbench/result?taskId=...`（也支持 jobId/candidateIndex/detail）。共享返回新增 `presentation`：作品标题、真实阶段摘要、精确编辑链接、预览、只导航的 actions、问题和技术详情。已有结果、产物验证字段保留；native job 不冒充工作台 task，不声称产物已转存或已验证。MCP 默认投影简明文本，`detail:true` 提供兼容旧客户端的完整文本 JSON。

## 资产目录（MCP 0.8.0）

新增 list_assets / get_asset / get_asset_manifest，分别对应共享 agent 操作 assets / asset / asset-manifest。详见 [资产目录、范围与验收](asset-catalog.md)。查询不产生任务；运行 `npm run test:assets` 验证分页、候选、去重、文件校验和 MCP/HTTP 一致性。

资产 kind 包含 character、animation、map、interactable、scene。已完成场景导出返回 exportId、sceneId、sceneRevision，下载包含已有的源包与 Godot 包；共享可编辑工程与独立导出分别标识。共享保存、读取和资产查询不触发生图；浏览器独有草稿不自动收录。场景修改通过独立文档命令执行。

`tasks` 支持 query、capabilityId、status、limit（1–200）、offset（非负整数）、snapshot。搜索在全部未归档记录上执行，返回 totalTasks、totalNativeJobs、searchedTasks、nextOffset 和 snapshot；各来源独立分页，带回相同 snapshot 和 nextOffset 直到 null。Web `GET /v1/tasks` 使用本地记录分页，另支持 refresh，返回 tasks、total、nextOffset、snapshot。历史变化时拒绝旧快照，客户端从第一页重新查询。已归档记录仅从执行列表隐藏，资产与原始产物仍可读。

### 序列帧 Godot 交付

SpritePipeline `export` 沿用原有输入和审批契约，同时生成 Godot ZIP。结果 `godotPackage` 指向本次任务目录的 `sprite-frames.godot.zip`；原生服务以 `job.export.godot_package_path` 标记可用包。适配器只有收到该字段时才请求 `/v1/jobs/{job_id}/exports/godot`，保留旧服务/旧记录兼容。资产库只下载已有包，不为了下载触发新导出。具体导入方法见[序列帧功能](sprite-generator.md#godot-spriteframes-包导出)。

### 地图原图与混元协议

`generate-origin` 只接收 prompt、provider 与 aspectRatio（1:1 / 3:2 / 2:3），不接收已有地图，返回实际尺寸图片和 `requiresAdoption:true`；前端预览采用后才替换中心图。`hunyuan-image-3` 对应 `hy-image-v3`，经 TokenHub 生图接口返回临时图片 URL 后立即转存。扩图以透明模板保护原像素；不是专用像素级扩图承诺。完整配置与限制见 [地图手册](map-stitcher.md)。以上操作仅供手动地图前端使用。
