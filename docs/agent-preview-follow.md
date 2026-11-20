# Agent 预览与页面跟随

本页保留 WorkBuddy 首次对话开页、制作前检查及会话隔离流程。配置与信任见[客户端接入](agent-clients.md)；宿主验收和历史记录见[客户端验收](agent-client-validation.md)。

## WorkBuddy 首次对话与制作前检查

1. 第一条用户消息到来时读取 `workbench_get_environment` 及 `preview`。服务离线时调用 `workbench_start_frontend`，查询 `frontend.ready`，最多等待 60 秒；仍在启动时报告状态与日志，遇服务冲突则先排错。仅 MCP 握手不触发开页。
2. 发现宿主原生 `present_files` 的真实 schema，按返回的 `preview.hostAction.arguments` 打开预览。展示已知作品时先 `workbench_present` 获得准确地址。完整 URL 的 `previewSession` 绑定本对话，旧页面不能替代。
3. 用 `workbench_get_frontend_context` 确认本 sessionId 的 visible 页面。hostAction 是待执行动作，不是已打开证明；不以系统浏览器替代 WorkBuddy 的会话预览。
4. 本会话未就绪时，`workbench_run_task`与高层 `ai-edit`返回 `preview_required`、`createsTask=false`、`providerCalled=false`。连接成功后以相同制作参数继续；已经提交的任务只查询原身份。暂停操作始终可用，不因预览未就绪而延迟。

用户明确拒绝/关闭预览，或已检查确认宿主工具不可用时，Agent 可使用 previewPolicy=user-declined/user-dismissed/host-unavailable 继续原授权工作。不能为了省略开页步骤而设置例外。用户明确要求重新打开时用 auto 重置例外；普通重连或轮询不能擅自重开。已连接页面上的暂停/忙碌/保存保护保持生效。

其他客户端保持无前端兼容，首次显式 present 才启用跟随。这里的例外和预览检查不改变任务授权、费用或采用流程。

`workbench_start_frontend` 只启动固定的 Web/Bridge，不启动 SpritePipeline、不安装依赖或调用生成 API。CLI `agent frontend` 与 HTTP `/v1/agent/frontend` 共用运行时。服务返回 starting 后继续检查环境；日志与 PID 在 `work/services/`，MCP 断开后服务可复用。端口冲突时保留未知进程，不自动换端口。

## 已连接页面上的操作

开放动作任务的展示路径使用 `work` 标识与 `version`，选定候选再带 `candidate`。这些字段由前端心跳和跟随通道保留；不要把旧任务的精确版本链接改成最新作品或资产库首页。规划、生成和检查在同一作品页面按真实状态推进，专家记录按需展开。

- 首次就绪和宿主开页沿用现有流程；后续不要为每步再调 present_files 新开标签。
- 先 list/describe 确定能力或读取已选作品，再调用 workbench_present。恰好传 taskId、jobId、assetId、capabilityId、editId 中一个；candidateIndex 只能配 taskId/jobId，candidateVersion 只能配 editId（也可为 source）。仅进入工具时用 discovery 的 capabilityId；已有作品用精确身份。
- WorkBuddy 的授权 run_task 或高层 ai-edit 在本会话页面就绪后自动启用跟随；其他客户端仍由首次 present 启用本 MCP 连接的自动跟随。随后 run_task、get_task、edit_image_region 与 get_image_edit 将真实 presentation 发布给前端，返回 frontendPresentation；失败任务有可读记录时也展示原失败步骤。未启用的诊断客户端不会因查询而改变页面。
- get_result/get_asset/list_assets 仍只读，没有导航副作用。用户选择旧作品或另一候选时，Agent 明确调用 present；不得把作品库首页当作指定作品详情。
- 用 workbench_get_frontend_context 的 requestId 查询确认。等待通常 1–2 秒，最多等待 10 秒再说明状态；不要阻塞长时间任务，不要通过再次 run 来催促展示。视觉审核仍须读取真实画面，不以展示确认代替。
- 页面暂停或阻塞时继续必要的后台工作并报告原因；不得改用宿主强行刷新页面绕过保护。用户要求暂停时不自动恢复。请求约两分钟过期；恢复很久以前的步骤需新的明确 present。
- 前端未连接：若本会话尚未按用户要求打开预览，沿用首次开页流程；已被用户关闭的预览只给精确链接。不要因重连而重新打开。
- 按真实步骤说明当前进展、展示状态和下一步；排错时再展开工具 JSON 和内部身份。

## 工具与状态

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| workbench_present | 一个 taskId / jobId / assetId / capabilityId / editId；可选 candidateIndex 或 candidateVersion | 校验真实目标，保存短期展示请求，不生成、不导出、不创建任务 |
| workbench_get_frontend_context | 可选 requestId | 只读查看活跃页面身份、编辑状态和展示确认 |

CLI 对应 agent present / agent frontend-context；HTTP 对应 POST /v1/agent/present 和 /v1/agent/frontend-context。前端用 /api/workbench/frontend 转发到 /v1/frontend/heartbeat。自动跟随启用状态属于 MCP 连接；CLI/HTTP 的 present 只提交指定的一次展示。

| 状态 | 含义 |
| --- | --- |
| waiting_for_frontend | 没有活跃目标页面；未展示 |
| pending / navigating | 等待页面接收或切换中；未确认到达 |
| displayed | 目标页面已回报当前地址；不代表图片加载成功、动作通过审查或用户已经看过 |
| paused | 用户暂停；不可强制导航 |
| blocked | 正在编辑、工具忙碌或保存失败；保留原页 |
| superseded / expired | 已被更新步骤替代或过期，不再自动执行 |
| unavailable | 展示通道失败；不改变原生产任务的成功/失败状态，不应重提交生成 |

browserOpened 始终为 false，因为此通道不打开浏览器窗口。displayed 是已有页面的地址确认，两者并不矛盾。多个打开的工作台中选择最近活跃的可见页面，一次请求固定到该页，不会让全部标签一起跳转。连续相同步骤去重，当前地址相同时只更新步骤卡，不刷新编辑器。


局部图片编辑链接保留原目标、`imageEdit` 会话和 `imageCandidate` 版本，在交互物或资产详情内打开共用工作区。运行中的明确候选只显示其已完成基准，并跟随该候选完成；不会偷偷改选更新的其他分支。有未保存笔划时保留草稿，完成结果留待明确选择。图片任务持久保存相同身份，按 taskId 查询也不会退回独立整图采用入口。关闭工作区不取消模型请求，重开读取原任务，不重新生成。

## 页面反馈与草稿

页面摘要含地址、已发布条目的名称/身份、dirty/busy 和会话信息；不包含完整图片像素、草稿或浏览器存储，也不把草稿登记成资产。读取实际画面使用宿主可用的查看能力；读取共享保存内容使用对应文档接口。交互物命令以共享文档契约为准。

短期握手文件位于 manifest.workspace.presentationDirectory，活跃页面约 20 秒失效，旧记录定期清理。测试使用隔离 WORKBENCH_TEST_RUN；按[验收文档](agent-client-validation.md)区分协议、页面内容与真实宿主执行证据。
