# 开放动作：从对象到交付

本指南用于创建新动作、继续分段制作、复核检查与导出。精确参数以 `sprite-generator` 当前 schema 为准；模型配置、界面详情与旧作业排错见[序列帧文档](../../docs/sprite-generator.md)，局部选帧调整见[选帧调整](../../docs/motion-adjustments.md)。

## 1. 规划与开始制作

1. **确定对象**：先读取对象库存和已有作品。新请求使用 `motionSpec.object_id` 和 `motionSpec.object_type`（类型从库存读取，旧 `character_id` 仍兼容）。
   - 已有角色预设可直接规划，不需要动作预设。
   - 128 px 物品原图支持 PixelLab 生成、本地导入或 PixelProp 转换后移送，流程见[物品原图导入与转换](../../docs/prop-art.md#导入与转换为动画原图)。若只有 GPT Image 物品大图，先执行 `reference-art convert-prop` 检查 `compare.png`，再带 `confirmation.note` 执行 `transfer`（用户未委托确认时先用 `workbench_present` 展示对比图）。
2. **提交规划（`plan-motion`）**：
   - 在 `motionSpec.description` 中保留用户原话，按需求填写 `ending`、候选数和预算。规划本身会调用模型；纯讨论只读数据。
   - **交互物状态骨架**：可在 `motionSpec.interactable_skeleton` 按顺序列出状态（首项为原图，最多 5 个），规划每对相邻状态对应一段，段数不符由本机校验退回。
   - **自定义模型**：通过 `planningModels` 按角色（`appearance` / `motion` / `strategy` / `coordinator`）指定模型，例如 `{"strategy": {"model": "kimi-k3.1-pro"}}`；冻结配置保存在作品的 `planning_config` 中，`revise-motion` 自动继承。
   - **预算控制**：PixelLab 规划前会读取可用额度；可通过 `motionSpec.budget` 设 `max_frames_per_request` 与 `max_total_frames`（含所有候选，播放停留不计绘图帧）。
3. **确认方案并生成（`generate-motion`）**：
   - 方案返回后只处理仍未明确的关键问题。`generate-motion` 必须绑定返回的 `revision` 与 `planSha256`。
   - 首次 `plan-motion` 且用户已授权连续制作时可传 `autoExecute=true`；`revise-motion` 不传或传 `false`，确认新方案后再生成。
   - 遇到带遮挡的刚体平移时，仅在用户明确要求尝试时传 `allowUnsupportedMotion`。
   - 追踪原 `taskId` 与 `?work=<openWorkId>`，切换候选时保留准确的版本与候选索引。

### 交互物合同与视觉复核要点

- **交互物核对**：规划合同核对视角、初态与部件归属。仅外观文字与参考图不一致时以参考图为准，不阻断制作；影响运动或固定部件集合的差异在规划阶段解决。铰接和形变先选定已核对结构，将各部件归入运动或固定清单（铰接另指定轴点与运动端点），检查阶段结合画面、去遮挡后的固定区像素变化与铰接半径综合判断。
- **复核协议**：新任务默认启用增强复核（基础 2 次 + 外观/运动独立专家各 1 次 + 有争议时最多 1 次复核；基础协议最多 2 次），详细机制见[视觉复核文档](../../docs/sprite-review-evaluation.md)。涉及角色结构辅助或时序观察见[角色视觉结构](../../docs/visual-structures.md)。

## 2. 网页入口与交互物动画面板

需要用户在网页查看或手动操作时，用 `workbench_present` 打开准确页面：

- **交互物动画**：`object_type=interactable` 的作品默认在 `/tools/interactable-motion` 打开（可带 `?work=<openWorkId>&document=<id>&definition=<definitionId>`），支持在面板内生成、导入或转换物品原图；完整界面与工具说明见[交互物动画面板](../../docs/交互物动画独立面板方案.md)。
- **写回与绑定**：交互物编辑器“制作状态动画”会先保存工程再跳转面板。写回统一经 `import-motion-asset` 提交，可附 `durations`（逐帧相对时长）和 `playback: ping_pong`（仅改写回片段，不动原帧与导出）；只读查询槽位绑定用 `workbench_get_motion_bindings`。
- **确定性工具与派生素材**：固定部件回填、对齐、批量清理和旋转草稿经 `local-frame-edits` 存为完整播放备选，需对比后采用。倒放、旋转草稿、色调派生与上传状态图属于派生素材，目前只在网页面板创建并经人工播放确认后入库。

## 3. 分段与完整检查

1. **追踪进度**：复核期间用 `workbench_get_task` 查 `presentation.reviewProgress`；用 `workbench_get_result` 查 `pendingCheckpoints` 中的片段 token 和 `readyForDecision`。
2. **读取序列并看图**：片段就绪后调 `get-motion-stage` 获取指定候选和零基 stage 的全序列，用 `workbench_get_result`（`detail:true`, `section:"/result/orderedFrames"`）读帧路径。按实际 FPS 检查运动、末姿势、装备与接缝，然后用原 `stageToken` 和 `workRevision` 调 `review-motion-stage` 并写明观察结论。
3. **多状态链规则**：用 `get-motion` 查 `state_chain`（首项为参考原图，后续含来源段、帧号与 PNG 哈希）。`get-motion-stage` 中 `frame` 从零计且不含输入参考，`raw_index` 从零计且含上下文帧。可先用 `accept_state` 锁定真实状态帧，之后仍须裁决过渡；若拒绝过渡，已锁定状态图保留，后段停止。
4. **选帧截尾与目标图**：若目标姿势早于越界尾段，查看完整序列后可传 `anchorFrame` 和 `acknowledgeTrim` 截尾（原始帧仍保留）。制作前已有目标状态图时可用 `target-motion-stage` 绑定，输出端点仍取真实生成帧。
5. **完整验收**：接受的真实末帧作为下段输入。完整复核显示 `readyForApproval` 后，播放整段动作确认接缝，再由用户或获委托的主 Agent 裁决。

## 4. 调整与任务恢复

- **选帧修改**：用户审美偏好也是有效目标，不要让专家建议覆盖用户原话。先调 `get-motion-adjustment` 查可编辑范围，再按授权额度创建备选；已开始后段依赖的锚点、跨段范围及不支持的帧数会被接口拒绝。查看原版、备选全序列与两侧衔接后再决定采用或保留原版（旧 `repair-motion-stage` 任务沿用其原 attempt/token）。
- **异常恢复**：查询刷新继续原任务；提交中断或结果不明时，先查原回执和远端 ID，通过 `recover` / `attach-provider-job` 恢复，避免重复付费提交。

## 5. 采用、导出与交付

- 实际看图检查后填写 `reviewNote` 并确认已评估的提醒；技术硬错误须先处理，模型报告不能代替实际看图。
- 采用后导出准确候选，标准产出包含 PNG、预览、配方/QA 与单动作 Godot SpriteFrames ZIP（历史导出若缺 Godot 包，可对已有候选补导出）。
- 最终帧数、FPS 与 loop 以导出配方为准。接入游戏请继续使用[游戏工程 Skill](../../.agents/skills/forge-game-engineering/SKILL.md)。
