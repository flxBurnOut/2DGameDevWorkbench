# 交互物品原图生成与转换

> 默认物品生图能力：`image-assets`（`generate-prop` / `edit-image` / `process-image`）；128×128 物品动画参考支持 PixelLab 生成、本地 PNG 导入与 `PixelProp` 转换（`reference-art`）。

## 1. GPT Image 2.6 生图与采用

在交互物编辑器右侧 **外观 → 获取图片 → 生成透明物件** 中输入单件物品描述，默认用 `gpt-image-2.6-sunburst` 生成 1024×1024 透明 PNG，最多附 8 张参考图（PNG/JPEG/WebP）。本流程只需 Web 与 Bridge，无需启动 SpritePipeline。

- **尺寸规则**：支持方形/横向/竖向预设及自定义宽高（须为 16 的倍数、总像素 655,360–8,294,400、最长边 ≤ 3840、宽高比 1:3–3:1）。重开历史记录自动回填原尺寸。
- **凭据**：使用受保护本机 Key 或 `OPENAI_API_KEY`（兼容旧 GPT Image 2 Key，界面不回显）；纯文本走 Images generations，有源图或参考图走 Images edits。
- **异步执行与异常恢复**：提交后立刻持久化 `running` 任务；等待时可离开页面并在制作记录或资产库恢复，关闭页面不取消已发请求。若超时、进程退出或租约失效，刷新返回派生的 `attention_required`（保留底层记录以便承接迟到结果，不自动重发付费请求）。
- **校验与产物**：服务端解码校验尺寸、真实透明背景与可见内容（拒绝纯色底和空图），分别保存 `provider-response.png`（`rawSha256`）、`image.png`（`sha256`）、`processing-report.json`、`image-metadata.json` 与 `provider-usage.json`（记录时间、耗时、HTTP、白名单 token 用量与返回档位，缺失项为 `null`）。
- **采用规则**：点击“采用到物件”时重读完成任务并校验 SHA-256，保留工程/物件 ID、行为与状态专用图，替换默认图并清空默认待机/聚焦动画。`generation.sourceTaskId` 与 `generation.sha256` 随工程保留。

## 2. MCP 与本地无模型处理

### 生成与蒙版编辑

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

- `prompt` 上限 12,000 字；`edit-image` 需传 `image`（`kind="prop"`），可配 `references` 与同尺寸 `mask`（仅 `Alpha=0` 可编辑，`Alpha=1–255` 逐字节保留源图 RGBA8）。
- 产物资产 ID 为 `image:<task-id>`（`kind=prop`），`get_result` 链接指向 `/tools/interactable-editor?imageTask=<task-id>`，`requiresAdoption=true`。

### 本地处理（`process-image`）

无需 Key、不联网，可对已有候选执行透明噪点清理或成对 `preserveFrom` + `mask` 后合成（保留原尺寸，最长边 ≤ 3840）：

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

- `alphaCleanupThreshold` 取 `0–16`（prop 默认 1、background 默认 0），将 `0 < Alpha ≤ 阈值` 归零；有蒙版时仅清理可编辑区。
- 网页预览提供 **清理透明噪点（本地）** 按钮，产出独立 `provider=local` 变体（采用新任务 `sha256`，不覆盖原图）。

## 导入与转换为动画原图

交互物编辑器“获取图片”、交互物动画面板及 GPT 物品候选页均提供 **导入 PNG / 从物品图转换** 入口（支持历史 GPT 物品任务或上传图片，提供 1×/4× 与多背景实时预览）。

- **本地导入 128 px PNG（`reference-art` `import`）**：传 `subject=prop`、`prompt` 及 `sourceImagePath`/`sourceImage`，仅接受 ≤ 2 MB、128×128、有可见像素与透明背景的 PNG（记录颜色数与半透明诊断，不阻断导入）。
- **大图确定性转换（`reference-art` `convert-prop`）**：传 `prompt` 及 `sourceTaskId`（已完成的 `image-assets` prop 任务）、`sourceImagePath`、`sourceImage` 三选一，文件最长边 ≤ 4096、≤ 30 MB，固定输出 128 px（无透明底时需选抠色）。转换调用独立 `forge-pixel-prop` 包（经 SpritePipeline，需服务在线；独立 CLI 为 `npm run pixel-prop -- convert <源图> -o <输出>`），支持 `area`/`dominant`/`nearest`、颜色数 `0` 或 `2–64`、外部调色板或 `object:<ID>` 等配方参数，默认配方见 [PixelProp 说明](../Tools/PixelProp/README.zh-CN.md)。实时预览走 `POST /v1/reference-art/convert-prop/preview`（不建任务、不写文件）。

```json
{"operation":"convert-prop","sourceImagePath":"Tools/PixelProp/examples/battery.png","prompt":"侧视电池，完整电极与黄色指示灯","recipe":{"colors":24,"resample":"area","padding":4}}
```

- **确认与移送（`transfer`）**：导入产出 `reference.png`/`result.json`，转换另存 `compare.png`、`recipe.json`、`report.json`（均 `providerCalled=false`）。检查视角、初始状态、部件完整和透明背景后，调 `transfer` 并提交至少 4 字的 `confirmation: {note}`（未委托 Agent 确认时先用 `workbench_present` 展示对比图）。
- **重算核验与来源追踪**：移送时核对产物与哈希；转换来源会按原配方重算并以解码像素哈希 `pixelSha256` 比对（不受跨平台 PNG 压缩差异影响，算法版本 1 需在版本 2 下重转）。重复移送复用同一 `reference_<哈希前24位>` 对象。来源摘要保存在对象旁的 `provenance.json`（`pixellab` / `import` / `convert-prop`），规划新作品时冻结记录供界面展示与实验筛选。

## 旧 PixelLab 流程

`reference-art` 的 `generate`（`subject: "prop"`）保留 PixelLab Pixflux 128×128 侧视物品生成（共用 SpritePipeline 受保护 Key，提示词上限 1,800 字，服务端自动附加侧视/独立物品/透明底约束，记录在 `adapter.effectivePrompt`）：

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

- 产出 `reference.png` 与 `result.json`，资产 ID 为 `reference:<task-id>`（`kind=prop`），预览链接 `/tools/interactable-editor?artTask=<task-id>`。
- 已完成的 128×128 PixelLab 物品图可直接点击 **移送到交互物动画** 或调用 `reference-art transfer` 创建交互物预设，随后在 `/tools/interactable-motion?object=` 规划动画。

## 验证

运行 `npm run test:image-assets`、`npm run test:prop-art` 与 `npm run test:pixel-prop`（均使用模拟服务与隔离目录）。
