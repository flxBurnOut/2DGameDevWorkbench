# 序列帧生成工作区

> 机器契约以 `workbench/manifest.json` 的 `sprite-generator` 为准。本工具集成自 [NativeFramesGeneration](https://github.com/flxBurnOut/NativeFramesGeneration.git)（MIT License，见 `THIRD_PARTY_NOTICES.md`），开放动作实现在 `Tools/SpritePipeline/sprite_pipeline/collaboration/`。

`/tools/sprite-generator` 默认打开 React 五阶段开放动作工作区，角色与交互物共用对象、分段方案与检查点（交互物作品默认转至[交互物动画面板](交互物动画独立面板方案.md)，加 `&layout=studio` 可留在本页）。旧预设与逐帧手绘保留在 `?legacy=1`。

> **通用约束**：模型复核意见不自动改帧、重画或采用；新协议仅作用于新建或显式修订的作品，旧任务与导出按原冻结版本与哈希读取；中断或结果不明的请求保留回执，不自动重发。

## 1. 本地启动与凭据

环境要求 Node.js 22.13+、Python 3.11+。首次安装 Python 依赖，之后直接启动工作台：

```powershell
npm run sprite-pipeline:setup
npm run dev
```

- 启动器自动托管本地 SpritePipeline（`http://127.0.0.1:7860`），数据写至 `work/sprite-pipeline/`，导出写至 `outputs/sprite-pipeline/`；端口已有健康实例时复用，被其他进程占用则报错。单独调试 Python 界面运行 `npm run sprite-pipeline`。
- 连接外部受保护部署时在本地 `.env` 设置 `NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL`（仅 URL，绝不放 token）、`SPRITE_PIPELINE_API_URL` 与服务端专用的 `SPRITE_PIPELINE_API_TOKEN`。
- **PixelLab Key**：与角色原图页共用受保护存储（位于数据目录 `config/credentials.json`，首次启动可从旧独立版用户目录一次性迁入已有 Key，不覆盖现存配置）；界面留空仅表示不回显。

## 2. 五阶段主流程

流程为 **准备与描述 → 查看制作方案 → 自动制作 → 检查与调整 → 导出与使用**。打开页面或填写草稿不建任务，点击“制定方案”才持久化并调用规划模型（作品存于 `work/sprite-pipeline/open-motion/`）。

### 规划与预算

- **专家协作与来源溯源**：外观与动作专家独立观察，策略专家综合提案，协调专家产出结构化方案。每条要求标明来源（用户原话 / 参考图观察 / 专家建议），无法确定的关键问题写入 `plan.questions` 并暂停执行。校验出错时可在当前预算内请对应专家修正一次；显式修订可沿用输入未变的已有观察。
- **绘图简报与策略版本**：新建或显式修订默认冻结 `generation_policy_version=6`（由段目标与关键姿势组装 12 行绘图文本，每段上限 1,000 字符，超限拦截不截断）与 `visibility_review_version=4`。策略演进与格式细节见[规划与绘图策略](visual-structures.md#规划与绘图策略)。
- **动作约束**：最多 4 段、每段 4–16 偶数帧，总计 ≤ 64 帧；`return_to_reference` 默认 `false`（勾选“结束时回到原图姿势”才允许绑回原图）。原始返回帧完整保留，播放映射仅在多返回 1 帧且首帧与输入参考一致时跳过该额外上下文帧。
- **预算与空位**：规划前先查 PixelLab 余额并按分段向上取整估算单位；同一 PixelLab 凭据的原图与动画共享生成空位（排队标 `queued`，发送前拒单标 `not_submitted`）。视觉复核上限默认 `experts_v1` 为 `5 ×（分段数 + 1）× 候选数`（基础协议为 `2 ×`），最高 200。
- **段末目标图**：制作前可在方案页或经 `target-motion-stage` 本地绑定同尺寸透明 PNG 作为段末引导（`last_frame` 条件）；目标图与哈希随制作冻结，仅作生成条件，输出端点仍取实际生成帧。

### 分段确认、复核与选帧修改

- **分段确认**：每段完成后停在“确认第 N 段”，必须看实际播放序列后裁决。接受后冻结真实末帧快照作为下段起点；若目标姿势提前到达，可显式选真实帧截尾（`anchorFrame` + `acknowledgeTrim=true`，保留原始尾帧记录）；拒绝则停止后续片段，保留已确认结果。
- **视觉复核**：技术 QA 后执行基础观察/审核 + 独立外观/运动视角 + 必要的争议复核，完整机制、角色/交互物确定性探针及离线评测见[视觉复核文档](sprite-review-evaluation.md)。像素变化测量仅提示近静止帧对，不作运动质量判定。
- **角色视觉结构（可选）**：支持原图静态解析、跨帧追踪与结构辅助复核，详见[角色视觉结构](visual-structures.md)。
- **修改部分帧**：检查页提供三类修改，均先生成备选、完整播放对比后再决定采用（已锁定状态图、接续边界与停留帧受保护）：
  - **调整部分帧**（免费多帧替色 / 受限生成 / 窗口重画）：流程、帧数限制与 MCP 操作见[选帧调整](motion-adjustments.md)。
  - **局部调整当前帧**：进入共用图片编辑工作区保存 `local_pixels_v1` 备选，见[图片局部调整](image-editing.md)。
  - **旧版局部修复**：仅保留给历史记录。
- **采用门禁**：需完成完整播放确认、填写 ≥ 4 字结论、确认技术提醒且无未处理技术硬错误。

### 模型设置

默认规划模型、视觉复核模型与单专家覆盖分开配置（公开参数存 `work/sprite-pipeline/config/open_motion_models.json`，密钥按服务存受保护存储，图片部件定位共用 `appearance` 角色、成品复核共用 `reviewer` 角色）。支持腾讯云 TokenHub Chat Completions 与 OpenAI Responses：
- **Kimi K3**：使用 `max_completion_tokens`（不传冲突 `temperature`），推荐预设低推理、32k 上限、420 秒超时，参考 [TokenHub Kimi 说明](https://cloud.tencent.com/document/product/1823/132232)。
- **GLM 5.3 Flash**：多模态型号 `glm-5.3-flash`（纯文本 `glm-5.3`/`5.2` 不可用于看图专家），使用 `max_tokens`，推荐低推理、16384 上限、300 秒超时。

## 对象与预设

- 角色动画准备页仅列角色预设并显示朝向，上传区只收 64×64 / 128×128 透明角色 PNG；交互物预设固定 128×128（不含 `facing` / `weapon_hand`），在[交互物动画面板](交互物动画独立面板方案.md)中管理，物品原图导入与转换见[物品原图](prop-art.md#导入与转换为动画原图)。
- `GET /v1/presets`、`GET /v1/open-motion/references` 与 `workbench_list_presets` 返回统一的 `objects`（含 `object_type`）并保留旧 `characters`/`actions` 兼容。
- 开放动作 `motionSpec` 使用 snake_case 的 `object_id` 与 `object_type`（`character`/`interactable`，兼容旧 `character_id`）。对象预设存于数据目录 `objects/<id>/object.json`（portable 模式在 `presets/objects/`），旧作业快照容器名 `character` 保持兼容。
- 导出清单包含 `object_id` / `object_type`（交互物省略 `source_facing`）；这里导出的是动画片段，状态槽写回见[内部素材导入](internal-imports.md)。

## 3. MCP 操作总览

开放动作为主路径，旧版直接建作业仅用于兼容既有角色动作 preset：

| 路径 | `operation` | 说明 |
| --- | --- | --- |
| 开放动作（推荐） | `plan-motion` / `revise-motion` / `get-motion` / `generate-motion` / `pause-motion` / `resume-motion` | 规划需 `planningAuthorized=true`，可传 `planningModels` 冻结各角色模型；制作绑定 `expectedRevision` 与 `planSha256`；仅初次 `plan-motion` 获连续授权时可设 `autoExecute=true` |
| 分段与目标 | `target-motion-stage` / `get-motion-stage` / `review-motion-stage` | 本地绑段末目标图、取有序帧与 `stage.token`、带 `stageDecision=accept\|reject` 与 `reviewNote` 裁决 |
| 选帧修改 | `get-motion-adjustment` / `create-motion-adjustment` / `review-motion-adjustment` / `edit-motion-frames` | 详见[选帧调整](motion-adjustments.md)（旧 `repair-motion-stage` / `review-motion-repair` 仅兼容旧记录） |
| 旧版直接作业 | `create` / `create-and-generate` / `generate-existing` / `get` / `check` / `safety` / `review-frame` / `approve` / `reject` / `export` / `recover` / `attach-provider-job` | 仅用既有角色/动作 preset（`characterId` / `actionId`），不用于交互物 |

- 异步查询沿用 `workbench_get_task`；请求恢复与原生 `request_key` / `command_receipt` 细则见[连接器契约](connector-contract.md#5-spritepipeline-适配器)。
- 离线连通性诊断可运行 `examples/requests/sprite-generator-fixture.json`（`diagnostic_dummy` 仅作测试）。

## Godot SpriteFrames 包导出

采用候选后点击 **导出 PNG + Godot 包**（或 MCP `export`），一次原子产出 PNG、预览、配方/QA 与 `<文件名>.godot.zip`（服务端记录 `godot_package_path` / `godot_sha256`，下载路由 `/v1/jobs/{job_id}/exports/godot`）：

- **包结构与规则**：将 ZIP 内 `forge_sprites` 目录拷入 Godot 4.7.x 项目根即可使用 `sprite_frames.tres` 或 `animated_sprite.tscn`（不含 `project.godot`）。完整保留导出配方的格位顺序、动作名、FPS、loop 与脚底锚点（nearest 过滤）；多动作角色接入时应合并动作而非替换整份 `SpriteFrames`，见[游戏工程](game-engineering.md)。
- **交付到游戏项目与复用已有导出**：
  - 导出完成后弹出项目选择窗口，支持“导出到此项目”并“复制给 WorkBuddy”交付接入（详见[Godot 交付](godot-delivery.md)），也可仅下载 ZIP。
  - 作品库“导出”或工作区顶部“已导出动画 → 游戏项目”直接恢复已有 PNG 与 Godot 包，不重复生成或审批；播放检查中已采用结果显示“已采用：返回导出”。若历史 PNG 缺少 Godot 包，按现行检查门槛以新文件名补导出完整包并保留旧文件。

## 4. 附录：旧版工作区（`?legacy=1`）与历史迁移

- **旧版七页工作区**：保留作品库、预设生成（Animate with Text V3）、手工像素修补（洋葱皮、三方冲突合并）、地面/空中攻击视觉打 tag 与逐帧 AI 修补（每帧最多两次，`POST /jobs/{job_id}/candidates/{candidate_index}/frames/{frame_index}/ai-repair`，支持 1–64 帧），逐帧编辑器顶部支持返回开放动作作品。
- **独立版资产迁移**：启动器默认设 `SPRITE_PIPELINE_IMPORT_USER_ASSETS=1`，首次检测到早期独立版（Windows `%LOCALAPPDATA%/SpritePipeline`）真实作业与角色时，一次性校验复制到 `work/sprite-pipeline/`（不覆盖同名，冲突入 `recovery/`，记录在 `config/user_library_import.json`，设 `0` 关闭）。

## 5. 验证

- Node 接线：`npm run test:dev-supervisor`、`npm run test:adapters`、`npm run test:http`、`npm run test:mcp`、`npm run test:open-motion`；
- Python 回归：`Tools/SpritePipeline` 下跑 `pytest`（核心用例含 `test_open_motion.py`、`test_open_motion_recovery_media.py`、`test_godot_export.py`，设 `GODOT_47_BIN` 时同步验证 Godot 4.7.x 实机导入）与 `pip check`。
