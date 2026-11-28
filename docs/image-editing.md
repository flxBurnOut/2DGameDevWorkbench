# 图片局部调整

图片局部调整支持三类源图：**交互物静态槽**（默认图、切换状态图与序列条目图）、**独立图片任务**（`image:` 资产）和**动画帧**（`motion-frame`）。共用工作区整合本地像素工具、原尺寸 AI 局部编辑、版本时间线与单图恢复；试验性的部件属性计划与独立成品复核见[部件属性计划与复核](../workbench/guides/image-attribute-editing.md)。

## 入口与范围

| 入口 | 作用范围 |
| --- | --- |
| 交互物编辑器 → “局部调整默认图片” / 各状态槽入口 | 修改指定静态图片槽；采用默认图会停用默认 idle/focus 动画，保留行为与其他槽位 |
| 独立图片任务预览或资产库 `image:` 详情 → “局部调整图片” | 另存为新的 `image:<任务ID>` 变体，不覆盖原任务与原素材 |
| 动画检查页 → “局部调整当前帧” | 确定性修改当前可编辑帧，保存为动画备选后返回完整播放对比（锁定边界与状态图保持保护） |

从交互物进入前，页面先等待当前工程保存到 Bridge（冲突或失败时保留本地草稿，不打开旧图）；工作区打开后宿主暂停交叉编辑与离开跳转。

## 网页工作区操作

工作区以 Portal 独立渲染，按目标自动选默认模式：满足 AI 尺寸要求时默认进入 **AI 局部修改**（初始空选区 + 矩形工具）；动画帧与小图（如 128×128）默认进入 **本地精修**（初始选中整图，不自动放大）。

### 工具与快捷键

- **左栏**：选区工具（矩形、涂选、连通；支持新建/添加/减去，Shift 临时加、Alt 临时减，以及选整图/清空/可见像素/可见包围框）、本地绘制工具（画笔、橡皮、填充、移动、取色，仅本地模式显示）、视图平移（空格或中键拖动，滚轮缩放）。
- **右栏**：按“修改范围 → 对范围执行（换色、批量配色、清理透明噪点、擦除、从旧版本恢复）”组织。批量配色支持逐行 `#RRGGBB → #RRGGBB`（最多 64 对 `palette-map`）、“擦除选区像素”和“移动选区(x,y)”；整段为纯配色表且无参考图时走本地候选。
- **快捷键**：`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` 重做（笔划与选区共用一条顺序）、`Ctrl/Cmd+A` 选整图、`Ctrl/Cmd+D` 清空选区、`Esc` 关闭窗口。
- **选区显示**：淡蓝色标示可编辑范围，AI 返回后默认隐藏以便看图（左上角可一键恢复显示）；本地完成后保持可见。增减笔刷以有序不重叠 `mask-runs`（最多 65,536 段）保存硬边界。

### 版本时间线、预览与草稿保护

- **版本切换**：底部时间线记录“打开时的图片”和各“版本 N”，区分 **工作中**（下一步基准）与 **已应用**。点击历史缩略图仅只读查看，不丢未保存笔划；点 **从这里继续改** 才切换工作版本。支持 96 MiB 已验证版本缓存与快速切换取消旧读取。
- **对照视图**：上方支持 **修改前 / 修改后 / 差异高亮**（比较全部 RGBA 通道）以及 **按摆放尺寸比较**（单幅超 320 px 时裁取编辑区附近同位置窗口，不缩放比例）。
- **未保存笔划与深链**：执行其他操作或应用时自动先把笔划存为新版本；浏览器另在 IndexedDB 每 ~600 ms 存一份恢复副本（单份 ≤ 2 MiB、最多 12 份，恢复前核对基准像素哈希）。链接携带 `?imageEdit=...&imageCandidate=...` 精确定位会话与候选；在途候选运行期间只显示已完成基准并跟随完成，不覆盖未保存笔划，关闭窗口不取消已提交请求。
- **恢复与历史会话**：采用后旧会话保留 **恢复打开时的图片**（仅对原绑定或本会话曾采用的绑定有效，生成新 PNG 候选并采用，不回滚工程其他编辑）；继续精修需点击 **基于当前图片继续精修** 建新会话。历史会话从标题栏“更多”进入；目标版本变动或锁定时只读查看。

## AI 局部修改与透明度保护

- **尺寸与输入限制**：AI 编辑保持源图尺寸不变，要求宽高均为 16 的倍数、总像素 655,360–8,294,400、最长边 ≤ 3840、宽高比 1:3–3:1（小像素图走本地精修）。描述上限 12,000 字，最多附 8 张 PNG/JPEG/WebP 参考图（网页单张 ≤ 30 MiB、参考合计 ≤ 32 MiB，服务端总计 ≤ 80 MiB）。使用已有 GPT Image 2.6 配置。
- **请求冻结与恢复**：提交前冻结 `baseCandidateVersion`、硬边蒙版、描述、参考字节与透明度开关，并在发出请求前落盘任务 ID。返回 `running` 后只查询原 `taskId` / `editId`；断连、超时或 Bridge 重启不会自动重发。
- **本地后合成与透明度保持**：
  - 选区外像素一律从本步基准逐字节复制解码 sRGB/RGBA8（含隐藏 RGB）并在编码后校验。
  - **保持透明度**：网页默认开启，API 用 `constraints.preserveAlpha=true`（未传默认 `false`）。开启后从本步基准逐像素复制全部 Alpha、跳过低 Alpha 清理，并在 `processing-report.json` 中核验 `changedAlphaPixels == 0`；关闭后才允许模型改动选区透明度。
  - 前端若检测到选区大面积新增近黑像素会给出提醒（不阻止有意改黑）；保护区零改动与视觉品质需分开检查。

## MCP / CLI 与 Bridge 契约

完整字段定义见[共享契约](../lib/workbench/image-edit-contract.mjs)。Web、CLI 与 MCP 统一连到长驻 Runtime Bridge（Web 代理 `/api/workbench/image-edit/<操作>`，Bridge `POST /v1/agent/<操作>`）；Web 端支持 `mediaProtocol: 1` 从 `/api/workbench/image-edit/media` 按哈希分页读取预览和 RGBA8 缓冲（兼容旧 `includePixels`）。

| 工具 | 用途 |
| --- | --- |
| `workbench_inspect_image_target` | 发现已保存目标（不含浏览器未提交草稿），或读取源版本、`sha256`、`rgbaSha256` 与可用操作；可传 `intent` 预览本地配色建议 |
| `workbench_resolve_image_region` | 解析几何、Alpha、连通颜色、`mask-runs` 或命名区域（`saveAs` 需 `commandId`） |
| `workbench_edit_image_region` | 执行本地处理（`process-image`）、显式 `ai-edit`（`edit-image`）或本地重合成 `recompose-ai` |
| `workbench_apply_image_candidate` | 校验目标版本、源哈希、槽位指纹与锁后采用静态图，或为动画帧保存 `local_pixels_v1` 备选（回执 `saved_variant`）；传 `candidateVersion="source"` 恢复原图 |
| `workbench_get_image_edit` | 读取会话历史、状态与采用记录；传 `comparison: {}`（独立素材可设 `previewWidth`）生成摆放尺寸对照图 |

CLI 示例：

```text
npm run workbench -- agent image-inspect --input work/inspect-image.json --json
npm run workbench -- agent image-resolve --input work/resolve-image.json --json
npm run workbench -- agent image-edit --input work/edit-image.json --json
npm run workbench -- agent image-apply --input work/apply-image.json --json
npm run workbench -- agent image-session-get --input work/read-edit.json --json
```

### 像素与版本规则

- **双哈希**：`sha256` 为源文件编码字节哈希，`rgbaSha256` 为解码后的 straight-alpha sRGB/RGBA8 哈希；前端 Canvas 仅作显示，权威像素来自服务端 RGBA 缓冲。
- **幂等写入**：修改调用必填 `expectedRevision`、`expectedSha256` 与稳定 `commandId`（续会话另填 `expectedEditRevision` 与 `baseCandidateVersion`）。相同命令重复调用返回原回执，同 ID 改载荷报冲突。
- **本地像素核心**：`features/image-edit/core.mjs` 复用无 DOM 的 `pixel_editor_core.js`（静态图无需 Python 或 Key，动画帧锁检查与备选保存需 SpritePipeline）。手工 `pixel-patch` 用有序 `spans` 且单次编解码载荷 ≤ 512 KiB，大面积修改请用填充/移动等声明式操作。
- **持久化目录**：会话、命名区域与快照位于 `work/image-edits`；静态图采用不自动更新已交付到 Godot 游戏的资源。

## 回归测试

- 单元测试与模拟集成：`npm run test:image-edit`、`npm run test:image-assets`、`npm run test:editor-documents`、`node Tools/SpritePipeline/tests/test_pixel_editor_core.mjs`；
- 浏览器交互回归：启动 `node tests/image-edit/ui-server.mjs`，访问打印地址下的 `/tests/image-edit/workspace-regression.html` 与 `/tests/image-edit/workspace-interaction.html`（均由本地夹具拦截，无真实付费调用）。
