# 交互物品原图生成

> 默认场景物件能力：`image-assets` / `generate-prop`；支持 `edit-image`。旧 `reference-art` / `generate` / `subject=prop` 继续兼容。地图拼接仍由用户在前端完成。

## 前端流程

进入“场景 → 制作交互物”，选择要编辑的物件，展开右侧“生成透明物件”。输入单个物品的描述，例如“深蓝金属外壳的复古工业电池，黄色指示灯，清晰轮廓”。默认使用 GPT Image 2.6，实际模型 ID 为 `gpt-image-2.6-sunburst`，输出透明 PNG；默认 1024×1024，可选择其他支持的尺寸，不强制缩成 128×128。可上传最多 8 张 PNG、JPEG 或 WebP 参考图。

“输出尺寸”保留方形、横向和竖向预设，也可选择“自定义宽高”。宽高必须为 16 的倍数，总像素为 655,360–8,294,400，最长边不超过 3840，宽高比在 1:3–3:1 内；不合法时显示原因并禁止提交。地图背景使用同一面板和尺寸规则。重新打开制作记录会回填该任务的尺寸；本地处理等未记录请求尺寸的任务读取已保存结果，无法读取时明确提示并恢复默认尺寸，不继承上一条记录。

GPT 图片设置与地图图片生成共用受保护的本机 Key，也可使用 `OPENAI_API_KEY`。旧 GPT Image 2 配置的 Key 可复用；已有 Key 不回显。文本请求使用 Images generations，有源图或参考图时使用 Images edits；原有自定义服务地址继续生效。此流程只需要网页和 Runtime Bridge，不要求启动 PixelLab / SpritePipeline。

每次生成是新的付费请求。提交后先保存并返回 `running` 任务，查询只跟踪原任务，不重复提交。等待期间可以离开页面，从制作记录、资产库的“物品原图”或面板中的最近记录恢复。超时、连接中断、服务商 5xx 或执行进程退出可能留下未知的上游结果，此时标为 `attention_required`；先检查任务产物及服务商记录，再决定是否另行生成。刷新或重启不会恢复一次新的付费提交。图片不会自动覆盖物件。

关闭面板或离开网页不会取消服务端生成；停止执行进程也不能保证撤销已经发出的上游请求。当前提供原任务状态查询，不提供跨进程重启后的自动续发。

孤儿任务经 `refresh` 检查会报告派生的 `attention_required`，不覆盖持久记录，以保留可能稍后到达的真实完成结果。底层记录可能仍为 `running`；未刷新读取不能证明仍有活跃执行进程。

完成前服务端完整解码 PNG，并检查实际像素尺寸、Alpha、真实透明像素和可见内容；纯色背景和全透明空图不能作为成功的透明物件。`provider-response.png` 保留服务商原始字节；`image.png` 是经过蒙版保护和可选透明噪点清理的可采用版本，两者哈希分别记录为 rawSha256 / sha256。`processing-report.json` 记录处理规则、清理像素数和保存后重新解码的保护区校验。`image-metadata.json` 保存模型、尺寸、提示词、来源及输入副本哈希；`generation-diagnostics.json` 保存阶段和失败信息，不保存 Key。生成完成仍为待采用状态。

预览确认后可下载 PNG，或点击“采用到「物件名称」”。采用时重新读取完成任务、校验图片与结果记录的 SHA-256，然后作为内嵌 PNG 加入项目。它保留项目 / 物件 ID、其他图片、动画帧和交互行为，替换默认图片并清空默认待机 / 聚焦动画选择。状态专用图片仍保持各自配置。若目标项目 / 物件已经删除或默认图在读取期间被更换，采用失败并保留现有内容。

采用后沿用本机草稿自动保存；如需跨机器交接，保存源文件或导出 Godot 包。素材的 `generation.sourceTaskId` 和 `generation.sha256` 会随源文件及源包保留。保存 / 导出发现已登记的生成图片内容变化会拒绝；有意修改图片时，应作为新素材导入，不能继续冒充原始生成结果。

## 用量与费用证据

新任务另保存 `provider-usage.json`，由结果的 `usageEvidence` 指向。它仅记录请求时间、耗时、HTTP 状态、请求 ID、白名单数字 token 用量及服务端返回的质量档位，不复制完整响应或凭据。请求默认 `quality=auto`；服务端可能选择不同档位，应逐张比较。HTTP 失败或网络中断时也保留能取得的证据；缺失用量为 null，不能按零费用处理。图片验证失败但已返回 usage 时仍保留用量。历史任务没有该文件，不能据此补造其费用。token × 已核实费率是估算，实际账单单独记录。

## MCP 使用

先发现 `image-assets` 的当前 schema。透明物件请求示例：

```json
{
  "capabilityId": "image-assets",
  "input": {
    "operation": "generate-prop",
    "provider": "gpt-image-2.6",
    "name": "备用电池",
    "prompt": "blue metal battery, yellow indicator light, clear silhouette",
    "width": 1024,
    "height": 1024
  }
}
```

`prompt` 最多12000字符。`edit-image` 需要 `image`，用 `kind="prop"` 校验透明物件；可带 `references` 和 `mask`。图片源只接受仓库内普通图片或 base64 data URL。带蒙版时，结果、源图和蒙版必须完全同尺寸；输出尺寸改变会在调用模型前拒绝。仅蒙版 Alpha=0 可编辑，Alpha=1–255（包括半透明边缘）从源图复制，保存后按解码 sRGB/RGBA8 校验四通道逐字节一致，包含透明像素下的 RGB。蒙版内的形状、大小与接缝仍需看图。旧地图扩图保持自身契约。

### 不调用模型的本地处理

`process-image` 使用已有候选，不需要 Key、不调用图片 API。`image` 是待处理图片；可成对传入 `preserveFrom`（保护源图）和 `mask`，用与新编辑任务相同的处理器修复旧候选。不得传 prompt、provider、references、width 或 height；保留原尺寸，最长边3840、最多8294400像素。

```json
{
  "operation": "process-image",
  "kind": "prop",
  "image": "outputs/candidate/image.png",
  "preserveFrom": "outputs/original/image.png",
  "mask": "work/edit-mask.png",
  "alphaCleanupThreshold": 1
}
```

`alphaCleanupThreshold` 可为0–16，prop默认1、background默认0；0关闭清理。只把0<Alpha≤阈值的像素RGBA归零，Alpha高于阈值及已完全透明像素不变。有蒙版时清理仅限可编辑区，源图保护区已有的噪点也必须保留。若要整图清理，先创建独立清理版本，再以该版本作为后续编辑的保护源图，不能把这一步说成原图像素完全未变。

物品预览提供“清理透明噪点（本地，无需额度）”，生成独立待采用版本，不覆盖原图或当前物件。无蒙版时该按钮清理整张图的Alpha=1像素。局部合成通过Agent/CLI提供明确源图与蒙版。结果 `provider=local`，不伪造模型或用量；rawImage 指向候选原始副本，processingEvidence 指向处理证据。采用新任务的 sha256，不能沿用原始候选哈希。

get_task 查询同一任务，get_result 直达 `/tools/interactable-editor?imageTask=<task-id>`；该链接只打开预览。result 的 `requiresAdoption=true`，采用时重新检查任务、PNG 尺寸和 SHA-256，并保留原项目 / 物件身份及状态专用图片。资产 ID 为 `image:<task-id>`，分类为 `kind=prop`；生成、编辑、采用、保存和导出是不同步骤。

## 旧 PixelLab 流程

旧记录和 `reference-art` 能力继续使用 PixelLab Pixflux，固定 128×128 透明侧视物品，并与角色原图、序列帧共用 SpritePipeline 的受保护 Key。它要求服务已运行或已配置；PixelLab Key 与 GPT 图片 Key 分别保存。调用示例：

```json
{
  "capabilityId": "reference-art",
  "input": {
    "operation": "generate",
    "subject": "prop",
    "name": "备用电池",
    "prompt": "blue metal battery, yellow indicator light, clear silhouette"
  }
}
```

原始物品提示词最多 1800 字符。服务端附加固定的独立非人物品、侧视、完整轮廓、透明背景、无场景和文字约束；不调用第二个模型、不自动翻译。实际请求描述记录在任务的 `adapter.effectivePrompt` 中。

随后使用 get_task 查询原任务。完成后 get_result 的链接直达 `/tools/interactable-editor?artTask=<task-id>`；它打开该原图预览，不自动把图采用到任意已有物件。list_assets 的 `kind=prop` 用于查找物品原图，角色原图仍是 kind=character。下载 ZIP 包含真实 prop.png。

用户只要图片时，在图片交付处结束。需要完整交互物时，读取真实 PNG 和结果 metadata，将其绑定到原项目中正确物件的 visual.assetId；资产 source 使用实际工作区路径或内嵌 data URL，可附 generation 来源字段，再执行 interactable-editor 的 save-project / export-godot。沿用 projectId / definitionId，不新建同名物件代替原目标。默认图更新不应静默覆盖状态专用图片。

物品图不是角色预设，transfer 会拒绝。生成一张 PNG 也不表示已经配置拾取、开关、动画、碰撞或游戏逻辑。

## 兼容与输出

省略 subject 的旧角色请求继续按 character 执行，角色页记录不混入物品。仍复用已有 `/v1/reference-art/jobs` 网关及 protected settings，不增加服务、依赖或另一份 Key。

旧 PixelLab 成功输出为任务目录的 reference.png 与 result.json；result 增加 subject。物品保持独立任务身份，资产 ID 为 reference:<task-id>，其分类和编辑入口按 subject 区分。旧角色元数据没有 subject 也继续兼容。新 GPT 图片任务使用前文的 image.png 与独立 image: 身份，不改写旧记录。

## 验证

`npm run test:image-assets` 验证 GPT 图片生成、参考图与蒙版、原始字节、透明验证、来源哈希、跨进程查询和不确定提交；`npm run test:prop-art` 继续验证旧 PixelLab 的 MCP、恢复、分类、采用和导出。均使用模拟服务与隔离目录，不证明真实模型画面质量，也不产生真实生图费用。

旧 PixelLab 面板的人工验收：

1. 在已有 PixelLab Key 的环境中打开面板，确认自动显示已配置，未生成空任务。
2. 给一个明确物品提交一次生成，查看等待、成功预览和 PNG 下载。
3. 采用到指定物件，确认预览、ID、交互行为及其他物件保持正确。
4. 刷新后检查草稿和生成记录，再保存源文件并导入，检查图像和来源保留。
5. 返回角色原图页，确认物品不出现在角色历史；在资产库用物品原图分类找到并打开同一张图片。
6. 对已有动画 / 状态图的物件，检查默认动画停用与状态专用图片保留符合预期。

最后记录本次采用是否经过真实 PixelLab 验证；没有真实模型调用时，明确记为模拟链路验收。

### 本地验收记录（2026-09-09）

模拟网关下的 MCP 生成、恢复、物品分类、PNG 下载、角色移送隔离、来源哈希与采用保护、保存及 Godot 源包往返已通过。相同像素来自不同生成任务时仍保留独立来源身份。

独立 Edge 无头浏览器通过实际前端执行描述、生成、预览、采用、刷新恢复，确认每次操作仅提交一个模拟生成任务；深浅色与 430px 窄屏已检查，无未处理页面错误。截图与本机报告保存在忽略的 work/prop-art-ui/；它们使用测试图片，不代表真实 PixelLab 画面质量。原图、交互物、工作台、适配器、HTTP、MCP、资产、展示和 Agent 回归，以及 lint、typecheck、构建、两个 Skill 校验均已通过。

本次没有真实 PixelLab 调用，也未做新游戏的 Godot 引擎验收。已运行的 Runtime Bridge 需要重启以加载服务端修改；仅刷新网页不会更新已加载的 Node 适配器。
