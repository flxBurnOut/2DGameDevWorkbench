# Codex 三路审查修复与协议登记

> 返回[问题清单索引](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | `2026-11-20T14:29:28-05:00` |
| 基准提交 | `897575b88afc` |
| 归档提交 | `ea982818aaeb` |
| 登记问题 | `PAPER-07`、`PAPER-08`、`PAPER-09`、`PAPER-10` |
| 跟进问题 | `PAPER-03`、`PAPER-04`、`PAPER-05`、`PAPER-06` |

## 问题条目

| 编号 | 影响环节 | 登记现象 | 验证方法 |
| --- | --- | --- | --- |
| PAPER-07 | [experiment_requests.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_requests.py#L229-L244)、[adjustments.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/adjustments.py#L245-L266)、[experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L303-L321) | 绘图预算仅约束 `model_only` 副本，未覆盖 `human_verified`；完成态只看候选有帧，未区分技术 QA 失败与整片视觉复核结局 | 全部绘图入口接入统一运行级账本（或预注册跨组差异），并分四层导出完成态结局 |
| PAPER-08 | [experiment_replay.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_replay.py#L130-L238)、[execution.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/execution.py#L253-L276) | 离线回放组取得上游 ID 后若在等待时中断，原目录无法续查恢复；交互物末段 `hold_frames` 未跨五组统一 | 为回放组补原目录恢复入口（已知 ID 续查原作业），并在冻结协议中跨五组统一 `hold_frames` 播放时间表 |
| PAPER-09 | [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L676-L810)、[motion-experiments.md](../../motion-experiments.md) | 盲评打包分母仅凭命令行入参决定，未核对预注册 `run_id` 清单；播放页缺少任务需求与参考图 | 引入预注册清单逐项对账并拦截诊断样本，在盲评页展示统一格式的需求与参考图（隐藏组别） |
| PAPER-10 | [pipeline.py](../../../Tools/PixelProp/pixel_prop/pipeline.py#L15-L131)、[recipe.py](../../../Tools/PixelProp/pixel_prop/recipe.py#L8-L44)、[tools-tab.tsx](../../../components/interactable-motion/tools-tab.tsx#L25-L188) | `PixelProp` 单个远处 `Alpha=1` 噪点会撑大裁切框并忽略 JPEG EXIF 方向；交互物面板固定区回填（`T1`）通道差启发式与旋转草稿（`T8`）起始帧前后端不一致 | 升级 `PixelProp` 算法版本（按有效 Alpha 阈值裁切并应用 EXIF 方向、更新黄金哈希），统一 `T8` 起始帧来源并改进 `T1` 预览 |

## 记录

### 三路代码审查范围

基于 `897575b88afc` 并行完成三路只读检查：
1. **增量变更复审（`d724350e9373`）**：发现 `without_probes` 误撤独立局部对比失败、`final_review_wins` 跳过最小帧门槛、内部状态锚点下 `redraw_only` 拒绝合法区间、v2 历史回放套用 v3 提示词规则、`blind_pack` 异尺寸拉伸与窄容器溢出。
2. **实验与资产管线检查**：覆盖 `experiment*.py`、`checkpoints.py`、`production_review.py`、`visibility_review.py`、`dispute_review.py`、`prop_measurements.py`、`derived_assets.py`、`local_frame_edits.py`、`frame-tools.ts` 与 `Tools/PixelProp`。
3. **论文与源码交叉核查**：发现 2026-11-11 拉杆案例的归因混淆了原始付费裁决与事后归档重放测试，以及多处术语和实现口径偏差。

以下高风险向后兼容问题在本批修复；需跨模块重构或升级黄金哈希的 4 项记为 `PAPER-07`–`PAPER-10`。

### 跟进修复与状态

- **跟进 `PAPER-03`（代码已修，待实测视觉案例）**：在 [experiment.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment.py#L379-L510) 与 [review_evaluation.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/review_evaluation.py#L19-L290) 补齐 2×2 反事实矩阵（`full`/`without_probes`/`without_retention`/`final_review_wins` + `baseline_only`）与逐维输出；保留 `adjustment_comparison` 独立失败结论；对争议提议补齐最小不同帧数门槛；`score_reviews` 同时支持角色与交互物两套维度并标明错误拒绝/放行极性。
- **关闭 `PAPER-04`（已关闭）**：[experiment_requests.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_requests.py#L13-L175) 为 v2 历史回放保留旧拼接逻辑（`legacy_prompts=True`）；终态提取先去尾空白且不重复写入 `End`；帧号平移只改写路标起首 `fN:`，不动句中普通引用。
- **关闭 `PAPER-05`（已关闭）**：[adjustments.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/adjustments.py#L174-L195) 与 [experiment_policy.py](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/experiment_policy.py#L33-L73) 在存在内部状态锚点时按锁点切分连续区间，按前序可播放区间计算最大合法偶数窗。
- **关闭 `PAPER-06`（已关闭）**：完善 `model_only` 组别防人工介入校验（API/检查点/调整/本地编辑全链路拦截，回顾导出标记历史越权）；修复 `retrospective` 在缺少提案帧时的崩溃及人工耗时漏记；盲评打包拒绝重复目录与异尺寸帧、采集无作业预检失败目录，播放页按容器宽度自动选整数放大倍数且非循环播完即停。
- **复核安全与交互物工具加固**：
  - `checkpoints.py` 补全帧号下界校验与降级提示 500 字符截断；
  - `visibility_review.py` 要求遮挡上下文包含观察帧外的前后参考帧，并拦截争议复核用空证据抹去专家疑点；
  - `vision_review.py` 在对 HTTP 200 拒答/不完整响应抛错前先落盘 `response_id` 与用量回执；
  - `derived_assets.py` 改用临时目录原子发布，倒放（`T9`）逐帧校验哈希，旋转草稿（`T8`）拒绝全透明帧，色表派生（`T5`）拒绝同色空映射；
  - `local_frame_edits.py` 拒绝零像素空改动，`frame-tools.ts` 的整数对齐（`T3`）跳过会裁切可见边缘像素的位移。

### 论文文档校准

同步更新《[论文主文档](../../论文-序列帧长动作生成.md)》《[论文方向与方法](../../论文方向与方法.md)》《[序列帧实验支撑](../../motion-experiments.md)》：
- 修正拉杆先导案例归因：原始付费评审中外观专家与争议复核已判固定斜撑缺失，所有 VLM 漏判的是过渡中主杆长度伸缩；铰接半径探针是在后续归档掩码重放中定位异常；
- 全文统一使用“六项非对称复核指标”和“错误拒绝 / 错误放行 / 弃权”术语，对齐 `model_only` 与 `human_verified` 工作流口径、共同可行配对子集、交互物三类通过率，以及 `PixelProp` 与 `T1/T3/T8/T9` 实际代码行为。

### 回归验证

- 核心与扩展 Python 回归（19 个测试文件）：**306 passed**；
- `Tools/PixelProp/tests`：**31 passed**；
- `node tests/interactable-motion/run.mjs`：**9/9 suites ok**（含 `T3` 不裁切边缘像素回归）。
