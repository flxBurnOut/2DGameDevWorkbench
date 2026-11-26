# 资产目录与交接清单

资产目录（前端入口 `/assets`）汇总工作台内所有已落盘的可复用资产，提供按类型/名称检索、分页浏览、ZIP 打包下载、素材包导入与可恢复回收站。资产目录与任务执行历史相互独立：查询不建任务、不调模型，归档后台执行记录也不隐藏资产。

## 1. 资产类型与 ID 规则

扫描全部已登记产物的任务记录、SpritePipeline 原生作品库与本地导入包（不自动扫描浏览器 IndexedDB 未保存草稿或外部游戏目录；交互物经 `save-project` 保存后即被收录）：

| 类型（`kind`） | 典型 ID 格式 | 说明 |
| --- | --- | --- |
| `character` | `reference:<taskId>` / 角色预设 ID | 角色原图（原图任务与移送角色按 `sourceTaskId`/`characterId` 关联展示） |
| `prop` | `image:<taskId>`、`reference:<taskId>`、`motion-state:<job>:<候选>:<序>`、`motion-derived:<work>:<id>` | GPT Image 物品、本地处理变体、PixelLab 物品图、已确认状态图及人工接受的派生状态图 |
| `animation` | `animation:<jobId>:<candidateIndex>`、`motion-transition:...`、`motion-derived:...` | 角色与交互物动画候选（含 `objectId`/`objectType`）、已接受过渡及人工接受的派生过渡 |
| `interactable` | `projectId` + `definitionId` | 已保存的交互物工程（部分导出不删其余物件） |
| 导入资产 | `imported:<32hex>` | 通过素材包导入的本地资产，原服务离线仍可预览、下载与复用 |

- 同源不同候选独立列出；同一候选的多次查询、检查或导出不增加资产数；不同独立生成即使像素相同也不合并。
- 详情 `history` 可追溯已归档的制作/导出记录；当前下载只打包当前版本文件。

## 2. 只读工具与筛选参数

MCP、CLI `agent` 与 HTTP `POST /v1/agent/<operation>` 共用 [asset-contract.mjs](../lib/workbench/asset-contract.mjs)：

| MCP 工具 | CLI / HTTP | 参数 |
| --- | --- | --- |
| `workbench_list_assets` | `assets` | `query`、`kind`、`characterId`、`actionId`、`candidateCount`、`candidateIndex`、`status`、`availability`、`purposes`、`target`、`scope`（`active`/`trashed`）、`sortBy`（`createdAt`/`updatedAt`）、`limit`（默认 24，上限 100）、`offset`、`snapshot` |
| `workbench_get_asset` | `asset` | `assetId`（返回尺寸、帧率/朝向、文件存在性、SHA-256、版本指纹与精确页面链接） |
| `workbench_get_asset_manifest` | `asset-manifest` | `assetIds`（1–100 个）、可选 `projectName`（返回 `manifest` 与 `markdown` 交接说明，不复制文件） |

- `query` 用于名称关键词搜索；按批次定位候选时使用 `candidateCount`、`candidateIndex` 与 `sortBy=createdAt` 等结构化参数。
- 翻页时带回 `snapshot` 直至 `nextOffset` 为 `null`；目录变更时从第一页重查。任务历史分页规则见[连接器契约](connector-contract.md#任务历史分页)。

## 3. 打包下载与素材包导入

- **ZIP 打包下载**：前端点击“下载所选素材”或详情页“下载素材（ZIP）”调用 `/api/workbench/assets/download` → `/v1/assets/download`，返回 `forge-assets.zip`（单次上限 100 件、源文件总计 128 MiB，超出分批下载）。包内每件资产独立建目录并附根目录清单 `forge-assets.json`（含路径、角色、SHA-256、帧序、FPS、循环、`frameDurations` 与已有 Godot 包）。下载仅复制当前文件，不触发审核或导出。
- **导入 Forge 素材包**：入口在资产库顶部及 `/assets?import=package`，先上传检查再确认选中项入库；支持“打开编辑副本”分配新本机工程 ID。完整包格式、暂存与提交 API 见[Forge 素材包导入合同](asset-packages.md)。

## 4. 关联工作流入口

- **物品原图生成与本地处理**：GPT Image 与 `process-image` 详情直达 `/tools/interactable-editor?imageTask=<taskId>`，规则见[物品原图](prop-art.md)。
- **图片局部调整**：可用、未回收的 `image:` 详情页提供 **局部调整图片** 按钮，完整操作与恢复见[图片局部调整](image-editing.md)。
- **内部跨模块导入**：资产库中的图片、动画与工程可直接导入交互物编辑器，详见[内部素材导入](internal-imports.md)。
- **交付到 Godot 游戏**：详情页可将已有 Godot ZIP 交付到目标项目，详见[Godot 交付](godot-delivery.md)与[游戏工程](game-engineering.md)。

## 5. 可恢复回收站

资产库支持单选或批量勾选（单批上限 100 件）执行 **移入回收站** 或 **恢复所选**（经 `POST /api/workbench/assets/manage` → `/v1/assets/manage`）。

- 回收站仅调整目录可见性，**不删除磁盘源文件、任务记录或已有工程引用**（也不能恢复已被用户手动从磁盘删除的文件）。
- 索引位于 `work/asset-trash/index.json`，采用跨进程目录锁与原子替换保护；损坏或残锁时采用安全失败策略（确认无写入进程后再由维护者清理锁）。备份工作区数据时应保留此目录。
- `workbench_list_assets` 传 `scope=trashed` 可查询回收站，三个资产 MCP 工具保持纯只读。
