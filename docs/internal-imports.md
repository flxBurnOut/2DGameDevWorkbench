# 内部素材导入与跨模块联用

交互物编辑器可直接从资产库复用图片、动画和完整源工程，无需先下载再上传；导入不调用生成模型、不建生产任务。

## 1. 已接通的复用入口

| 来源 | 入口 / 操作 | 效果 |
| --- | --- | --- |
| 资产库交互物 | 编辑交互物项目 | 读取完整源工程并定位目标物件，保留行为、图片、音效与范围 |
| 物品原图或角色原图 | 用于交互物外观 | 绑定当前物件默认图（停用默认动画），保留状态图与行为 |
| 资产库动画 | 用于交互物动画 | 导入选定候选的有序帧、FPS 与循环作为默认动画 |
| 交互物状态链 | 素材区选择切换槽或序列条目的“状态图 / 进入过渡” | 写入已确认状态图或已接受过渡片段（见下文写回协议） |
| 已完成 `image-assets` 任务 | 页面采用或 `workbench_adopt_document_image` | 按任务 ID 与 SHA-256 采用透明物品为默认图 |
| 共享交互物工程 | `?document=<id>` 或文档 MCP 工具 | 打开同一服务端版本，保留来源快照 |
| 物品/角色原图移送 | `reference-art transfer` | 移送为角色或交互物动画参考对象 |
| 静态槽 / 独立图片局部调整 | 局部调整入口 | 详见[图片局部调整](image-editing.md) |

- **格式过滤**：交互物静态外观仅接收原件为 PNG、JPEG、WebP 的素材；GIF 仅支持在资产库预览和下载，不会自动抽帧转换。
- **物品原图分类**：按任务 `subject=prop` 分类（兼容缺少 `subject` 但验证通过的旧 prop 记录，拒绝冲突的 character 记录）。

## 2. 一致性与冲突保护

- 导入前校验资产 ID、版本指纹与 SHA-256；来源变化或缺文件时中止并保留当前编辑。
- 替换项目前先保存当前草稿；同 ID 不同内容的项目按独立导入版本处理。导入期间暂停跨页导航。
- 同一原图重复导入复用素材 ID；不同来源即使像素相同也保留各自任务与哈希记录。

## 3. 共享文档采用与状态链写回

通用共享文档事务（`expectedRevision`、`commandId`、`validate`、`simulate`）见[交互物编辑器](interactable-editor.md)与[连接器契约](connector-contract.md#8-交互物适配器与共享文档)；与跨模块素材复用直接相关的两项操作：

- **采用图片任务（`workbench_adopt_document_image`）**：消费已完成的 `image-assets` 任务，按 `sourceTaskId` + `sha256` 重读原 PNG 并绑定指定 `definitionId`，保留行为与状态图。
- **写回交互物状态链（`import-motion-asset`）**：
  1. 用 `workbench_list_assets` 按 `motionSource=state` 或 `transition`（带 `derivation` 为人工接受的派生素材）查找目标并取得详情中的 `revision`。
  2. 经 `workbench_apply_document_commands` 提交 `import-motion-asset`，传入 `assetId`、`assetRevision`、`definitionId`、`target`（`toggle-state` 或 `sequence-entry`）和从 0 开始的 `index`（过渡可附加 `durations` 与 `playback: ping_pong` 调整节奏，不改原帧）。
  3. 写回状态图会覆盖该条目的待机动画继承；过渡按确认帧序、FPS 与末帧停留播放，回执 `frameHashes` 记录逐帧 SHA-256。写回前后可用 `workbench_get_motion_bindings` 只读核对各槽绑定（网页端对应交互物动画面板“写回”页签）。

## 4. 实现与验证

- 导入用途定义在 `manifest.assetImports`，Web 代理 `POST /api/workbench/assets/import` → `/v1/assets/import`，返回带清单与校验值的内部 ZIP（上限 256 MB；临时移送存浏览器 IndexedDB）。
- 交互物“保存到资产库”执行 `save-project` 持久化可编辑源工程；交付到外部 Godot 游戏工程见[Godot 交付](godot-delivery.md)。
- 回归测试：`npm run test:asset-import`、`npm run test:prop-art`、`npm run test:editor-documents`。
