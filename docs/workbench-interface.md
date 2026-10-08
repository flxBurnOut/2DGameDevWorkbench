# 工作台界面与制作流程

外层工作台围绕角色美术与场景组织资产生产，保持已有序列帧、地图、交互物工具的内部编辑方式。它是外部 Agent 的可视协作面：展示真实任务、进度和产物，并承载画布、图层、碰撞区等不适合纯对话操作的内容；页面不提供通用 Agent 对话框。

界面采用深蓝黑、网格和明确的角色美术/场景色彩语义，不再使用仿 macOS 的窗口灯或系统标题栏装饰。中文操作名优先，协议参数集中到工具内部或高级页。

## 入口与流程

| 页面 | 功能 |
| --- | --- |
| `/` | 两个大入口：角色美术、场景；全局制作状态栏；初次引导 |
| `/player` | 选择原图生成或序列帧制作 |
| `/tools/reference-art` | 输入描述 → 生成像素原图 → 移送为序列帧参考图 |
| `/tools/sprite-generator` | 选角色与动作 → 生成序列帧 → 检查与导出 |
| `/scene` | 提供生成地图原图、地图拼接、交互物与场景组装入口 |
| `/tools/map-stitcher` | 原有地图编辑器，外层增加草稿恢复和流程位置 |
| `/tools/map-stitcher-legacy` | 旧地图页面的兼容入口，仅用于回归或迁移，不作为默认制作路线 |
| `/tools/interactable-editor` | 原有交互物编辑器，支持按项目与对象定位恢复 |
| `/tools/scene-composer` | 组装已有地图与交互物，保存源包并导出 Godot 场景 |
| `/assets` | 分页查找持久资产、精确候选详情及下载真实素材 ZIP |
| `/advanced` | 服务连接、执行记录、输入快照和真实产物路径；不承担 Agent 对话 |

导航、上下文栏、制作状态栏用于定位工作；上下文栏不再展示不可操作的三步进度条。工具内的视图、图层、生成、预览、导入和导出继续沿用现有操作。地图和交互物既可独立导出，也可在场景组装中手动摆放并统一导出。场景素材更新需要手动替换，不自动改写来源。

## 新手引导

首次进入开始页展示三步引导：选择角色美术或场景、了解首件作品所需素材、学习从制作记录继续。支持上一步、跳过、最终进入所选路线。步骤和完成状态保存在当前浏览器的 `workbench.onboarding.v1`；顶部「新手引导」和高级工具中的入口均可从第一步重看。

引导不会创建项目、提交生成或调用收费图片接口。

## 制作记录

记录以具体资产为单位：某个角色动作、一张地图、一个交互物。底部显示最近的未完成资产，展开后分为制作中与已完成，提供恢复入口与存在于任务记录中的产物下载。

| 数据来源 | 标识与恢复方式 |
| --- | --- |
| 地图本机草稿 | `map:<uuid>`；链接中的 `?map=` 恢复该地图的图片、图层、区域和视图设置 |
| 交互物本机草稿 | `interactable:<projectId>:<definitionId>`；`?project=&object=` 恢复对应项目并选中对象 |
| 序列帧作业 | `sprite:<jobId>`；`?job=` 交由原生工具打开已有作业 |
| 后台执行记录 | 按已知作业或对象身份合并尝试与产物；无法关联本机草稿的记录进入高级任务详情 |

`prepared` 和 `awaiting_configuration` 明确显示尚未执行或等待配置。序列帧 `created` 表示作业保存、`review_required` 表示等待检查、`approved` 表示可导出，只有 `exported` 才表示完成。未知服务状态显示需要处理。服务断连时保留上次读取的状态，并提示连接中断；不会补造进度百分比。

后台记录与原生作业每 6 秒刷新，刷新只查询已有作业，不重新发起生成。测试 fixture 与诊断作业不进入原生资产列表。

## 保存与恢复

地图和交互物统一保存到 IndexedDB `workbench-production-v1` 的 `drafts` 与 `items` 两个存储区。草稿内容、制作记录及交互物当前项目指针在同一事务中提交，写入成功才标记保存。不同地图和不同交互物项目分别保存。

- 地图约在修改后 800 毫秒自动保存，存储原始图片 `File` 字节，恢复时重新生成图片 URL。地图的 API 密钥不进入快照。未完成队列恢复为暂停状态，用户主动继续后才请求图片服务。
- 交互物约在修改后 700 毫秒自动保存，一个项目中的每个对象对应一条制作记录。旧版 `workbench-interactable-editor` 的当前草稿可以读取并迁移；原旧数据不删除。
- 外层导航先等待保存完成。保存失败时留在当前页并展示错误；地图生成正在进行、交互物正在导入或导出时阻止切换。地图新建、状态导入及交互物项目导入也先保存当前工作。
- 顶部「保存草稿」允许手动重试。关闭或刷新存在未保存修改、仍在进行操作的页面时使用浏览器原生离开提示。源文件备份继续使用各工具的原有导出。
- 序列帧作业由 Python 服务保存。网页通过只读汇总接口读取摘要，恢复链接只选择已有作业，不创建或重跑。工具内部尚未提交的表单仍遵循原生工具的行为。

草稿属于当前浏览器与网站地址；更换浏览器、清理网站数据或切换地址不会自动携带草稿。共享任务仍位于 `work/tasks/`，Agent 产物仍位于 `outputs/`。浏览器草稿不伪装成这些磁盘文件。

## 实现位置与扩展

`workbench/manifest.json` 是路线与能力的唯一清单，`productionLines` 定义顶级入口，能力 `ui` 提供路线归属、入口说明和步骤。`lib/workbench/modules.ts` 从中派生前端数据。

- `components/workbench/`：首页、场景页、常驻外壳、引导、记录、高级工具和深色样式。
- `lib/workbench/work-items.ts`：状态归一化、稳定资产身份和执行尝试合并。
- `lib/workbench/browser-store.ts`：草稿与制作记录的原子保存。
- `lib/workbench/editor-session.ts`：当前编辑会话、离开检查和保存同步。
- `components/map-stitcher/use-map-workspace.ts`：地图外层会话与自动保存；快照恢复在 `features/map-stitcher/workspace-draft.ts`。
- `features/interactable-editor/browser-storage.ts`：交互物多项目保存和旧草稿兼容读取。
- `app/api/workbench/sprite-pipeline/jobs/route.ts`：原生作业摘要白名单，不向浏览器暴露连接器令牌。
- `Tools/SpritePipeline/sprite_pipeline/ui.py`：`workbench_job` 恢复入口与选中作业通知。已运行的 Python UI 需重新启动以加载源代码变化。

公共 Provider 在浏览器宿主支持 `document.modelContext` 时注册 `list_workbench_capabilities` 与 `start_workbench_task`。地图页另外注册七个作用于当前可见编辑器的工具：

- `map_stitcher_read_summary`
- `map_stitcher_set_view`
- `map_stitcher_import_images`
- `map_stitcher_generate_layer`
- `map_stitcher_create_regions`
- `map_stitcher_export`
- `map_stitcher_generation_queue`

这些 Browser WebMCP 工具复用页面的选择、锁定、版本检查和忙碌状态。它们的存在不开放 Agent 地图自动制作；仍须遵守手动前端边界。它们不替代仓库级 STDIO MCP；MCP / CLI 继续使用共享运行时，工具算法保持在原工具、适配器或服务端连接器中。

## 本地与托管边界

Web 的同源 API 通过 `WORKBENCH_RUNTIME_URL` 访问默认位于 `127.0.0.1:8790` 的 runtime bridge。托管页面无法自然读取开发者电脑上的回环服务、任务目录或另一 origin 的 IndexedDB。远程使用需要单独部署经过认证和访问控制的 runtime；只发布界面不会让本地能力自动上线。

## 验证

常规验证：`npm run lint`、`npm run typecheck`、`npm run build`。

外壳回归：`npm run test:workbench-shell`，覆盖 Manifest 路线、状态真实性、执行尝试去重、本机恢复链接优先、保存失败及繁忙操作的离开保护。既有地图、交互物与 MCP 检查保持原命令。

完整测试矩阵见 [使用与操作手册](operations-manual.md)，整体分层见 [系统架构](architecture.md)。

## 原图与序列帧路线

开始页的角色美术路线先进入 `/player`，可选择原图生成或直接制作动作。`/tools/reference-art` 提供描述、朝向、PixelLab Key 设置、真实任务进度与 PNG 预览。Key 与序列帧共用，生成操作进入 runtime ledger；`?task=` 可恢复原图记录。移送成功后进入序列帧的 `?character=` 链接并预选角色，尚未创建动画任务。未提交的原图提示词只保留在当前页面；生成后的提示词、名称和朝向随任务保存。
