# Forge 使用与操作手册

本手册面向工作台日常使用者与维护者，覆盖安装启动、密钥配置、角色原图与动画制作、交互物与图片局部调整、资产管理、Godot 交付以及备份与排错。

> **三条通用原则**（适用于所有模块）：
> 1. **模型结论仅作参考**：规划、复核与结构解析都不会自动改帧、重画或采用素材，最终以人工或获委托 Agent 看到的实际画面为准。
> 2. **旧作品按原版本冻结**：升级代码或调整模型设置只影响新建或显式修订的作品，不改写已有任务、报告和导出。
> 3. **结果不明时先查不重发**：遇到超时、断连或刷新后，优先查询原任务并恢复回执，不重复提交付费请求。

## 1. 工作台分工与核心概念

- **Web 工作台**负责可视化编辑、预览、检查与导出；**外部 Agent（WorkBuddy、Codex 等）**经由项目 MCP 和 Skills 负责需求澄清、工具调度与 Godot 代码接入。
- 四个常用概念：
  - **任务**：一次执行记录（生成、检查、保存或导出），同一作品可能对应多条任务；
  - **作品**：资产库中的实际素材，同一批动画的多个候选是不同版本；
  - **草稿**：浏览器 IndexedDB 中的未提交编辑状态；
  - **导出包**：可下载或交付到 Godot 工程的真实资源 ZIP。

## 2. 安装与启动

需要 **Node.js 22.13+**；制作角色原图、动画或转换物品图另需 **Python 3.11+**（导出 Godot 包无需本机安装 Godot，实机验收基线为 Godot 4.7.x）。在仓库根目录执行：

```sh
npm ci
npm run sprite-pipeline:setup
npm run dev
```

- `sprite-pipeline:setup` 在 `Tools/SpritePipeline/.venv` 中安装锁定 Python 依赖及 `PixelProp`（不改动系统 Python；拉取更新或换机时重新执行，勿直接复制 `.venv`）。
- 仅使用交互物编辑与静态图片局部调整时，可跳过 Python setup，直接运行 `npm run dev:interactable`。
- 仅需原生 HTTP API（不装 Gradio 原生面板）时，可用 `npm run sprite-pipeline:setup -- --api-only` 与 `npm run dev -- --api-only`。

启动后访问 `http://localhost:3000`（服务端口：前端 `3000`、Runtime Bridge `127.0.0.1:8790`、SpritePipeline `127.0.0.1:7860`）。在终端按 `Ctrl+C` 关闭时，启动器拉起的子服务同步退出，启动前已在运行的外部服务不受影响。

需要拆分启动时，可分别运行 `npm run dev:web`、`npm run workbench:http` 与 `npm run sprite-pipeline`（`npm run sprite-pipeline:api` 仅提供 API，不带原生 UI）。改动服务端代码后，先保存编辑、确认无进行中生成再重启对应进程。

## 3. 模型与密钥配置

- **PixelLab Key（角色原图、PixelLab 物品图与动画）**：在角色原图或序列帧的“设置”中保存一次即共用，存在 `work/sprite-pipeline/config/credentials.json`（Windows 使用 DPAPI、macOS 使用钥匙串、其他系统用受限权限文件；`PIXELLAB_API_KEY` 环境变量存在时优先）。保存后输入框留空属正常现象，以“已配置”状态为准。
- **规划与视觉复核模型**：在序列帧“模型设置”中分别配置默认规划模型、视觉复核模型与单专家覆盖，支持 TokenHub（如 Kimi K3、`glm-5.3-flash` 多模态）与 OpenAI，密钥按服务复用受保护存储。
- **GPT Image 2.6（透明物品与静态图编辑）**：在交互物编辑器的图片设置中保存 Key（与上述同一 OS 受保护存储机制），或通过本机 `.env` 配置 `OPENAI_API_KEY`。旧视觉检查另支持 `TOKENHUB_API_KEY`。

> 浏览页面、查询模板与资产目录、本地像素工具及 Godot 打包均不消耗外部模型额度。

## 4. 导航、保存与图片局部调整

- 顶栏主导航依次为：角色原图（`/tools/reference-art`）、角色动画（`/tools/sprite-generator`）、交互物动画（`/tools/interactable-motion`）、交互物编辑（`/tools/interactable-editor`）与资产库（`/assets`），右侧图标进入帮助、工作台管理（`/advanced`）与主题切换。
- **保存边界**：交互物浏览器草稿存于当前浏览器与域名的 IndexedDB，“保存到资产库”写到本机服务，“导出 Godot”生成引擎包；换机器迁移请下载工程 JSON 源文件并备份磁盘目录。
- **图片局部调整**：交互物默认/状态静态图与资产库 `image:` 素材均可打开共用局部调整工作区，支持本地画笔/换色/批量配色/清理/单图恢复，以及原尺寸 AI 局部修改（默认开启“保留原图透明度”）。完整工具与版本时间线见[图片局部调整](image-editing.md)。

## 5. 角色原图制作

1. 进入 **角色原图**，确认 SpritePipeline 与 PixelLab 已就绪。
2. 填写角色外观描述（职业、服装、武器、配色、侧视方向）、朝向与尺寸（64×64 粗像素或默认 128×128），可选勾选视角/朝向核对，点击 **生成一张原图**。
3. 核对人物完整度、透明边缘与朝向后，点击 **用于制作序列帧**（可填写简短外观约束 `identityDescription`），自动在角色动画页预选该角色。
4. 已有本地透明 PNG（64×64 或 128×128、≤ 2 MB）可直接经“从资产库选用”或 MCP `reference-art import` 导入，无需付费重画。详见[角色原图](reference-art.md)。

## 6. 角色动画制作与审查

角色动画按五阶段推进：**准备与描述 → 查看制作方案 → 自动制作 → 检查与调整 → 导出与使用**。

1. **准备与描述**：选择已有角色（或移送过来的角色），填写动作描述、结束姿势与循环属性；按需在预算区调整候选数、绘图帧上限或复核协议（默认 `experts_v1`）。如需部件级约束，可先展开 **结构解析与纠正** 核对原图结构并显式勾选辅助（见[角色视觉结构](visual-structures.md)）。
2. **查看制作方案**：点 **制定方案** 调用专家协作；核对动作事件、装备归属与结束姿势。失败可点 **重新制定方案**；有合适目标图时可本地绑定段末目标 PNG（见[序列帧生成](sprite-generator.md)）。
3. **自动制作与分段确认**：每段完成后停在“确认第 N 段”，必须完整播放并逐帧核对后点击 **确认此段，继续制作**（将真实末帧锁为下段起点）。若目标姿势提前出现，可展开选择较早锚点截尾；本段不合格可停止后续制作。
4. **整段检查与选帧调整**：全部片段完成后按正常速度与慢放检查整段衔接。如需修改，点 **调整部分帧** 选连续范围（128 px 外观编辑一次 2 帧，运动重画 4–16 偶数帧，每帧最多 2 次绘图；可选逐帧涂选保护区）生成备选并同步对比，或从播放器进当前帧局部精修（详见[选帧调整](motion-adjustments.md)）。
5. **采用与导出**：完成完整播放确认、填写 ≥ 4 字结论并确认提醒后采用，随后点击 **导出 PNG + Godot 包**。已有旧作业与逐帧手绘可在 `/tools/sprite-generator?legacy=1` 查看。

## 7. 交付到 Godot 游戏项目

在角色动画、交互物编辑器或资产库详情中均可打开统一交付窗口：

1. 点击 **选择项目…** 在页面内浏览选定含 `project.godot` 的目录（或粘贴路径）。
2. 点击 **导出到此项目**，将标准包落盘至目标工程的 `forge_imports/<delivery-id>/`。
3. 点击 **复制给 WorkBuddy** 在会话中触发外部 Agent 完成资源安装、动作合并或交互物信号连接；也可点击 **仅下载 ZIP** 手动解压（角色动画将 `forge_sprites/` 拷入项目根，交互物将 `addons/workbench_interaction/` 拷入项目根，并在关卡根放一个 `interaction_runtime_2d.tscn`）。

- **多动作角色更新**：单次导出只含一个动作，更新已有多动作角色时使用工程 Skill 的 `sprite_frames_merge.gd` 合并动作，保留其余动画、碰撞与控制器行为。
- 完整接入契约与异常锁恢复见[Godot 交付](godot-delivery.md)和[游戏工程](game-engineering.md)。

## 8. 交互物与状态动画

1. **准备物品原图**：交互物编辑器右侧支持 GPT Image 2.6 生成透明物品、PixelLab 生成 128×128 物品图，以及 **导入 128 px PNG / PixelProp 大图转换**（本地免费，命令行 `npm run pixel-prop -- convert <源图> -o <输出>`）。导入或转换后填写确认说明即可移送为动画对象，详见[物品原图](prop-art.md)。
2. **制作状态动画**：切换或序列物件点击左栏 **制作状态动画** 打开 `/tools/interactable-motion`，定义状态图、生成与检查过渡、用固定部件回填/对齐/清理/派生等工具微调，并在“写回”页签提交槽位绑定与场景模拟预览（详见[交互物动画面板](交互物动画独立面板方案.md)）。
3. **配置行为与导出**：在交互物编辑器配置查看（`inspect`）、切换（`toggle`）、拾取（`pickup`）或序列（`sequence`）行为、触发方式（默认按键 E）、反馈与状态记忆，内置画布模拟确认后点击 **导出 Godot**（详见[交互物编辑器](interactable-editor.md)）。

## 9. 资产查找、下载与回收站

- **检索与下载**：资产库按角色原图、物品原图、动画与交互物展示持久素材；归档后台制作历史不隐藏资产。勾选素材点击 **下载所选素材** 获得真实文件 ZIP（单次 ≤ 100 件 / ≤ 128 MiB），也可导入 Forge 素材包。
- **回收站与草稿清理**：资产库支持批量移入回收站与恢复（仅改目录可见性，不删磁盘文件）。管理页“删除浏览器项目与草稿”仅清理当前浏览器 IndexedDB 草稿，不影响磁盘任务与素材。详见[资产目录](asset-catalog.md)。

## 10. WorkBuddy 与外部 Agent 协作

- **MCP 接入与重信任**：根目录 `.mcp.json` 配置 `2d-game-workbench`（`node scripts/workbench-mcp.mjs`，工作目录为仓库根）；修改环境变量后需在宿主连接器界面重新信任并重连。详见[客户端接入](agent-clients.md)。
- **预览与页面跟随**：WorkBuddy 在首条用户消息时检查并打开本会话预览，执行步骤自动在同一标签切换；遇到 `preview_required` 需先就绪预览或按例外策略继续。详见[预览与页面跟随](agent-preview-follow.md)。
- **工具清单与验收**：完整 MCP 工具分组见[工具与任务语义](agent-client-tools.md)，宿主行为验证场景见[客户端验收](agent-client-validation.md)。

## 11. 备份、部署与常见故障

### 备份清单

| 数据 | 位置或方式 | 说明 |
| --- | --- | --- |
| 共享任务与产物 | `work/tasks/`、`outputs/` | 一起保留 |
| 动画与角色数据 | `work/sprite-pipeline/` | 含作业、对象预设与导入记录 |
| 共享交互物与图片会话 | `work/editor-documents/`、`work/image-edits/`、`work/game-exports/` | 含版本历史与交付索引 |
| 浏览器草稿 | 编辑器下载源 JSON | IndexedDB 不随 Git 迁移 |
| 凭据 | 本机 `.env` 或受保护存储 | 私下保管，换机重新配置 |

### 反向代理与跨源配置

- 自定义前端域名或端口时，在前端与 Bridge 同时设置 `WORKBENCH_FRONTEND_URL`（仅控制来源校验，不改监听端口）。
- Web 与 Bridge 分机部署或置于反向代理后时，从 Bridge `/health` 读取 `workspaceId` 配入 `WORKBENCH_RUNTIME_WORKSPACE_ID`（迁移目录后需更新）。
- 目标工程安装锁异常残留时，先确认无残留写入进程，按[Godot 交付 · 并发锁](godot-delivery.md#5-并发锁gitignore-与异常恢复)处理，勿直接删 `forge_imports/`。

### 常见故障排查

| 现象 | 检查与处理 |
| --- | --- |
| 动画页出现 `Not Found` JSON | SpritePipeline 可能以 API-only 启动；保存工作后改用 `npm run dev` 或 `npm run sprite-pipeline` |
| 提示接口不兼容 | 端口残留旧版本 Python/Node 进程；确认进程归属后重启 |
| 前端动态模块加载失败 | 多为前端进程中断或依赖缓存损坏；重启前端并刷新，无需删草稿或素材目录 |
| API 提示来源不受信任 | 在前端与 Bridge 配置一致的 `WORKBENCH_FRONTEND_URL` 后重启 |
| Key 输入框空白或报缺 Key | 先看“已配置”状态与数据目录，检查环境变量覆盖或重新在设置页保存 |
| 列表缺旧素材 | 确认使用同一浏览器与 `localhost:3000`、SpritePipeline 在线且数据目录一致；勿清空 `work/` |
| Godot 动画缺动作或卡首帧 | 勿整份覆盖多动作 `SpriteFrames`，改用合并；检查控制器是否每帧重置动画 |
| Godot 交互物靠近无响应 | 确认角色为 `PhysicsBody2D`、加入 `interaction_actor` 组，且物件 mask 包含角色 layer |

## 12. 维护与文档索引

| 路径 | 用途 |
| --- | --- |
| `workbench/manifest.json` | 能力、schema、路由与指导主题注册表 |
| `workbench/conversation-guide.md` | Agent 对话决策与按需主题入口 |
| `workbench/guides/development.md` | 开发模块路由、本地验证与 CI 门禁 |
| `.agents/skills/2d-game-workbench/` | 资产制作、检查与交付 Skill |
| `.agents/skills/forge-game-engineering/` | Godot 工程接入 Skill 与 helper |
| `docs/agent-clients.md` · `agent-client-tools.md` · `agent-preview-follow.md` · `agent-client-validation.md` | MCP 接入、工具索引、预览跟随与验收 |
| `docs/README.md` | 全部公开文档总览 |
| `THIRD_PARTY_NOTICES.md` | 上游来源、同步基线与 MIT 许可边界 |
