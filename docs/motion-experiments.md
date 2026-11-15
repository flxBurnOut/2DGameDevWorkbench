# 序列帧实验支撑

真实实验的对象、规模、费用上限和盲评人数尚未定。模拟调用与归档帧回放只证明流程连通，不能作为生成质量的实验结果。所有输出目录必须是新建的隔离目录。

命令从 `Tools/SpritePipeline` 目录用项目虚拟环境执行，下文以 `EXP` 代表 `.venv/bin/python -m sprite_pipeline.collaboration.experiment`（Windows 为 `.venv\Scripts\python.exe -m …`）。`ROOT` 是序列帧服务的数据根目录。

## 各组如何共用同一份方案

一次对比的所有组别都从同一个已规划作品出发，使用相同的编译后提示词、每段帧数、FPS、参考图、末帧条件和种子。第 `i` 段的绘图种子在所有组别里都按流程的同一规则由作品种子推出。各组之间只有接续方式不同。

| 组别 | 在哪里运行 | 接续方式 |
| --- | --- | --- |
| 一次生成 `single` | 冻结协议回放 | 单次画完整动作；合计超过 16 帧拒绝 |
| 盲目接续 `blind` | 冻结协议回放 | 用上一段真实最后一帧接续，不调用复核 |
| 关键帧先行 `keyframe_first` | 冻结协议回放 | 先为每段执行一条 4 帧姿势提案并冻结其真实末帧，再以首末图填充。方案已绑定末帧目标的段直接用该目标 |
| 模型验证后接续 `model_only` | 真实流程中的作品副本 | 流程自带的复核给出结论，按固定规则自动裁决，没有人看画面 |
| 人工验证后接续 `human_verified` | 真实流程中的作品副本，或来源作品本身 | 模型复核加人工确认，即完整方法 |

前三组不经过检查点，所以在流程之外回放；后两组需要流程的复核、修复和检查点，所以在流程内运行。回归测试核对了回放组发出的提示词、帧数、种子和末帧条件与流程实际提交的请求逐项相同。

### 第一步：冻结协议

```sh
EXP freeze ROOT WORK_ID /absolute/new-protocol
```

作品须已有可执行方案并指定了种子；已开始制作的作品取其候选的实际种子。目录内含 `protocol.json`、`reference.png` 和各段的末帧目标图，回放前逐个核验哈希。历史版本加 `--revision N`。

### 第二步：回放三个对照组

```sh
EXP simulate blind /absolute/new-protocol /absolute/new-run
```

命令行只连接免费的模拟提供方，结果标记 `diagnostic_only`。真实实验在获得费用授权后，由脚本调用 `load_protocol` 与 `run_arm` 并传入真实提供方。网络失败、中断与未知结果均停止，不自动重发。`run.json` 记录方案来源、每次调用的种子、首末图摘要、用量和顺序帧。

关键帧先行组的姿势来自一条 4 帧动画调用的末帧，写论文时须如实报告，不能称为一次静态图生成。一次生成组把各段提示词拼成一条，这是该组做法本身的一部分。

手写协议仍可用于连通性检查：`EXP simulate blind protocol.json /absolute/new-run --reference /absolute/reference.png`，其中 `protocol.json` 含 `seed`、`fps`、`stages`（每段 `prompt` 与 `frames`）。这样的运行在 `run.json` 中标记为 `manual`，不能与真实流程的结果放在一起比较。

### 第三步：建立流程内的两组

```sh
EXP clone ROOT WORK_ID model_only paper-run-01-model
EXP clone ROOT WORK_ID human_verified paper-run-01-human
```

副本是带实验标记的普通作品，方案、参考图、末帧目标和种子与来源相同，尚未开始制作。`human_verified` 副本在页面上照常制作和确认。`model_only` 副本用下面的命令自动裁决：

```sh
EXP model-only ROOT COPY_ID --authorize-paid-calls
```

这条命令会按作品配置的服务实际绘图和复核，会产生费用，必须显式授权。它只接受 `model_only` 副本，不会替用户裁决普通作品。每段的固定规则：

1. 复核结论为通过，直接确认，继续下一段。
2. 否则请求一次段内重画，范围是除首末帧外最大的偶数帧窗口，说明取自复核报告中未通过的条目。重画结果采用后重新复核。
3. 重画后仍未通过、片段少于 6 帧无法重画，或预算不允许重画，则判该段不合格并停止。

裁决记录写入作业（确认人为 `experiment-model-only`），摘要另存到副本目录的 `experiment-run.json`。副本继承来源作品的规划调用记录，跨组汇总费用时规划费用只算一次。

## 消融

| 消融 | 做法 | 是否需要新的生成 |
| --- | --- | --- |
| 去掉独立专家 | 导出中每份复核报告的 `review_ablation.baseline_only`，即同一批画面上基础检查自己的结论 | 否 |
| 去掉保留矛盾规则 | `review_ablation.final_review_wins`：争议复核提议取消原有疑点时，直接按提议计结论。`retained_contradictions` 是被规则拦下的条数 | 否 |
| 只允许整段重画 | `EXP clone … --repair-policy redraw_only`。副本上确定性编辑、受限生成和段内重画一律拒绝，只能对一段的全部可编辑帧重画 | 是 |
| 加 / 不加角色结构 | 规划作品时是否附带视觉结构，各建一个作品 | 是 |

前两项由已保存的复核报告重新计算，不调用模型。只有采用专家协议且复核完整结束的报告才有这两项，其余为 `null`。

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
- `cost` 的调用次数与原生预算账本同口径，另加属于本作业的独立修改调用。Token、额度单位和美元分别保存，不用估计汇率混算。没有明确 `cost_usd` 的请求计入 `unpriced_calls`，此时 `total_usd` 为 null。未知人工用时单独计数，`known_human_seconds` 只是已记录小计。
- 派生作业包含来源作业继承的预算记录，跨多个版本统计时需按来源请求去重。

## 匿名播放包

```sh
EXP blind /absolute/new-blind-pack /absolute/run-A /absolute/export-B
```

输入可以是回放运行目录或回顾性导出目录。每个片段随机命名、打乱顺序，PNG 重新编码清除元数据；公开包只含匿名编号、帧数、FPS、像素和离线播放页面，打开 `index.html` 即可播放。

编号对应表写到包目录旁的 `new-blind-pack-private-key.json`，不要交给盲评者。对应表同时列出没有产出可播放片段的运行（被复核叫停、中断，或导出中没有完整候选）及其组别，`runs` 是全部运行数。计算可用率时以 `runs` 为分母，这些运行计为不可用。仍在进行中的运行会被拒绝打包。

可见画面本身可能透露方法特征，匿名打包不等于消除所有盲评偏差。
