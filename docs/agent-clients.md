# Agent 客户端接入

Codex、WorkBuddy 或其他客户端负责理解请求、选择能力并执行已授权任务。Web 工作台承载任务、草稿、素材预览与可视化编辑。生产接口以 `workbench/manifest.json` 和运行时契约为准。

## 按任务查阅

| 需要做什么 | 入口 |
| --- | --- |
| 在仓库中工作 | [根 AGENTS 导航](../AGENTS.md) |
| 制作、修改、检查或交付素材 | [生产 Skill](../.agents/skills/2d-game-workbench/SKILL.md) |
| Godot 资源和代码接入 | [工程 Skill](../.agents/skills/forge-game-engineering/SKILL.md)；目标工程自身指导 |
| 配置 MCP 或 CLI | 本页下面的接入配置 |
| 查工具、任务状态与结果结构 | [工具与任务语义](agent-client-tools.md) |
| WorkBuddy 首次开页、预览检查和跟随 | [预览协议](agent-preview-follow.md) |
| 验收宿主行为或查历史验证 | [客户端验收](agent-client-validation.md) |
| 服务、安装和数据排错 | 本页排错；[操作手册](operations-manual.md) |

## MCP 配置

仓库提供 `.mcp.json`。以下为通用配置及可由用户在本机创建的 Codex 配置示例：

```json
{
  "mcpServers": {
    "2d-game-workbench": {
      "command": "node",
      "args": ["scripts/workbench-mcp.mjs"]
    }
  }
}
```

```toml
[mcp_servers."2d-game-workbench"]
command = "node"
args = ["scripts/workbench-mcp.mjs"]
required = false
startup_timeout_sec = 10
tool_timeout_sec = 300
default_tools_approval_mode = "writes"
```

客户端必须以仓库根目录作为工作目录启动 server。需要手工配置的客户端使用：

- 名称：`2d-game-workbench`
- 传输：STDIO
- 命令：`node`
- 参数：`scripts/workbench-mcp.mjs`
- 工作目录：本仓库根目录

可以在终端直接运行 `npm run workbench:mcp` 做启动诊断，但 STDIO server 启动后等待 MCP 消息是正常现象，不会显示交互式菜单。

WorkBuddy 配置可为本 server 添加 `env: {"FORGE_MCP_HOST":"workbuddy"}`。修改后在宿主连接器界面重新信任并重连；保留其他连接器配置。初始化 clientInfo.name 包含 WorkBuddy / CodeBuddy 时也能识别该宿主。第一次用户消息触发的开页约定见[预览协议](agent-preview-follow.md)，仅连接 MCP 不会自动开页。

## 按需读取指导

`workbench_list_capabilities` 返回简短 `conversationGuidance` 与 topic 索引。使用 `workbench_get_guidance({topic})` 读取相关正文；省略 topic 返回概览。主题来自清单的 `agentAssets.guidanceTopics`，不接受任意文件路径。

CLI `npm run workbench -- agent guidance --json` 和 HTTP `POST /v1/agent/guidance` 共用这一读取入口；请求体可为 `{"topic":"motion"}`。返回 source、text、sha256，读取不创建任务或调用生成服务。

纯 MCP 客户端也能读取两份 Skill 与已登记的工程参考。实际修改目标游戏仍需要宿主文件/命令能力；读到了指导不代表已经安装资源或写入代码。跨会话授权和用户选择以实际对话为准，问题未回答不等于接受推荐项。

## CLI 后备

客户端不能加载 MCP 时，在仓库根目录使用同一运行时：

```powershell
npm run workbench -- list --json
npm run workbench -- agent interactable-template --input-json '{"kind":"toggle","name":"门"}' --json
npm run workbench -- describe interactable-editor --json
npm run workbench -- run interactable-editor --input examples/requests/interactable-export.json --json
npm run workbench -- status <task-id> --json
```

具体样例文件以 `examples/requests/` 当前内容为准。CLI 与 MCP 共享任务目录、状态机、适配器和输出验证，不是另一套实现。

共享工程使用 `npm run workbench -- agent documents --json` 发现，再以 `agent document-get|document-create|document-save|document-apply|document-restore|document-validate|document-simulate|document-adopt-image` 配合 `--input <json-file>` 操作。文档 CLI 与 MCP 都转发长驻 Runtime Bridge，Bridge 离线时明确失败，不回退为另一进程直接写文件。HTTP 等价为 `POST /v1/agent/<operation>`；网页使用 `/api/workbench/documents` 同源代理。引擎导出使用 `interactable-editor` 能力的 `export-godot`，见[交互物编辑器](interactable-editor.md)。


## 浏览器与部署

仓库 STDIO MCP 操作持久任务与共享 Bridge。Browser WebMCP 仅在宿主支持 `document.modelContext` 且页面打开时存在，使用页面真实工具与锁定、版本、忙碌状态。用户明确要求网页操作时，按保留页面的已有流程执行。能力选择见[生产 Skill](../.agents/skills/2d-game-workbench/SKILL.md)。

`npm run dev` 启动 Web、回环 Runtime Bridge 和默认 SpritePipeline；Web API 代理到 Bridge。远端托管页面不能直接读取开发者电脑的回环服务、本地任务或另一来源的浏览器存储。远程执行需要单独部署有认证、TLS、访问控制和审计的 runtime；详见[架构](architecture.md)。

## 排错

| 现象 | 检查 |
| --- | --- |
| 客户端看不到 server | 确认项目已信任、工作目录正确、Node 版本满足要求，并重载项目配置 |
| 工具列表为空或旧 | 运行 `npm run workbench -- doctor --json`，重启 MCP server |
| `awaiting_configuration` | 查看任务给出的环境变量；只配置对应外部 operation，勿伪造输出 |
| Sprite 任务一直运行 | 使用 `get`/`status` 查询原 job，并检查 `127.0.0.1:7860` 健康状态 |
| Web 看不到 Agent 任务 | 确认 `npm run workbench:http` 在 `127.0.0.1:8790` 运行，检查 `WORKBENCH_RUNTIME_URL` |
| 托管页面无法访问本机任务 | 这是预期网络边界；需要安全远程 runtime，不应暴露本机回环服务 |
| 输出路径不存在 | 把任务视为未完成或失败，检查 `result.json` 和适配器错误，不手工编造路径 |

### 配置存在但原生工具未挂载

WorkBuddy 5.5.4 的信任指纹包括 STDIO 命令、参数以及环境变量名称。新增 `FORGE_MCP_HOST` 会改变指纹；旧信任记录只对应旧配置，`disabled:false` 不表示新配置已经获信任。

1. 在 WorkBuddy 连接器/MCP 管理中找到 `2d-game-workbench`，查看更新后的命令和参数，再点击“信任”或“信任并启用”（以当前界面文案为准）。
2. 重新连接该 server，再新建或刷新项目会话。
3. 明确要求“只用原生 MCP 调用 workbench_get_environment，不使用 CLI”。成功证据是宿主实际工具调用，而非终端 doctor 或手写 STDIO 客户端成功。
4. 原生 MCP 成功后，再验收内部浏览器开页和任务跟随。CLI 共用生产运行时，但不验证 WorkBuddy 工具挂载及 MCP 会话预览流程。

信任确认由用户在宿主界面完成，不直接改写 mcp-approvals.json、不删除安全迁移标记、不伪造审批记录。排查时分清“独立 MCP 握手通过”“宿主挂载通过”“页面已展示”三种证据。

协议字段见[连接器契约](connector-contract.md)。客户端验收方法和历史记录已集中到[验收文档](agent-client-validation.md)。
