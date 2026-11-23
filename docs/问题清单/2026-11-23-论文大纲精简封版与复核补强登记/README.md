# 2026-11-23 论文大纲精简封版与复核补强登记

| 项目 | 内容 |
| --- | --- |
| 记录时间 | `2026-11-23T10:24:23-05:00` |
| 基准提交 | `34f5231ce5d9`（仅修改文档与问题清单，零源码改动） |
| 归档提交 | `e3af4aa7d9c3`（v8 大纲精简封版与问题登记提交） |
| 登记问题 | `PAPER-11`、`PAPER-12` |
| 跟进问题 | `PAPER-02`、`PAPER-10` |

## 1. 本批背景

综合对 v7 大纲的外部审稿交叉核查意见与源码逐行复核，确认前一版大纲虽与全仓库源码逐条对齐，却将 `PixelProp`、静态图局部编辑/`recompose-ai`、交互物 `T5/T8/T9` 派生以及底层类名/常量一并塞入 8 页主干，反而加重了“工程流水账”观感；同时角色主实验尚缺确定性探针分段接线，离线复核亦缺乏等调用次数投票基线与风险–覆盖率（Risk–Coverage）评估。

本批在不改动任何产品功能与源码的前提下，将 [论文主文档](../../论文-序列帧长动作生成.md) 与 [论文方向与方法](../../论文方向与方法.md) 收敛为 **v8 精简封版**，拆开“8 页论文唯一主线”与“全栈工程总账”，并登记正式实验前优先级最高的零绘图费补强任务 `PAPER-11` 与 `PAPER-12`。

## 2. 本批新登记问题

| 编号 | 优先级 | 现象与影响环节 | 建议修补与验证方法 |
| --- | --- | --- | --- |
| PAPER-11 | 高（零生成费） | **角色主实验缺少分段确定性探针接线、铰接平面假设未显式化及聚焦图非整数缩放**：<br>1. [prop_measurements.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py#L86-L135) 仅在绑定物品结构策略时启用探针，导致角色主实验上 2×2 消融的探针维度为空；而 [frame_checks.py](../../../Tools/SpritePipeline/sprite_pipeline/processing/frame_checks.py#L20-L76) 已包含地面基线偏移、面积变化、质心速度跳变与调色板偏离指标，仅未接入分段 `guard_measurements`。<br>2. 交互物铰接半径守恒隐含平面内正交旋转假设，3/4 透视旋转的合法缩短会被误报；<br>3. [dispute_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/dispute_review.py#L67) 聚焦图当前使用非整数缩放比例 `min(320/w, 320/h)`，与论文像素级保真及盲评整数倍原则不完全一致。 | 1. 在保留既有任务归档兼容性的前提下，新建角色测量接线模块，复用 `frame_checks.py` 的地面基线、面积、质心与调色板指标接入分段 `guard_measurements`（阈值仅在独立开发集上标定冻结）；<br>2. 为交互物合同增加 `rotation_plane` 字段，标记为平面外旋转时显式跳过半径探针并报告保留集错误拒绝率；<br>3. 将聚焦图改为 `max(1, 320 // max(w, h))` 整数倍最近邻缩放居中留白（同步升级证据协议以兼容历史归档），并补全单元测试验证。 |
| PAPER-12 | 高（仅离线 VLM 费用） | **复核协议缺少等调用次数无守卫基线、风险–覆盖率曲线与客观段级漂移导出**：<br>1. 专家复核最多使用 5 次调用而基线仅 2 次（[sprite-review-evaluation.md](../../sprite-review-evaluation.md#L42) 亦声明两者非等成本对照），现有实验尚无法区分收益源自程序守卫还是调用次数增加；<br>2. [review_evaluation.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/review_evaluation.py#L260-L311) 当前仅输出包含重叠关系的 6 项整数计数（`missed_defects` 包含 `false_negative`、`unnecessary_blocks` 包含 `false_positive`），缺乏三态混淆矩阵、置信度阈值扫描下的 **错误放行率–自动覆盖率（Risk–Coverage）曲线** 与双人独立标注语料（含 `uncertain` 标注规范与一致性 $\alpha$）；<br>3. `retrospective` 尚缺随段位累积的客观几何漂移导出。 | 1. 构建并划分开发集/保留集的冻结 `ReviewEvidence` 语料（角色与交互物，明确三态标注规程，$\ge 2$ 名独立标注员并报告 Krippendorff's $\alpha$）；<br>2. 在 `review_cli.py` / `review_evaluation.py` 增加等调用次数基线模式（`self_consistency` $k$ 次投票与无守卫汇总 `experts_no_guard`），支持输出 3×3 混淆矩阵、阈值扫描 Risk–Coverage 曲线及多 VLM 模型横向评测；<br>3. 在回顾导出中添加逐段地面基线、面积、轮廓重叠度与调色板距离计算，支撑 Section 3.2 客观漂移曲线。 |

## 3. 跟进问题与大纲事实校准记录

### 3.1 跟进 `PAPER-02`（大纲命名已裁决）
- 在 [论文主文档](../../论文-序列帧长动作生成.md) Section 5 / 7.3 与 [论文方向与方法](../../论文方向与方法.md) 第 2 节正式定案：`keyframe_first` 对照组在论文中定名为 **“从初态生成的未验证端点提案（Unverified Endpoint Proposal）”**，保留代码标识 `keyframe_first`。
- 相关工作补齐近期关键帧与锚点防漂移文献对比：[Chronos](https://arxiv.org/pdf/2611.05893)、[KeyID](https://arxiv.org/pdf/2608.16154) 与 [Lookahead Anchoring](https://arxiv.org/abs/2510.23581)。
- 是否追加独立静态关键帧小样本仅作可选补充，不再阻塞大纲封版与离线实验推进。

### 3.2 跟进 `PAPER-10`（移出本篇论文阻塞路径）
- 经 v8 大纲精简封版，`PixelProp` 内部算法细节与交互物 `T5/T8/T9` 零生成派生已全部移出 8 页论文主干贡献（产品代码保持不变）。因此 [2026-11-20 Codex三路审查修复与协议登记](../2026-11-20-Codex三路审查修复与协议登记/README.md) 中登记的 `PAPER-10` 降级为工作台产品工具改进项，不再阻塞本篇论文实验。

### 3.3 大纲精简封版与事实校准细节
1. **剥离旁支模块（只改大纲，不改源码）**：将静态参考图编辑（属性计划、两阶段 Critic、`recompose-ai`）、`PixelProp`（[recipe.py](../../../Tools/PixelProp/pixel_prop/recipe.py#L35) 将 `colors` 限在 `0..64`，仅外部显式 >64 色调色板走 [quantize.py](../../../Tools/PixelProp/pixel_prop/quantize.py#L78) KD-Tree）与 `T5/T8/T9` 派生从 8 页核心叙事与 Contributions 中剔除；核心主线精简为“可编译状态转移合同 + 守卫检查点（弃权守卫与统一探针）+ L1–L4 有界分级修复”，标题精简为 *Verify Before You Chain: Guarded Checkpoints and Bounded Repair for Black-Box Sprite Animation*。
2. **修正争议触发条件与拉杆定位**：对照 [independent_review.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/independent_review.py#L95) 补全“三方一致判 `fail` 时亦触发争议复核（`verify_claimed_defect`）”；明确拉杆归档序列（阈值在同样本冻结且重放曾用脚本通过意见）仅作“VLM 漏判过渡杆长”的定性引子，从 Teaser 实测阻断主证中撤出。
3. **移除客观不可证的人类注意力表述**：将 RQ 与实验指标中的心理学“选择性人类注意力”表述替换为可客观计量的 **检查点升级率（Escalation Rate）**、API 成本与后端记录耗时，并在 Threats to Validity 明确界定研究者按预注册规程操作的工作流对比边界。
4. **修正《论文分支执行计划》过时引用**：[论文方向与方法](../../论文方向与方法.md) 第 5 节不再写“以停留在 11-14 的《[论文分支执行计划](../../论文分支执行计划.md#L29)》为准”（该计划 1.1 节仍保留早期口径），统一以[工程问题清单](../README.md)为准。
