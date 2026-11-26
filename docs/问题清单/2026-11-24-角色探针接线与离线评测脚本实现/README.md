# 角色探针接线与离线评测脚本实现

> 返回[问题清单索引](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | `2026-11-24T01:08:46-05:00` |
| 基准提交 | `078b12abf6d6` |
| 归档提交 | `fe37d69135f7` |
| 登记问题 | — |
| 跟进问题 | `PAPER-11`、`PAPER-12` |

## 记录

### 关闭 `PAPER-11`（已修复并复验）

1. **角色确定性探针接入分段与整段检查守卫**：
   - 新增 [character_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/character_measurements.py)，复用 [frame_checks.py](../../../Tools/SpritePipeline/sprite_pipeline/processing/frame_checks.py) 的确定性检测（不改动盲审提示词），将问题映射到三个维度：
     - **节奏（`rhythm`）**：位置跳变、质心/速度跳变与接地动作的地面基线偏移（按参考图自身基线校验）；
     - **装备/外观（`equipment`）**：前景面积变化、调色板偏离及空白/缺 Alpha/损坏/异尺寸帧；
     - **完整性（`completeness`）**：循环首尾差异（刻意排除连续重复帧与安全边距提醒，避免误伤定帧或宽武器动作）。
   - 在 `checkpoints.py`、`visual_review.py` 与 `production_review.py` 中独立写入 `motion_evidence['character_probes']`（不注入专家提示词），经 `prop_measurements.py` 的 `guard_measurements` 触发退回与人工留痕；同时扩展 `experiment.py` 的 `counterfactual_verdicts`，使角色主域完整输出 2×2 反事实矩阵。
2. **交互物旋转平面标记**：
   - [contracts.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/contracts.py) 的 `HingeMeasurement` 新增 `rotation_plane`（`in_plane` / `out_of_plane`，默认 `in_plane` 且序列化时省略默认值，保持历史 `plan_sha256` 不变）。
   - [prop_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py) 在 `out_of_plane` 时跳过 2D 半径守恒检测（标记 `radius_check_skipped: True`），仍照常执行固定区像素检测。
3. **争议聚焦图整数倍缩放居中**：
   - [dispute_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/dispute_review.py) 在联合包围盒不超过 320×320 时按 `max(1, min(320 // bw, 320 // bh))` 做整数倍最近邻缩放，在 320×320 网格内居中贴图并记录 `scale`。

### 跟进 `PAPER-12`（脚本已就绪，待素材与标注到位后运行）

1. **等调用次数无守卫离线基线**：在 [review_evaluation.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/review_evaluation.py) 与 [review_cli.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/review_cli.py) 新增两项子命令：
   - `self-consistency [--calls 5]`：连续执行 $k$ 次（默认 5 次）独立盲审采样，关闭置信度与最小帧数守卫，按维度多数票裁决（平票转 `uncertain`）；
   - `experts-no-guard`：预算 5 次的多视角+争议流程，关闭不沉默覆盖、可见性守卫、置信度/帧数门槛与确定性探针。
2. **3×3 混淆矩阵与 Risk–Coverage 扫描**：
   - `score_reviews` 在兼容旧输出的同时新增三态混淆矩阵与六项比率（自动覆盖率、弃权率、总体/选择性错误放行率、总体错误拒绝率、选择性错误率）；对 `unguarded=True` 报告直接使用原始裁决。
   - 新增 `risk_coverage_curve` 与 CLI `--risk-coverage`，沿置信度阈值扫描风险–覆盖率权衡，同时保留结构化人工升级项不随阈值下调。
3. **回顾导出逐段客观漂移指标**：在 [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py) 新增 `sequence_drift_metrics`，计算相对参考图的逐帧及汇总地面基线偏移、面积变化率、轮廓 IoU 与调色板偏离度，接入 `retrospective`（`stages[].drift`、`clips[].drift`）与 `legacy_export`（`clips[].drift`）。

### 隔离验证

本批验证均使用本地合成 PNG、模拟夹具与临时目录执行，未触碰真实素材或外部付费接口：

- 专项测试（`test_prop_planning_limits.py`、`test_production_review.py`、`test_review_evaluation.py`、`test_paper_experiment.py`）：**89 passed**；
- 全量沙箱 Python 回归（排除 keychain 与跨服务写回）：**884 passed, 57 subtests passed, 2 skipped**（仅 9 项已知沙箱阻断的 macOS Keychain 凭据用例失败）；
- Node 交互物套件（`node tests/interactable-motion/run.mjs`）：**9/9 ok**。

### 下一步

待真实素材与双人独立标注到位后，按阶段推进 `PAPER-01`（历史作业盘点导出）与 `PAPER-12`（离线基准实测）；付费主实验前另需闭环 `PAPER-02/03/07/08/09`。
