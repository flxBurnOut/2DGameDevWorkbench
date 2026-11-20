# 2026-11-20 Codex 三路审查修复与协议登记

| 项目 | 内容 |
| --- | --- |
| 记录时间 | `2026-11-20T14:29:28-05:00` |
| 基准提交 | `897575b88afc`（工作区基于该提交执行三路只读审查与修复） |
| 归档提交 | `ea982818aaeb`（修复与文档校准提交） |
| 登记问题 | `PAPER-07`、`PAPER-08`、`PAPER-09`、`PAPER-10` |
| 跟进问题 | `PAPER-03`、`PAPER-04`、`PAPER-05`、`PAPER-06` |

## 1. 本批背景与三路审查范围

在 `897575b88afc` 基础上，通过本机 Codex CLI 并行发起三路只读深度审查（零付费调用、工作区无污染）：

1. **增量变更复审（`d724350e9373` 六文件）**：定位 1 项高、6 项中、2 项低风险问题，核心涉及 `without_probes` 撤回无关的 `adjustment_comparison` 失败、`final_review_wins` 跳过 `grounded_audit` 最小帧门槛、内部 `state_checkpoint` 下 `redraw_only` 拒绝合法区间、v2 历史回放套用 v3 提示词规则、`blind_pack` 异尺寸帧拉伸与窄容器溢出。
2. **实验与资产管线全栈审查**：覆盖 `experiment*.py`、`checkpoints.py`、`production_review.py`、`visibility_review.py`、`dispute_review.py`、`prop_measurements.py`、`derived_assets.py`、`local_frame_edits.py`、`frame-tools.ts` 与 `Tools/PixelProp`，定位 6 项高、12 项中、4 项低风险问题。
3. **论文与源码交叉核查**：比对 [论文主文档](../../论文-序列帧长动作生成.md)、[论文方向与方法](../../论文方向与方法.md)、[序列帧实验支撑](../../motion-experiments.md) 与真实归档及源码，定位 8 项高、7 项中、4 项低风险问题，最关键一项为拉杆先导案例的因果归因混淆了原始付费裁决与事后归档重放测试。

本批实施了**全部高价值、向后兼容的实验/复核/资产安全修复与论文事实校准**，并将需要跨模块协议重构或黄金哈希升级的 4 项正式实验前置议题独立登记为 `PAPER-07`–`PAPER-10`。

## 2. 本批新登记问题（正式付费实验前待闭环）

| 编号 | 优先级 | 现象与影响环节 | 建议修补与验证方法 |
| --- | --- | --- | --- |
| PAPER-07 | 高 | **跨组绘图预算口径与完成态定义不一致**：`check_model_redraw_budget` 仅约束 `model_only` 副本，`human_verified` 仍可跳过同上限或经独立修改预算额外支出；同时 `drive_model_only` 与 `retrospective` 仅凭候选存在帧即判 `complete/playable`，未区分技术 QA 失败（`check_failed`）与整片视觉复核结局。影响环节：[experiment_requests.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_requests.py#L229-L244)、[adjustments.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/adjustments.py#L245-L266)、[experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L303-L321)、[论文主文档](../../论文-序列帧长动作生成.md) Section 7.2。 | 在全部付费绘图入口接入统一运行级账本（或预注册跨组预算差异），并考虑追加同权限裁决者对照以单独归因验证效应；将候选帧已归档、技术 QA 通过、整片视觉复核与盲评可用四层结局分开导出并纳入 `retrospective.json`。 |
| PAPER-08 | 高 | **回放组中断恢复与交互物 `hold_frames` 播放对齐缺失**：三个离线回放组在提交成功取得上游 ID 后，若在 `wait()` 期间被信号或异常中断，`run.json` 停留在 `running` 状态，原目录无法继续轮询恢复也无法纳入盲评分母；此外交互物末段 `hold_frames` 仅进入生产流程内两组，离线回放三组在同 FPS 下提前结束。影响环节：[experiment_replay.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_replay.py#L130-L238)、[execution.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/execution.py#L253-L276)。 | 为 `experiment_replay.py` 增加原目录恢复入口（已知上游 ID 只续查原作业，未知 ID 登记为单次不确定提交并可转入 `interrupted`），并在冻结协议中固化播放时间表，使五组统一执行相同的 `hold_frames` 播放停留规则（单独记为零绘图成本）。 |
| PAPER-09 | 高 | **盲评预注册 `run_id` 对账与评审上下文缺失**：`blind_pack` 已拦截重复目录与无作业 `model_only` 预检失败，但 `runs` 分母仍由传入命令行参数决定，无法核验是否漏传预注册运行或混入 `diagnostic_only` 诊断样本；公开播放页仅呈现像素画面与 FPS，缺少任务需求、原始参考图与预期状态端点，评审员无法独立判定是否符合任务目标。影响环节：[experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L676-L810)、[motion-experiments.md](../../motion-experiments.md)。 | 引入预注册清单（锁定每条“任务×种子×组别”的唯一 `run_id`、来源与正式运行资格），在 `blind_pack` 时逐项对账并拒绝 `diagnostic_only` 混入正式盲评；在盲评页面展示统一格式的原始需求、参考图与应到状态表（严格隐藏方法组别与生产裁决）。 |
| PAPER-10 | 中 | **`PixelProp` 噪点裁切与 EXIF 方向边界，以及 `T1/T8` 前后端对齐**：1024px 图中仅一个远处 `Alpha=1` 噪点即可撑大裁切包围盒，使 128px 转换主体剧烈缩小随后噪点被阈值清掉；JPEG 输入的 EXIF Orientation 亦被忽略。此外前端 `T1` 的 `≥64` 通道差启发式可能跳过严重透明缺损或覆盖低色差前景，`T8` 新过渡草稿以生成首帧为基底而后端要求首帧逐像素等于已确认起始状态。影响环节：[pipeline.py](../../../Tools/PixelProp/pixel_prop/pipeline.py#L15-L131)、[recipe.py](../../../Tools/PixelProp/pixel_prop/recipe.py#L8-L44)、[tools-tab.tsx](../../../components/interactable-motion/tools-tab.tsx#L25-L188)。 | 将 `PixelProp` 升级至新算法版本（按配方有效 Alpha 阈值确定主体裁切并保留抗锯齿边、解码前统一应用 EXIF 方向、更新黄金哈希与回归测试）；统一 `T8` 前后端起始状态图来源与哈希，并将 `T1` 透明缺损与前景遮挡分层标记预览。 |

## 3. 本批跟进修复与复验记录

### 3.1 跟进 `PAPER-03`：2×2 离线反事实矩阵、独立门禁保真与双口径 `score_reviews`

- **修改文件**：[experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L379-L510)、[review_evaluation.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/review_evaluation.py#L19-L290)。
- **修复内容**：
  1. `counterfactual_verdicts(report, *, frame_count=None)` 补全 **2×2 消融矩阵**（`full`、`without_probes`、`without_retention`、`final_review_wins`，另加 `baseline_only`），并输出逐维 `checks_by_condition`，可直接送入 `score_reviews()`。
  2. 零探针时 `without_probes` 直接沿用 `report['verdict']`；有探针或有提案时与 `report.get('comparison', {}).get('verdict')` 联合聚合，避免洗掉 `adjustment_comparison` 的 `preservation=fail` 等独立失败判定。
  3. 对 `final_review_wins` 与 `without_retention` 的争议提议重新执行与 `grounded_audit` 一致的最小不同帧数门槛（`rhythm/transition/fixed_parts ≥ 2`，`completeness ≥ min(N, 3)`）。
  4. `_adjudication_items` 去重键纳入规范化 `frames`，避免吞掉同维度不同帧证据；回滚探针 `prior` 时跳过已有保留矛盾的维度，防止同维度合并归档错误覆盖保留矛盾。
  5. `score_reviews(labels, reports, *, dimensions=None)` 现同时支持角色 `CHARACTER_DIMENSIONS` 与交互物 `PROP_DIMENSIONS`（按标签维度自动识别并保持旧接口兼容），并显式注释 `false_positive`（错误拒绝）与 `false_negative`（错误放行）的极性。
- **验证**：[test_paper_experiment.py](../../../Tools/SpritePipeline/tests/test_paper_experiment.py#L415-L535) 与 [test_review_evaluation.py](../../../Tools/SpritePipeline/tests/test_review_evaluation.py#L244-L265) 覆盖 2×2 四格、comparison 失败保真、单帧提议拦截、合并归档防覆盖与交互物双口径评分，全部通过。

### 3.2 跟进 `PAPER-04`：v2 历史提示词保真与 `single`/`keyframe_first` 提示词边界

- **修改文件**：[experiment_requests.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_requests.py#L13-L175)、[experiment_replay.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_replay.py#L70-L73)。
- **修复内容**：
  1. `freeze_drawing` 增加 `legacy_prompts=False`，`experiment_replay.py` 在 `self.version == 2` 时传入 `legacy_prompts=True`，确保历史 v2 协议继续使用旧版拼接与前缀，不随 v3 变更。
  2. `_pose_arm_prompt` 先 `.strip()` 再判定 1,000 字符上限，且 `Action: Hold ending pose` 不再重复写入 `fields['end']`，避免长终态描述重复超限。
  3. `_single_arm_prompt` 仅平移姿势路标起首的 `(^|;\s*)f(\d+):`，不改写句中普通引用。
- **验证**：[test_paper_experiment.py](../../../Tools/SpritePipeline/tests/test_paper_experiment.py#L1016-L1060) 复验 982 字符加尾空格、260 字符长 `End`、句中 `f4:` 保留及 v2 历史拼接，全部通过。

### 3.3 跟进 `PAPER-05`：内部 `state_checkpoint` 下 `redraw_only` 区间切分

- **修改文件**：[adjustments.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/adjustments.py#L174-L195)、[experiment_policy.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_policy.py#L33-L73)。
- **修复内容**：`adjustments.context()` 在存在 `state_checkpoint` 时透出 `state_checkpoint_frame`；`is_stage_redraw_range()` 按锁点切分连续可编辑区间，并在存在内部确认状态锚点时按其前序可播放区间计算最大合法偶数窗（例如 8 帧锁定 `[0, 5]` 时接受 `[1, 4]`）。
- **验证**：[test_paper_experiment.py](../../../Tools/SpritePipeline/tests/test_paper_experiment.py#L1063-L1074) 覆盖 `[0, 5]`、`[0, 5, 7]`、`[0, 4]` 与 16 帧 `[0, 7]` 场景，全部通过。

### 3.4 跟进 `PAPER-06` 与实验回顾/分组完整性加固

- **修改文件**：[experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L239-L259)、[experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L663-L915)、[checkpoints.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/checkpoints.py#L174-L230)、[api.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/api.py#L393-L455)、[adjustments.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/adjustments.py#L221-L228)、[local_frame_edits.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/local_frame_edits.py#L68-L125)。
- **修复内容**：
  1. **`model_only` 组别权限隔离**：`api.py`（`review` / `review-stage` / `repair-stage` / `review-repair`）、`Checkpoints.decide`（非 `experiment-model-only` 裁决者）、`Adjustments.create` 与 `local_frame_edits.create_local` 均拒绝人工介入 `model_only` 副本；`_model_interruption` 在回顾导出时检测历史混入的人工裁决或修改并标记 `protocol_violation / human_intervention_in_model_only`。
  2. **回顾导出修复**：`retrospective()` 先判定 `inherited` 再读取 `attempt['proposed_frames']`，缺失时标记 `proposed_archive_unavailable: True` 而不崩溃；对已采用/已拒绝或带秒数的备选均计入 `timings`，不再因 `decision_note` 为空漏记 `human_seconds`。
  3. **盲评打包与播放器加固**：`collect_clips()` 拒绝重复目录并支持采集无 Job 的 `model_only` 预检失败目录（`experiment-run.json`）；`blind_pack()` 校验同片段帧尺寸一致、拒绝重复片段、写入 `loop` 标记；`PLAYER` HTML 改为按容器宽度自适应选择整数放大倍数，非循环动作默认播完即停（提供循环开关），且不含任何组别关键字。
- **验证**：[test_paper_experiment.py](../../../Tools/SpritePipeline/tests/test_paper_experiment.py#L1076-L1168) 及 Node JS 播放器实测（320px 容器缩放至 2×=256px 且非循环第 3 帧自动停止）全部通过。

### 3.5 复核安全、视觉回执与交互物确定性资产加固

- **修改文件**：[checkpoints.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/checkpoints.py#L175)、[visual_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/visual_review.py#L75)、[dispute_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/dispute_review.py#L134)、[prop_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py#L129)、[visibility_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/visibility_review.py#L120-L185)、[vision_review.py](../../../Tools/SpritePipeline/sprite_pipeline/vision_review.py#L224-L253)、[derived_assets.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/derived_assets.py#L150-L290)、[local_frame_edits.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/local_frame_edits.py#L119-L122)、[frame-tools.ts](../../../features/interactable-motion/frame-tools.ts#L87-L108)。
- **修复内容**：
  1. `checkpoints.py` 补全 `f < 1` 帧号下界校验；降级提示拼接统一截断至 `<= 500` 字符，防止 `Audit.model_validate` 二次校验溢出崩溃。
  2. `visibility_review.py` 要求 `not_visible` 的遮挡上下文至少包含观察帧集之外的外部前后帧；v4 `retain_visible_disagreement` 拦截争议复核用空 `items=[]` 清除独立专家可见性疑点。
  3. `vision_review.py` 在对 HTTP 200 不完整/拒答响应抛错前先调用 `on_response` 保留 `response_id`、`response_model`、`usage` 与状态回执。
  4. `derived_assets.py` 改用临时目录原子重命名发布，倒放逐帧校验 `accepted['frames']` 哈希并记录 `endpoint_matches_start_state`，旋转草稿拒绝全透明空白帧，色表派生按 `pairs[rgb] != rgb` 拒绝同色空映射。
  5. `local_frame_edits.py` 拒绝零像素空改动（透明像素或同色色表）；`frame-tools.ts` 的 `T3 detectOffset` 跳过会裁切可见边缘像素的位移。
- **验证**：
  - `PYTHONPATH=Tools/SpritePipeline Tools/SpritePipeline/.venv/bin/python -m pytest -q` 运行 19 个核心及扩展测试文件（覆盖实验、可见性复核、评测、交互物面板/状态链、局部修改、视觉回执、恢复与生成条件，不含跨进程 Node 写回用例）：**306 passed**（核心 13 文件 224 passed + 扩展 6 文件 82 passed）。
  - `PYTHONPATH=Tools/PixelProp Tools/SpritePipeline/.venv/bin/python -m pytest -q Tools/PixelProp/tests`：**31 passed**。
  - `node tests/interactable-motion/run.mjs`：**9/9 suites ok**（含新增 `detectOffset` 不裁切 `x=0` 可见像素回归）。

### 3.6 论文与实验文档事实校准

- **修改文件**：[论文主文档](../../论文-序列帧长动作生成.md)、[论文方向与方法](../../论文方向与方法.md)、[序列帧实验支撑](../../motion-experiments.md)。
- **校准要点**：
  1. 修正拉杆先导案例因果归因：真实付费记录中外观专家与争议复核已将 `fixed_parts`（缺斜撑）判为失败，所有 VLM 一致漏判的是 `transition` 中的主杆伸缩，确定性半径探针是在后续归档掩码重放中定位第 4–8 帧异常。
  2. 将“六维评测”统一更名为“六项非对称复核指标”，全文统一使用“错误拒绝 / 错误放行 / 弃权”并与代码 `false_positive / false_negative` 极性显式对照；同步更新 2×2 反事实矩阵、`model_only` 与 `human_verified` 完整工作流净效应口径、`single`/`keyframe_first` 共同可行配对子集、交互物三类通过率分列报告，以及 `reference_only`、`InteractableSkeleton`、`PixelProp`（`>64` 色启用 KD-Tree）、`verified_geometry=False`、PNG 直接解码（避开 JPEG 但仍含灰底合成与缩放）与 `T1/T3/T8/T9` 精确范围。
  3. 修正正文第 58 行章节交叉引用，并将在正式付费前需闭环的 `PAPER-07`–`PAPER-10` 同步纳入文档清单。
