# 连接器与任务契约

## 1. 范围

本文描述 MCP、CLI、Web HTTP bridge 与能力适配器共享的任务语义。输入字段的机器权威是 `workbench/manifest.json`；本文解释跨能力约束和协议转换，不复制完整 JSON Schema。

当前四项能力均使用 `local-adapter`。Agent 仅开放原图、序列帧和交互物；地图的底层契约供手动前端使用：

| 能力 | 适配器 | 是否依赖外部服务 |
| --- | --- | --- |
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
| `GET /v1/interactable-assets?path=...` | 预览允许的本地交互物素材 |
| `POST /v1/interactable-assets` | 上传交互物图像或音频到受控目录 |

通用 JSON 请求上限为 50 MB。交互物上传端点另按素材契约限制单文件 64 MB；交互物项目导入由 Web 编辑器限制为 256 MB。`/v1/artifacts` 只接受以 `outputs/` 开头、解析后仍位于真实输出根目录内的文件。

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

## Agent 第一阶段扩展

共享 Runtime 的 `agentRequest` 供 MCP、CLI `agent <operation> --input <json-file>` 与 HTTP `POST /v1/agent/<operation>` 使用。当前 operation 为 guidance、environment、start、frontend、presets、interactable-template、tasks、assets、asset、asset-manifest、result、artifact。工具映射见 [Agent 客户端接入](agent-clients.md)。查询参数也通过 JSON 传递；未知字段和越界产物均被拒绝。artifact 在 HTTP/CLI 返回预览 base64，MCP 转换成原生 image 内容；原始产物不被修改。具体工具名和审核规则见 [Agent 客户端接入](agent-clients.md)。

### 只读作品结果与展示

`POST /v1/agent/result` 使用 `{ taskId }` 或 `{ jobId, candidateIndex? }`，可加布尔 `detail`；两个身份不能同时传入。task 查询也可指定已存在的序列帧 `candidateIndex`。此操作读取已有记录，不创建执行任务、不刷新收费生成、不操作浏览器。

前端代理为 `GET /api/workbench/result?taskId=...`（也支持 jobId/candidateIndex/detail）。共享返回新增 `presentation`：作品标题、真实阶段摘要、精确编辑链接、预览、只导航的 actions、问题和技术详情。已有结果、产物验证字段保留；native job 不冒充工作台 task，不声称产物已转存或已验证。MCP 默认投影简明文本，`detail:true` 提供兼容旧客户端的完整文本 JSON。

## 资产目录（MCP 0.8.0）

新增 list_assets / get_asset / get_asset_manifest，分别对应共享 agent 操作 assets / asset / asset-manifest。详见 [资产目录、范围与验收](asset-catalog.md)。查询不产生任务；运行 `npm run test:assets` 验证分页、候选、去重、文件校验和 MCP/HTTP 一致性。

资产 kind 包含 character、animation、map、interactable、scene。scene 只读取已经完成的网页导出，返回 exportId、sceneId、sceneRevision，不增加自动场景制作操作；下载包含已有的源包和 Godot 包。浏览器草稿不自动收录。

`tasks` 支持 query、capabilityId、status、limit（1–200）、offset（非负整数）、snapshot。搜索在全部未归档记录上执行，返回 totalTasks、totalNativeJobs、searchedTasks、nextOffset 和 snapshot；各来源独立分页，带回相同 snapshot 和 nextOffset 直到 null。Web `GET /v1/tasks` 使用本地记录分页，另支持 refresh，返回 tasks、total、nextOffset、snapshot。历史变化时拒绝旧快照，客户端从第一页重新查询。已归档记录仅从执行列表隐藏，资产与原始产物仍可读。

### 序列帧 Godot 交付

SpritePipeline `export` 沿用原有输入和审批契约，同时生成 Godot ZIP。结果 `godotPackage` 指向本次任务目录的 `sprite-frames.godot.zip`；原生服务以 `job.export.godot_package_path` 标记可用包。适配器只有收到该字段时才请求 `/v1/jobs/{job_id}/exports/godot`，保留旧服务/旧记录兼容。资产库只下载已有包，不为了下载触发新导出。具体导入方法见[序列帧功能](sprite-generator.md#godot-spriteframes-包导出)。

### 地图原图与混元协议

`generate-origin` 只接收 prompt、provider 与 aspectRatio（1:1 / 3:2 / 2:3），不接收已有地图，返回实际尺寸图片和 `requiresAdoption:true`；前端预览采用后才替换中心图。`hunyuan-image-3` 对应 `hy-image-v3`，经 TokenHub 生图接口返回临时图片 URL 后立即转存。扩图以透明模板保护原像素；不是专用像素级扩图承诺。完整配置与限制见 [地图手册](map-stitcher.md)。以上操作仅供手动地图前端使用。
