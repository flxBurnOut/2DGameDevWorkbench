# 序列帧实验支撑

本工具用于在统一冻结方案、种子与预算下运行五组接续对照、离线复核消融、历史回顾导出与匿名盲评打包。所有输出目录必须是新建的隔离目录。

以下命令均在 `Tools/SpritePipeline` 下使用项目 `.venv` 执行，下文以 `EXP` 代指 `.venv/bin/python -m sprite_pipeline.collaboration.experiment`（Windows 为 `.venv\Scripts\python.exe -m ...`），`ROOT` 为序列帧数据根目录。

## 1. 五组对照与执行流程

一次对比从同一个已规划作品版本冻结各段提示词、帧数、FPS、参考图、末帧条件与种子：

| 组别 | 运行位置 | 接续方式 |
| --- | --- | --- |
| `single`（一次生成） | 冻结协议回放 | 单次画完整动作，合计超 16 帧按本地预检受阻 |
| `blind`（盲目接续） | 冻结协议回放 | 自动用上段真实末帧接续，无复核、无修复 |
| `keyframe_first`（未验证端点提案） | 冻结协议回放 | 未绑目标图时先由初态出 4 帧提案锁末帧，再以首末图填充 |
| `model_only`（纯模型门控） | 流程内作品副本 | 完整 VLM 复核 + 固定规则自动裁决，禁止人工介入 |
| `human_verified`（完整方法） | 流程内作品副本/原作品 | 守卫检查点 + 人工确认与分级修复 |

### 第一步：冻结协议

```sh
EXP freeze ROOT WORK_ID /absolute/new-protocol [--revision N]
```

作品须已有可执行方案与种子（已开始制作的作品取候选实际种子）。输出 `protocol.json`、`reference.png` 与各段末帧目标图，回放前逐一校验哈希。

### 第二步：回放三个对照组

```sh
EXP simulate blind /absolute/new-protocol /absolute/new-run
```

CLI 默认连接模拟提供方（结果标 `diagnostic_only`）；真实付费实验获授权后经脚本调用 `load_protocol` 与 `run_arm` 传入真实提供方。支持手写 `protocol.json` 加 `--reference` 做连通性测试（记为 `manual`，不混入正式比较）。

### 第三步：建立流程内两组并运行 `model_only`

```sh
EXP clone ROOT WORK_ID model_only paper-run-01-model
EXP clone ROOT WORK_ID human_verified paper-run-01-human
EXP model-only ROOT COPY_ID --authorize-paid-calls
```

- `human_verified` 副本在工作台按规程制作与确认；`model_only` 副本仅允许 `experiment-model-only` 自动裁决（API 与检查点入口拒绝人工介入，回顾导出另检历史越权并标 `protocol_violation`）。
- **`model_only` 固定规则**：复核通过即接续；失败或不确定时在冻结预算内做最多一次最大合法偶数窗重画并复审；复审仍未通过或无法重画则停止；若复核或重画中断/结果未知，记为技术中断计入可用率分母。跨组汇总时来源规划费用只算一次。

## 2. 消融方式

| 消融 | 做法 | 是否新增生成 |
| --- | --- | --- |
| 仅基线检查 | 离线重算 `review_ablation.baseline_only` | 否 |
| 2×2：去确定性探针（保留矛盾开） | `review_ablation.without_probes`：撤回 `guard_measurements` 探针降级，保留评审矛盾与局部对比失败；`probe_overrides` 记拦截详情 | 否 |
| 2×2：去保留矛盾（探针开） | `review_ablation.without_retention`：按争议复核通过提议计（仍校验最小帧门槛），保留探针降级 | 否 |
| 2×2：双关闭 | `review_ablation.final_review_wins`：同时移除矛盾保留与探针降级（仍校验最小帧门槛与对比失败） | 否 |
| 仅整段重画（`redraw_only`） | `EXP clone ... --repair-policy redraw_only`：仅允许覆盖当前段最大合法偶数可编辑窗（兼顾锁点与内部 `state_checkpoint` 前序区间，且 ≥ 4 帧） | 是 |
| 加/不加角色结构 | 规划时是否附带已核对视觉结构，各建作品 | 是 |

前四项由已保存复核报告离线输出逐维 `checks_by_condition`，可直接送入[视觉复核文档](sprite-review-evaluation.md)的 `score_reviews` 与 `risk_coverage_curve`；同时覆盖交互物 `tracked_parts` 与角色 `character_probes`（角色探针不注入专家提示词）。

## 3. 回顾性导出与盲评打包

```sh
EXP inventory /absolute/jobs
EXP export /absolute/jobs/JOB /absolute/open-motion/WORK/work.json /absolute/new-export
EXP export-legacy /absolute/jobs/JOB /absolute/new-export
EXP blind /absolute/new-blind-pack /absolute/run-A /absolute/export-B
```

- **清点与导出**：`inventory` 列出各作业为 `full` / `legacy` / `unreadable`；`export` 导出开放动作完整帧、报告、人工耗时（`human_seconds` / MCP `humanSeconds`，未填记未知）与修复级别统计；`export-legacy` 导出旧版整段作业用于失败标注。
- **匿名盲评包**：输入支持回放目录、回顾导出目录及无作业 `model_only` 预检拦截目录（拒绝重复目录、未完成运行与异尺寸帧）。重新编码 PNG 清除元数据、随机打乱编号；`index.html` 提供 **1× 原尺寸与容器自适应整数倍放大双视图**、三背景切换、非循环播完即停与单帧步进。编号对应表与可用率分母 `runs` 保存在包外的 `*-private-key.json`（正式实验前另按[问题清单 `PAPER-09`](问题清单/README.md)补齐预注册 `run_id` 对账与需求/原图展示）。

## 4. 协议 v3、记账与指标字段参考

- **12 行结构化简报超限处理**（对应[策略 6](visual-structures.md#规划与绘图策略)）：预检按去首尾空白后的最终文本核验 1,000 字符上限。仅当简单拼接或加 `Hold ending pose: ` 前缀超限时：
  - `single` 组确定性去重共享头标签（`Appearance / Camera / Facing / Relations` 等，`End`/`Boundary` 取末段）并只平移路标起首的 `fN:` 帧号；
  - `keyframe_first` 组确定性提取终态核心行（不重复写入 `End`），不调额外模型、不静默截断，仍超限则记 `blocked_preflight`。
  - 历史 v2 协议回放自动沿用 `legacy_prompts=True`，不改变旧请求文本。
- **额外首帧与费用口径**：v3 与生产检查点共用 `input_pose_v1`（多回 1 帧且确认为输入姿势时播放映射跳过；不能确认则记提供方异常）。`run.json.cost` 按绘图尝试记账（未知尝试计入分母、缺美元价记 `unpriced_calls` 且 `total_usd=null`）；若 PixelLab 轮询返回异号作业 ID，仅沿用与原查询 ID 绑定的用量并记录冲突。
- **`retrospective.json` 核心字段**：
  - `tool_usage`：按 `deterministic` / `restricted_generation` / `window_redraw` / `stage_redraw` 统计修复次数；
  - `drawing_frame_budget`：核对已请求帧数、待执行预留帧数与冻结上限；
  - `stages[].drift`（标 `drift_source`: `'accepted'` 或 `'raw'`）与 `clips[].drift`：由 `sequence_drift_metrics` 相对 `input/reference.png` 本地离线计算地面基线偏移（`ground_y_delta_px`）、前景面积变化率（`area_change_ratio`）、轮廓 IoU（`silhouette_iou`）与调色板偏离度（`palette_deviation_ratio`）的逐帧及最大/均值/末帧汇总；
  - `escalation`：汇总总检查点复核数（`total_checkpoint_reviews`）、无待裁决冲突的直接通过数（`auto_pass_reviews`）、升级裁决数与升级率（`escalated_reviews` / `escalation_rate`）、确定性探针/矛盾保留各自触发的升级数、人工介入次数（`human_interventions`）及配对 `reviewed_at` 与 `decided_at` 的后端墙钟耗时（`known_wall_seconds`），自动排除 `model_only` 规则裁决；
  - 坏帧段保留 `raw_count`、`invalid_raw_indices` 与其余有效原帧；派生作业跨版本统计时需按来源请求去重。
