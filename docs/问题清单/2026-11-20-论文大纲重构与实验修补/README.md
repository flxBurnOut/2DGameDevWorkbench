# 论文大纲重构与实验前修补登记

> 返回[问题清单索引](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | `2026-11-20T12:42:34-05:00` |
| 基准提交 | `dce5a94041c2`（`paper-vbyc`） |
| 归档提交 | `ed6d5dd17e65`（`2026-11-20T12:58:24-05:00`） |
| 登记问题 | `PAPER-01`、`PAPER-02`、`PAPER-03` |
| 跟进问题 | — |

## 问题条目

| 编号 | 影响环节 | 登记现象 | 验证方法 |
| --- | --- | --- | --- |
| PAPER-01 | [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py)、[论文主文档](../../论文-序列帧长动作生成.md) Section 3.2 | Windows 历史真实角色作业尚未清点与回顾导出，缺少零成本基线数据 | 执行 `inventory` 区分 `full`/`legacy`/`unreadable` 作业并导出到隔离目录，产出失败分类与漂移统计 |
| PAPER-02 | [motion-experiments.md](../../motion-experiments.md)、[experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py) | `keyframe_first` 组实际由同生成器出 4 帧并锁末帧，直接称作“关键帧先行”易被质疑为不公平基线 | 正式实验前二选一拍板：论文更名为“未验证端点提案”并说明原因，或在预算允许时加测独立静态关键帧小样本 |
| PAPER-03 | [prop_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py#L114-L135)、[experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L369-L385) | `counterfactual_verdicts` 未把确定性探针拦截与独立专家分歧拆开统计，且 `final_review_wins` 混入了探针改写后的状态 | 拆分 `baseline_only`、`without_probes`、`final_review_wins` 及 `probe_overrides` 计数并用单测复验，另整理 2–3 组配对视觉案例 |

## 记录

### 评审视角诊断

从 IEEE CoG 审稿视角复审早期草案，梳理出三类主要拒稿风险：
1. 若核心主张只停在“先验证再接续”，易被看作常识性工作流包装；
2. 问题设定绑定过多 PixelLab API 细节，削弱了面向通用黑盒生成器的泛化性；
3. 角色、交互物与局部编辑拼盘感较重，且交互物早期小测通过率低（首轮 1/8、第二轮 0/6），不宜强行包装为“第二成功主域”。

### 大纲重构要点

在不改动底层实现的前提下，同步修订了《[论文：先验证，再接续](../../论文-序列帧长动作生成.md)》与《[论文方向与方法](../../论文方向与方法.md)》：
- 将问题抽象为短视界黑盒生成器下的带不变量状态转移，聚焦 2D 精灵的隐性漂移与 VLM 评审盲区，收拢为可编译合同、保分歧检查点与分级修复三大机制；
- 把历史作业回顾分析前置至 Section 3.2 作为描述性动机与失败分类统计；
- 将交互物重定位为刚体不变量压力测试领域，主实验聚焦“游戏可用率 vs API 成本 / 人工开销”的权衡。
