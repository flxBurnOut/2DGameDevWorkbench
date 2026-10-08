# 序列帧生成工作区

> 状态：当前维护。机器契约以 `workbench/manifest.json` 中的 `sprite-generator` 为准。

项目把 `NativeFramesGeneration` 的完整本地工作台保存在 `Tools/SpritePipeline/`，并通过 `/tools/sprite-generator` 接入统一导航。上游来源为 `https://github.com/flxBurnOut/NativeFramesGeneration.git`，当前同步基线为提交 `4f7f4cc4bee625d75c53570887ddf184dbe380ba`（2026-09-08 同步，攻击动作连续性检查、参考图画布与动画播放器更新），并保留工作台任务跳转、当前任务同步及帧图 / 导出产物下载接口。

当前集成包含原始资产与恢复记录校验、QA 算法版本门禁、修补前后问题差异、五状态逐帧时间线、问题帧导航，以及多标签页草稿的三方像素冲突合并。外部替换要求选择帧时捕获的 SHA-256，避免覆盖更晚版本。

作品库按实际素材展示参考图和动画，支持预览、筛选及继续检查 / 修补 / 导出；空任务、失败尝试和测试执行记录单独放在执行历史中，不计为作品。

## 原图参考入口

`/tools/reference-art` 可用 PixelLab 生成 128×128 透明角色图，并与本工具共用一次保存的 Key。点击“用于制作序列帧”后，创建可复用角色并在生成页预选参考图、名称和外观提示词；不会创建或提交动画任务。详见 [角色原图](reference-art.md)。

## PixelLab Key 的保存与恢复

Key 保存于当前数据目录的 `config/credentials.json`，Windows 使用当前用户的 DPAPI 加密；关闭页面或重启服务后自动读取，输入框留空不代表 Key 丢失。工作台默认数据目录为 `work/sprite-pipeline`。

工作台启动入口会在该凭据文件尚不存在时，从早期独立版的系统用户数据目录导入已有 PixelLab Key（Windows 默认 `%LOCALAPPDATA%/SpritePipeline/config`）。导入后保存到工作台目录；已有配置和主动清除留下的记录不会被覆盖，便携模式不会导入。原图与序列帧继续共用同一服务的配置。

## 两种使用面

- 外部 Agent 通过仓库 STDIO MCP 或 CLI 调用结构化任务，任务记录进入 `work/`，交付副本进入 `outputs/<task-id>/`。
- 人通过 Web 中嵌入的 SpritePipeline 工作区选择预设、逐帧检查、修补和导出。Web 不包含主 Agent 对话。

二者连接同一个 SpritePipeline 服务，但浏览器内部草稿/原生 job 与仓库任务记录仍是不同数据来源，由工作台状态栏按已知身份合并展示。

## 本地启动

环境要求：Node.js 22.13+、Python 3.11+；CI 使用 Python 3.12。

首次使用安装 Python 依赖：

```powershell
npm run sprite-pipeline:setup
```

随后只需启动主站。启动器会自动启动本地序列帧管线；如果 7860 上已经有健康的 SpritePipeline，则直接复用：

```powershell
npm run dev
```

只需独立调试 Python 管线时才运行 `npm run sprite-pipeline`。主站托管的管线会随主站退出；已在启动前运行的外部管线不会被主站关闭。7860 被其他程序占用时，启动器会明确报出端口冲突，不会误连。

管线默认监听 `http://127.0.0.1:7860`。如需连接另一个可信地址，在本地 `.env` 中设置：

```dotenv
NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL=https://your-private-sprite-pipeline.example
SPRITE_PIPELINE_API_URL=https://your-private-sprite-pipeline.example
SPRITE_PIPELINE_API_TOKEN=optional-bearer-token
```

`NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL` 会进入浏览器，只能保存 URL，绝不能放 token。`SPRITE_PIPELINE_API_TOKEN` 仅由服务端读取。

## 功能边界

嵌入界面采用上游的七页布局：默认打开作品库，另有开始、1 · 生成、2 · 播放检查、3 · 逐帧修补、4 · 导出及设置。生成服务使用 PixelLab Animate with Text V3；像素级手工修补、已有 Sheet 导入与离线诊断不依赖收费生成。

手工像素修补可直接编辑未锁定、未导出的候选帧，无需先逐帧标记待修补；保存仍校验原版本 SHA-256、使该帧旧审核失效并重新执行 QA。外部整帧替换仍须先标记待修补。修补页支持采用当前帧并继续、处理完后返回整段播放确认；洋葱皮默认关闭，橡皮擦模式暂时隐藏洋葱皮以显示真实透明区域。内置地面攻击预设明确限定为一次纵向劈砍。

通过根目录 npm 命令启动时，Python 管线只监听回环地址，任务和角色包写入 `work/sprite-pipeline/`，成品写入 `outputs/sprite-pipeline/`；两者都不会提交到 Git。直接使用上游启动器时仍沿用其用户数据与文档导出目录。公开部署的 Cloudflare 页面不能启动本机 Python；若要远程使用，需要把管线单独部署到可信 HTTPS 服务，并补充访问控制和持久存储。

## Agent / MCP 接线

`sprite-generator` 由 `sprite-pipeline` 本地适配器驱动。Manifest 输入必须包含 `operation`；创建作业时还要提供真实预设的 `characterId` 和 `actionId`。适配器会将它们转换为 Python 所需的 `character_id` / `action_id` 并调用 `/v1/jobs`，不会再把通用 Workbench envelope 直接发给 FastAPI。

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

用户明确要求输入校验时使用 `workbench_prepare_task`；讨论或等待授权不创建记录；已明确要求执行时使用 `workbench_run_task`。异步生成返回 `running` 后，重复调用 `workbench_get_task` 会轮询同一个上游作业，不会再次提交付费生成。候选帧以及导出的 Sheet/预览会被复制到 `outputs/<task-id>/`，任务只有在记录中的每个输出文件真实存在时才会持久化为相应状态。健康指示灯通过同源 `/api/workbench/sprite-pipeline/health` 代理验证 `ok` 与 `version`，端口上其他服务或 404 不会被误报为已连接。

标准输出类别为 `jobRecord`、`orderedFrames`、`spriteSheet`、`godotPackage`、`preview` 和 `metadata`。实际 operation 不一定一次产生所有类别；只报告任务 `outputs` 中真实存在的路径。`created`、`review_required`、`approved` 是 SpritePipeline job 阶段，仓库任务仍以 `running/completed/failed` 等状态报告；只有实际导出后才能把可交付文件描述为完成。

如需无网络、无付费地验证整条 Agent 接线，可运行 `examples/requests/sprite-generator-fixture.json`；其 `diagnostic_dummy` 产物仅用于诊断，不是可交付美术资源。

上游仓库所有者已于 2026-09-04 确认以 MIT License 发布，当前集成副本包含 `Tools/SpritePipeline/LICENSE`；来源与许可记录见根目录 `THIRD_PARTY_NOTICES.md`。

## 更新与验证

`Tools/SpritePipeline/` 内 README 和 API 文档属于上游组件文档，更新组件时尽量按独立提交同步，不在工作台文档中复制其全部内部实现。工作台接入发生变化时同步更新 manifest、适配器、本文和 [连接器契约](connector-contract.md)。

```powershell
npm run test:dev-supervisor
npm run test:adapters
npm run test:http
npm run test:mcp
npm run workbench -- doctor --json
```

修改上游组件时还应在 `Tools/SpritePipeline` 中按其锁定依赖运行 `python -m pytest -q` 和 `python -m pip check`。整体开发入口见 [使用与操作手册](operations-manual.md)。

## 旧版资产恢复与任务栏

工作台把序列帧任务保存在项目的 `work/sprite-pipeline/jobs`，角色参考保存在 `work/sprite-pipeline/characters`。独立版默认使用 Windows 用户目录 `%LOCALAPPDATA%/SpritePipeline`。两个目录不同会造成旧任务没有出现在工作台列表中，不能仅凭列表数量判断文件已丢失。

工作台启动器默认启用 `SPRITE_PIPELINE_IMPORT_USER_ASSETS=1`：首次发现旧版的真实任务与角色参考时，校验并复制到项目目录。原目录保持不动；已有同名数据不覆盖，冲突副本放入 `work/sprite-pipeline/recovery`。导入结果记录在 `work/sprite-pipeline/config/user_library_import.json`。这是逐项的一次性导入：重复启动不会重复导入，删除已导入资产后不会从旧目录重新复活；后续仍在独立版修改同一个任务时不会双向同步。生成中的任务暂缓，fixture 流程测试不导入。设置该变量为 `0` 可关闭，显式 portable/test 根目录也不导入用户资产。

工具上方的上下文栏显示当前位置、当前任务和实际状态；“制作记录”按钮打开已有记录，可从具体作品继续。生成、播放检查、修补和导出使用序列帧工具自己的标签页，上下文栏不再展示无法操作的三步条。

验收时刷新页面，打开序列帧“资产库”，点击刷新后选择旧任务，再点“打开所选任务”，检查动画和逐帧图片。任务可能包含多个候选，任务数量不同于图片或候选数量。再点上方“制作记录”，确认可打开记录并返回对应作品。

## 攻击视觉检查与人工修补

地面攻击（`attack`）和空中攻击（`attack_in_air`）的非循环生成默认进行视觉检查。检查后只在问题帧添加提醒 tag，例如“蓄力 · 刀刃翻向”，保存问题说明、建议修改和阶段置信度；不会因不通过而自动重新生成或采用替代帧。无法判断时标为待人工确认。

在设置中保存视觉检查 API Key。默认使用 TokenHub 混元 `hy-vision-2.0-instruct`，可复用服务端 `TOKENHUB_API_KEY`；也可选择 OpenAI `gpt-5.4-2026-03-05`，使用独立的 `OPENAI_API_KEY`。两家密钥分开保管；图片发给所选服务，视觉检查按用量计费，不自动重试结果未知的请求。地图页面只保存在进程内的 Key 需在此另行保存。

在 **3 · 逐帧修补 → AI 修补当前问题帧** 中，由人决定保留当前帧、手工修改或请求 AI 重新生成。新请求必须携带当前帧的攻击阶段及专项约束，并锁定前后帧参考；例如蓄力阶段要求刀保持在肩后，不提前出刀或重新蓄力。可靠且对应当前版本的视觉判断可以自动提供阶段；否则必须人工选择，不能按固定帧号猜测阶段。修改其他帧后，旧报告不能继续自动提供阶段。

每帧最多人工请求两次，每次使用四个上下文槽位并对完整动画复检；生成和视觉检查按用量计费。必须先预览、再由人明确采用，只有目标帧会替换；其余帧与原始版本保留。保存的次数不会因刷新或重启重置，手工像素修补仍可继续。旧自动补做队列不再自动提交或采用，已有结果保留。

检查与修补继续支持实际 1–64 帧，完整保留播放顺序；少于四帧时仅对提交上下文补齐，不增加最终帧数。单帧不足以证明动作连续性，不能判为通过。首尾帧明确记录缺失的邻帧，不虚构衔接。

旧版在发送前停止的检查可点击“继续视觉检查”，或调用 `POST /jobs/{job_id}/motion-review/resume`；它只复用原帧检查并打 tag，不自动重新生成。人工修补接口 `POST /jobs/{job_id}/candidates/{candidate_index}/frames/{frame_index}/ai-repair` 可传入 `phase`（默认 `auto`）；可用阶段为 `prepare`、`windup`、`charge`、`strike`、`extend`、`follow_through`、`recover`，其中举刀/蓄力仅用于地面攻击，伸展仅用于空中攻击。不确定或不适用的阶段会在收费请求前被拦截。

旧 `/attack-plans` 接口及记录保留兼容；复杂的分段方案面板不再显示。修补子任务作为执行记录保留，不列入作品库。

## Godot SpriteFrames 包导出

“4 · 导出”的按钮为“导出 PNG + Godot 包”。通过现有检查并采用候选后，一次导出 PNG、预览/配方/QA 及 `<文件名>.godot.zip`。下方“Godot SpriteFrames 包（ZIP）”可直接下载；重新选择已有导出作品可重新下载，不会重复生成。旧导出记录没有 ZIP 时仍可读取原文件，需在当前审批规则允许时重新导出获得新包。

将 ZIP 中整个 `forge_sprites` 文件夹放进 Godot 4.7.x 项目根目录，再将包内 `sprite_frames.tres` 赋给 AnimatedSprite2D 的 Sprite Frames 属性；也可直接把 `animated_sprite.tscn` 拖入场景，运行时自动播放。无需手动切图、排序或逐帧添加。多个作业/候选按独立目录区分；请保持目录结构。包不含 project.godot，不覆盖游戏设置。

SpriteFrames 保留导出配方中的准确格位/有效帧顺序、动作映射名、运行 FPS 和 loop。纹理无裁切、缩放或重排。示例场景按角色锚点设置脚底原点并使用 nearest 过滤；仅替换资源不会改变原角色碰撞/偏移。当前包只包含所选动作；给已有多动作角色更新时应合并该动作，保留其他动画，见[工程 Skill](game-engineering.md)。

MCP/CLI 的 `sprite-generator export` 同步返回 `godotPackage` 和实际 ZIP 文件，资产库下载也包含已有 Godot 包。服务端记录新增可选 `godot_package_path` / `godot_sha256`，下载接口为 `/v1/jobs/{job_id}/exports/godot`；旧记录无包时返回 404。ZIP 与 PNG 使用同一份已验证快照，并与其他导出文件一起原子发布/回滚；不绕过审批、不调用模型，不要求安装 Godot。

验证：SpritePipeline `tests/test_godot_export.py` 覆盖包内容、下载、旧记录、UI 回调、源文件修改拒绝和回滚。设置 `GODOT_47_BIN` 后还会真实导入并播放，验证非规则帧序、别名、FPS、循环和脚底偏移。

表单、像素修补编辑器与动画播放器跟随工作台深浅主题。API Key 等输入框使用可见边框和聚焦色；切换主题通过消息同步，不重载播放器。

## 将已导出动画交给游戏项目

工作区顶部“已导出动画 → 游戏项目”读取当前作业已经保存的 Godot 包，打开统一目录选择窗口；不存在包时提示先完成采用/导出，不触发生产。要交付某个精确候选，用它的资产详情入口。帧序、别名、FPS、loop 与原包保持一致，WorkBuddy 应合并到原角色动作中，保留其他动画与控制器。详见 [Godot 交付](godot-delivery.md)。

### 序列帧导出到游戏项目

在角色美术的内嵌序列帧工具进入“4 · 导出”，导出 PNG + Godot 包成功后会打开统一项目选择窗口。选择或输入游戏根目录并点“导出到此项目”，再点“复制给 WorkBuddy”获取精确交付及动作接入请求。已有导出可通过“选择游戏项目并交付给 WorkBuddy”再次交付；路径会记住，仍可仅下载 ZIP。保持当前作业与候选一致；接入时只合并本次动作，保留其他动作与控制器。窗口不会自行启动 WorkBuddy，导出成功不代表脚本接好或引擎通过。独立 SpritePipeline 的 ZIP 下载保持可用。

### 已导出动画再次使用

作品库“导出”会恢复所选候选的 PNG、Godot 包和附加文件。播放检查中的已采用结果显示“已采用：返回导出”，只导航、不重复审批；手动进入导出页会刷新已采用列表。历史 PNG 若没有可用 Godot 包，会提示以新的文件名导出完整包，保留旧文件；重新打包仍遵守原有检查门槛，不会自动生成或跳过审核。旧页面已经出现的控件错误需刷新页面清除。
