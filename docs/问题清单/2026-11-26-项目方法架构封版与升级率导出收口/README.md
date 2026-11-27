# 2026-11-26 项目方法架构封版与升级率导出收口

> 返回[工程问题清单](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | `2026-11-26T20:23:47-05:00` |
| 基准提交 | `93b86611fefd` |
| 归档提交 | `73da8a598c7b`（收口代码、单测与正式封版记录） |
| 登记问题 | — |
| 跟进问题 | `PAPER-11`、`PAPER-12` |

## 1. 本批目标：最后 2 项对齐收口与正式封版

在确认 `VBYC` 三大核心模块（防目标漂移可编译合同、守卫检查点与统一确定性探针、L1–L4 有界分级修复）及 v8 8 页大纲已闭环后，完成最后 2 项代码收口微调并正式宣布**系统架构定稿、转入论文正文撰写阶段**：

1. **补全交互物规划提示的 `rotation_plane` 规则（跟进 `PAPER-11`）**：在 [planning.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/planning.py#L168-L173) 的 `PROP_INSTRUCTIONS` 中明确 `hinge_rotation` 当部件存在前后向镜头透视缩短时将 `hinge.rotation_plane` 设为 `out_of_plane`（其余保持默认 `in_plane`），打通线上规划自动标注透视旋转平面的最后一环。
2. **自动导出检查点升级率与后端操作耗时（跟进 `PAPER-12` / RQ3）**：
   - 在 [checkpoints.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/checkpoints.py#L191-L197) 为分段复核结果补全 `reviewed_at` 时间戳，并在 `decide()` 中为 `human_decision` 补全 `decided_at` 时间戳；
   - 在 [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L675-L760) 新增 `_parse_iso_dt` 与 `_escalation_summary`，使 `retrospective()` 直接输出 `escalation` 汇总（`total_checkpoint_reviews`、`auto_pass_reviews`、`escalated_reviews`、`escalation_rate`、`probe_escalated_reviews`、`contradiction_escalated_reviews`、`human_checkpoint_decisions`、`human_adjustment_decisions`、`human_interventions`、`measured_wall_decisions`、`known_wall_seconds`），并按与 `cost.human_seconds` 一致的口径过滤 `model_only` 规则裁决。
3. **正式封版边界登记**：在 [论文方向与方法](../../论文方向与方法.md)、[论文-序列帧长动作生成](../../论文-序列帧长动作生成.md)、[motion-experiments](../../motion-experiments.md) 与根 [AGENTS](../../../AGENTS.md) 标明 VBYC 方法架构与 v8 8 页大纲双封版定稿，正式进入第 1–5、7–8 节正文撰写；后续改动严格限缩于历史素材清理、离线评测运行及第三阶段付费在线实验前的 `PAPER-07`～`09` 护栏。

## 2. 隔离验证证据（未接触真实素材与付费接口）

- 新增单测：
  - [test_prop_planning_limits.py](../../../Tools/SpritePipeline/tests/test_prop_planning_limits.py) 新增 `test_prop_instructions_document_hinge_rotation_plane`；
  - [test_paper_experiment.py](../../../Tools/SpritePipeline/tests/test_paper_experiment.py) 在 `test_model_only_redraw_preserves_actual_review_and_drawing_outcome` 验证 `model_only` 下 `human_interventions == 0` 且 `measured_wall_decisions == 0`，并在 `test_retrospective_and_legacy_export_compute_objective_drift_metrics` 校验 `reviewed_at`/`decided_at` 字符串格式、`escalation_rate == 0.0` 全直通用例以及含 `deterministic_probe` 冲突下的 `escalated_reviews == 1`、`probe_escalated_reviews == 1`、`escalation_rate == 0.5`。
- 运行六项关联测试套件（沙箱内仅跳过已知需真实回环端口的 `test_archive_writeback_to_shared_document`）：
  ```sh
  PYTHONPATH=Tools/SpritePipeline Tools/SpritePipeline/.venv/bin/python -m pytest -q \
    Tools/SpritePipeline/tests/test_prop_planning_limits.py \
    Tools/SpritePipeline/tests/test_open_motion_checkpoints.py \
    Tools/SpritePipeline/tests/test_production_review.py \
    Tools/SpritePipeline/tests/test_interactable_motion.py \
    Tools/SpritePipeline/tests/test_interactable_state_chain.py \
    Tools/SpritePipeline/tests/test_paper_experiment.py \
    -k "not test_archive_writeback_to_shared_document"
  ```
  结果：**103 passed, 1 deselected in 30.88s**。
