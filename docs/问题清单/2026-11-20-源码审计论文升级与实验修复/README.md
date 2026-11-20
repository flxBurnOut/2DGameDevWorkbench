# 源码审计论文升级与实验支撑修复

> 返回[问题清单索引](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | 2026-11-20T13:37:44-05:00，美东时间 |
| 基准提交 | `15365894c8a8`，`paper-vbyc` |
| 归档提交 | `d724350e9373`（代码修复、回归测试、论文升级与本批登记，提交时间 2026-11-20T13:44:07-05:00） |
| 登记问题 | PAPER-04、PAPER-05、PAPER-06 |
| 跟进问题 | PAPER-03 |

## 问题条目

| 编号 | 优先级 | 可观察现象 | 处理与验证 |
| --- | --- | --- | --- |
| PAPER-04 | 高 | 策略 6 的 12 行结构化简报单段约 650–850 字符，在 `experiment_requests.py` 中 `single` 组直接用空格拼接各段会重复粘贴 12 行模板头、`keyframe_first` 组机械加 18 字符前缀，导致合法 16 帧双段或 983–1000 字符单段在 `preflight` 因 `prompt_length` 被误杀 | 在 [experiment_requests.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_requests.py) 增加 `_single_arm_prompt` 与 `_pose_arm_prompt`：普通文本与未超限简报保持原样；仅当 12 行结构化简报超 1,000 字符时确定性去重共享标签并将局部 `fN:` 平移为全片帧号，或提取终态姿势核心行（零模型调用、不静默截断，仍超限照常由 `preflight` 拦截）。回归测试：[test_paper_experiment.py](../../../Tools/SpritePipeline/tests/test_paper_experiment.py) `test_structured_brief_arms_deduplicate_single_and_extract_pose_without_truncation` 及既有边界用例全通过。 |
| PAPER-05 | 高 | `redraw_only` 消融在常规未锁定段上存在奇偶帧死锁：每段帧数 $N$ 为偶数且仅第 0 帧锁定，可编辑帧数 $N - 1$ 必为奇数；`adjustments.py` 要求过渡重画选偶数帧（4–16），而 `experiment_policy.py` 要求必须选中全部可编辑帧，导致常规未锁定段无法提交任何 `stage_redraw` | 在 [experiment_policy.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_policy.py) 抽出 `is_stage_redraw_range()` 并由 [adjustments.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/adjustments.py) 共用：可编辑帧为偶数时要求覆盖全部，为奇数时允许头对齐或尾对齐的最大合法偶数窗口（$N - 2 \ge 4$ 帧），继续拒绝局部小窗口、外观编辑与确定性编辑。回归测试：`test_redraw_only_allows_maximal_even_stage_redraw_on_unlocked_even_segment` 验证 8 帧未锁定段拒绝 `[1, 4]`、成功执行 `[1, 6]` 与 `[2, 7]` 并导出 `tool_usage == {'stage_redraw': 2}`。 |
| PAPER-06 | 中 | `blind_pack` 生成的离线匿名播放页仅有单个原生 1× `<img>` 与播放/暂停按钮，未实现论文承诺的“1× 原尺寸与整数倍放大双视图”及棋盘格背景对照 | 在 [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py) 为 `clips.json` 补充 `width` / `height`，升级 `PLAYER` HTML 提供并排 **1× 原尺寸 + 整数倍最近邻放大（`image-rendering: pixelated`）双视图**、棋盘格/浅灰/深灰背景切换及逐帧步进，并确认不含任何实验组名称或路径泄漏。回归测试：`test_four_offline_arms_and_anonymous_playback` 通过。 |

## 记录

### 跟进 PAPER-03（发现崩溃并完成代码修复与复验）

- **深挖根因**：通读 [production_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/production_review.py#L155-L158) 与 [prop_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py#L114-L135) 后发现，`guard_measurements` 生成的探针冲突条目不含 `'proposal'` 字段，但会被 `production_review.py` 合并写入 `expert_review.requires_human_adjudication`。导致一旦真实交互物运行触发确定性探针拦截（如拉杆样本），[experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L369-L385) 的 `counterfactual_verdicts` 会直接因 `item['proposal']` 报 `KeyError: 'proposal'` 崩溃。
- **修复**：
  1. 在 `prop_measurements.py` 探针冲突条目补充 `'source': 'deterministic_probe'`（保留原有 `prior` / `frames` / `reason` 兼容所有既有断言）；
  2. 重写 `experiment.py` 的 `counterfactual_verdicts()`，通过 `_is_probe_override()` 同时识别新字段与历史无 `source` 字段的旧探针条目，按 `(dimension, is_probe, reason)` 合并顶层与 `expert_review` 裁决列表，输出完全解耦的 `baseline_only`、`without_probes`、`final_review_wins`（基于探针改写前的 `pre_probe_checks` 重算）、`retained_contradictions`、`probe_overrides` 与 `probe_override_details`。
- **验证**：`test_review_ablation_is_recomputed_from_the_stored_report` 覆盖 `guard_measurements` 合并进 `expert_review` 以及历史无 `source` 标签探针记录两类场景，零 `KeyError` 且三组反事实结论准确解耦。`PAPER-03` 代码侧已修复复验，剩余待正式实测或归档导出后整理配对视觉对比案例。

### 论文大纲源码级升级与回归验证

- 完成全量架构文档与 `Tools/SpritePipeline/sprite_pipeline/collaboration/`、`Tools/PixelProp/`、`features/interactable-motion/`、`lib/workbench/` 核心源码对照审计，将《[论文：先验证，再接续](../../论文-序列帧长动作生成.md)》《[论文方向与方法](../../论文方向与方法.md)》《[序列帧实验支撑](../../motion-experiments.md)》同步升级为“程序化认识论守护 + 生成式与确定性混合管线”推荐方案，并与源码口径完全对齐（同模型隔离视角、独立专家三态/争议复核四分类、三层 No-Silent-Override 边界、SAM 2.1 探针前置依赖、PixelLab 后合成零渗漏 $\neq$ 接缝连续、`PixelProp` 与交互物确定性原语/派生资产分列口径）。
- 定向 Python 回归：`test_paper_experiment.py`、`test_prop_planning_limits.py`、`test_production_review.py`、`test_visibility_review.py`、`test_motion_adjustments.py`、`test_review_evaluation.py` 共 **120 项全部通过**；`test_adjustment_regions.py` 与 `test_open_motion_checkpoints.py` **25 项全部通过**；`test_open_motion.py`、`test_open_motion_recovery_media.py` 与 `test_interactable_panel_backend.py` **44 项全部通过**；`Tools/PixelProp/tests` **31 项全部通过**；`pip check` 无依赖冲突。全量 `Tools/SpritePipeline/tests`（排除跨服务 Node 写回）跑出 **871 passed、57 subtests passed**（其余 10 项失败均为受限环境无法写入本机 macOS Keychain 的凭据用例，与本批改动无关）。
- `PAPER-01`（Windows 历史真实作业盘点）与 `PAPER-02`（`keyframe_first` 基线命名/对照裁决）状态不变，继续在[问题清单索引](../README.md)跟进。

## 本目录文档

本页记录 2026-11-20 源码深度审计后的论文升级、跟进 `PAPER-03` 及新登记修复的 `PAPER-04`、`PAPER-05`、`PAPER-06`。
