# 用户选帧修改与备选版本

“调整部分帧”用于对开放动作作品做局部修改，既支持处理专家指出的缺陷，也支持按个人审美偏好调整。选帧与填要求不建任务，点击 **生成一个备选** 或由获授权 Agent 提交后才建立独立修改任务。

## 1. 使用流程

1. 在分段确认或检查页点 **调整部分帧**，选择连续帧范围并填写修改要求（有用户输入时以用户原话为准，留空时采用该范围专家建议）。
2. 提交前核对调用上限（最多 1 次需求理解 + 1 次绘图 + 2 次基础或至多 5 次增强复核），选择生成方式（默认按帧数与要求推荐，可选免费替色、受限外观编辑或动作重画）。
3. 如需帧内空间保护，勾选 **精确限定修改区域** 并逐帧涂选。
4. 备选完成后同页同步播放原版与备选，对比完整片段与两侧衔接：界面独立显示 **修改目标（`change`）** 与 **其他内容保持（`preservation`）** 结论（区域模式另显示域外 RGBA 校验结果）。
5. 完整播放并填写简短结论、确认提醒后采用；保留原版不会删除备选或清零已记录费用。

- **帧号与复核约定**：需求理解使用页面一致的 1 起算原帧号；绘图提示只描述所选局部窗口。复核同步参照原版，不增加复核次数；继承来源作品冻结的复核版本（新作品为可见性核对版本 4，见[视觉复核文档](sprite-review-evaluation.md)）。

## 2. 保证与边界

| 维度 | 现行规则 |
| --- | --- |
| **范围与锁定帧** | 未选中帧逐字节保持原文件，不改帧序、帧数或 FPS。首帧、完整候选中已锁定分段锚点及停留帧始终受保护；当前未确认且后段未启动、未绑目标图的段尾可显式选中（标为“未锁定段尾”）。 |
| **区域保护模式** | 选区必须由用户逐帧显式提供（非空且非全图，不从结构观察自动推断）。因 PixelLab 无原生空间蒙版，原始返回会完整保留，交付图经本地二值后合成保证域外 RGBA 零改动；选区内质量与接缝须人工看图判定。未勾选区域模式时仅按时间窗口编辑，不做帧内像素锁定。 |
| **帧数限制** | 128 px 外观编辑限 2 帧；64 px 外观编辑限 2–14 偶数帧；运动过渡重画限 4–16 偶数帧。单帧、奇数帧或超范围在付费前直接拒绝，不自动扩选、换方法或拆成多次请求。 |
| **采用与派生** | 未锁定段采用后绑定新帧与备选报告（仍须确认该段）；完整候选采用会建立同一作品的新版本与原生作业，保留原版本与旧导出。修改目标优先于冲突的历史专家建议，且改善不可抵消新退化。 |
| **预算与重试次数** | 绘图次数按单帧计数，每帧在同一版本/候选/段中最多参与 2 次修改绘图（理解失败不占绘图次数但留规划账本，采用不清零）。先读上下文中的 `frame_attempts` 判定剩余次数，勿用任务总数推断。 |

### 协议与异常恢复

- **现行冻结协议**：意图格式 v4 使用严格 JSON Schema，在用户有明确要求时排除无关旧建议且不截断用户原话；区域任务冻结逐帧来源哈希与稀疏二值选区（`spatial_policy=source_pixels_v1`）；对比复核（`comparison_protocol=1`）在原预算内同时输出 `change` 与 `preservation`。
- **失败与幂等**：已有待处理或未知备选时阻止并行新建；同 `requestKey` 返回原任务；HTTP 拒绝仅保存状态码、错误码、参数名与提供方请求 ID，不自动重试或换模型。

## 3. MCP 操作

所有操作均属 `sprite-generator`：

1. `get-motion-adjustment`：传 `openWorkId`、`expectedRevision`、`candidateIndex`（可选 `stageIndex`，省略表完整候选），只读返回可编辑范围、建议、逐帧剩余次数与 `orderedFrames`。
2. `create-motion-adjustment`：传同一作品标识、`adjustmentToken`、零基闭区间 `adjustmentStart`/`adjustmentEnd`、可选 `adjustmentRequest`、`generationAuthorized=true`、`adjustmentBudget` 与稳定 `requestKey`；仅修外观时传 `adjustmentPreserveMotion=true`；需空间保护时附逐帧绑哈希的 `adjustmentRegions`（`{frame, source_sha256, spans:[{start,length}]}`）。
3. `workbench_get_task`（或带 `adjustmentId` 的 `get-motion-adjustment`）：轮询进度并读取原帧与备选完整帧路径。
4. `review-motion-adjustment`：传 `expectedRevision`、`adjustmentId`、`adjustmentToken=preview_token`（无预览拒绝时用 `source_token`）、`stageDecision=accept|reject`、`reviewNote` 与必要 `acknowledgeWarnings`。

## 确定性帧编辑

- **单帧局部编辑**：经图片编辑目标 `motion-frame`（`workId`/`workRevision`/`candidateIndex`/可选 `stageIndex`/`frameIndex`）进入共用图片工作区，按原图解析选区并转为 `FrameEditRegion`。采用动作保存为 `local_pixels_v1` 动画备选（回执 `saved_variant`，不消耗绘图次数、不调模型），随后在动画页播放并正式采用。
- **多帧色表替换**：经 MCP `edit-motion-frames` 或 HTTP `local-frame-edits`（网页支持“选中全部可编辑帧”）提交，允许单帧/奇数帧与整图选区，自动跳过锁定帧，保存后逐帧核验未选区域 RGBA。
- **修复级别记录**：任务 `repair_level` 区分 `deterministic`、`restricted_generation`、`window_redraw` 与 `stage_redraw`（仅覆盖段内全部可编辑帧，不动锁定边界）。

## 4. 模块与回归

核心实现位于 `Tools/SpritePipeline/sprite_pipeline/collaboration/`：`adjustments.py`、`adjustment_regions.py`、`adjustment_comparison.py`、`adjustment_review.py`、`adjustment_delivery.py`、`adjustment_import.py`（维护用 `register_saved_alternative` 关联已完成隔离备选）；前端位于 `motion-adjustment.tsx`、`motion-edit-region.tsx`。

回归测试：`pytest Tools/SpritePipeline/tests/test_motion_adjustments.py`、`npm run test:open-motion` 及相关 MCP/HTTP 回归。
