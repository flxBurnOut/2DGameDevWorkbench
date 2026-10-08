# 地图拼接架构

> 状态：当前维护。本文只描述地图子系统；Agent、MCP、Runtime 与 Web 的总体关系见 [系统架构](architecture.md)。

当前主入口 `app/(workbench)/tools/map-stitcher/page.tsx` 组合模块化的 FrameRonin 编辑器。旧版路由保留为迁移回退；Unity 不在能力范围内。能力入口、输入和输出以 `workbench/manifest.json` 为准，本文中的内部模块名用于维护定位。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `frame-ronin-map-editor.tsx` | 项目栏、单选图片视图、弹窗与模块组合 |
| `use-map-editor-controller.ts` | 文档动作、选择、锁定、版本检查、历史、资产生命周期、生成与导出 |
| `canvas/map-canvas.tsx` | 导航与绘制手势路由、快捷键作用域、图片和交互层、派生预览 |
| `region-drawing-overlay.tsx` | 选中卡片的坐标输入、草稿、命中与 SVG 标注 |
| `panels/map-inspector.tsx` | 地图块、区域、生成队列三个属性页签 |
| `panels/map-api-settings.tsx` | 服务端配置读取与密钥设置表单 |
| `use-map-agent-tools.ts` | 页面 WebMCP；调用控制器动作 |
| `editor-state.ts` | 文档、会话和偏好类型；历史外部存储；图片提交凭据 |
| `editor-selectors.ts` | 区域范围、资源就绪、缓存身份、内存估算和快捷键目标过滤 |
| `generation-queue.ts` | 并发调度、内存 / 锁暂停、取消、重试 |
| `region-engine.ts` | 规范几何、合法性、命中、SVG 与世界坐标 |
| `layer-engine.ts` | 真实黑白参考提取、Mask、扣除、羽化与拼接 |
| `map-production.ts` | 分层就绪判定、实际导出合成、全部 PNG、透明物件参考派生 |
| `state-package.ts`、`godot-import.ts` | Pixelwork 源状态、SceneMaker 迁移与 Godot 恢复 |
| `engine-export.ts`、`psd-export.ts` | Godot 与 PSD 资源 |
| `lib/workbench/adapters/map-stitcher.mjs` | 前端共享 Runtime 的 compose、generate-origin 与 generate-layer 协议转换 |

## 状态和动作

文档只有卡片与区域；视图、编辑会话、选择、历史和派生缓存分别管理。文档快照不可变，`MapHistory` 通过 `useSyncExternalStore` 通知 React，避免可变对象被编译器错误缓存。事件 / 异步提交用即时更新的引用读取最新锁和目标，不依赖旧渲染闭包。

图片写入凭据记录项目 epoch、卡片、图片类型、原 URL 和锁版本。替换目标图片、切换项目、撤销 / 重做或切换目标锁后，旧异步结果会被拒绝。对成对参考图先校验全部写入目标，再一次性提交。区域动作按目标类别检查锁，并使用同一范围选择器进行列表、计数、清空和删除。

历史最多 80 步，保留原图片引用供撤销和重做使用。根据当前文档与两侧历史共同计算资产引用；只有完全不可达时才释放 Blob URL。失败导入释放中间素材，不替换当前文档。派生预览 URL 由对应效果负责取消与释放。

## 画布与几何

底图层按文档顺序绘制，选中装饰与命中区域位于独立交互层；选择不提升底图。显示视图是六选一，区域效果与辅助显隐分离。物件与 Mask 的缓存身份包含图片 URL、视图、卡片尺寸和该卡片所有遮挡扣除区域。

画布捕获阶段先决定是否平移。仅主指针左键进入选中卡片的区域编辑器；父卡片不再收到已消费的区域手势。自由套索使用指针捕获；取消、失焦与编辑上下文变化都使草稿失效。

矩形兼容两个对角点及旧导出的四角点。多边形与自由套索共用闭合路径；检查有限坐标、面积、顶点数和自交。顶层裁剪将各区域先做遮罩并集，避免不同绕序的重叠多边形互相抵消。

区域默认归属于创建时的图片视图。`mapLayer` 不限制遮挡扣除、碰撞和顶层的实际效果；跨视图参考可以从区域列表定位。

## 生产与持久化

中心原图和整体扩图通过已有服务端代理请求所选图片 API；本地镜像补全已移除，旧来源值只兼容读取。前端不新增连接器不支持的语义分层参数。地表副本标为草稿；物件来自上传或真实黑白参考；透明物件可反向派生黑白参考。只有完整且非草稿的素材才启用分层合成。

队列限制并发为 1–4，自动扩展总数为 1–64。内存保护在调度前检查图片 / 历史与临时画布估算；暂停、取消和失败重试有独立状态。取消的 AbortSignal 和文档凭据共同阻止旧结果提交。

保存继续使用 Pixelwork v2。新增 `workbench.editorPreferences`、`tileImageOrigins` 和 `surfaceDrafts` 扩展；保留每个区域的卡片本地坐标与所属视图。Godot 包嵌入 `source_state.zip` 用于完整恢复，旧包按实际信息降级为合成卡片。完整编辑源不包含撤销栈。

PNG 导出预览与 Godot 默认可见图层共享就绪判定。图片拼接、Alpha 扣除、顶层裁剪和碰撞导出共用坐标与几何。隐藏卡片被明确排除，辅助标注的显隐不影响输出。

## Workbench 接入

模块能力只登记在 `workbench/manifest.json`。前端通过共享 Runtime / adapter 执行地图操作；MCP 发现和执行排除该能力，Agent 不得改走 CLI、HTTP 或浏览器工具绕过手动边界；页面七个 WebMCP 工具是对当前浏览器文档的操作入口，共用控制器，不另建编辑模型。服务端密钥不进入客户端、任务记录、日志或编辑状态。

测试和使用方式见 [用户文档](map-stitcher.md) 与 [使用与操作手册](operations-manual.md)。
