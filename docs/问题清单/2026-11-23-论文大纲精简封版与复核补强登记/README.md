# 论文大纲精简封版与复核补强登记

> 返回[问题清单索引](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | `2026-11-23T10:24:23-05:00` |
| 基准提交 | `34f5231ce5d9`（本批仅改文档与问题清单，不改源码） |
| 归档提交 | `e3af4aa7d9c3` |
| 登记问题 | `PAPER-11`、`PAPER-12` |
| 跟进问题 | `PAPER-02`、`PAPER-10` |

## 问题条目

| 编号 | 影响环节 | 登记现象 | 验证方法 |
| --- | --- | --- | --- |
| PAPER-11 | [prop_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py#L86-L135)、[frame_checks.py](../../../Tools/SpritePipeline/sprite_pipeline/processing/frame_checks.py#L20-L76)、[dispute_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/dispute_review.py#L67) | 角色主实验缺少分段确定性探针接线；交互物铰接半径隐含平面内旋转假设（3/4 透视易误报）；争议聚焦图使用非整数缩放 | 复用 `frame_checks.py` 指标接入角色分段守卫；新增 `rotation_plane` 字段跳过平面外半径校验；聚焦图改为整数倍最近邻缩放居中并补单测 |
| PAPER-12 | [review_evaluation.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/review_evaluation.py#L260-L311)、[sprite-review-evaluation.md](../../sprite-review-evaluation.md) | 复核评测缺少等调用次数（5 次）无守卫投票基线、3×3 混淆矩阵与 Risk–Coverage 曲线；回顾导出缺逐段客观几何漂移计算 | 新增 `self_consistency` 与 `experts_no_guard` 离线基线、3×3 混淆矩阵、阈值扫描曲线与逐段漂移导出；后续在双人独立标注语料（开发集/保留集）上运行 |

## 记录

### v8 大纲精简封版与口径校准

复核 v7 大纲后，发现将 `PixelProp`、静态参考图局部编辑（属性计划、两阶段 Critic、`recompose-ai`）与交互物零生成派生（`T5` 色表、`T8` 旋转草稿、`T9` 倒放）一并塞进 8 页主干会导致叙事发散。本批将[论文主文档](../../论文-序列帧长动作生成.md)与[论文方向与方法](../../论文方向与方法.md)收敛为 **v8 封版**：

1. **收敛单主线**：8 页论文只聚焦“可编译状态转移合同 + 守卫检查点（弃权守卫与角色/交互物确定性探针）+ L1–L4 有界分级修复”，定稿标题为 *Verify Before You Chain: Guarded Checkpoints and Bounded Repair for Black-Box Sprite Animation*。上述旁支模块移出主文，产品功能不受影响。
2. **修正争议触发条件与拉杆定位**：补全三方一致判失败时亦触发争议核实（[independent_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/independent_review.py#L95)）；明确拉杆归档样本仅作“VLM 漏判过渡杆长”的定性引子，不作为 Teaser 阻断主证。
3. **指标客观化**：用可计量的检查点升级率（Escalation Rate）、API 成本与操作耗时替代“人类选择性注意力”等主观表述。
4. **清理过时进度引用**：[论文方向与方法](../../论文方向与方法.md) 第 5 节不再以停更于 11-14 的早期执行计划为准，统一指向[工程问题清单](../README.md)。

### 跟进问题

- **`PAPER-02`（命名已裁决）**：`keyframe_first` 组在论文中定名为“从初态生成的未验证端点提案（*Unverified Endpoint Proposal*）”，补全 [Chronos](https://arxiv.org/pdf/2611.05893)、[KeyID](https://arxiv.org/pdf/2608.16154) 与 [Lookahead Anchoring](https://arxiv.org/abs/2510.23581) 对比；是否加测静态关键帧小样本保留为可选项。
- **`PAPER-10`（移出论文阻塞路径）**：因 `PixelProp` 与 `T5/T8/T9` 已移出论文主文，`PAPER-10` 转为工作台产品改进任务，不阻塞论文实验。
