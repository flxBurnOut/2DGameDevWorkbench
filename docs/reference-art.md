# 角色原图生成

`reference-art` 是工作台独立能力。它使用 PixelLab Pixflux 生成 64×64 或 128×128 透明背景像素角色，供现有序列帧工作区直接使用。输入和输出以 `workbench/manifest.json` 为准。

物品原图复用本适配器的 `generate`，传入 `subject: prop`，从交互物编辑器制作与采用，不能执行角色 transfer。角色请求省略 subject 保持原行为。详见[物品原图](prop-art.md)。

## 使用流程

1. 用 `npm run dev` 启动完整工作台，在 `/player` 选择“制作角色原图”。此能力复用 SpritePipeline 服务；首次安装仍使用 `npm run sprite-pipeline:setup`，无需增加一套服务或 Python 依赖。
2. 在原图的 PixelLab 设置中保存 Key；如果已在序列帧设置中保存，无需再输入。两处使用同一个服务实例的受保护凭据，页面只显示配置状态。环境变量 `PIXELLAB_API_KEY` 可覆盖本地存储，启用覆盖时不能从界面修改。
3. 输入角色描述、可选名称和朝向，点击“生成一张原图”。可选原生 64×64 粗像素或 128×128 精细像素（默认），侧视、透明背景，提示词原样传给 PixelLab；不额外调用付费提示词增强。每次生成都是新的付费任务。
4. 等待完成，检查人物、武器、朝向及边缘。页面按整数倍显示，下载保持原始 PNG。
5. 点击“用于制作序列帧”。原图被创建为可复用角色预设，随后在序列帧生成页预选该角色、显示参考图、名称与外观提示词。选择动作后再主动生成动画。

重复移送同一原图会复用相同角色 ID，不重复创建角色；若相同 ID 的内容已发生变化则拒绝覆盖。移送验证源任务身份、登记产物、SHA-256、图片尺寸与 Alpha。它不缩放、不重画、不提交动画。

## 架构与密钥

- `components/reference-art/`：原图表单、预览、历史和移送按钮。
- `lib/workbench/adapters/reference-art.mjs`：共享 Runtime 适配器，管理任务交接和产物校验。
- `Tools/SpritePipeline/sprite_pipeline/reference_art.py`：小型服务端网关，共用已有 `SpritePipelineService` 的密钥及角色预设写入方法。
- 原图页面的 Key 只通过专用 settings 接口发送到本机服务；不写入任务、日志、浏览器存储或能力清单。保存尝试结束后清空页面输入。
- 默认网关只在本机回环地址运行。托管网页不能自行启动用户电脑的 Python 服务，远程使用需要独立受保护的 Runtime 和 SpritePipeline。

## PixelLab 协议与任务恢复

依据 [PixelLab 官方文档](https://api.pixellab.ai/v2/docs) 和 [OpenAPI](https://api.pixellab.ai/v2/openapi.json)：

- 提交：`POST /v2/create-image-pixflux-background`，传递 description、image_size、no_background、view、direction 和可选 seed。
- 接收 `background_job_id` 后记录到 runtime task 的 `adapter.referenceJobId`，状态为 `running`。
- 查询：`GET /v2/background-jobs/{id}`，完成图位于 `last_response.image.base64`。页面约每 6 秒查询，适配器限制两次查询至少间隔 5 秒。
- 查询不会再次提交生图。进程重启后可从任务记录继续查询；必须在上游任务过期前取回并保存产物。页面关闭期间没有额外常驻轮询器。
- POST 超时或响应丢失时不自动重试，明确报告结果无法确认；先检查 PixelLab 账户任务再决定是否重新生成。
- 无 Key 或服务不可用时停在 `awaiting_configuration`；它不代表已生成。配置完成后需要明确发起新的生成。

成功产物为 `outputs/<task-id>/reference.png` 与 `result.json`。用户原始提示词、名称、朝向及上游任务 ID 保存在 `work/tasks/<task-id>.json`。图像尺寸不符、完全透明、缺少透明背景或不可解码时不标记成功。

## Agent / CLI

先 list，再 describe，不把 API Key 放入 input：

```powershell
npm run workbench -- describe reference-art --json
npm run workbench -- prepare reference-art --input examples/requests/reference-art.json --json
npm run workbench -- run reference-art --input examples/requests/reference-art.json --json
npm run workbench -- status <task-id> --json
```

生成输入：`operation: generate`，必需 prompt，可选 name、facing（right/left）及 seed、size（64/128）。移送输入包含 `operation: transfer` 与 `sourceTaskId`，可选不超过 300 字符的 identityDescription 仅描述外观；名称、提示词和朝向来自已保存的源任务。移送任务产出 `result.json`，包含 characterId、sourceTaskId 和序列帧打开链接。MCP 通过通用工作台任务工具执行；使用 get_result 读取移送的 characterId，使用 read_artifact 查看原图，无需直接读取磁盘 JSON。

## 验证

`npm run test:reference-art` 覆盖准备、配置缺失、异步恢复、产物校验、移送和 HTTP；SpritePipeline 的 `tests/test_reference_art.py` 覆盖官方请求结构、一次提交、密钥共用与不回显、图片校验、幂等角色导入及真实 Gradio 角色选择回调。测试使用模拟服务或内存传输，不产生 PixelLab 费用。真实付费生成需要用户在界面或 Agent 中另行发起。

长于 300 字符的生图提示词默认不原样附入动画提示，改用参考图身份锁定，避免“站立不动”等原图要求污染动作或超过动画 API 上限。完整生图提示保留在源任务。物品原图仍固定 128×128。
