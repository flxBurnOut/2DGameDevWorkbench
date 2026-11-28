# 工作台界面与制作流程

Web 工作台按“角色美术”与“交互物”两条制作线组织入口，作为外部 Agent 的可视协作面，承载画布、图层、碰撞区与动画检查等可视化操作（页面不内置通用对话窗）。

### 视觉与布局约定

- 纯色背景，网格只出现在画布与预览区；角色与交互物各有独立色彩语义。
- 颜色、圆角（3 档）、字号（6 档）与控件高度由 `lib/workbench/theme-palette.json` 经 `npm run theme:sync` 生成；下拉框统一使用 `components/ui/native-select.tsx`。
- 按 ≥ 1100 px 桌面宽度设计，响应断点仅 `≤ 1099px` 与 `≤ 700px` 两档；界面以中文操作为主，协议参数集中在工具内或高级页。

## 1. 页面路由与工具入口

| 路由 | 用途 |
| --- | --- |
| `/` | 工作台首页：四张工具卡、继续制作（最近 5 条）、最近素材（最新 6 件）与导入素材包，见[首页与帮助](#首页与帮助) |
| `/player` | 服务端重定向到首页（兼容旧链接） |
| `/tools/reference-art` | 角色原图生成、本地导入与移送 |
| `/tools/sprite-generator` | 角色动画五阶段工作区（旧版 `?legacy=1`） |
| `/tools/interactable-motion` | 交互物动画面板：状态定义 → 方案 → 制作与检查 → 写回 |
| `/tools/interactable-editor` | 交互物编辑：外观、行为、碰撞、模拟与 Godot 导出 |
| `/assets` | 资产库：分页检索、候选详情、打包下载、导入素材包与回收站 |
| `/advanced` | 服务连接、全部制作记录、游戏交付历史与本机数据管理 |

### 角色原图

`/tools/reference-art` 提供描述、朝向、尺寸、PixelLab Key 设置（与序列帧共用）、实时进度与 PNG 预览，`?task=` 恢复记录。移送前可填写“保持的外观特征”（按源任务隔离草稿），移送后跳到角色动画 `?character=` 并预选该角色。

### 角色动画

主流程为 **准备与描述 → 查看制作方案 → 自动制作 → 检查与调整 → 导出与使用**：

- **对象与上传**：准备页仅列角色预设（交互物链接自动转到 `/tools/interactable-motion`，加 `&layout=studio` 可留在角色页查看）；上传角色原图只收 64×64 / 128×128 透明 PNG，可填“保持的外观特征”（切换角色或上传成功后自动清空）。
- **方案与分段检查**：动作约束与关键姿势默认收起。分段检查卡默认展示完整播放器、逐帧条、末姿势与结论；完整播放并写明结论后才可点主按钮 **确认此段，继续制作**（刷新保留进度）。
- **整段检查与结构历史**：检查页播放确认绑定当前帧摘要，改帧后需重确认；原图结构与跨帧结构支持只读预览历史版本，并以当前版本与令牌恢复为新版本。
- **模型设置**：默认展示规划/复核型号、服务状态与空白 Key 区，单专家覆盖与高级参数按需展开。

### 交互物动画

完整工具与状态说明见[交互物动画面板](交互物动画独立面板方案.md)。界面分为：顶栏工具条（作品名、版本、四阶段与对象条）、左栏只读状态图、中栏按阶段切换的状态卡片/方案/检查/过渡画布、右栏“要求 / 检查 / 工具 / 写回”页签，以及底部单主操作状态栏。

- 128×128 物品原图支持 PixelLab 生成、本地 PNG 导入或 `PixelProp` 转换后移送，见[物品原图导入与转换](prop-art.md#导入与转换为动画原图)。
- 交互物编辑器点击“制作状态动画”会先保存工程再带上下文跳转本面板；提交规划前先落盘请求与 ID 以便断线续查，首次规划成功后自动带出目标图与状态草稿（按提交骨架计算过渡段数，含返回初态段），切换物件按真实初态排列并核对写回方向。

### 交互物编辑与工作台管理

- **交互物编辑**：顶栏主按钮唯一保留 **导出 Godot**；“打开”支持打开共享工程（全分页搜索，打开前先存草稿并处理冲突）和从资产库选用；“保存”分列草稿（IndexedDB）、保存到资产库（`save-project`）与下载工程 JSON。“获取图片”集成 GPT Image 透明物品生成（支持自定义宽高校验与历史回填）、128 px 导入与 PixelProp 转换对话框。
- **工作台管理（`/advanced`）**：查看服务健康、全部制作记录，以及全部/待处理游戏交付详情与接入证据（见[Godot 交付](godot-delivery.md)）。

## 2. 顶栏、导航与反馈

所有页面共用 `components/workbench/shared-navigation.tsx` 顶栏：

- **左侧**：Forge 标志（回首页）+ 5 项主导航（角色原图、角色动画、交互物动画、交互物编辑、资产库，顺序由 manifest `ui.navOrder` 控制）。
- **右侧**：“制作记录”（有待处理显示警示数字、有制作中显示脉冲圆点、断连显示 `!`）与帮助、工作台管理、深浅色切换三个图标按钮。
- **二级栏与返回来源**：当前作品名与“返回来源资产”位于各工具自己的二级栏，不占顶栏。跨页跳转统一经 `WorkbenchProvider.navigate` 执行离开前保存检查并显示顶部进度条；从资产库跳入时保留同站 `/assets` 的 `returnTo` 筛选与分页上下文。

## 首页与帮助

- **首页卡片**：四张工具卡分为“角色”和“交互物”两组（宽屏四列、`< 900px` 两组上下排、移动端单列），预览区优先取资产库最新作品（交互物动画轮播 `public/home-samples/` 三段标注“示例”的归档片段；开启减少动态效果时不轮播）。
- **快捷区**：下方列出“继续制作”（按需处理 → 制作中 → 编辑中 → 已保存 → 已完成取最近 5 条；任务编号类名称显示工具名，原名放悬停提示）、“最近素材”（最新 6 件）与右上角“导入素材包”。
- **帮助面板**：优先展示当前工具说明、下一步建议、保存状态与“数据保存在哪里”折叠说明；子页面底部提供“回到首页”。

## 3. 制作记录、轮询与本地草稿

全局浮层“制作记录”以单个资产为单位切换“制作中 / 已完成”，适配器英文报错转为简短中文提示（原文放悬停）。

| 数据来源 | 标识与恢复方式 |
| --- | --- |
| 交互物本机草稿 | `interactable:<projectId>:<definitionId>`，`?project=&object=` 恢复 |
| 序列帧原生作业 | `sprite:<jobId>`，`?job=` 恢复 |
| 开放动作作品 | `motion:<openWorkId>`，`?work=`（旧版带 `version`）恢复 |
| 后台任务记录 | 按作业/对象合并尝试与产物，其余进 `/advanced` 详情 |

- **轮询策略**：有制作中任务每 6 秒刷新（使用 `/api/workbench/tasks?since=` 增量检查），空闲每 30 秒刷新，标签隐藏暂停、切回立即刷新。页面跟随心跳在有待展示步骤时 1.5 秒、空闲 3 秒、隐藏 8 秒一次（有效期 20 秒）。
- **草稿持久化**：交互物草稿约 700 ms 自动写入 IndexedDB `workbench-production-v1`（同事务提交草稿、记录与当前项目指针，兼容读取旧版 `workbench-interactable-editor` 草稿）；跨页或导入前先等保存完成，失败时停留在当前页提示。浏览器草稿绑定当前浏览器与 origin，与 `work/tasks/`、`outputs/` 磁盘数据相互独立。

## 4. 前端实现与验证

- **精简清单**：页面不直引完整 `workbench/manifest.json`，而是读取构建/开发时自动生成的 `lib/workbench/ui-manifest.json`（`npm run ui-manifest:sync` / `ui-manifest:check`）。
- **主要模块**：`components/workbench/`（首页、外壳、顶栏、帮助与延迟加载弹窗）、`app/interaction.css` 与 `components/ui/`（统一样式与交互状态）、`components/interactable-motion/`、`features/interactable-motion/`、`lib/workbench/browser-store.ts`、`editor-session.ts`、`work-items.ts`。
- **WebMCP 与远端托管边界**：见[系统架构](architecture.md#1-服务拓扑与调用边界)。
- **回归验证**：`npm run lint`、`npm run typecheck`、`npm run build`、`npm run test:workbench-shell`（另有 `tests/workbench-shell/navigation-server.mjs`、`tests/editor-documents/library-server.mjs`、`tests/authoring-gaps/web-server.mjs`、`tests/image-assets/dimensions-server.mjs`、`tests/game-export/history-server.mjs` 隔离浏览器夹具）。完整测试路由见[开发导航](../workbench/guides/development.md)。
