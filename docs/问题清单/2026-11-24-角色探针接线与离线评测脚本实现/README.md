# 2026-11-24 角色探针接线与离线评测脚本实现

| 项目 | 内容 |
| --- | --- |
| 记录时间 | `2026-11-24T01:08:46-05:00` |
| 基准提交 | `078b12abf6d6` |
| 归档提交 | 待本次归档提交后回填 |
| 登记问题 | — |
| 跟进问题 | `PAPER-11`、`PAPER-12` |

## 1. 本批目标与执行边界

根据用户指令执行两项零绘图生成费代码/脚本工作：
1. 增量补齐 **`PAPER-11`**（角色侧确定性探针守卫接线、交互物铰接平面 `rotation_plane` 显式声明、争议聚焦图整数倍最近邻缩放居中）。
2. 完成 **`PAPER-12`** 的离线评测基线、Risk–Coverage 阈值扫描及回顾导出客观漂移计算脚本与隔离单元测试；**严格遵守“素材拿来前不进行运行”边界**，未接触任何 `work/` / `outputs/` / `games/` 真实素材，亦未发起任何真实 VLM 或 PixelLab 调用。

## 2. 问题跟进与实现详情

### 2.1 关闭 `PAPER-11`（已修复并复验）

1. **角色确定性探针接入分段与整段检查守卫**：
   - 新增 [character_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/character_measurements.py)，复用 [frame_checks.py](../../../Tools/SpritePipeline/sprite_pipeline/processing/frame_checks.py) 中的 `run_qa` 确定性检测，在不修改原有角色盲审提示词的前提下计算并映射问题标志：
     - `rhythm`：`frame_position_jump`、`centroid_jump`、`centroid_velocity_jump`、`ground_baseline_drift`（按实际 `job.action.grounded` 与参考图自身 `ground_y` 基线校验）；
     - `equipment`：`area_change`、`palette_deviation`、`blank_frame`、`missing_alpha`、`corrupt_frame`、`frame_size_mismatch`；
     - `completeness`：`loop_endpoint_difference`（有意排除 `consecutive_duplicate_frames` 与 `safe_margin_violation`，避免误杀刻意定帧或宽武器边缘动作）。
   - 在 [checkpoints.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/checkpoints.py)、[visual_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/visual_review.py) 与 [production_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/production_review.py) 中记录 `motion_evidence['character_probes']`（与交互物 `tracked_parts` 分离保存，确保盲审提示词及 `without_probes` 无文本泄露），并经扩展了角色标签映射的 [prop_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py) `guard_measurements` 触发确定性退回与人审留痕。
   - 在 [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py) `counterfactual_verdicts` 与 `_infer_frame_count` 中补充识别 `character_probes`，使角色主域同样完整输出 2×2 反事实矩阵（`without_probes`、`without_retention`、`final_review_wins` 与 `probe_overrides`）。
2. **交互物 `HingeMeasurement.rotation_plane` 与平面外旋转跳过**：
   - 在 [contracts.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/contracts.py) 的 `HingeMeasurement` 新增 `rotation_plane: Literal['in_plane', 'out_of_plane'] = 'in_plane'`，并通过 `@model_serializer(mode='wrap') preserve_legacy_hinge` 在值为默认 `'in_plane'` 时省略键名，保证历史计划 `plan_sha256` 100% 不变。
   - 在 [prop_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py) `measure_parts` 中，当 `rotation_plane == 'out_of_plane'` 时跳过 2D 半径守恒检测（标记 `'rotation_plane': 'out_of_plane'` 与 `'radius_check_skipped': True`），仍照常执行 `fixed_parts` 像素检测。
3. **争议聚焦图整数倍最近邻缩放居中**：
   - 在 [dispute_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/dispute_review.py) `focus_panels` 中，当联合包围盒宽、高均不大于 320px 时，使用 `scale = max(1, min(320 // bw, 320 // bh))` 计算整数倍最近邻缩放尺寸 `(bw * scale, bh * scale)`，在每个 320×320 网格区域（header 下方 `y+28` 起）水平垂直居中贴图，并在 `selection` 中记录 `'scale': scale`。

### 2.2 跟进 `PAPER-12`（脚本已就绪并复验；待真实素材/语料后运行）

1. **等调用次数无守卫离线投票与多视角基线**：
   - 在 [review_evaluation.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/review_evaluation.py) 新增 `raw_audit_verdict` 与 `unguarded_audit`，并扩展 `ReviewExperiment.run` 与 [review_cli.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/review_cli.py)：
     - `self-consistency [--calls 5]`（默认 5 次）：连续执行 $k$ 次彼此独立的盲 `Audit` 采样（关闭 0.80/0.85 置信度及最小帧数守卫），按各维度多数票裁决（平票退回 `uncertain`），保留投票计数与 `unguarded=True` 标记。
     - `experts-no-guard`（预算 5 次）：执行 `observe + audit + appearance + motion`，若三方就通过/失败未达成一致则再调一次 `resolve`，直接按分类映射并关闭 `No-Silent-Override`、可见性守卫、置信度/最小帧数门槛及确定性探针。
2. **3×3 混淆矩阵与 Risk–Coverage 曲线**：
   - `score_reviews` 在完整保留原有 `totals`、`rows`、`label_digest`（以及 `comparison_gate` 兼容性）的同时，新增 `confusion_matrix`（`pass` / `fail` / `uncertain` 3×3 矩阵）与 `rates`（`coverage`、`abstention_rate`、`false_accept_rate_overall`、`false_accept_rate_selective`、`false_reject_rate_overall`、`selective_error_rate`）；对 `unguarded=True` 报告直接使用其原始裁决而不重套 0.80/0.85 守卫。
   - 新增 `risk_coverage_curve` 与 CLI `--risk-coverage` 参数，沿标量置信度阈值扫描风险与覆盖率，同时固定保留 `requires_human_adjudication` 等结构化弃权（不随阈值降低而放行）。
3. **回顾性导出客观逐段/逐剪辑漂移指标**：
   - 在 [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py) 新增 `sequence_drift_metrics`，计算相对于 `input/reference.png` 的逐帧与汇总（最大/均值/末帧）`ground_y_delta_px`、`area_change_ratio`、`silhouette_iou` 与 `palette_deviation_ratio`，同步接入 `retrospective`（各段记入 `stages[].drift` 与 `drift_source`，完整播放记入 `clips[].drift`）与 `legacy_export`（记入 `clips[].drift`）。

## 3. 隔离验证证据（未接触真实素材与付费接口）

所有测试仅使用本地合成 PNG、Fixture 模拟提供方与临时目录执行：
1. **新增与关联专项回归**：
   ```sh
   PYTHONPATH=Tools/SpritePipeline Tools/SpritePipeline/.venv/bin/python -m pytest -q \
     Tools/SpritePipeline/tests/test_prop_planning_limits.py \
     Tools/SpritePipeline/tests/test_production_review.py \
     Tools/SpritePipeline/tests/test_review_evaluation.py \
     Tools/SpritePipeline/tests/test_paper_experiment.py
   ```
   结果：**89 passed in 15.06s**（含新增的 `test_hinge_rotation_plane_preserves_legacy_hash_and_skips_out_of_plane_radius`、`test_character_probes_guard_checkpoints_and_populate_2x2_counterfactual`、`test_focus_panels_use_integer_scale_and_centered_tile`、`test_equal_compute_self_consistency_and_experts_no_guard_cli`、`test_confusion_matrix_and_risk_coverage_sweep_cli`、`test_retrospective_and_legacy_export_compute_objective_drift_metrics`）。
2. **全量沙箱 Python 回归**：
   ```sh
   PYTHONPATH=Tools/SpritePipeline Tools/SpritePipeline/.venv/bin/python -m pytest -q Tools/SpritePipeline/tests \
     -k "not keychain and not test_archive_writeback_to_shared_document"
   ```
   结果：**884 passed, 57 subtests passed, 2 skipped, 4 deselected**（仅 9 项已知受限沙箱阻断的 macOS `SecKeychainAddGenericPassword` 凭据测试失败：`test_backend_capabilities.py` 1 项、`test_motion_correction.py` 1 项、`test_quota_result_safety.py` 5 项、`test_workbench_credentials.py` 2 项）。
3. **Node 交互物套件**：
   ```sh
   node tests/interactable-motion/run.mjs
   ```
   结果：**9/9 ok**。

后续仅余待真实素材与冻结语料到位后的数据采集与正式运行（`PAPER-01` 清点导出、`PAPER-12` 双人独立标注与离线对比测试）。
