# 独立交互物编辑器

> 项目字段编辑源：`features/interactable-editor/contract.mjs`（经 `npm run schema:interactable` 同步至 `workbench/manifest.json`）。运行时：**Workbench Interaction Kit 1.0.0**（Godot 4.7.x）。

`/tools/interactable-editor` 用于编辑 2D 交互物件的外观、感知范围、碰撞、触发、反馈与状态记忆，可独立导出为不依赖特定游戏单例的 Godot 资源包。

## 1. 入口与工具选择

| 使用方式 | 适用场景 | 推荐接口与数据去向 |
| --- | --- | --- |
| **Web 编辑器** | 拖拽范围/碰撞、试玩模拟、上传素材与视觉微调 | IndexedDB 自动草稿 + Bridge 共享工程；导出建 runtime 任务 |
| **共享文档 MCP（日常推荐）** | Agent 与网页实时接续编辑同一 `projectId` | `workbench_list/get/create/save_document`、`workbench_apply_document_commands` → `work/editor-documents/` |
| **任务式 MCP / CLI** | 离线归档源工程或直接产出可审计 Godot ZIP | `interactable-editor` 能力的 `save-project` / `export-godot` → `work/tasks/` 与 `outputs/<task-id>/` |

- 共享保存、资产库 `save-project` 与 `export-godot` 彼此独立：保存源工程不自动导出 Godot。

## 2. 网页编辑与素材入口

只编辑交互物时运行 `npm run dev:interactable`（无需 Python、生图 API 或 Godot）；完整工作台运行 `npm run dev`。

1. 左侧新建或复制 **查看 / 切换 / 拾取 / 序列** 物件；导入 PNG/JPEG/WebP 图片（单文件 ≤ 64 MB，支持规则精灵表切片）与 WAV/OGG/MP3 音效。
2. 在 **外观、触发、行为、记忆** 页签配置参数，画布直接拖动范围与碰撞并在内置模拟器测试靠近、按键、点击与双物件重叠。
3. **物品原图与动画联用**：
   - 右侧“外观 → 获取图片”支持 GPT Image 2.6 生图、128 px PNG 导入与 PixelProp 大图转换（详见[物品原图](prop-art.md#导入与转换为动画原图)）；
   - 切换与序列物件的“制作状态动画”会保存工程并跳转[交互物动画面板](交互物动画独立面板方案.md)，写回与资产库复用见[内部素材导入](internal-imports.md)；
   - 静态默认图、切换状态图与序列条目图均可进入共用局部调整工作区（采用默认图会清空默认待机/聚焦动画，配置了动画的状态槽只读；操作与契约见[图片局部调整](image-editing.md)）。
4. **打开与导出**：“打开工程”支持本机草稿、源 JSON、资产库项目或本机服务端共享工程（全分页搜索，多标签共享未确认保存并防冲突覆盖）；“导出 Godot”可勾选多物件批量打包并进入[Godot 交付](godot-delivery.md)。

## 3. 共享文档与任务式 MCP

### 共享文档事务（推荐用于协作编辑）

- 发现与读取：`workbench_list_documents(kind="interactable")`、`workbench_get_document`（支持 `metadataOnly=true`），前端 `?document=<projectId>` 打开同一工程。
- 新建与命令事务：`workbench_create_document`、`workbench_apply_document_commands`（必填 `expectedRevision` 与 `commandId`，单次最多 100 条原子提交；冲突返回 `409 / REVISION_CONFLICT`，同命令安全幂等）：
  - 项目与定义：`rename`、`add-object`、`remove-object`、`rename-object`
  - 外观与素材：`add-asset`、`bind-asset`（切状态槽传 `target=toggle-state|sequence-entry` 与零基 `index`）、`set-visual`、`import-motion-asset`
  - 范围与触发：`set-shape`、`set-activation`
  - 行为与反馈：`set-content`、`set-behavior`、`set-feedback`、`set-completion`
- 图片采用与模拟：`workbench_adopt_document_image` 按任务 ID 与 SHA-256 采用 `image-assets` 物品为默认图；`workbench_validate_document` 校验结构与媒体；`workbench_simulate_document` 确定性回放最多 200 个类型化事件并检查 `expectEvents`/`expectStates`（只读）。`workbench_restore_document` 将历史快照恢复为新版本。

### 任务式接口（模板、归档与导出）

```bash
npm run workbench -- describe interactable-editor --json
npm run workbench -- run interactable-editor --input examples/requests/interactable-export.json --json
```

- 先调 `workbench_interactable_template(kind, name?)` 获取模板，再配置完整 `project`（至少含 `projectId`、`objects[].definitionId`；兼容忽略早期残留 `copyworms` 字段）：
  - `operation: "save-project"`：保存完整源工程 `interactable-project.json` 到资产库。
  - `operation: "export-godot"`：可选 `selectedDefinitionIds` 与 `targetProfile: "generic"`，纯本地产出 `interactables.zip`、`interactable-project.json` 与 `result.json`。
- 主要配置组：`visual`（含 `clips`）、`detection`、`pointer`、`solid`、`activation`、`content`、`behavior`、`feedback`、`cooldownSeconds`/`completion`、`memory`（完整约束以 `contract.mjs` 与 manifest 为准）。

## 4. 行为、触发与状态记忆约定

| 行为类型 | 一次成功交互结果 |
| --- | --- |
| `inspect`（查看） | 展示内容与反馈，可重复或一次完成 |
| `toggle`（切换） | 切换 A/B 状态，可分别设图片、动画、色彩、显隐与碰撞 |
| `pickup`（拾取） | 提交一次 `picked_up`，随后保留、隐藏或释放 |
| `sequence`（序列） | 推进一项，末项可停止、循环或停留 |

- **四种触发**：`proximity_press`（默认 action `workbench_interact` / 键 `E`，优先用游戏既有按键映射）、`pointer_click`（按 Z → 优先级 → 距离 → 节点路径消歧）、`automatic_enter`（进入排队一次）、`external_request`（代码显式触发）。同一运行时一次只受理一个交互。
- **反馈与实例隔离**：按序执行 `show_text`、`wait`、`play_animation`（需等待时关循环）、`play_audio`；状态与冷却均属各实例独立持有。
- **状态记忆**：`instance`（默认，重载重置）、`session`（关卡共用 `InteractionStateStore` 节点，`clear_session()` 清空）、`persistent`（落盘 `user://workbench_interaction_<slot>.cfg`，支持 `get_state()` / `apply_state(snapshot)` 接自定义存档；动态节点应设显式 `instance_id`）。

## 5. Godot 导出结构与信号接入

解压 `interactables.zip` 到项目根，保留 `addons/workbench_interaction/`（含 `runtime/v1/`、`objects/<definition-id>/{object.tscn,definition.tres,assets/}`、`sources/`、`packages/`，不含 `project.godot`）。

1. 在关卡根放置一个 `runtime/v1/interaction_runtime_2d.tscn`，再摆放 `object.tscn`。
2. 靠近触发时把带碰撞形状的 `PhysicsBody2D`（如 `CharacterBody2D`）加入 `interaction_actor` 组并匹配 detection mask（或直接设运行时 `actor`）。
3. 通过信号连接游戏逻辑（`focus_entered` / `focus_exited` / `interaction_started` / `interaction_finished` / `interaction_cancelled` / `interaction_completed` / `picked_up` / `toggled` / `sequence_advanced`，均携带 `context` Dictionary；另提供 `set_enabled`、`reset_state`、`get_state`、`apply_state`）：

```gdscript
func _ready() -> void:
    $Collectible.picked_up.connect(_on_picked_up)
    $InteractionRuntime2D.busy_changed.connect(_on_busy_changed)

func _on_picked_up(context: Dictionary) -> void:
    print(context.definitionId, context.instanceId, context.result)

func _on_busy_changed(busy: bool) -> void:
    pass
```

## 6. 开发与测试

```powershell
npm run schema:interactable   # 修改 contract.mjs 后同步 manifest
npm run test:interactable     # 传 -- --godot <路径> 或设 GODOT_47_BIN 跑实机引擎回归
npm run test:interactable-http
npm run test:interactable-web
```

其余联调与壳层回归见[开发导航](../workbench/guides/development.md)。
