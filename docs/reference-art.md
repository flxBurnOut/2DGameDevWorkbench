# 角色原图生成

`reference-art` 使用 PixelLab Pixflux 生成 64×64 或 128×128 透明背景像素角色，或导入本地 PNG，移送后供序列帧工具使用。物品原图的生成、导入与转换见[物品原图](prop-art.md#导入与转换为动画原图)。

## 使用流程

1. 启动 `npm run dev`（首次安装执行 `npm run sprite-pipeline:setup`），进入 `/tools/reference-art`。
2. 在设置中保存 PixelLab Key（与序列帧共用受保护本机存储；环境变量 `PIXELLAB_API_KEY` 存在时优先并锁定界面修改）。
3. 输入角色描述、可选名称、朝向（`right`/`left`）与尺寸（64 或默认 128），点击 **生成一张原图**（提示词原样传给 PixelLab，不额外调提示词增强）。
4. **可选视角/朝向核对**：勾选生成上方的核对选项时，使用当前 `reviewer` 模型单次看图判定一致、不符或待核实；不符或待核实时，移送前需填写实际观察与理由。
5. 点击 **用于制作序列帧** 移送为角色预设，自动跳转序列帧页面并预选该角色（尚未创建动画任务）。重复移送同一原图复用原角色 ID，若内容变化则拒绝覆盖。

### 外观约束与提示词长度规则

- **角色外观约束**：移送前可填写 `identityDescription`（最多 300 字），仅描述需保持的配色、装备、比例与轮廓，不改写原提示词；草稿按源任务隔离。角色动画页直接上传原图时同名字段上限 1,000 字（`identity_description`）。
- **长提示词隔离**：超过 300 字符的原图生成提示词默认不原样拼入动画提示，改用参考图锁定外观，避免“站立不动”等原图词污染动作或触发动画 API 字数超限（完整原文保留在源任务中）。
- **本地导入角色 PNG**：资产详情点“用作角色参考”或原图页点“从资产库选用角色原图”，走 `operation: import` 保存本地记录（不调模型）；要求 ≤ 2,000,000 字节、64×64 或 128×128、有可见像素与透明背景的 PNG，导入后仍需手动移送。

## PixelLab 队列与恢复

协议遵循 [PixelLab v2 OpenAPI](https://api.pixellab.ai/v2/openapi.json)：

- 后台按凭据排队协调原图与动画作业，关页或重启后继续原请求。
- 获得空位先查 `GET /v2/balance`，可核实余额不足或上游明确拒单（无受理 ID 与用量）时标为 **未提交**（首页待处理与继续制作略过，历史仍可查）。
- 正常提交走 `POST /v2/create-image-pixflux-background` 并轮询 `/v2/background-jobs/{id}`；收到 `429` 且明确未接单则继续等空位；超时或回执不明留待核对，后续只查同一请求。
- 成功产出 `outputs/<task-id>/reference.png` 与 `result.json`（尺寸不符、全透明或无透明背景均判失败）。

## MCP / CLI 调用

```powershell
npm run workbench -- describe reference-art --json
npm run workbench -- run reference-art --input examples/requests/reference-art.json --json
npm run workbench -- status <task-id> --json
```

- `generate`：必填 `prompt`，可选 `name`、`facing`、`seed`、`size`、`checkOrientation`（结果写入 `orientationReview`）。
- `transfer`：传 `sourceTaskId`，可选 `identityDescription`（≤ 300 字）；需要人工核对的记录另附 `confirmation.note`（≥ 4 字）。用 `workbench_get_result` 读 `characterId`，用 `workbench_read_artifact` 看图。
- `import`：传 `sourceImagePath` 或 `sourceImage`（`data:image/png;base64,...`，原始字节 ≤ 2 MB），可选展示描述 `prompt`（标为 `description-added-on-import`、`providerCalled=false`）。物品导入（`subject=prop`）与转换（`convert-prop`）参数见[物品原图](prop-art.md#导入与转换为动画原图)。

## 模块与验证

- **主要代码**：`components/reference-art/`、`lib/workbench/adapters/reference-art.mjs`、`Tools/SpritePipeline/sprite_pipeline/reference_art.py`。
- **对象库存边界**：本页只创建与移送角色预设，物品原图入口在交互物编辑器与交互物动画面板，统一对象模型见[序列帧对象与预设](sprite-generator.md#对象与预设)。
- **回归测试**：`npm run test:reference-art`、`Tools/SpritePipeline/tests/test_reference_art.py` 与 `npm run test:pixel-prop`。
