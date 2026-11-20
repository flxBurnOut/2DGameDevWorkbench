# 局部编辑 P0 诊断

此入口冻结现有 A 流程、采集诊断证据，不修改产品编辑语义。每批 24 例、六类各 4 例，几何类为两个部件替换和两个轮廓变化。素材家族及派生图全部排除于后续正式测试。诊断集中的重复素材不能作为独立样本。

## 批次与执行

输入 JSON 的完整可运行结构可参考 [隔离回归](../../tests/image-edit/evaluation.mjs)。真实素材、人工标注、提示、图片与账本留在忽略的 `work/` 中。每案记录原图路径、素材家族、画风、摆放宽度、指令、保持要求、失败例、Alpha 策略和标注来源。

评测工具中的 `annotation` 包含 `allowed`、`target`、可选 `influence` 和 `protected` 区域，统一在原始整数像素坐标计算 `W = (U ∩ (T ∪ F)) ∖ P`。区域格式复用现有选区契约。这些是评测标注，不是新增的生产计划 API。不能把 Agent 标注写成人工美术标注。

```powershell
# 准备新目录；冻结后不能就地改提示、源图、选区或执行代码
node scripts/image-edit-evaluation.mjs freeze work/example/batch.json work/example/frozen
# fixture 批次只能使用 mock；此入口替换网络，不产生真实调用
node scripts/image-edit-evaluation.mjs mock work/example/fixture
# 真实执行须已有对应素材外发、服务和费用授权
node scripts/image-edit-evaluation.mjs run work/example/frozen
# 也可先运行预登记的小批量；后续 run 跳过已完成的 case
node scripts/image-edit-evaluation.mjs run work/example/frozen color-01,geometry-01
node scripts/image-edit-evaluation.mjs report work/example/frozen
```

`freeze` 保存 Git 提交、执行代码与依赖文件哈希、服务公开配置、Node/Sharp/设备信息、每案原图、精确蒙版和选区叠图。实际执行经现有 `imageEditRequest` 和适配器进入唯一的隔离任务目录，不采用到原工程。配置凭据只在执行进程内读取，不复制到评测目录或报告。原图保持原始文件字节；RGBA 哈希另记。

新批次从评测入口递归冻结仓库内导入的模块，包括运行时、图片编辑存储和换色实现。每次执行或续跑都核对当前依赖与冻结哈希。旧批次仍可生成报告，缺少依赖记录的批次须另行冻结才能开始新的执行。

真实请求派发前保存稳定命令与预算预留，再保存实际 multipart 的允许字段、每张输入的完整字节及哈希。不记录 Authorization、Key 或任意响应头。原始返回、用量、最终编码 PNG、处理报告和任务身份均保留。原始与最终图分别解码计算选区内外变化、Alpha 变化和新增纯黑像素。纯黑计数是诊断线索，不能自动判定画质失败。

## 预算与恢复

批次必须声明 `execution`（`real` 或 `fixture`）、USD 总额、单次预留、最大调用数、`K=1`、零重试和已核实的单价。当前 A 保持 `quality` 字段省略，也就是现有 `auto` 语义；每次实际返回档位另记。直接 Images API 不按缓存价估算。用量字段不完整时，费用保持未知，保留原预留并停止。

单次预留是本地保守余量，不是图片 API 的服务端美元上限。设置时需要覆盖支持的尺寸/档位，记录依据；不得靠事后取消请求来保证费用。金额报告区分按返回用量计算的费用与服务商账单，不把缺失账单写成零。

执行器有独占锁；已完成记录只读跳过，已有意图没有结果时禁止重新提交。进程崩溃后先检查 `intent.json`、`receipt.json` 和其中的原 task/edit 身份，通过现有任务状态与会话读取恢复。不要删除意图或预算预留后重跑。`awaiting_configuration` 且无派发证据属于明确未提交；留存原记录并记录核对依据后才解除预留。修改执行工具后另建批次，记录差异，不能将旧提供方返回当成新代码生成的结果。

历史 P2C 曾比较 RGB 与分层明暗参考，协议和研究结论留在 [new-arch 记录](https://github.com/aaaarthur666-design/2DGameDevWorkbench/blob/new-arch/workbench/guides/local-edit-evaluation.md)。其独立执行脚本保留供历史证据处理；论文分支不提供分层分析或分层换色。历史材料与新批次分开，不因工具裁剪把旧提供方返回记作新实验。

## 历史回放

```powershell
node scripts/image-edit-replay.mjs work/example/replays.json work/example/replay-output
```

清单元素为 `{ "id": "old-example", "directory": "outputs/原任务", "family": "素材家族", "preserveAlpha": true }`。工具复制原图、蒙版、提供方原始返回、历史最终图、元数据和用量，再使用当前合成器重新合成。报告旧图与当前合成的像素差异，不调用提供方。它只能验证合成行为；历史提示、模型档位和输入版本不相同时，不能证明当前生成画质改善。缺少原始文件的旧报告仅作线索，不能补造证据。

## 复核和结论

`report` 生成 `index.html` 与 `summary.json`。页面含原图、选区、原始返回、最终图、摆放尺寸和局部放大。逐案保存 `review.json`，明确 reviewer、是否独立、结论和缺陷位置；人工盲评还需保留两张原票、分歧裁决及实际分钟数。Agent 的非盲诊断不代替独立人评。

主要错误分类为定位/标注、输入或预处理、生成语义、生成结构/画风、合成/Alpha、复核误判、服务/证据缺失。同一例可有多个观察，但不能重复计入成功率分母。区分“观察到的缺陷”和“原因假设”。实际提交、原始返回、最终图、独立验收四类证据缺一项时，原因标未知；保护区通过不等于可用。未完成的任务、缺图和无有效修改按冻结的评测口径处理，不能事后删除。

P0 不宣布画质提升；A/B 配对、正式留出素材、两位独立人评、修补时间和按素材整组统计在后续阶段完成。没有实际记录的美术工时、模型分析耗时或 GPU 推理量保持未测。

验证：`npm run test:image-edit-evaluation` 覆盖蒙版交集/极性、隐藏 RGB、软透明度、预算耗尽、未知提交、重复执行、源图篡改、真实 Bridge 的模拟请求采集；产品基线另跑 `test:image-edit` 与 `test:image-assets`。本机回环服务在受限沙箱中可能不可达，应记录执行环境，不能据此修改产品超时或关闭恢复保护。
