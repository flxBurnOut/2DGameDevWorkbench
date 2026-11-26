# 局部编辑 P0 诊断评测

本工具用于冻结现行静态图局部编辑主流程（“A 流程”），按固定样本批采集客观诊断数据（“P0 批次”），不改动产品编辑语义。每批默认 24 例、分 6 类各 4 例（几何类含 2 例部件替换与 2 例轮廓变化）。

## 准备与执行命令

输入 JSON 结构参考[隔离回归](../../tests/image-edit/evaluation.mjs)，真实素材、标注和账本存放在忽略的 `work/` 目录下。每条样本记录原图路径、素材家族、画风、摆放宽度、指令、保持要求、失败例、Alpha 策略与标注来源；其中 `annotation` 使用与选区契约一致的整数像素坐标（`allowed`、`target`、可选 `influence`、`protected`），按 `W = (U ∩ (T ∪ F)) ∖ P` 计算实际可写区。

```powershell
# 1. 冻结批次（保存 Git 提交、依赖哈希、配置、原图与精确蒙版；冻结后不可就地修改）
node scripts/image-edit-evaluation.mjs freeze work/example/batch.json work/example/frozen

# 2. 夹具离线模拟（替换网络，无真实调用）
node scripts/image-edit-evaluation.mjs mock work/example/fixture

# 3. 真实执行（需已有对应费用与素材外发授权；可指定子集，续跑自动跳过已完成项）
node scripts/image-edit-evaluation.mjs run work/example/frozen
node scripts/image-edit-evaluation.mjs run work/example/frozen color-01,geometry-01

# 4. 生成报告（index.html 与 summary.json）
node scripts/image-edit-evaluation.mjs report work/example/frozen
```

- **依赖锁定**：`freeze` 会递归记录仓库内依赖模块哈希，每次 `run` 都会校验当前代码与冻结哈希；改代码后须另建新批次。
- **执行隔离**：真实执行经 `imageEditRequest` 落入唯一隔离任务目录，不写回原工程；凭据仅在进程内读取，不落盘到评测目录或报告。
- **证据留存**：派发前先落盘稳定命令、预算预留和脱敏后的 multipart 输入字节与哈希；返回后保留原始响应、用量、最终 PNG 及选区内外/Alpha/新增纯黑像素统计。

## 预算与崩溃恢复

- 批次配置须声明 `execution`（`real` / `fixture`）、USD 总额、本地保守单次预留（覆盖所选尺寸档位）、最大调用数、`K=1`、零重试及核实单价。当前 A 流程省略 `quality`（沿用默认 `auto`）并记录实际返回档位；用量不完整时保留预留并停止。
- 执行器持有独占锁：已完成项只读跳过；若进程崩溃且已有提交意图无结果，先检查 `intent.json`、`receipt.json` 和原 task/edit ID，经任务与会话接口恢复，不要删意图或预留后重跑。仅在 `awaiting_configuration` 且确认无派发证据时留档解除预留。

## 历史回放（本地重合成）

```powershell
node scripts/image-edit-replay.mjs work/example/replays.json work/example/replay-output
```

清单项格式：`{ "id": "old-example", "directory": "outputs/原任务", "family": "素材家族", "preserveAlpha": true }`。脚本复制原图、蒙版、原始返回与历史结果，用当前合成器离线重新合成并输出像素差异，用于验证合成器行为变化（不调用模型）。

> 历史 P2C（RGB 与分层明暗参考对照）的研究记录保留在 [new-arch 分支](https://github.com/aaaarthur666-design/2DGameDevWorkbench/blob/new-arch/workbench/guides/local-edit-evaluation.md)；本论文分支不提供分层分析或分层换色。

## 复核与评测口径

`report` 生成含原图、选区、原始返回、最终图、摆放尺寸与局部放大的 HTML 对比页。逐案在 `review.json` 记录评审人、是否独立、结论与缺陷坐标（人工盲评另记双票、分歧裁决与实际耗时）；错误归类为：定位/标注、输入预处理、生成语义、生成结构/画风、合成/Alpha、复核误判、服务/证据缺失。

- **样本与来源隔离**：诊断集素材家族不进入后续留出测试集，重复素材不作独立样本；明确区分人工盲评与 Agent 非盲诊断，区分观察缺陷与原因假设。
- **费用与证据完整**：报告分别列出按用量估算的费用与服务商实际账单；未完成项、缺图与无效修改按冻结口径统计，不事后剔除；缺少提交/原始返回/最终图/验收任一项时归因记为未知。
- **结论边界**：P0 仅用于定位失败原因（纯黑计数、保护区零改动均为诊断指标，需结合视觉检查判定可用性）；正式画质结论留待后续留出集 A/B 盲评。

## 回归测试

运行 `npm run test:image-edit-evaluation`（覆盖蒙版极性、软透明度、预算耗尽、未知提交、重复执行、源图篡改与模拟 Bridge 采集），产品基线另跑 `npm run test:image-edit` 与 `npm run test:image-assets`。
