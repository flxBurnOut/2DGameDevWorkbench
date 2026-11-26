# 源码审计论文升级与实验支撑修复

> 返回[问题清单索引](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | `2026-11-20T13:37:44-05:00` |
| 基准提交 | `15365894c8a8`（`paper-vbyc`） |
| 归档提交 | `d724350e9373`（`2026-11-20T13:44:07-05:00`） |
| 登记问题 | `PAPER-04`、`PAPER-05`、`PAPER-06` |
| 跟进问题 | `PAPER-03` |

## 问题条目

| 编号 | 影响环节 | 登记现象 | 验证方法 |
| --- | --- | --- | --- |
| PAPER-04 | [experiment_requests.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_requests.py) | 12 行结构化绘图简报（原策略 6）在 `single` 组直接拼接会重复模板头、`keyframe_first` 组机械加前缀，导致合法 16 帧双段或近上限单段在预检被误拦截 | 仅超 1,000 字符时确定性去重共享标签并平移局部帧号，或提取终态姿势行；在 [test_paper_experiment.py](../../../Tools/SpritePipeline/tests/test_paper_experiment.py) 验证不截断且超限仍拦截 |
| PAPER-05 | [experiment_policy.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_policy.py)、[adjustments.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/adjustments.py) | `redraw_only` 消融在偶数帧未锁定段上出现奇偶死锁（仅首帧锁定后余下奇数帧，无法满足偶数窗要求） | 可编辑帧为奇数时允许头对齐或尾对齐的最大合法偶数窗（$N - 2 \ge 4$），继续拒绝局部小窗与其他工具；在 `test_paper_experiment.py` 验证 8 帧未锁定段 |
| PAPER-06 | [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py) | 盲评离线播放页只有单个 1× 视图，缺少论文约定的 1× 原尺寸与整数倍放大双视图及背景切换 | 为 `clips.json` 补宽高，升级播放页提供并排双视图、三背景切换与逐帧步进，且不泄漏组别信息 |

## 记录

### 跟进 `PAPER-03`（修复崩溃并解耦反事实统计）

- **根因**：[prop_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py#L114-L135) 生成的探针冲突条目不含 `proposal` 字段，合并写入 `expert_review.requires_human_adjudication` 后，导致 [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L369-L385) 在真实触发探针拦截时直接 `KeyError` 崩溃。
- **修复**：探针冲突条目新增 `'source': 'deterministic_probe'`；重写 `counterfactual_verdicts()`，兼容无 `source` 的旧记录，拆分输出 `baseline_only`、`without_probes`、`final_review_wins`（基于探针改写前的状态）、`retained_contradictions`、`probe_overrides` 与明细。
- **验证**：`test_paper_experiment.py` 覆盖新旧两类探针记录，零崩溃且三组反事实结论准确解耦。代码侧已修复复验，剩余待正式实测或归档整理配对视觉案例。

### `PAPER-04`–`PAPER-06` 修复结果

- **`PAPER-04`**：在 `experiment_requests.py` 新增 `_single_arm_prompt` 与 `_pose_arm_prompt`，普通文本和未超限简报保持原样，超限时确定性去重或提取终态行（不调用模型、不静默截断）。
- **`PAPER-05`**：在 `experiment_policy.py` 抽出 `is_stage_redraw_range()` 供 `adjustments.py` 共用，支持最大合法偶数窗重画。
- **`PAPER-06`**：升级 `experiment.py` 盲评播放页为 1× + 整数倍最近邻双视图与背景切换。

### 论文口径校准与回归验证

- 对照 `Tools/SpritePipeline/sprite_pipeline/collaboration/`、`Tools/PixelProp/`、`features/interactable-motion/` 与 `lib/workbench/` 源码，将两篇论文文档和 `motion-experiments.md` 校准至实际代码口径：明确同模型隔离视角复核、独立专家三态与争议四分类、不沉默覆盖边界、SAM 2.1 仅作前置追踪器，以及后合成“域外零渗漏 $\neq$ 接缝连续”。
- **Python 回归**：核心与实验专项 189 项全通过，`Tools/PixelProp/tests` 31 项全通过，`pip check` 无冲突；全量 `Tools/SpritePipeline/tests`（排除跨服务 Node 写回）通过 **871 项、57 个子测试**（另有 10 项因沙箱无法访问 macOS Keychain 失败，与本批无关）。
- `PAPER-01`、`PAPER-02` 状态未变，继续在总索引跟进。
