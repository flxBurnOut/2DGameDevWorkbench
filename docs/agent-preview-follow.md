# Agent 预览与页面跟随

本页是 WorkBuddy 首次对话开页、制作前预览检查与 MCP 页面跟随协议的规范文档。MCP 配置与信任见[客户端接入](agent-clients.md)，验收用例见[客户端验收](agent-client-validation.md)。

## WorkBuddy 首次对话与制作前检查

1. **首条消息检查环境**：调用 `workbench_get_environment` 读取 `preview` 状态。前端离线时调 `workbench_start_frontend` 并等待 `frontend.ready`（最多 60 秒；超时则汇报日志位置，端口冲突时先排错，不自动换端口）。仅 MCP 握手不触发开页。
2. **宿主打开预览**：按 `preview.hostAction.arguments` 调用宿主原生 `present_files` 打开带 `previewSession` 的完整 URL（绑定本对话，旧页面不能替代）。展示已知作品时先调 `workbench_present` 获取精确地址。
3. **确认本会话页面就绪**：调 `workbench_get_frontend_context` 确认本 `sessionId` 的可见页面已连接；不以系统浏览器替代 WorkBuddy 内置预览。
4. **未就绪拦截**：本会话预览未就绪时，`workbench_run_task` 与高层 `ai-edit` 返回 `preview_required`（`createsTask=false`、`providerCalled=false`）。页面就绪后以原参数继续；暂停操作不受此限制。

### 预览例外策略（`previewPolicy`）

- 当用户明确拒绝/关闭预览，或已确认宿主无开页工具时，Agent 可传 `previewPolicy`（`user-declined` / `user-dismissed` / `host-unavailable`）继续原授权工作，仅返回精确链接。
- 只有用户明确要求重新打开预览时，才传 `auto` 重置例外；普通重连、轮询或后台查询不会重开已关闭的预览。
- 非 WorkBuddy 客户端默认支持无前端运行，首次显式调用 `workbench_present` 后开启本 MCP 连接的自动跟随。

`workbench_start_frontend` 仅启动固定端口的 Web 与 Runtime Bridge（不启动 SpritePipeline、不安装依赖、不调外部模型），日志与 PID 保存在 `work/services/`，CLI `agent frontend` 与 HTTP `/v1/agent/frontend` 共用实现。

## 已连接页面上的跟随规则

- **复用标签与精确深链**：后续步骤通过跟随通道在同一标签内切换，无需反复调用 `present_files` 开新标签。开放动作链接保留 `work`、`version` 与 `candidate`；局部图片编辑链接保留 `imageEdit` 与 `imageCandidate`（工作区草稿与候选切换细则见[图片局部调整](image-editing.md)）。
- **`workbench_present` 参数**：`taskId`、`jobId`、`assetId`、`capabilityId`、`editId` 五选一；`candidateIndex` 仅配 `taskId`/`jobId`，`candidateVersion` 仅配 `editId`（可为 `source`）。展示已有作品传精确 ID，不传资产库首页。
- **自动跟随范围**：启用跟随的 MCP 连接在调用 `run_task`、`get_task`、`edit_image_region`、`get_image_edit` 时自动发布当前步骤给前端（含可读失败步骤）；`get_result`、`get_asset`、`list_assets` 始终纯只读，无导航副作用。未启用跟随的客户端查状态不改页面。
- **确认到达与保护**：用 `workbench_get_frontend_context({requestId})` 查到达状态（通常 1–2 秒，最多等 10 秒），不要靠重复 `run` 催促展示。页面处于 `paused`（用户手动暂停）或 `blocked`（正在编辑/保存失败）时保持原页并继续后台工作，不强制刷新覆盖草稿。请求约 2 分钟过期，过期后需发新的 `present`。

## 工具与状态参考

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `workbench_present` | `taskId` / `jobId` / `assetId` / `capabilityId` / `editId` 其一，可选 `candidateIndex` 或 `candidateVersion` | 校验目标并写入短期展示请求（不生成、不建任务） |
| `workbench_get_frontend_context` | 可选 `requestId` | 只读查询活跃页面地址、编辑状态与展示确认 |

CLI 对应 `agent present` / `agent frontend-context`，HTTP 对应 `POST /v1/agent/present` 与 `/v1/agent/frontend-context`；前端经 `/api/workbench/frontend` 转发至 `/v1/frontend/heartbeat`。

| 状态 | 含义 |
| --- | --- |
| `waiting_for_frontend` | 无活跃目标页面 |
| `pending` / `navigating` | 等待接收或页面切换中 |
| `displayed` | 页面已上报到达该 URL（仅表地址到达，看图验收仍需读取实际画面） |
| `paused` | 用户已暂停跟随，保持原页 |
| `blocked` | 页面忙碌、编辑中或保存失败，保持原页 |
| `superseded` / `expired` | 已被更新步骤取代或超时失效 |
| `unavailable` | 展示通道异常（不影响原生产任务状态） |

- 返回字段 `browserOpened` 为历史兼容保留字段，此通道不拉起系统浏览器，故恒为 `false`。
- 多标签同时打开时只绑定最近活跃可见页；连续相同步骤自动去重，同 URL 只更新步骤卡不刷新编辑器。

## 页面心跳与数据范围

页面心跳摘要只含 URL、当前作品/条目 ID、`dirty`/`busy` 与会话信息，不含图片像素或浏览器草稿正文。短期握手文件保存在 `manifest.workspace.presentationDirectory`，活跃页面约 20 秒过期并定期清理。
