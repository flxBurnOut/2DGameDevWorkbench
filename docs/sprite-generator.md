# 序列帧生成工作区

> 状态：当前维护。机器契约以 `workbench/manifest.json` 中的 `sprite-generator` 为准。

`/tools/sprite-generator` 默认是 React 五阶段工作区（开放动作），角色与交互物共用对象、分段方案和检查点。旧预设和逐帧编辑保留在旧版工作区 `?legacy=1`。

本工具是 Forge 对 `NativeFramesGeneration` 的集成扩展：完整本地工作台保存在 `Tools/SpritePipeline/`，开放动作实现在 `Tools/SpritePipeline/sprite_pipeline/collaboration/`，不表示独立上游已发布相同功能。上游来源 `https://github.com/flxBurnOut/NativeFramesGeneration.git`，当前同步基线为提交 `4f7f4cc4bee625d75c53570887ddf184dbe380ba`（2026-09-08，攻击动作连续性检查、参考图画布与动画播放器更新），并保留工作台任务跳转、当前任务同步及帧图 / 导出产物下载接口。上游所有者已于 2026-09-04 确认以 MIT License 发布，见 `Tools/SpritePipeline/LICENSE` 与根目录 `THIRD_PARTY_NOTICES.md`。

全篇通用规则：模型报告不自动修改、重画或采用素材；新规则只用于新建或显式修订的工作，旧任务、导出和哈希不升级；失败、中断或结果未知的请求保留回执，不自动重发。

## 五阶段主流程

步骤为“准备与描述 → 查看制作方案 → 自动制作 → 检查与调整 → 导出与使用”。每阶段只有一个主要推进操作；候选数量、预算、技术记录与恢复工具按需展开。打开页面、编辑描述或选择素材不创建生产任务；明确点击“制定方案”才持久保存并调用规划模型。描述草稿保存在当前浏览器，提交后的作品保存在 `work/sprite-pipeline/open-motion/`。已有作业可通过精确 `job` 链接打开，新作业的旧式资产链接按 `open_plan` 绑定打开对应作品版本。

- **准备：** 使用已有角色、上传透明 64/128 PNG，或先到原图模块生成并移送。描述动作、结束姿势与是否循环；不需要为新动作添加 preset、代码分支或专用系统提示词。
- **方案：** 外观与动作专家先独立观察，策略专家综合建议，协调专家形成结构化方案（见[规划](#规划)）。
- **制作：** 最多四个顺序片段，每段 4–16 偶数帧，计划与实际动画均至多 64 帧。叙事阶段不必对应一次调用，连续事件与自然收势优先一起生成。后段使用上段已确认的真实末帧；末帧可用制作前绑定的目标图片（见[段末目标图](#段末目标图)）。
- **节奏与原始帧：** 新方案可安排 FPS，选择固定 FPS 时必须遵守。原始返回完整保留；播放映射只移除“返回数恰好多一帧，且首帧与输入参考画面相符”的额外上下文帧，不删除实际动作姿势、不压缩有意停顿、不插帧或倒放。
- **检查：** 每段完成后停在“确认第 N 段”，最后检查完整动作（见[分段确认](#分段确认)与[视觉复核](#视觉复核)）。
- **采用：** 底部列出尚未满足的条件：完整播放确认、至少 4 个字的检查结论、技术提醒确认，以及未处理的阻断 / 修补帧。满足这些条件不会跳过服务端校验。对未通过 / 不确定报告的人工裁决还需明确接受提醒，技术硬错误仍禁止采用。
- **交付：** 采用后可重复导出 PNG/GIF/Godot；Godot 使用共享项目路径选择及 WorkBuddy 交接提示。不同版本和候选使用不同导出文件，旧素材保留。游戏脚本接入与 Godot 实机验收由外部 Agent 完成。

### 规划

**专家与调用。** 外观与动作专家先独立观察，策略专家综合建议，协调专家发布方案。专家可请求原图局部观察或向其他专家提出具体问题，全部受调用上限约束。每条要求标注来源：用户原话、参考图观察或专家建议。用户原始描述完整附入方案，模型对原话的改写标为“专家解读”。无法确定的关键问题进入 `plan.questions` 并阻止执行。

**校验与修正。** 规划发现完整响应中的字段错误，或本机发现预算、终态等方案错误时，可在本次授权上限内请出错角色修正一次，且要为剩余专家预留调用。超时、请求失败、响应未完成和规划预算用尽时停止并保留回执。

**进度显示。** 按每位专家最近一次调用显示。“提出建议”“提交方案”不等于本机校验通过；校验反馈表示拒绝，不显示成功勾号。失败、中断、未知结果和预算耗尽不会继续转圈。含关键问题的方案不标为已通过执行校验。刷新只读状态，不重发模型请求。

**重新规划。** 失败页以“重新制定方案”替换不可用的制作按钮，显示重新规划额度，并保留返回修改入口。显式重新规划使用新的请求标识和作品版本，输入可以不变。提交未收到确认时，重试沿用原请求标识。服务先保存请求与作品的绑定，再发布可规划的作品。重启后服务继续发布已有回执的准备记录，客户端可用 `GET /v1/open-motion/requests/{request_key}` 只读查询原始版本。修订通过校验并发布新版本后，旧版本停止后续提交。

**沿用观察。** 明确修订作品时，原图、结构、配置及适用的规划协议一致，才可沿用角色原图的独立外观观察；动作观察和交互物外观观察还要求任务描述、预算和有效绘图上限一致。沿用的观察标明来源版本，节省本次调用。

**回到原图。** `return_to_reference` 默认为 false。用户勾选“结束时回到原图姿势”后才允许把原图绑定为末帧。不要求回原图不等于禁止自然收势。

**质量合同与绘图文本。** 质量合同 v3 让每段描述可见末姿势、段内节奏和分段理由；v4 把完整动作意图留给规划和验收，每段 `motion` 合同区分相机、身体朝向、物体轨迹、支撑与发力、物品归属、进入 / 离开时的运动，以及连续经过 / 收稳 / 有意停顿。合同还含 3–6 个通用关键姿势及大致帧位置，描述身体、肢体与装备的可见相对位置及发力范围，不针对动作名称写分支。这些是可见关系和专家推断，不是动作名称规则、骨骼锁定、物理模拟或模型保证的精确关键帧。

绘图只接收当前段的过渡、外观、局部节奏、目标姿势与本段关键姿势。规划内部版本冻结在 `generation_policy_version` 与 `visibility_review_version`，新建或显式修订的正式工作默认分别为 6 和 4：

- 策略 6 的定稿使用方案已有的段目标、整段关键姿势、运动约束和检查点；服务把关键姿势换算为各段内部帧号，加入停顿区间和衔接方式，组装绘图提示。
- 方案页的生成描述就是提交给 PixelLab 的完整文本，每段最多 1,000 字符；超长在提交前阻止，不静默截断。
- 实际生成提示词在开始制作时校验并冻结，后续代码或设置变化不会改写正在执行的片段。
- 可选质询为后续必要环节预留调用次数。

各策略版本（含隔离实验的策略 1/2）的差异见[角色视觉结构 · 规划与绘图策略](visual-structures.md#规划与绘图策略)。

**交互物方案**会列出描述与参考图的差异、影响和处理方式；仅外观描述不一致时以参考图为准。铰接和形变需选择已核对的结构（在交互物动画面板状态图下方的“部件结构”中选择），铰接还需可见的固定轴点和端点部件。

### 预算与额度

**绘图帧数。** 支持单次帧数上限和所有候选合计帧数上限。规划前读取 PixelLab 余额，定稿按每个分段分别向上取整估算单位。只有订阅次数时按剩余次数折算可规划帧数；有美元余额时保留用户帧数上限，实际费用由 PixelLab 确认。可核实的余额或用户上限连每候选最少 4 帧也覆盖不了时，停止规划调用。读取失败显示“额度未知”，用户上限仍然生效。

**生成空位。** 同一 PixelLab 凭据的原图和动画共享生成空位。原生状态 `queued` 表示等待空位，工作台显示原因，可继续查询原任务。`not_submitted` 表示请求在生成前被阻止，或提供方明确拒绝且没有产物、受理回执与用量，可在历史中查看。

**视觉调用。** 新前端默认每候选最多 25 次视觉请求：`experts_v1` 预留 `5 ×（分段数 + 1）× 候选数`，覆盖最多四段和整段；基础协议为 `2 ×（分段数 + 1）× 候选数`；上限最高 200，修复后的复查和历史请求继续计入。准备页展开预算可切换协议，改用旧协议不删除旧报告。MCP 新请求未给协议和视觉上限时用增强协议；只显式给出旧视觉上限而未声明协议的请求沿用基础协议。

状态骨架已确定过渡段数时，服务在调用专家前检查所有候选最低需要的生成次数、绘图帧数和复核额度，并按每段分别计费核对已知的 PixelLab 余额。专家定稿后再按实际分段和帧数校验。方案超预算时保留需要调整的事项。暂停会阻止后续绘制提交，已提交的请求仍保存回执。

### 段末目标图

方案页直接显示实际段末图片的绑定情况，未绑定的段明确为文字引导。展开“用已有图片约束段末姿势”可绑定已检查的同尺寸透明 PNG（MCP `target-motion-stage`，见下文）。此操作本地保存，不生图。

开始制作后目标图与哈希冻结。每段首图仍为原图或上段已确认末帧，目标图通过真实 `last_frame` 输入传递，只作绘图条件，不替换输出末帧；实际生成的末帧仍须检查后才能接续。目标集摘要与 PNG 哈希变化会阻止旧页面提交；原生请求省略目标摘要时保持旧接口兼容。原图终态仍需明确约定，不能借上传同一张原图绕过意图限制。

### 分段确认

完成一段后，系统观察实际全帧、检查该段目标与装备连续性，然后停在“确认第 N 段”。用户或 Agent 必须实际检查后裁决，模型通过也不自动放行。

- 确认时复制真实播放帧为不可变快照，把实际最后一张 PNG 作为后段输入；不替换成想象的端点、不倒放、不补帧。原图继续作为外观复核依据。
- 每个确认绑定版本、方案、输入图片和全部实际帧的摘要；内容改变、错版本、未确认上一段或快照被改动都会阻止继续。“继续”不能绕过检查。
- **目标姿势提前到达**：末尾越过目标时，展开“目标姿势提前到达时，选择实际锚点”，选择真实帧作为本段终点，并确认采用范围与原因。后段使用该图片，播放快照只含起点至所选帧，原始尾帧留在记录中。MCP 对应 `anchorFrame`（当前播放片段零基索引）与 `acknowledgeTrim=true`，省略时使用最后一帧。这是显式人工截取，不是模型自动裁帧；原报告针对完整原片段，截取依据记在人工结论，最终复核使用实际组装顺序。
- **不合格**：可停止后续制作，原始结果与已确认片段保留。修改描述会创建新版本，不自动局部重画或复用旧阶段。分段模型中断时保留回执、转人工检查。
- 最后一段也要确认，随后组装并对完整动作复核接缝、事件与节奏。片段通过不代表完整动画通过。

交互物以真实末帧登记状态图。

### 视觉复核

技术 QA 后先执行两次基础视觉请求：记录所有实际帧，再核对完整性、装备一致性和节奏。新任务默认使用[独立视觉专家与争议复核](sprite-review-evaluation.md)（`experts_v1`）：再增加外观与运动两次独立意见，有争议时最多再复核一次。协议和预算随任务冻结，旧任务不补收费检查。复核建议取消原缺陷时仍须实际画面确认。

报告必须覆盖完整帧序、三个维度和有效帧号；失败、低置信度、中断或修改后过期的报告不能标为通过。视觉请求失败、结果未知与报告过期分开显示，既有图片与错误记录保留。人工仍须完整播放并记录结论；人工确认可填写实际检查秒数，留空按未知记录。

视觉模型在本页统一配置：图片部件定位使用 appearance 角色，成品复核使用 reviewer 角色，模型与端点随请求冻结。免费模拟策略、成本导出和匿名包见[实验支撑](motion-experiments.md)。

**辅助测量。** 像素变化测量只提示可能的近静止帧对，忽略透明 RGB；光效也会产生变化，所以不能据此证明身体运动、发力正确或自动通过。交互物检查页可展开逐帧测量，对照固定部件像素变化、半径与模型意见；测量与通过意见冲突时需人工裁决，原始意见保留。单角色单种子对照只说明该样本，不证明普遍提升。

**结构（可选）。** 准备页提供[角色视觉结构](visual-structures.md)：语义部件、可见区域、锚点和关系可叠加检查、本地纠正及版本恢复。一次静态解析用一次语义模型调用，查看与纠正不再调用、不改原图。已确认的结构可显式选入动作规划和段级绘图提示，既有 `motionSpec.visual_structure` 使用精确分析身份和 token，不增加独立 MCP 操作；未选择时保留旧行为，结构确认与动画审批分开。完整与分段播放器可接入时序结构观察：复用已确认的原图结构，默认免费本地追踪，可显式追加一次关键帧语义核对；纠正与恢复只改观察版本。结构辅助复核另存意见，最多三次调用，复用冻结基线并校验要求来源，不改变原候选状态或自动生成。

### 修改部分帧

检查页提供三类修改，都先成为备选，在完整播放对比中决定采用。已锁定状态图、段首段尾及停留帧受保护，未锁定段尾可编辑。完整候选采用会建立新版本，旧原始帧和导出保留。

- **调整部分帧**：选择连续范围，按专家建议试做或填写个人偏好；原版通过检查也可以调整。每次明确提交是独立修改任务，用户原话优先。可选免费确定性替色、受限生成或动作重画：
  - 免费替色可同时覆盖一段或完整候选中所有可编辑帧，同一 RGB 色表不改 Alpha，锁定帧明确保留。
  - 默认是选帧与文字要求；精确区域涂选可选、默认关闭，只有区域模式才保证区域外 RGBA 不变。PixelLab 受限生成要求逐帧授权选区，并在本地保护范围外像素。
  - 128 像素原帧编辑一次 2 帧，任意未锁定位置均可（包括当前未确认、后段未执行且未绑定目标图的段尾）。不支持的帧数直接拒绝，不改用另一种生成方法，也不自动拆分收费。
  - 意图格式 v4 以实际原帧为基线，有明确要求时排除无关专家建议，精简绘图指令并预留长度；旧提示冻结。`comparison_protocol=1` 在原预算内分别判断目标变化与未要求内容是否保持。Kimi 需求理解使用独立冻结的严格格式，失败不会误称视觉复核，历史分别显示三类调用。没有生成备选的失败不显示采用选择。

  流程、费用和 MCP 操作见[选帧修改与备选版本](motion-adjustments.md)。
- **局部调整当前帧**：使用同一图片编辑工作区，支持确定性像素工具与保存会话；动画原尺寸不支持 GPT Image 生成编辑。点击“保存为动画备选”后对比采用。见[图片局部调整](image-editing.md)。
- **旧版局部修复**（“只修复这一段的局部问题”，仅保留给已有记录）：支持外观编辑或运动过渡重生成，只修当前未锁定段的内部窗口，保留段首尾、窗口外帧和原始输出。外观编辑额外带原图与下一帧作上下文，128 像素一次修 2 帧，64 像素修 2–14 个偶数帧；运动过渡用窗口真实首尾作引导，支持 4–16 个偶数帧。每段最多两次，计入现有预算并为未完成片段和复核预留额度。采用会归档旧报告并重新复核，之后仍须单独确认本段。生成空位被占用时保留片段与尝试预算，空位释放后可从原片段再次发起。

逐帧编辑器顶部提供“返回当前作品”，保留作品版本和候选；先保存像素修改，再返回重新检查。

### 模型设置

模型设置把默认规划模型、视觉复核模型和单个专家覆盖分开。服务目前支持腾讯云 TokenHub Chat Completions 与 OpenAI Responses；PixelLab 独立负责实际绘制。没有新配置时读取原视觉设置，避免静默切换付费模型。

- “新增或编辑可选模型”可填写准确模型 ID、服务、输出上限和推理参数，加入列表、分配角色后保存。添加型号不代表账号已开通权限；新型号须支持图片输入和结构化 JSON。未知权限、HTTP 失败或无效结构不会自动降级或换模型。
- Key 按服务复用受保护存储，留空保留原值。公开参数存于忽略的 `work/sprite-pipeline/config/open_motion_models.json`。任务冻结完整有效配置，设置修改只影响新规划；旧报告保留原模型来源，换模型比较须独立记录并遵守新授权的调用上限。
- **Kimi K3**：使用 `max_completion_tokens`，不发送与固定采样值冲突的 temperature。输出上限包含推理与正文；可选预设为低推理强度、32k 输出上限、420 秒等待，实际成本仍按用量回执判断。超时与输出截断都保存失败证据。参数依据 [TokenHub Kimi 官方说明](https://cloud.tencent.com/document/product/1823/132232)。其他兼容型号可手动指定 Token 参数。
- **GLM 5.3 Flash**：TokenHub 可选 `glm-5.3-flash`（多模态），可与 Kimi 规划共用同一个 Key。推荐复核起始参数为 low、16384 输出 Token、300 秒等待，自动使用 `max_tokens`；GLM 5.3 Flash/FlashX 不接受 medium 或 `max_completion_tokens`。`glm-5.3` 和 `glm-5.2` 是纯文本型号，不能用于需要看图的专家。模型可用不代表复核准确。

### MCP 操作

开放动作使用同一能力的 `plan-motion`、`revise-motion`、`get-motion`、`generate-motion`、`pause-motion`、`resume-motion`，输入由 manifest 的 `motionSpec` 约束：

- 规划须 `planningAuthorized=true`；制作须 `expectedRevision` 与返回的 `planSha256`。只有初次 `plan-motion` 且用户已授权在预算内直接制作时才传 `autoExecute=true`。`revise-motion` 省略该字段或传 false，查看新方案后用新 revision 和 planSha256 调用 `generate-motion`。
- 异步查询沿用 `workbench_get_task`，不要重复 run。作品链接为 `?work=<openWorkId>`；生成后继续用现有 check / review / approve / export 原生作业接口。
- `plan-motion` 可用 `planningModels` 按角色指定本作品的模型，键为 `appearance`、`motion`、`strategy`、`coordinator`，值至少含 `model`，例如 `{"strategy": {"model": "kimi-k3.1-pro", "provider": "tokenhub"}}`。省略 `provider` 时沿用该角色的服务，其他省略项用模型配置默认值，凭据取本机已配置的。实际配置见作品的 `planning_config`，后续 `revise-motion` 继承。原生 HTTP 创建请求对应 `planning_models`。

分段与修复操作：

| 操作 | 输入要点 | 说明 |
| --- | --- | --- |
| `target-motion-stage` | `stageIndex`、`targetImageBase64`、`reviewNote`、当前 `expectedRevision`；`clearTarget=true` 取消 | 制作前本地绑定段末目标图，不生图 |
| `get-motion-stage` | `candidateIndex`、零基 `stageIndex` | 返回实际帧文件、检查标准、`stage.token` 与 `repairPreviews` 有序 PNG |
| `review-motion-stage` | `expectedRevision`、原 `stageToken`、`stageDecision=accept\|reject`、实际 `reviewNote`；未通过 / 不确定报告还需 `acknowledgeWarnings` | 确认只解锁原任务的后续执行，不生成替代任务；模糊响应可按原 token 重试，不会重复提交绘图 |
| `repair-motion-stage` | 准确 `stageToken`、零基闭区间 `repairStart/repairEnd`、`repairMode`、实际问题 `reviewNote`、`generationAuthorized=true`、当前版本 | 旧版局部修复 |
| `review-motion-repair` | `repairAttempt`、预览 token、裁决和实际结论 | 检查整段与两侧接缝后采用或拒绝；失败 / 未知记录可明确保留原片段 |

已执行后段所依赖的锚点不得静默修改，应通过新版本重新核对。`get-motion-stage` 的 `stage.review` 与 `get-motion` 候选的 `quality_review` 包含 `protocol`、基础结论、独立意见、争议分类及实际请求账本，用现有接口即可读取。

### 验证

`python -m pytest tests/test_open_motion.py` 覆盖新动作、专家观察 / 质询、版本、预算、重复请求、暂停恢复、参考图改变、人工采用与重复导出。离线测试不证明真实模型的画面质量。

## 对象身份与预设（N1）

角色动画准备页的“已有对象”只列角色预设，显示朝向，并可使用原有角色结构工具。交互物对象在[交互物动画面板](交互物动画独立面板方案.md)的对象下拉中选择，显示自身原图与来源（PixelLab 生成 / 导入 / 转换），不添加朝向或持武器的手。本页带交互物 `?object=` 或交互物作品 `?work=` 打开时转到 `/tools/interactable-motion`（加 `&layout=studio` 可在本页查看同一作品）。“上传角色原图”只接受 64×64 / 128×128 透明 PNG 角色输入；物品原图的导入与转换见[物品原图](prop-art.md#导入与转换为动画原图)，128 像素 PixelLab 物品图可直接[移送到交互物动画](prop-art.md#旧-pixellab-流程)。

**接口清单。** `GET /v1/presets` 返回 `objects`，同时保留旧 `characters` 与 `actions`；`GET /v1/open-motion/references` 返回 `objects` 与旧 `characters`，预览路径 `/v1/open-motion/references/<id>` 可读取任一类型。`workbench_list_presets` 同样保留这三份清单；旧服务缺少 objects 时按角色清单兼容。对象行的类型字段为 `object_type`。

**请求字段。** 新 `plan-motion` / `revise-motion` 在 `motionSpec` 内使用 `object_id` 与 `object_type`（`character` 或 `interactable`，省略按 character）。ID 必须来自已有有效预设，类型须与预设一致。旧 `character_id` 仍接受，同时提供两个 ID 时必须一致。这里使用 snake_case，不能改成 `objectId` / `objectType`。

**兼容约定。** 只含旧 `character_id` 的历史输入和记录按旧形状序列化，不自动加入 object_id/object_type，不迁移旧作业或改变冻结哈希。工作与作业的参考快照容器继续叫 `character`，可保存两种预设；容器名是兼容约定，不能据此把交互物当作角色。新交互物预设使用 128×128 画布，不含 `facing` 或 `weapon_hand`。

**导出。** 交互物动画沿用 SpriteFrames 导出，清单带 `object_id` / `object_type` 和兼容的 `character_id`，不写无意义的 `source_facing`。资产目录与导入元数据使用 `objectId` / `objectType`，保留帧序、FPS、循环、锚点和来源；旧角色包按原规则读取。这里交付的是动画片段，不是 N5 的状态槽或过渡绑定。

**存储。** 对象预设来自普通数据根的 `objects/<id>/object.json`，portable 模式为 `presets/objects/<id>/object.json`；角色原目录继续可读。私有 portable 对象预设不提交到仓库。交互物可使用结构面板及专用规划与复核合同。状态链与写回的真实生成效果仍待验证；对象字段兼容与模拟测试不证明 PixelLab 对物品动画的生成品质。

## 原图与 PixelLab Key

`/tools/reference-art` 可用 PixelLab 生成 128×128 透明角色图，与本工具共用一次保存的 Key。点击“用于制作序列帧”后，创建可复用角色并在生成页预选参考图、名称和外观提示词，不会创建或提交动画任务。详见[角色原图](reference-art.md)。

Key 保存在当前数据目录的 `config/credentials.json`（工作台默认数据目录为 `work/sprite-pipeline`），Windows 使用当前用户的 DPAPI 加密。关闭页面或重启服务后自动读取，输入框留空不代表 Key 丢失。

凭据文件尚不存在时，工作台启动入口会从早期独立版的系统用户数据目录导入已有 Key（Windows 默认 `%LOCALAPPDATA%/SpritePipeline/config`），然后保存到工作台目录。已有配置和主动清除留下的记录不会被覆盖，便携模式不导入。

## 使用面与本地启动

- 外部 Agent 通过仓库 STDIO MCP 或 CLI 调用结构化任务，任务记录进入 `work/`，交付副本进入 `outputs/<task-id>/`。
- 人通过五阶段主工作区描述动作、确认方案、播放检查和导出；旧版嵌入工作区保留预设及逐帧修补。Web 不包含主 Agent 对话。

二者连接同一个 SpritePipeline 服务，但浏览器草稿 / 原生 job 与仓库任务记录是不同数据来源，由工作台制作记录按已知身份合并展示。

环境要求：Node.js 22.13+、Python 3.11+。首次使用安装 Python 依赖，之后只需启动主站：

```powershell
npm run sprite-pipeline:setup
npm run dev
```

启动器会自动启动本地序列帧管线；7860 上已有健康的 SpritePipeline 时直接复用。主站托管的管线随主站退出，启动前已在运行的外部管线不会被关闭；7860 被其他程序占用时，启动器明确报出端口冲突，不会误连。只需独立调试 Python 管线时运行 `npm run sprite-pipeline`。

通过根目录 npm 命令启动时，Python 管线只监听回环地址 `http://127.0.0.1:7860`，任务和对象预设写入 `work/sprite-pipeline/`，成品写入 `outputs/sprite-pipeline/`，都不提交到 Git。直接使用上游启动器时沿用其用户数据与文档导出目录。连接另一个可信地址时，在本地 `.env` 中设置：

```dotenv
NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL=https://your-private-sprite-pipeline.example
SPRITE_PIPELINE_API_URL=https://your-private-sprite-pipeline.example
SPRITE_PIPELINE_API_TOKEN=optional-bearer-token
```

`NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL` 会进入浏览器，只能放 URL，绝不能放 token；`SPRITE_PIPELINE_API_TOKEN` 只由服务端读取。公开部署的 Cloudflare 页面不能启动本机 Python；远程使用需把管线单独部署到可信 HTTPS 服务，并补充访问控制和持久存储。

## 旧版工作区

旧版嵌入界面采用上游的七页布局：默认打开作品库，另有开始、1 · 生成、2 · 播放检查、3 · 逐帧修补、4 · 导出及设置。生成服务使用 PixelLab Animate with Text V3；像素级手工修补、已有 Sheet 导入与离线诊断不依赖收费生成。旧任务可返回五阶段工作区。

**作品库与集成能力。** 作品库按实际素材展示参考图和动画，支持预览、筛选及继续检查 / 修补 / 导出；空任务、失败尝试和测试执行记录放在执行历史中，不计为作品。当前集成包含原始资产与恢复记录校验、QA 算法版本门禁、修补前后问题差异、五状态逐帧时间线、问题帧导航，以及多标签页草稿的三方像素冲突合并。

**手工修补。** 可直接编辑未锁定、未导出的候选帧，无需先逐帧标记待修补；保存仍校验原版本 SHA-256、使该帧旧审核失效并重新执行 QA。外部整帧替换须先标记待修补，并使用选择帧时捕获的 SHA-256，避免覆盖更晚的版本。修补页支持采用当前帧并继续、处理完后返回整段播放确认；洋葱皮默认关闭，橡皮擦模式暂时隐藏洋葱皮以显示真实透明区域。内置地面攻击预设限定为一次纵向劈砍。

### 攻击视觉检查与 AI 修补

地面攻击（`attack`）和空中攻击（`attack_in_air`）的非循环生成默认进行视觉检查。检查只在问题帧添加提醒 tag（如“蓄力 · 刀刃翻向”），保存问题说明、建议修改和阶段置信度；不会因不通过而自动重新生成或替换帧。无法判断时标为待人工确认。

视觉检查 Key 在设置中保存：默认 TokenHub 混元 `hy-vision-2.0-instruct`，可复用服务端 `TOKENHUB_API_KEY`；也可选 OpenAI `gpt-5.4-2026-03-05`，使用独立的 `OPENAI_API_KEY`。两家密钥分开保管，图片发给所选服务并按用量计费。图片服务与序列帧分别管理配置，一处已配置不代表另一进程可用。

在 **3 · 逐帧修补 → AI 修补当前问题帧** 中，由人决定保留当前帧、手工修改或请求 AI 重新生成：

- 新请求必须携带当前帧的攻击阶段及专项约束，并锁定前后帧参考，例如蓄力阶段要求刀保持在肩后，不提前出刀或重新蓄力。可靠且对应当前版本的视觉判断可以自动提供阶段，否则必须人工选择，不能按固定帧号猜。修改其他帧后，旧报告不能再自动提供阶段。
- 每帧最多人工请求两次，每次使用四个上下文槽位并对完整动画复检。必须先预览、再由人明确采用，只替换目标帧。保存的次数不因刷新或重启重置。旧的自动补做队列不再自动提交或采用，已有结果保留。
- 检查与修补支持实际 1–64 帧，完整保留播放顺序；少于四帧时只对提交上下文补齐，不增加最终帧数。单帧不足以证明动作连续性，不能判为通过；首尾帧明确记录缺失的邻帧，不虚构衔接。

发送前停止的旧检查可点击“继续视觉检查”或调用 `POST /jobs/{job_id}/motion-review/resume`，只复用原帧检查并打 tag。人工修补接口 `POST /jobs/{job_id}/candidates/{candidate_index}/frames/{frame_index}/ai-repair` 可传 `phase`（默认 `auto`），可用阶段为 `prepare`、`windup`、`charge`、`strike`、`extend`、`follow_through`、`recover`；举刀 / 蓄力仅用于地面攻击，伸展仅用于空中攻击，不确定或不适用的阶段在收费前拦截。旧 `/attack-plans` 接口及记录保留兼容，复杂的分段方案面板不再显示。修补子任务作为执行记录保留，不列入作品库。

### 旧版资产恢复

工作台把任务保存在 `work/sprite-pipeline/jobs`，角色参考在 `work/sprite-pipeline/characters`，通用对象预设在 `work/sprite-pipeline/objects`。独立版默认使用 Windows 用户目录 `%LOCALAPPDATA%/SpritePipeline`。两个目录不同时，旧任务不会出现在工作台列表中，不能仅凭列表数量判断文件丢失。

启动器默认启用 `SPRITE_PIPELINE_IMPORT_USER_ASSETS=1`：首次发现旧版的真实任务与角色参考时，校验并复制到项目目录。原目录保持不动；已有同名数据不覆盖，冲突副本放入 `work/sprite-pipeline/recovery`；结果记录在 `work/sprite-pipeline/config/user_library_import.json`。这是逐项的一次性导入：重复启动不重复导入，删除已导入的资产后不会从旧目录复活，之后在独立版修改同一任务也不会双向同步。生成中的任务暂缓，fixture 流程测试不导入。设为 `0` 可关闭，显式 portable/test 根目录也不导入。

验收：刷新页面，打开序列帧“资产库”并刷新，选择旧任务后点“打开所选任务”，检查动画和逐帧图片（一个任务可能含多个候选）。再点上方“制作记录”，确认可打开记录并返回对应作品。

## Agent / MCP 接线

`sprite-generator` 由 `sprite-pipeline` 本地适配器驱动。Manifest 输入必须包含 `operation`。旧版动作 / 攻击的直接作业创建使用真实角色预设的 `characterId` 和 `actionId`，不新增交互物直接创建入口；开放动作使用 `motionSpec` 对象身份。适配器把它们转换为 Python 所需的 `character_id` / `action_id` 并调用 `/v1/jobs`，不会把通用 Workbench envelope 直接发给 FastAPI。

```json
{
  "operation": "create-and-generate",
  "characterId": "your_character_id",
  "actionId": "idle",
  "provider": "pixellab",
  "candidateCount": 1,
  "wait": false
}
```

| operation | 必要意图 | 结果语义 |
| --- | --- | --- |
| `create` | 用真实角色/动作 preset 新建 job | job 已保存，不代表帧已生成 |
| `create-and-generate` | 新建并启动生成 | 通常先返回 `running` |
| `generate-existing` | 为已有 `jobId` 启动生成 | 复用已有 job |
| `get` | 查询已有 `jobId` | 不创建第二个生成请求 |
| `export` | 导出已通过门禁的指定候选与排列 | 返回 Sheet、预览和现有服务生成的 Godot ZIP |
| `check` / `safety` | 当前候选 QA 与安全检查 | 检查结果，不代表已采用 |
| `review-frame` / `approve` / `reject` | 逐帧审查与候选采用/拒绝 | 保留说明并执行底层门禁 |
| `recover` / `attach-provider-job` | 恢复已存在的远端作业 | 不提交新生成；使用真实已知 ID |

用户明确要求输入校验时使用 `workbench_prepare_task`；讨论或等待授权不创建记录；明确要求执行时使用 `workbench_run_task`。异步生成返回 `running` 后，重复调用 `workbench_get_task` 轮询同一个上游作业，不会再次提交付费生成。

标准输出类别为 `jobRecord`、`orderedFrames`、`spriteSheet`、`godotPackage`、`preview` 和 `metadata`。候选帧及导出的 Sheet / 预览复制到 `outputs/<task-id>/`，只有记录中的每个输出文件真实存在时，任务才持久化为相应状态。一次 operation 不一定产生所有类别，只报告 `outputs` 中真实存在的路径。`created`、`review_required`、`approved` 是 SpritePipeline job 阶段，仓库任务仍以 `running/completed/failed` 等状态报告；实际导出后才能把可交付文件描述为完成。

健康指示灯通过同源 `/api/workbench/sprite-pipeline/health` 代理验证 `ok` 与 `version`，端口上的其他服务或 404 不会被误报为已连接。无网络、无付费地验证整条接线可运行 `examples/requests/sprite-generator-fixture.json`，其 `diagnostic_dummy` 产物仅用于诊断，不是可交付美术资源。

## Godot SpriteFrames 包导出

“4 · 导出”的按钮为“导出 PNG + Godot 包”。采用候选后一次导出 PNG、预览 / 配方 / QA 及 `<文件名>.godot.zip`，下方“Godot SpriteFrames 包（ZIP）”可直接下载。重新选择已有导出作品可重新下载，不重复生成。旧导出没有 ZIP 时仍可读取原文件，需在当前审批规则允许时重新导出获得新包。

把 ZIP 中整个 `forge_sprites` 文件夹放进 Godot 4.7.x 项目根目录，再把 `sprite_frames.tres` 赋给 AnimatedSprite2D 的 Sprite Frames 属性；也可把 `animated_sprite.tscn` 拖入场景，运行时自动播放。多个作业 / 候选按独立目录区分，请保持目录结构。包不含 project.godot，不覆盖游戏设置。

SpriteFrames 保留导出配方中的准确格位 / 有效帧顺序、动作映射名、运行 FPS 和 loop，纹理不裁切、缩放或重排。示例场景按角色锚点设置脚底原点并使用 nearest 过滤；只替换资源不会改变原角色碰撞 / 偏移。包只含所选动作，给已有多动作角色更新时应合并该动作、保留其他动画，见[工程 Skill](game-engineering.md)。

MCP/CLI 的 `sprite-generator export` 同步返回 `godotPackage` 和实际 ZIP，资产库下载也包含已有 Godot 包。服务端记录可选 `godot_package_path` / `godot_sha256`，下载接口为 `/v1/jobs/{job_id}/exports/godot`，旧记录无包时返回 404。ZIP 与 PNG 使用同一份已验证快照，与其他导出文件一起原子发布 / 回滚；不绕过审批、不调用模型、不要求安装 Godot。

验证：SpritePipeline `tests/test_godot_export.py` 覆盖包内容、下载、旧记录、UI 回调、源文件修改拒绝和回滚；设置 `GODOT_47_BIN` 后还会真实导入并播放，验证非规则帧序、别名、FPS、循环和脚底偏移。

## 将已导出动画交给游戏项目

导出 PNG + Godot 包成功后会打开统一项目选择窗口：选择或输入游戏根目录，点“导出到此项目”，再点“复制给 WorkBuddy”获取精确的交付及动作接入请求。路径会被记住，仍可仅下载 ZIP；独立 SpritePipeline 的 ZIP 下载保持可用。

- 工作区顶部“已导出动画 → 游戏项目”或“选择游戏项目并交付给 WorkBuddy”读取当前作业已保存的 Godot 包；不存在包时提示先完成采用 / 导出，不触发生产。交付某个精确候选时，用它的资产详情入口。
- 作品库“导出”会恢复所选候选的 PNG、Godot 包和附加文件。播放检查中的已采用结果显示“已采用：返回导出”，只导航、不重复审批；手动进入导出页会刷新已采用列表。历史 PNG 没有可用 Godot 包时，提示以新文件名导出完整包并保留旧文件，重新打包仍遵守原有检查门槛。旧页面已出现的控件错误需刷新页面清除。

帧序、别名、FPS、loop 与原包一致；WorkBuddy 应只合并本次动作，保留其他动作与控制器。窗口不会自行启动 WorkBuddy，导出成功不代表脚本接好或引擎通过。详见[Godot 交付](godot-delivery.md)。

## 更新与验证

`Tools/SpritePipeline/` 内的 README 和 API 文档属于上游组件文档，更新组件时尽量按独立提交同步，不在工作台文档中复制其内部实现。工作台接入发生变化时，同步更新 manifest、适配器、本文和[连接器契约](connector-contract.md)。

```powershell
npm run test:dev-supervisor
npm run test:adapters
npm run test:http
npm run test:mcp
npm run workbench -- doctor --json
```

修改上游组件时，还应在 `Tools/SpritePipeline` 中按锁定依赖运行 `python -m pytest -q` 和 `python -m pip check`。整体开发入口见[使用与操作手册](operations-manual.md)。
