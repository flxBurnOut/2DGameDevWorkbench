# 论文大纲重构与实验前现实修补

> 返回[问题清单索引](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | 2026-11-20T12:42:34-05:00，美东时间 |
| 基准提交 | `dce5a94041c2`，`paper-vbyc` |
| 归档提交 | `ed6d5dd17e65`（论文大纲重构与本批登记，提交时间 2026-11-20T12:58:24-05:00） |
| 登记问题 | PAPER-01、PAPER-02、PAPER-03 |
| 跟进问题 | — |

## 问题条目

| 编号 | 优先级 | 可观察现象 | 影响环节与验证方法 |
| --- | --- | --- | --- |
| PAPER-01 | 高 | Windows 机器上的真实历史角色作业尚未清点与回顾导出，无法区分开放动作作业（`full`）与旧版整段作业（`legacy`），导致论文 Section 3.2 动机研究与失败分类学缺少零成本基线数据 | **影响环节**：[实验支撑脚本](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py)（`inventory`、`export`、`legacy_export`）、[论文主文档](../../论文-序列帧长动作生成.md) Section 3.2 与 RQ1/RQ3。<br>**修补与验证**：在 Windows 机器对真实作业目录执行 `EXP inventory`，统计 `full` / `legacy` / `unreadable` 作业数、已复核段数、人工裁决数与修复数；向新建隔离目录执行回顾导出并完成失败类型人工标注，产出 Section 3.2 的描述性统计表（零新增 PixelLab 费用）。 |
| PAPER-02 | 高 | `keyframe_first` 对照组通过同生成器执行 4 帧动画调用并冻结末帧充当各段关键帧，而非独立静态图像关键帧生成；若论文直接命名为“关键帧先行”，易被审稿人质疑为不公平基线（Strawman Baseline） | **影响环节**：[实验支撑说明](../../motion-experiments.md)、[论文主文档](../../论文-序列帧长动作生成.md) Section 5 / 7.2、[实验支撑脚本](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py)。<br>**修补与验证**：正式付费实验前二选一拍板并写入冻结协议：① 推荐方案（低成本）：将论文口径与报告定性为**未验证推测端点接续（Speculative Unverified Endpoints）**，明确论证使用同生成器短程提案是为维持一致像素网格与画风分布、避免跨模型域偏移，并注明与代码组别 `keyframe_first` 的映射；② 补充方案（预算允许时）：在角色小样本上增加独立静态关键帧生成对照，检验两种端点来源差异。 |
| PAPER-03 | 高 | 确定性探针拦截 VLM 误判的统计未在回顾导出中与独立专家分歧解耦：`guard_measurements` 将测量冲突写入顶层 `report['requires_human_adjudication']` 并改写 `report['checks']`，而 `counterfactual_verdicts` 仅读取 `expert_review.requires_human_adjudication` 统计 `retained_contradictions`，既未输出探针拦截计数，也在计算 `final_review_wins` 时混入了已被探针改写的检查状态 | **影响环节**：[确定性测量守护](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py#L114-L135)、[回顾反事实统计](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L369-L385)、[论文主文档](../../论文-序列帧长动作生成.md) Section 6.2 与 RQ3。<br>**修补与验证**：扩展 `counterfactual_verdicts` 与 `retrospective.json`，拆出 `baseline_only`、`final_review_wins`（基于探针改写前的原始检查状态）、`without_probes` 三组反事实结论以及 `probe_overrides` 计数与帧级明细；用含拉杆归档帧和专家分歧夹具的单元测试复验解耦统计，并在真实实验或归档样本中整理至少 2–3 组“VLM 判通过 vs 确定性探针/专家分歧拦截”配对视觉对比案例用于论文主图。 |

## 记录

### 背景与评审诊断

2026-11-20 从 IEEE CoG 资深审稿人视角复审论文方向与 8 页草案，识别出三项主要拒稿风险：
1. 核心主张若停留在“先验证再接续”，易被视为常识性人机工作流包装，且 `human_verified > blind / model_only` 存在同义反复感；
2. 问题设定混入过多 PixelLab 特定 API 限制，降低跨生成器泛化价值；
3. 角色、交互物与局部编辑拼盘感偏重，且交互物在实测中通过率极低（首轮 1/8，第二轮采用 0/6），若强行定位为“第二成功领域”易反噬全篇。

### 本批文档重构

基于现有代码与实验支撑底座（不推翻底层实现），同步更新了《[论文：先验证，再接续](../../论文-序列帧长动作生成.md)》与《[论文方向与方法](../../论文方向与方法.md)》：
- **学术升维**：将问题抽象为“黑盒短视界端点条件生成器下的带不变量状态转移”，聚焦 2D 游戏精灵特有的隐性不变量漂移与 VLM 评审盲区，提炼三大核心机制（来源可追溯合同、非对称保分歧检查点门控、分级保不变性修复协议）。
- **结构调整**：把历史作业回顾分析前置至 Section 3.2 作为零成本描述性动机与失败分类学；把交互物重定位为刚体与锚点不变量压力测试领域；把 RQ2 聚焦于“游戏可用率 vs API 费用 / 人工耗时”的帕累托权衡。
- **源码核查（PAPER-03 证据）**：检查 `prop_measurements.py:114-135` 与 `experiment.py:369-385` 确认，`guard_measurements` 对 `report['checks']` 的就地改写与顶层 `requires_human_adjudication` 写入尚未被 `counterfactual_verdicts` 单独区分统计，导致拉杆测试中“VLM 一致误判通过、确定性探针拦下”这一核心案例目前无法在 `review_ablation` 中自动分离计数。

## 本目录文档

本页记录 2026-11-20 论文大纲重构背景及正式付费实验前登记的三项现实修补条目（`PAPER-01`、`PAPER-02`、`PAPER-03`）。
