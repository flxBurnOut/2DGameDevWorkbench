# 场景专家协作

场景组装工具栏的「场景协作」从**已保存的共享场景**开始，可以复用已有地图和物件，也可以在授权额度内生成新物件、创建地图并连续扩图。空地图场景同样可用。专家先讨论，在独立候选中制作，再用实际渲染与交互模拟复核；原场景在明确采用前保持原版本。该能力也开放给 MCP、CLI 和 HTTP。

## 使用入口

1. 打开已有或空地图场景，确认共享保存成功，然后点击「场景协作」。入口会先完成当前草稿的保存。
2. 在「专家模型设置」填写服务、模型 ID 与 Key。模型必须支持图片输入与结构化 JSON 输出。六种角色默认共用一个模型，可分别覆盖；不会根据名字假定模型能力或价格。
3. 描述制作要求，选择保持地图、创建新地图或扩建现有地图。按需补充已保存的交互物工程、保护物件；保持地图的任务还可指定允许局部改图的已解锁地图层。当前场景的物件素材自动可用。仅在浏览器里的旧交互物草稿，需要先打开并同步为共享工程。
4. 需要新图像时，在「新素材与地图的图像服务」分别选择物件素材服务和地图图像服务，沿用素材／地图页面的配置；设置本任务总额度。默认规划 16 次、复核 9 次、AI 改图 0 次、新素材与地图生成 0 次、新增地图块 0 个、修订 2 轮。关闭自动执行时，专家先生成方案，用户点击「执行此方案」后才制作候选。
5. 查看方案、专家讨论、调用用量、执行进度、原场景与候选对比、局部证据和行为回放。明确缺陷在已授权范围与剩余额度内进入局部修订。
6. 点击「采用到原场景」。若独立复核有未解决的不确定或追加裁决推翻了原缺陷结论，需要实际查看证据并填写确认结论。技术检查失败不能人工放行。

“制作方案与执行进度”的每个步骤可展开只读详情，按保存的类型参数显示生成描述、地图方向与重叠、修改目标和外观槽、布局坐标、行为命令或图片区域；名称能对应当前场景或方案中的新素材时显示其名称。方案下方另列视觉检查范围及行为验收条件，行为条件可展开查看准确输入顺序、至少事件次数和预期最终状态。高级折叠区保留原始只读参数。历史记录缺少参数或格式未知时明确提示，不推断新参数或检查结果。查看详情不调用模型、不改变方案；修改仍通过“补充要求 / 请求局部修订”完成。

关闭窗口不会取消正在进行的后台任务。历史任务保存在当前场景的协作列表；需要停止后续步骤时点击「在安全步骤暂停」。已发送请求可能完成，恢复时继续使用原请求记录。页面网络响应丢失会保留原命令，点击「恢复原请求」核对结果。制作任务因生成结果待核对而停下时，可用「核对原制作请求」检查原任务；该操作不重新提交生成。

历史每次显示 20 条，可点击「加载更早任务」继续查看全部记录；「刷新列表」读取最新排序。翻页期间若有任务新增或位置变化，会提示刷新，保留已加载内容，不把旧记录当成删除。任务链接使用 `?document=<sceneId>&sceneWorkflow=<workId>`，直接打开准确任务，即使它不在历史第一页。

WorkBuddy 创建、执行、修订、继续或采用场景任务前沿用会话预览检查；尚未打开时返回 `preview_required`，不创建任务或提交模型。按返回的宿主动作连接后，使用相同参数继续。随后查询原任务会通过现有页面跟随通道展示该任务进度；暂停、关闭和未保存页面仍受保护。显式展示历史任务可用 `workbench_present({sceneWorkflowId})`。预览例外仍只用于用户明确拒绝／关闭或已核实的宿主不可用，且不参与生产命令的身份计算。

## 制作范围与地图策略

| 支持 | 边界 |
| --- | --- |
| 复用或派生已有场景素材、选定交互物工程 | 新定义和素材保存在候选，不修改来源交互物工程 |
| 生成新物件素材 | 使用已冻结的图像服务生成真实透明 PNG；新增素材从基础 inspect 行为开始，后续配置与摆放使用依赖步骤 |
| 摆放、缩放、翻转、锚点、排序、参与标记 | 保护和锁定节点不能改写；受保护物件的素材、联动及与原节点的遮挡关系也保留 |
| 已有交互物行为和类型化联动 | 使用现有 toggle、inspect、pickup、sequence 和有向无环接线；不生成任意脚本 |
| 创建中心地图、按相邻块连续扩图与自动拼接 | 需要明确地图策略、生成额度与图块额度；服务器构造参考上下文并保留旧像素，不自动生成碰撞 |
| 单实例或允许地图层的局部改图 | 复用现有图片会话、版本和区域保护机制；创建／扩图任务中允许实例改图，禁止同时局部改写场景地图层 |
| 原图、整体、区域和事件回放的真实渲染 | 观察确切保存版本，返回 PNG、哈希、坐标变换与模拟状态 |
| 局部修订与再次复核 | 修订是新 ID 的增量步骤，保留完成回执和既有素材，重新检查完整候选 |

创建任务时冻结 `spec.mapMode`：

| 策略 | 来源与执行边界 |
| --- | --- |
| `preserve`（默认） | 可从已有或空地图场景开始；地图几何、碰撞、尺寸、偏移保持不变。只有 `editableMapLayerIds` 明确允许、已解锁且来源映射可验证的地图层可以局部改图 |
| `create` | 来源场景必须没有地图。先生成中心图块，再可扩展本任务创建的地图；不能替换任务开始时已有的地图 |
| `extend` | 来源场景必须已有地图，并通过完整源包验证。按指定相邻图块向左、右、上或下新增图块，保留既有地图内容 |

创建和扩图均需要正数的 `generationCalls` 与 `mapTiles`。每次地图步骤生成一张图、消耗一个图块额度，中心原图也计入图块数。每次扩展新增一个场景图片层；场景最多八个地图图片层，合成画布最多 6400 万像素、单边 30000 像素，额度不能突破这些上限。需要局部修改地图层图片时，在完成地图采用后另建 `preserve` 任务。

扩图读取候选内嵌的完整 Forge 地图工程或 Pixelwork v2 源包，核对图片字节、尺寸、图块坐标、碰撞和场景图层映射。普通源包目前要求零羽化，并且区域只含碰撞；遮挡扣除、顶层派生或其他不能证明逐像素映射的来源会保持只读。已保存的工作流地图输出按完整图层绑定和哈希核验，可继续链式扩图。只有导出图片、缺失源包或来源不一致时，不能自动扩图。

源包中整体图片类型的全局锁会禁止新增或生成地图块。场景已有图片层的锁和显示／参与标记保留；扩大画布时，已有层只增加透明边缘，旧像素仍在原世界坐标。模型收到服务器构造的相邻上下文，本地合成保留参考区像素，并让新增层在整个旧画布范围保持透明，防止覆盖已有地图。原图块、原源图片字节和既有碰撞不改写，候选保存独立的完整源包与拼接回执；来源地图工程和原场景在采用前不变。

新地图不含自动碰撞配置；扩图也不会按生成像素推断平台或碰撞。需要的图片缺失且不在授权生成范围内时，应提出具体问题，不能编造图片路径或把规划占位信息当作完成素材。跨文档原子提交仍不在此流程内。

交互模拟能够检查事件、开关状态、可见性、交互启用和碰撞启停，但不验证玩家跳跃、真实物理、游戏存档或 Godot 运行。候选采用后可沿现有场景导出流程接入目标游戏，再做引擎验收。

## 协作与复核

规划角色为总协调者、美术与素材、布局与空间、交互与行为。协调者按需要咨询；专家可以围绕具体问题继续咨询其他专家、请求局部观察或观察选定来源物件，再返回原发问者。涉及相应领域的执行步骤必须取得该专家的提案。

专家返回 `propose / consult / observe / finalize / ask_user` 结构化数据，不能直接调用编辑工具。统一执行器解析 `scene / object / image / generate / map` 五种类型的参数，并复用既有命令契约。最终方案包含区分用户原文与专家建议的需求、无环制作依赖图和视觉条件；涉及行为或联动时必须提供非空事件／状态断言。修订不能删减已确认需求或放宽验收。

`generate` 创建新物件素材，`object` 派生并配置定义，`scene` 摆放／替换实例及接线；生成和派生步骤本身不摆放物件。引用新素材的步骤必须依赖其制作步骤，最终生成素材或其派生物必须出现在可见且参与导出的实例中。`map` 的 `create` 建立中心块 `0,0`，每个 `extend` 产生 `wf_<step.id>` 图块；继续沿该块扩展时，必须直接依赖产生它的步骤。规划时只投影身份与几何，生产和复核需要实际图片与完整来源证据。

独立视觉复核和行为复核使用各自上下文，首次复核不读取制作专家的自我评价，检查实际候选、渲染和模拟结果。视觉复核包括新素材、地图接缝、比例、遮挡与原内容保留情况。结论分为满足要求、明确缺陷、审美建议、证据不足。审美建议不自动触发重做；争议最多追加一次复核，原意见保留。每轮同方向专家咨询最多两次，本任务最多追加 12 次规划观察。

| `budget` 字段 | 默认值 | 累计范围 |
| --- | --- | --- |
| `planningCalls` | 16 | 专家规划与咨询调用 |
| `reviewCalls` | 9 | 独立复核及追加裁决调用 |
| `imageCalls` | 0 | 局部 `ai-edit`；本地像素操作不计入 |
| `generationCalls` | 0 | 新物件、地图中心图及每次扩图共用的生成总次数 |
| `mapTiles` | 0 | 地图制作意图总数，包含中心图和扩展块 |
| `revisions` | 2 | 增量修订轮数 |

这些额度覆盖任务整个生命周期，修订与恢复不会重置。已记录的生成意图、失败或结果未知的提交仍占原额度，专家不能增加预算；缺少所需服务密钥时，在提交和预留生成额度前停止。额度按次数统计，不是金额报价。

模型判断仍可能出错。JSON 合法或模拟通过不代表美术质量满足要求；实际复核证据与模型用量均可在页面查看。

## 模型配置与凭据

配置存入现有受保护的本机设置存储。读取设置只返回模型配置和 Key 是否可用，不返回 Key。优先使用服务环境中的 `OPENAI_API_KEY` / `TOKENHUB_API_KEY`，其次为场景专家专用 Key，再次为清单登记的现有图片服务 Key 别名。环境管理的 Key 不能从页面覆盖。普通任务记录、模型上下文和回执不包含凭据。

服务地址在 `manifest.agentAssets.sceneCollaboration.modelProviders` 登记。OpenAI 使用 Responses 的图片输入和严格 JSON Schema；TokenHub 使用 Chat Completions 的图片输入、JSON 模式和本地 schema 校验。必要时通过 `SCENE_EXPERT_OPENAI_URL` / `SCENE_EXPERT_TOKENHUB_URL` 配置服务端代理地址；仅允许 HTTPS 或本机回环地址，不接受 URL 凭据和查询参数。OpenAI 协议参见[结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)与[图片输入](https://developers.openai.com/api/docs/guides/images-vision)。

物件与地图生成复用清单登记的现有图像服务，分别由 `spec.generationProviders.prop` / `.map` 选择；省略时使用该制作线支持的当前默认服务。`scene-workflow-settings` 的 `production.prop` / `.map` 返回支持的提供方、模型和配置可用性。任务冻结这两条制作线的提供方、模型、协议和地址，专家步骤不接受文件路径、模型、提供方或凭据。只需配置本任务实际使用的制作线。图像服务 Key 沿用素材／地图设置，快照不存密钥，也不接受地址中内嵌的认证信息。

角色模型与图像服务快照随任务固定，后续模型／地址修改影响新任务；执行时从受保护配置读取密钥。调用意图先于网络请求保存。角色回执记录请求 ID、返回模型、Token 用量和输出哈希；图像回执保存原任务身份、生成图与原始响应的哈希、处理／拼接证据及可用的上游请求 ID 和用量。OpenAI、Gemini、Hunyuan 的用量只保留允许的数字字段；未提供的 ID 或计数明确标为不可用，账单金额不推算。提供方错误正文不作为用户可见诊断。

## Agent / API

先读取 `workbench_get_guidance({topic: "scene-collaboration"})`，并用共享文档工具确认来源。执行契约以 `lib/workbench/scene-workflow-contract.mjs` 与 MCP discovery 为准。

| MCP | CLI / Bridge 操作 | 用途 |
| --- | --- | --- |
| `workbench_get_scene_workflow_settings` | `scene-workflow-settings` | 只读专家模型与两条图像制作线的模型／可用性；网页负责配置 |
| `workbench_list_scene_workflows` | `scene-workflow-list` | 按 documentId 过滤，沿 nextOffset + snapshot 分页读取全部历史 |
| `workbench_create_scene_workflow` | `scene-workflow-create` | 固定来源、保护范围、模型和预算，启动规划 |
| `workbench_get_scene_workflow` | `scene-workflow-get` | 只读状态、讨论、方案、回执与检查 |
| `workbench_execute_scene_workflow` | `scene-workflow-execute` | 执行确切 planHash 对应的方案 |
| `workbench_revise_scene_workflow` | `scene-workflow-revise` | 在原预算内补充说明并规划增量修订 |
| `workbench_pause_scene_workflow` | `scene-workflow-pause` | 在安全步骤之间暂停 |
| `workbench_resume_scene_workflow` | `scene-workflow-resume` | 显式继续安全步骤，或核对待完成的原制作请求；不重发生成 |
| `workbench_observe_scene_workflow` | `scene-workflow-observe` | 读取指定 evidenceId 的已保存图片，MCP 附图片块 |
| `workbench_adopt_scene_workflow` | `scene-workflow-adopt` | 核对原场景版本后采用确切候选 |

CLI 使用 `node scripts/workbench.mjs agent <operation> --input request.json --json`。Bridge 使用 `POST /v1/agent/<operation>`；网页代理为 `POST /api/workbench/scene-workflow/<简名>`。修改任务时使用 `workId`、任务自身的 `expectedRevision` 和稳定 `commandId`；这里的任务版本与场景文档版本是两个不同计数器。创建时 `spec.expectedRevision` 则是来源场景版本。暂停是安全边界信号，不要求任务版本；GET、list、observe 和 settings 读取不提交模型请求。

历史输入支持 `limit`（默认 20、最多 50）、`offset`（默认 0）与 `snapshot`。响应包含 `total`、`nextOffset` 和排序快照；继续查询时携带原快照，直到 `nextOffset=null`。顺序变化返回 `SCENE_HISTORY_CHANGED`，从第一页重读，不自动制作或删除任务。

创建请求示例（ID 与 revision 替换为实际共享工程）：

```json
{
  "commandId": "factory-scene-001",
  "spec": {
    "documentId": "factory-scene",
    "expectedRevision": 3,
    "description": "使用已有拉杆控制铁门，打开时隐藏门并关闭碰撞，保留平台。",
    "sourceDocumentIds": ["lever-project", "gate-project"],
    "protectedInstanceIds": ["platform"],
    "editableMapLayerIds": [],
    "mapMode": "preserve",
    "budget": { "planningCalls": 16, "reviewCalls": 9, "imageCalls": 0, "generationCalls": 0, "mapTiles": 0, "revisions": 2 },
    "autoExecute": true
  }
}
```

从已保存的空地图场景创建中心图、向右连续扩展两块，并生成一个新物件时，可使用以下范围与额度。提供方 ID 应先从实际 settings 结果中确认：

```json
{
  "commandId": "factory-new-001",
  "spec": {
    "documentId": "empty-factory-scene",
    "expectedRevision": 1,
    "description": "创建侧视工厂地图，连续向右扩展两块，生成一盏旧灯并摆放。",
    "mapMode": "create",
    "generationProviders": { "prop": "gpt-image-2.6", "map": "gpt-image-2.6" },
    "budget": { "planningCalls": 16, "reviewCalls": 9, "imageCalls": 0, "generationCalls": 4, "mapTiles": 3, "revisions": 2 },
    "autoExecute": true
  }
}
```

对应专家方案的制作步骤片段如下；完整方案仍需需求与视觉条件，涉及行为时还需断言。`input` 始终为符合类型契约的 JSON 字符串：

```json
[
  { "id": "origin", "title": "创建中心图", "kind": "map", "dependsOn": [], "input": "{\"operation\":\"create\",\"name\":\"工厂\",\"prompt\":\"侧视工厂内部\",\"aspectRatio\":\"3:2\"}" },
  { "id": "east-1", "title": "向右扩展", "kind": "map", "dependsOn": ["origin"], "input": "{\"operation\":\"extend\",\"name\":\"右侧走廊\",\"prompt\":\"延续工厂走廊\",\"neighborTileKey\":\"0,0\",\"direction\":\"right\",\"overlapPercent\":20}" },
  { "id": "east-2", "title": "继续向右扩展", "kind": "map", "dependsOn": ["east-1"], "input": "{\"operation\":\"extend\",\"name\":\"走廊尽头\",\"prompt\":\"延续走廊到仓库\",\"neighborTileKey\":\"wf_east-1\",\"direction\":\"right\",\"overlapPercent\":20}" },
  { "id": "lamp-art", "title": "生成旧灯", "kind": "generate", "dependsOn": [], "input": "{\"purpose\":\"object\",\"materialId\":\"lamp-material\",\"definitionId\":\"lamp-definition\",\"name\":\"旧灯\",\"prompt\":\"侧视工厂旧灯，孤立主体，透明背景\",\"visualWidth\":48,\"visualHeight\":72}" },
  { "id": "place-lamp", "title": "摆放旧灯", "kind": "scene", "dependsOn": ["lamp-art", "east-2"], "input": "{\"commands\":[{\"type\":\"add-instance\",\"materialId\":\"lamp-material\",\"instanceId\":\"lamp\",\"x\":400,\"y\":600}]}" }
]
```

上述三张地图图像加一张物件图像共占四次 `generationCalls`，地图占三个 `mapTiles`；`east-2` 使用 `east-1` 产生的 `wf_east-1`，无需猜测图块坐标或生成路径。对已有地图扩图时使用 `mapMode: "extend"`，初始邻居从任务的 `mapSource.tiles` 读取。

采用必须提交页面或 get 返回的确切 `candidateRevision` / `candidateHash`。复核中的 `requiresHuman` 需要实际核验后的 `acknowledgedCriteria` 和 `reviewNote`，Agent 不能把自己的追加裁决冒充用户确认。

## 持久化与恢复

`workspace.sceneWorkflowDirectory` 默认为 `work/scene-workflows/`。每个任务保存不可变来源、方案、生成请求与证据元数据，以及原子更新的任务记录；候选文档与图片会话位于该任务的私有目录，媒体与图片任务继续使用现有输出、来源校验和任务账本。`generationCalls` 保存终身生成记录，生成素材携带原 `sourceTaskId` / `sha256`；地图还保存完整候选源包、图块身份、拼接前后哈希和像素保护证据。最终采用只提交原场景一个新版本，源地图工程和交互物工程不变。

Bridge 是唯一调度与写入端。MCP / CLI 离线时失败，不另起写入权威；启动后读取历史不会自动恢复模型调用。安全中断可显式继续。已完成模型响应会复用；图片执行沿用原 editId / candidateVersion / taskId，生成执行沿用已保存意图与原 taskId。生成任务身份在付费提交前落盘；已分配任务但步骤回执丢失时，通过原任务关联记录恢复。

`recoverableProduction` 表示执行阶段仍有原制作请求需要核对；页面的「核对原制作请求」调用 `scene-workflow-resume`，仅观察该原任务并在取得可验证完成结果后继续。缺少原任务身份或上游结果仍未知时继续停止，不自动重发，也不能通过修订绕过未决提交。已明确失败的请求保留额度记录；用户补充要求后，可在剩余额度内规划新 ID 的增量步骤。原生地图请求进行期间，暂停在请求完成后的安全边界生效。

原场景在制作期间变化时，采用返回 `REVISION_CONFLICT`；保留候选，读取最新场景后建立新任务，不覆盖新版本。采用先保存意图，再以原版本与稳定命令提交；若提交成功但回执丢失，原请求可恢复同一个结果。前端同步同一采用版本后才解开编辑，避免旧草稿自动保存覆盖新内容。技术复核与采用重新核对不可变生成意图、原任务、提供方、源包及全部登记产物哈希；方案、图片、来源证据或候选变化时，旧复核不能放行。

## 开发验证

`npm run test:scene-workflow` 覆盖动态咨询、补充观察、真实候选文档／局部像素编辑／行为回放、新物件生成、中心地图与连续扩图、完整源包与旧像素保护、依赖关系、终身预算、用量证据、防止重发、独立复核、裁决确认、暂停与原请求恢复、产物篡改、版本冲突和三个 Agent 传输入口。图像适配器变化再运行 `npm run test:adapters` / `npm run test:image-assets`。模型和图像传输使用本地替身，测试目录通过 `WORKBENCH_TEST_RUN` 隔离，不触发真实付费生成。真实模型的审美与接缝质量、目标游戏物理需要单独授权的实际验证，不由这些测试推定。
