# 独立交互物编辑器

> 状态：当前维护。项目字段的编辑源是 `features/interactable-editor/contract.mjs`，同步后的机器契约位于 `workbench/manifest.json`。

工作台能力为 `interactable-editor`，页面为 `/tools/interactable-editor`，运行时为 **Workbench Interaction Kit 1.0.0**，目标引擎为 Godot 4.7.x。实现基于 copyWorms 的范围感知、最近物件选择和一次性完成逻辑，整理为独立配置与运行时，不依赖原游戏的单例、人物、背包或关卡。

| 使用方式 | 适合场景 | 数据去向 |
| --- | --- | --- |
| Web 编辑器 | 画面、范围、碰撞、文本、动画、声音和模拟等人工操作 | 草稿在浏览器；导出时建立 runtime 任务并下载源文件/ZIP |
| MCP / CLI `export-godot` | Agent 已有结构化项目，需要可审计导出 | `work/tasks/` 与 `outputs/<task-id>/` |

两种入口使用相同导出器，但浏览器草稿只有在执行导出后才成为 runtime 任务；它不会自动变成外部 Agent 发起的任务。交互物与地图可以分别导入 Godot，也可以通过[场景组装](scene-composer.md)手动摆放后统一导出。本编辑器继续只负责物件素材与行为。

## 物品原图生成

右侧提供“生成物品原图”面板，复用 PixelLab Key 与原图异步任务：描述 → 预览 → 明确采用到当前物件。输出 128×128 侧视透明 PNG，历史以 kind=prop 保存；图片生成与本编辑器的 save-project / export-godot 分开。采用保留物件身份和行为，图片来源 / SHA-256 随源包保存，保存与导出检查来源图片是否被改动。详见[物品原图](prop-art.md)。

## 开始编辑

运行 `npm run dev:interactable`，然后进入交互物编辑器。此命令启动网页与本地导出服务，不启动序列帧服务，也不需要 Python、图片生成 API 或 Godot。完整工作台也可使用 `npm run dev`。更新代码后，已运行的 Node Runtime Bridge 需要重启才能加载新适配器。

1. 左侧新建“查看、切换、拾取、序列”物件，或复制已有物件。复制会生成新的定义 ID。
2. 导入 PNG、JPEG、WebP 图片和 WAV、OGG、MP3 音效。可按自然文件名顺序导入多张动画帧，也可按单帧尺寸和帧数对规则精灵表从左上角依次切片。
3. 在“外观、触发、行为、记忆”页签配置物件。外观、感知范围、鼠标点击区域、物件自身的实体碰撞分别编辑。
4. 可在画布拖动来源或范围，模拟靠近、离开、按键、点击、外部调用和双物件重叠；查看文本、音效、动画、事件与状态恢复。
5. 点击“导出 Godot”下载通用包，或点击“导出 copyWorms 兼容版”下载适配包。左侧勾选多个物件后可以批量导出。没有必做的预览、Godot 检查或验证报告。

本机草稿通过 IndexedDB 自动保存。“保存源文件”下载可继续编辑的 JSON；“导入项目”可以打开源 JSON 或本工具导出的 ZIP。Godot 中手改的 `.tscn/.tres` 不反向写入源 JSON。任意第三方 `SpriteFrames.tres` 不属于当前导入格式；使用原始帧图或精灵表即可。

## 行为约定

| 类型 | 一次成功交互的结果 |
| --- | --- |
| inspect / 查看 | 展示内容和反馈；可重复，或一次完成 |
| toggle / 切换 | 成功后切换 A/B 状态，可分别配置图片、动画、色彩、显隐和自身碰撞 |
| pickup / 拾取 | 只提交一次 `picked_up`，完成后保留、隐藏或释放 |
| sequence / 序列 | 成功后推进一项；末项可停止、循环或停留末项 |

四种触发为 `proximity_press`（靠近按键）、`pointer_click`（点击）、`automatic_enter`（每次进入触发一次）、`external_request`（游戏代码请求）。默认 action 为 `workbench_interact`，键为 E；Godot 中已有 action 的映射保持不变。

同一运行时一次只受理一个交互，重叠时只显示最近且符合条件的物件提示。指针触发先按物件 Z，再按优先级、距离和节点路径消歧。自动触发在进入时排队，站在原地不会连续触发。显式外部请求可以省略来源和靠近要求，仍受完成、启用、冷却和忙碌状态限制。

反馈可按顺序组合 `show_text`、`wait`、`play_animation`、`play_audio`；成功状态由运行时提交，无需手动添加 finish 或信号步骤。要求等待的动画须关闭循环；循环动画可作为待机或状态外观。不等待的反馈可与后续步骤同时进行；隐藏或释放会结束物件显示，所以需要播完的拾取反馈应勾选等待。

完成状态、切换值、序列索引和成功次数属于每个实例，共享模板不共享进度。取消发生在提交之前，不推进索引、不发成功信号。冷却从成功后开始；最终完成的物件不再响应。编辑器预览模拟上述规则，白色来源使用碰撞层 1；实体碰撞仅可视化，不模拟人物移动物理。

## 导入 Godot

将 ZIP 解压到目标项目根目录，保留 `addons/workbench_interaction/` 结构：

```text
runtime/v1/                          固定 GDScript 和运行时场景
objects/<definition-id>/object.tscn   可编辑的交互物场景
objects/<definition-id>/definition.tres
objects/<definition-id>/assets/       原图、帧图、音效
sources/<export-id>/interactable-project.json
packages/<export-id>/INSTALL.md
packages/<export-id>/package-manifest.json
```

包不含 `project.godot`、EditorPlugin、旧 UID 或 `.godot` 缓存。素材可以被同一批次的多个物件引用，复制时应保留整个 addons 包。再次导出相同定义 ID 会更新对应物件目录；复制为新物件会使用新的目录。同一运行时主版本放在 `runtime/v1`，导入多个包时保持运行时版本一致。

在关卡根节点下放置 `runtime/v1/interaction_runtime_2d.tscn`，再放置各个 `object.tscn`。物件自动寻找最近祖先范围内的运行时，每个关卡配置一个即可。导出的物件本身已包含 Sprite/AnimatedSprite、感知碰撞形状和可选 StaticBody2D，可以在 Godot 编辑器看到并摆放。

靠近模式需要一个带有效碰撞形状的 `CharacterBody2D`、`RigidBody2D` 或其他 `PhysicsBody2D` 来源。将该物理节点加入 `interaction_actor` group，并让物件 detection mask 包含它的 collision layer。也可直接设置运行时的 `actor`。仅给普通 Node2D 加 group 不会产生 Area2D 物理重叠；无人物场景请使用指针或外部调用。

游戏逻辑通过信号接入，不会自动冻结人物或修改背包。例如：

```gdscript
func _ready() -> void:
    $Collectible.picked_up.connect(_on_picked_up)
    $InteractionRuntime2D.busy_changed.connect(_on_busy_changed)

func _on_picked_up(context: Dictionary) -> void:
    print(context.definitionId, context.instanceId, context.result)

func _on_busy_changed(busy: bool) -> void:
    # 如游戏需要，在这里切换自己的输入控制状态。
    pass

func trigger_from_game() -> void:
    var accepted: bool = $Collectible.request_interaction()
    print("是否受理：", accepted)
```

全部信号：`focus_entered`、`focus_exited`、`interaction_started`、`interaction_finished`、`interaction_cancelled`、`interaction_completed`、`picked_up`、`toggled`、`sequence_advanced`。携带的 context 包括 definitionId、instanceId、source、kind、result；取消时额外包含 reason。`interaction_finished` 表示一次成功，`interaction_completed` 表示最终完成。可调用 `set_enabled(bool)`、`reset_state()`、`get_state()`、`apply_state(snapshot)`。

## copyWorms 兼容导出

兼容包输出为 `interactables-copyworms.zip`，放在独立的 `addons/workbench_interaction_copyworms/` 目录，不覆盖普通包、原游戏脚本或 `project.godot`。在**实际关卡根节点**下放置 `compat/copyworms/v1/interaction_runtime_2d.tscn`，然后放置包内物件；每关一个兼容运行时。MainEntry 模式也放在其关卡子节点下。

兼容基线为 copyWorms `bb1581d12c9626e294e403a01db5f3cffb229cd8`、Godot 4.7.x。自动连接 `GameManager.player_ref` / `player` group、人物碰撞位 4、`ui_accept`（默认 Enter，保留原改键），并接入原输入锁、对话状态、鼠标释放令牌和 UI 层 100。完成、取消、移除只释放本运行时的资源；暂停、转场、其他输入锁期间不发起新交互。新旧物件同时可用时，更近者响应，同距离优先原物件，一次输入只触发一个。

“触发 → 高级接入 → copyWorms 原事件物件 ID”可留空；留空执行编辑器行为。填写后，每次成功完成再发送 `interactive_object_triggered`，数据为 `{object_id: ID, workbench_context: context}`。取消、状态恢复不会发送。例如 `notice` 仍需要第一关处于卧室阶段。该映射不替换原节点，不绕过原 FSM，不会为自定义 ID 自动生成剧情处理器。四种物件原有的自定义信号仍可连接。

兼容转换只更改生成的 Godot 配置；草稿、源 JSON 和重新导入的源配置保留普通版的按键、层和 group。网页预览模拟通用行为，原剧情和原输入锁在游戏中运行。原项目接口变化后需要同步适配器。

CLI/MCP 使用相同能力与操作，在 input 中增加 `"targetProfile": "copyworms"`；省略时仍为 `generic`。示例：`examples/requests/interactable-copyworms-export.json`。开发验证命令为 `npm run test:interactable-copyworms -- --project <copyWorms路径> --godot <Godot可执行文件>`，只在 outputs 下复制项目并测试，不改动原项目。

## 可选状态记忆

- `instance`：默认。只保存在当前物件，重新加载后重置。
- `session`：在游戏根节点保留同一个 `InteractionStateStore`，将各关卡运行时的 `shared_state_store` 指向它。开始新局调用 `clear_session()`。
- `persistent`：使用 `user://workbench_interaction_<slot>.cfg`；`clear_slot(slot)` 清空该槽。也可通过快照方法接入自己的存档系统。

状态键组合 slot、namespace、关卡标识和 instance_id。运行时可填写稳定的 `scene_key`；静态物件默认以关卡内节点路径识别，动态物件或会改名的节点应设置显式 `instance_id`。相同物件模板的不同实例要使用不同 ID。恢复状态不会重播拾取或其他成功信号，已完成的 free 物件会恢复完成记录后释放。

## CLI 与 MCP

网页、CLI、MCP 都调用同一个 `lib/workbench/adapters/interactable-editor.mjs`。能力入口只登记在 `workbench/manifest.json`；生成器、模拟器和 Godot 模板位于 `features/interactable-editor/`。

```bash
npm run workbench -- list --json
npm run workbench -- describe interactable-editor --json
npm run workbench -- run interactable-editor --input examples/requests/interactable-export.json --json
npm run workbench -- status <task-id> --json
```

MCP 使用 `workbench_list_capabilities`、`workbench_describe_capability`、`workbench_run_task`、`workbench_get_task`。用户已要求导出时可以直接 run；prepare 只用于希望单独检查输入的情形。

输入外层字段为 `operation: "export-godot"`、`project`、可选的 `selectedDefinitionIds` 和 `targetProfile: "generic" | "copyworms"`（默认 generic）。省略选择表示导出全部；网页默认导出当前物件。项目至少包含 `projectId` 和 `objects`，物件至少包含 `definitionId`，其余字段有默认值。不要从本文手工复制一份 schema；模板分组用于理解，实际约束以 contract/manifest 为准：

| 配置组 | 主要字段 |
| --- | --- |
| visual | assetId、width/height、offset、scale、flipH/V、zIndex、visible、tint、idleAnimation、focusAnimation、float、dot、clips |
| visual.clips | name、fps、loop、frames；每帧 assetId、duration，可选 region {x,y,width,height} |
| detection | shape、actorGroup、mask、priority |
| pointer | type、width、height、radius、offset |
| solid | enabled、shape、layer、mask |
| activation | mode、action、key、cancelOnExit、enabled |
| content | prompt、pages、charactersPerSecond、promptOffset |
| behavior | kind、repeat、initialToggle、states[2]、entries、onEnd |
| feedback | type 对应的 pages / seconds / animation / assetId / waitForEnd / volumeDb |
| 收尾 | cooldownSeconds、completion: remain/hide/free |
| memory | scope、namespace、slot |
| copyworms | objectId：可选的原剧情事件物件 ID，仅兼容版生效 |

项目 assets 使用 `{id,name,mime,source}`。source 可为工作区内路径或支持格式的 base64 data URL。浏览器按素材单独上传，每个素材上限 64 MB；项目导回上限 256 MB。字段默认值与约束以 `contract.mjs` 为准。切片坐标和尺寸使用像素，duration 为相对于 fps 的帧时长倍数。

实际输出为 `outputs/<task-id>/interactables.zip`（兼容版为 `interactables-copyworms.zip`）、`interactable-project.json` 和 `result.json`，任务记录在 `work/tasks/<task-id>.json`。独立源 JSON 内嵌素材，可以移到其他机器继续编辑。`completed` 表示文件生成完成，不表示已验证用户目标游戏。

## 开发检查

```powershell
npm run test:interactable
npm run test:interactable -- --godot 'C:\path\to\Godot.exe'
npm run test:interactable-copyworms -- --project 'C:\path\to\copyWorms' --godot 'C:\path\to\Godot.exe'
npm run test:interactable-http
npm run test:interactable-web
npm run test:mcp
npm run workbench -- doctor --json
npm run typecheck
npm run lint
npm run build
```

Godot 参数也可通过 `GODOT_47_BIN` 提供；无参数只运行 JavaScript 检查。引擎回归测试生成隔离项目，覆盖四类行为、重叠焦点、输入消费、碰撞 mask、自动进入、文本、取消、冷却、媒体、释放、实例隔离和状态恢复。HTTP 测试覆盖上传、直接导出和源包导回。这些开发检查均不会在用户导出时执行。

修改 `contract.mjs` 后运行 `npm run schema:interactable`，将完整字段 schema 同步到 manifest；JavaScript 测试会检查两者一致。此脚本只更新交互物能力的 project 字段，保留其他能力配置。同步结果必须与代码一起提交，并运行 doctor。Windows 隔离环境偶尔无法读取系统根证书，离线引擎测试会单独报告该环境提示，仍严格检查脚本错误和测试退出状态。

完整验证矩阵见 [使用与操作手册](operations-manual.md)。

## MCP 制作与继续编辑

1. 发现 `interactable-editor` 的 schema，再调用 `workbench_interactable_template`，传入 `kind`（inspect/toggle/pickup/sequence）和可选名称。模板查询不生成文件、不创建任务、不调用生图 API。
2. Agent 在完整 `project` 中配置外观、触发、行为和记忆；保留 projectId 和 definitionId。`save-project` 保存全部物件与素材，产生可移植的 `interactable-project.json`，不导出 Godot 包。此操作不接受导出专用的 selectedDefinitionIds 或 targetProfile。
3. `workbench_get_result` 返回带 task 参数的编辑地址；制作记录中的物件也直达编辑器。已有不同的同 ID 本机草稿会保留，Agent 版本另存；再次打开同一任务会恢复该版本的后续编辑。
4. Agent 继续修改时，通过 get_task/read_artifact 读取已有源文件，修改后再次 save-project；需要交付包时才 export-godot。已保存不等于已导出。模板没有生成美术，缺图片时只能称为交互逻辑草稿。

人工验收：重连 MCP 后说“制作一扇靠近按 E 开关的门，先保存逻辑草稿，不要生成美术或导出”。应出现一个可继续编辑的物件，前端可查看触发与切换状态；再说“把按键改为 F，然后导出 Godot”，应沿用原物件 ID 并给出真实 ZIP。另说“把地图自动拼起来”，应引导至地图前端，任务数量不增加。

## 内部素材联用

当前支持从资产库直接选择可复用源文件，及地图、交互物与场景之间的内部移送；无需下载后再上传。导入不生成、不增加后台任务，保留版本和源文件；具体入口、默认辅助显示和升级方式见 [内部素材导入](internal-imports.md)。

## 交付到游戏项目

“导出 Godot”及 CopyWorms 兼容导出完成打包后，共用项目选择窗口。Agent 安装已有运行时和选中物件，再按目标项目连接人物检测、交互信号及已确定的业务逻辑；新窗口不改变选中对象或兼容配置。保存到资产库仍只是保存编辑源。详见 [Godot 交付](godot-delivery.md)。
