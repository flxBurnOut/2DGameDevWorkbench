# 内部素材导入与联用

交互物编辑器从资产库复用真实图片、动画和完整项目，无需先下载再上传。导入不生成、不导出引擎包，也不创建生产任务；采用后按目标编辑器保存草稿。共享交互物文档让网页和 Agent 继续同一工程；Agent 使用已声明的类型化命令。

## 已接通的入口

| 来源 | 入口 | 结果 |
| --- | --- | --- |
| 资产库交互物 | 编辑交互物项目 | 读取完整源项目，默认选中所选物件，保留行为、图片、声音与范围 |
| 物品原图或角色原图 | 用于交互物外观 | 绑定当前物件默认图片，保留状态图片和行为 |
| 资产库动画 | 用于交互物动画 | 导入选定候选的有序帧、FPS 和循环设置，作为当前物件默认动画 |
| 交互物编辑器 | 从资产库打开项目 / 导入原图或动画 | 打开完整项目，或把外观导入当前物件；不同版本保留独立项目 |
| 交互物状态链 | 在素材区选择切换槽或序列条目的“状态图”或“进入过渡”，再从资产库选用 | 写入确认的静态图，或把已接受段绑定为进入该条目时播放一次的动画 |
| 已完成 image-assets 图片任务 | 明确采用，或 `workbench_adopt_document_image` | 透明 prop 绑定指定交互物默认图片 |
| 共享交互物工程 | `?document=<id>` / 文档工具 | 打开同一稳定身份与服务端版本，保留来源快照 |
| 交互物静态槽 / 独立图片任务 | 图片编辑工具与共用工作区 | 读取真实源图、生成候选，再明确采用到绑定目标 |

角色原图到序列帧的“用于制作序列帧”沿用既有 transfer 流程。N2 已接通物品原图到交互物动画对象库的移送。图片不自动形成拾取、开关或剧情行为；动画导入不生成角色控制器，也不自动写入某个状态过渡。

交互物静态外观接受 PNG、JPG、WebP，依据原件格式筛选，不以预览图格式代替原件。GIF 仍可在资产库预览和下载；选择器、详情与直接导入请求会给出明确原因，不会自动抽帧或转换。

## 物品原图分类与旧记录

分类依据生成任务的 subject=prop，不依据图片相似度或名称。旧 result.json 缺少 subject 时，仅在任务明确为 prop 且 PNG 尺寸、SHA-256 均验证通过时兼容读取；明确 character 的冲突记录仍拒绝。分类或导入不重写生成记录，不重新生成。

服务端变更后 Runtime Bridge 与 MCP 需要加载新代码；旧 MCP 进程读取新版 manifest 不代表已经加载新版分类实现。按需重启后台、重连 MCP 并刷新前端。

原件格式元数据也由 SpritePipeline 提供；更新后重启旧 SpritePipeline 实例，使列表能够报告准确的 `primaryMime`，再刷新来源列表，无需重新生成素材。

## 来源与一致性

- 选择器支持名称搜索、分页和部分来源离线提示；只有可用的适用素材能导入。
- 内部读取校验所选资产身份、版本指纹和 SHA-256。来源变化或缺文件时失败，保留原编辑内容。
- 项目替换前保存当前草稿；同身份不同内容的项目作为独立导入版本，不覆盖原项目。
- 默认静态图片采用后停止原默认动画；状态专用采用保留默认与其他状态配置。动画导入保留原片段，新增默认播放片段。
- 同一原图重复导入复用素材身份；不同来源即使像素相同也保留各自来源。物品原图保留生成任务和内容哈希。
- 导入期间暂停跨页导航，避免迟到结果写入另一物件。源文件与编辑副本不自动双向覆盖。

## 共享版本与采用

交互物以 projectId 为文档身份，物件 definitionId 和资产 ID 沿用现有合同。共享保存冻结图片、动画与音效来源，之后修改上游不会自动改写已采用版本。

`workbench_get_document` 返回可审阅内容与 revision。apply/save/restore/adopt 必须带 expectedRevision 和稳定 commandId；冲突返回 409。相同命令重试返回原提交版本，currentRevision 另报告当前头版本；二者不同则重读当前工程。加载远端前保留本机恢复副本，不用旧草稿覆盖新版本。

`workbench_adopt_document_image` 只消费已完成 image-assets 任务，以 sourceTaskId + sha256 重读原 PNG，并指定已有 definitionId。采用保留行为与状态图片，是一次版本事务，不调用模型、导出或另建图片任务。不能用预览、缩略图或下载 URL 替代原图证据。

写回状态链时，用 `workbench_list_assets` 按 `motionSource=state` 或 `transition` 查询，取所选资产详情的 `revision`。通过 `workbench_apply_document_commands` 提交 `import-motion-asset` 命令，指定 `assetId`、`assetRevision`、`definitionId`、`target`（`toggle-state` 或 `sequence-entry`）和从 0 开始的 `index`。文档提交仍使用 `expectedRevision` 和原 `commandId`。状态图覆盖该条目的待机动画继承。过渡按确认的帧序和 FPS 播放，最终段包含约定的末帧停留。采用回执中的 `frameHashes` 按播放顺序列出 SHA-256。

validate/simulate 检查结构、媒体与有限交互事件，不代表 Godot 物理、真实音频或游戏存档。交互物导出继续使用 `interactable-editor` 的 `export-godot`；共享文档不提供观察图片或独立导出操作。

## 单张源图的局部调整

图片目标定位到交互物文档、定义和默认 / 切换状态 / 序列静态槽，或独立 image-assets 任务的 taskId。PNG、JPEG、WebP 保留文件 SHA-256，规范解码 sRGB/RGBA8 像素另有 rgbaSha256；预览和浏览器未保存草稿不是权威来源。

采用核对源 revision、哈希、目标绑定与命令身份。状态槽还核对槽位指纹，不能因 index 重排写到另一状态。交互物采用新增素材，只更新指定静态槽；行为、范围和碰撞保持。独立图片任务不可变，采用得到新的 `image:<候选任务ID>` 变体。图片调整不自动更新已导出的游戏资源。

工作区打开前等待持久保存，采用后读取准确版本并协调自动保存基线。“恢复打开时的图片”把这一张图片恢复为新版本，不回滚其他编辑。AI 候选冻结基准、硬边蒙版、描述与参考；精确会话和候选深链不改选同名新源。断连或重启后查询原任务，不自动重新提交。完整流程见[图片局部调整](image-editing.md)。

## 实现与验证

manifest.assetImports 声明导入用途、类型和目标编辑器。`POST /api/workbench/assets/import` 代理 `/v1/assets/import`，返回带身份清单与校验值的内部 ZIP，不调用生产 adapter。内部源文件总量上限 256 MB；临时移送存在浏览器 IndexedDB，不属于后台任务。共享文档另保存在 workspace.documentDirectory，由 Bridge 统一写入。

交互物的“保存到资产库”执行 save-project，创建完整可编辑源项目的保存记录，无需先导出 Godot。浏览、选择与导入不创建制作任务。

运行 `test:asset-import`、`test:prop-art`、`test:editor-documents` 及受影响的图片、交互物、资产、MCP/HTTP 和壳层回归。使用隔离 fixture，不消耗真实模型额度。真实宿主操作与 Godot 效果另行验收。完整工作台的历史跨编辑器验收保存在 [new-arch 文档](https://github.com/aaaarthur666-design/2DGameDevWorkbench/blob/new-arch/docs/internal-imports.md)，不作为本论文分支仍提供那些入口的声明。

[Godot 交付](godot-delivery.md)消费已导出的引擎包，写入明确选择的游戏，再由外部 Agent 接入脚本；它与工作台内部的可编辑源复用是不同步骤。
