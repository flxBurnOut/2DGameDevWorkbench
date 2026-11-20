# 序列帧实验支撑

真实实验的对象、规模、费用上限和盲评人数尚未定。模拟调用与归档帧回放只证明流程连通，不能作为生成质量的实验结果。所有输出目录必须是新建的隔离目录。

命令从 `Tools/SpritePipeline` 目录用项目虚拟环境执行，下文以 `EXP` 代表 `.venv/bin/python -m sprite_pipeline.collaboration.experiment`（Windows 为 `.venv\Scripts\python.exe -m …`）。`ROOT` 是序列帧服务的数据根目录。

## 各组如何共用同一份方案

一次对比从同一个已规划作品版本冻结各段提示词、帧数、FPS、参考图、末帧条件和种子。各组使用生产流程的规则推出每段绘图种子。协议同时保存各组最终发送的提示词和动态输入来源，包括一次生成组的拼接提示，以及关键帧先行组发给姿势调用的前缀。

| 组别 | 在哪里运行 | 接续方式 |
| --- | --- | --- |
| 一次生成 `single` | 冻结协议回放 | 单次画完整动作；合计超过 16 帧拒绝 |
| 盲目接续 `blind` | 冻结协议回放 | 用上一段真实最后一帧接续，不调用复核 |
| 关键帧先行 `keyframe_first` | 冻结协议回放 | 先为每段执行一条 4 帧姿势提案并冻结其真实末帧，再以首末图填充。方案已绑定末帧目标的段直接用该目标 |
| 模型验证后接续 `model_only` | 真实流程中的作品副本 | 流程自带的复核给出结论，按固定规则自动裁决，没有人看画面 |
| 人工验证后接续 `human_verified` | 真实流程中的作品副本，或来源作品本身 | 模型复核加人工确认，即完整方法 |

前三组在流程外回放，后两组在原流程内执行复核、修复和检查点。盲目接续组与原流程每段绘图使用相同的提示词、帧数、种子和末帧条件。它们各自按组别规则选择续段的输入图。

### 第一步：冻结协议

```sh
EXP freeze ROOT WORK_ID /absolute/new-protocol
```

作品须已有可执行方案并指定了种子。已开始制作的作品取其候选的实际种子。目录内含 `protocol.json`、`reference.png` 和各段的末帧目标图，回放前逐个核验哈希。历史版本加 `--revision N`。

协议 v3 记录每组必需的最终绘图请求、请求与合计帧数上限、绘图和复核调用上限，以及规划时已知的绘图额度。预检以去除首尾空白后的最终提示词 1,000 字符上限及各项帧数、像素和调用上限为准。当各段使用策略 6 的 12 行结构化简报且简单拼接或添加 `Hold ending pose: ` 前缀超过 1,000 字符时，`single` 组确定性地去重共享标签（`Appearance / Camera / Facing / Relations` 等，`End`/`Boundary` 取末段）并只平移姿势路标起首的 `fN:` 帧号，`keyframe_first` 组确定性提取终态核心行（`Appearance / Action: Hold ending pose / Camera / Facing / Relations / End`，不重复写入 `End`），不调用额外模型、不静默截断；合并或提取后仍超限、或非结构化提示超限时，该组记为 `blocked_preflight` 并保存具体原因。v2 冻结协议回放时保留旧版拼接与前缀规则（`legacy_prompts=True`），不随 v3 规则改变历史请求文本。

### 第二步：回放三个对照组

```sh
EXP simulate blind /absolute/new-protocol /absolute/new-run
```

命令行只连接免费的模拟提供方，结果标记 `diagnostic_only`。真实实验获得费用授权后，可由脚本调用 `load_protocol`，把读出的完整 `protocol` 作为 `run_arm` 的关键字参数，并传入引用图、末帧条件和真实提供方。`run.json` 保存最终请求、首末图摘要、提供方请求编号及回执，按每次调用原样记录用量。中断或结果未知时保留原请求并停止。

生产检查点与 v3 对照组共用 `input_pose_v1`。当绘图恰好多回传一帧、首帧确认为输入姿势时，播放映射跳过该帧。额外帧若不能确认为输入姿势，该次调用按提供方结果异常记账。帧数判定前归档通过校验的全部原始 PNG 与用量，正常结果一并保存播放帧对应的原始编号。

v3 的 `run.json.cost` 按绘图尝试登记一次费用。已知未发出请求和本地预检拦截至零次。提供方结果未知的尝试计入分母，即使回复缺少作业编号也保留其中的用量。后续轮询省略用量时沿用此前最近一次可核实的记录。PixelLab 轮询若显式返回另一个作业编号，回执记录所查编号和返回编号，本次费用只沿用先前与所查编号绑定的用量。

关键帧先行组的姿势来自一条 4 帧动画调用的末帧，写论文时须如实报告，不能称为一次静态图生成。一次生成组把各段提示词拼成一条，这是该组做法本身的一部分。

手写协议仍可用于连通性检查：`EXP simulate blind protocol.json /absolute/new-run --reference /absolute/reference.png`，其中 `protocol.json` 含 `seed`、`fps`、`stages`（每段 `prompt` 与 `frames`）。这样的运行在 `run.json` 中标记为 `manual`，不能与真实流程的结果放在一起比较。

### 第三步：建立流程内的两组

```sh
EXP clone ROOT WORK_ID model_only paper-run-01-model
EXP clone ROOT WORK_ID human_verified paper-run-01-human
```

副本保存冻结的绘图请求和预检结果。启动时核对方案、原图、目标、提示词和种子。`human_verified` 副本在页面上照常制作和确认。`model_only` 副本用下面的命令自动裁决：

```sh
EXP model-only ROOT COPY_ID --authorize-paid-calls
```

这条命令会按作品配置的服务实际绘图和复核，会产生费用，必须显式授权。它只接受 `model_only` 副本，不会替用户裁决普通作品。每段的固定规则：

1. 复核完成且结论为通过，直接确认，继续下一段。首次复核失败、中断或仅产生诊断报告时，该段保留在检查点，运行记为技术中断。
2. 复核完成且结论为失败或不确定时，请求一次段内重画，范围是除首末帧外最大的偶数帧窗口，说明取自复核报告中未通过的条目。提交前按冻结条件核算全部必需片段、已请求的重画和本次窗口。重画结果采用后重新复核。
3. 实际完成第二次复核后仍未通过、片段少于 6 帧无法重画，或预算不允许重画，则判该段不合格并停止。
4. 重画失败、提交结果未知或第二次复核中断时，保留最后一次完成的复核、原请求编号和已归档的用量与帧。该次运行作为技术中断计入可用率分母。

裁决记录写入作业（确认人为 `experiment-model-only`），摘要另存到副本目录的 `experiment-run.json`。常规 API 与检查点入口禁止人工介入裁决、修复或修改 `model_only` 副本；历史记录若混入非 `experiment-model-only` 的人工裁决或修改，回顾导出会将其标记为 `protocol_violation`（`human_intervention_in_model_only`）并移入排除清单。副本继承来源作品的规划调用记录，跨组汇总费用时规划费用只算一次。

## 消融

| 消融 | 做法 | 是否需要新的生成 |
| --- | --- | --- |
| 去掉独立专家与探针 | 导出中每份复核报告的 `review_ablation.baseline_only`，即同一批画面上基础检查自己的结论 | 否 |
| 2×2：去掉末端确定性探针（保留矛盾开） | `review_ablation.without_probes`：仅撤回 `guard_measurements` 的末端探针降级，保留评审内部矛盾与修改对比（`comparison`）等独立门禁。`probe_overrides` 与 `probe_override_details` 记录探针拦截条数、维度与帧号 | 否 |
| 2×2：去掉保留矛盾规则（探针开） | `review_ablation.without_retention`：争议复核提议通过时按提议计（仍须满足 `grounded_audit` 最小不同帧门槛），同时保留末端确定性探针降级。`retained_contradictions` 仅计被保留的评审矛盾条数 | 否 |
| 2×2：同时去掉保留矛盾与探针 | `review_ablation.final_review_wins`：同时移除矛盾保留规则与末端探针降级，但仍执行 `grounded_audit` 最小帧数校验并保留 `comparison` 独立结论 | 否 |
| 只允许整段重画 | `EXP clone … --repair-policy redraw_only`。副本上确定性编辑、受限生成和局部段内重画一律拒绝，只允许覆盖当前段最大合法偶数可编辑窗口的重画（首尾都锁时为全部 $N-2$ 帧；仅锁首帧时允许头/尾对齐的 $N-2$ 帧；存在内部 `state_checkpoint` 时取其前序可播放区间的最大合法偶数窗，且均需 $\ge 4$ 帧） | 是 |
| 加 / 不加角色结构 | 规划作品时是否附带视觉结构，各建一个作品 | 是 |

前四项由已保存的复核报告离线重新计算（并输出逐维 `checks_by_condition`，可直接输入支持角色与交互物双口径的 `review_evaluation.score_reviews`），不调用模型。其中 `without_probes` 只要报告含 `checks` 即可计算；`baseline_only`、`without_retention` 与 `final_review_wins` 仅在采用专家协议且复核完整结束时非 `null`。注意离线重算衡量的是段级决策敏感性，且 `without_probes` 仅撤回末端降级（未重跑去除 `tracked_parts` 上下文提示的 VLM 条件）。

## 人工时间与回顾性导出

片段确认、完整候选确认及修改备选采用页面可填写实际人工检查秒数。API 接收 `human_seconds`，MCP 的片段与备选裁决使用 `humanSeconds`。未测量时留空，导出保持未知，不用页面打开时间代替。

先清点可用的历史作业：

```sh
EXP inventory /absolute/jobs
```

每个作业给出可用的导出方式（`full`、`legacy` 或 `unreadable`）、段数、已复核段数、人工裁决数和修复数，只读取 `job.json`。

```sh
EXP export /absolute/jobs/JOB /absolute/open-motion/WORK/work.json /absolute/new-export
EXP export-legacy /absolute/jobs/JOB /absolute/new-export
```

`export` 用于开放动作作业。历史版本使用对应的 `version-N.json`，必须与作业中的作品版本一致。导出逐段原始帧、已确认帧、视觉报告与历史、人工裁决、局部修复和修改备选，以及完整候选播放帧。`export-legacy` 用于开放动作之前的旧版攻击流程作业：这些作业没有分段、检查点和复核记录，只导出整段播放帧与事件，只能用于整段的失败类型标注。两种导出都逐个核验 PNG 哈希，不修改作业，不调用模型。

`retrospective.json` 中：

- `tool_usage` 按级别统计修正工具的使用次数，覆盖检查点流程中的段内修复和修改备选两处。级别为 `deterministic`、`restricted_generation`、`window_redraw`、`stage_redraw`。
- 分段混有坏帧时，`raw_count` 记录返回槽位总数，`invalid_raw_indices` 列出未通过校验的位置，`raw` 中的文件保留原编号与哈希。该段停止接续。旧作业按当时保存的原始帧清单导出。
- 回顾读取原始轮询回执时，会核对正常响应以及旧 HTTP 错误回执所嵌套的响应中的作业编号。出现冲突会终止本次导出，错误详情给出请求编号和响应编号，供对照原始记录。
- v3 模型组的 `drawing_frame_budget` 列出已请求帧数、待执行必需片段预留帧数与冻结上限。复查历史运行时，使用原作业和对应作品版本重新执行 `export` 到新目录，再从新导出构建盲评包。若两项帧数之和超限，或首审仅有技术失败却继续生成，导出的播放帧可供核查，盲评私钥将该运行纳入排除清单及可用率分母。历史回包中未归档的图像无法通过回顾导出恢复。
- `cost` 的调用次数与原生预算账本同口径，另加关联的独立修改调用。每个提交、轮询和归档回执归入同一次尝试。被拒绝的修补与备选保留已确认的用量和通过格式校验的原始帧，重启后可从已保存的原始结果继续。美元和额度分别汇总。缺少美元价格的调用计入 `unpriced_calls`，此时 `total_usd` 为 null。未知人工用时单独计数，`known_human_seconds` 是已记录小计。
- 派生作业包含来源作业继承的预算记录，跨多个版本统计时需按来源请求去重。

## 匿名播放包

```sh
EXP blind /absolute/new-blind-pack /absolute/run-A /absolute/export-B
```

输入可以是回放运行目录、回顾性导出目录，或无作业的 `model_only` 本地预检拦截目录（含 `experiment-run.json` 且 `job_id` 为空）；重复传入同一目录或同一片段来源会被拒绝。同一片段内所有帧必须尺寸一致。每个片段随机命名、打乱顺序，PNG 重新编码清除元数据；公开包只含匿名编号、帧数、FPS、画布宽高、是否循环标记、像素和离线播放页面，打开 `index.html` 即可同时查看 **1× 原尺寸与适配容器宽度的整数倍最近邻放大双视图**，支持棋盘格/浅灰/深灰背景切换、非循环动作默认播完即停（可切换循环开关）及播放/暂停与单帧步进。

编号对应表写到包目录旁的 `new-blind-pack-private-key.json`，由实验人员保存。每组每次比较应提供一份运行或单候选导出。以私密表中的 `runs` 为可用率分母，包含预检拦截、未提交、提供方失败或结果未知、审查叫停及无完整候选的条目。v3 私密表保存各类排除原因。仍在进行中的回放运行会被拒绝打包。正式付费实验前另须按 `PAPER-09` 对账预注册 `run_id` 清单并补齐任务需求与参考图展示。

可见画面本身可能透露方法特征，匿名打包不等于消除所有盲评偏差。
