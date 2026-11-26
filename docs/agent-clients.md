# Agent 客户端接入

Codex、WorkBuddy 等外部客户端负责理解需求、调用工具和执行已授权任务；Web 工作台负责可视化编辑、预览与检查。实际工具能力与参数以 `workbench/manifest.json` 及运行时 discovery 为准。

## 快速导航

| 需求 | 文档 |
| --- | --- |
| 按任务选入口 | [根 AGENTS 导航](../AGENTS.md) |
| 资产制作与交付流程 | [资产制作 Skill](../.agents/skills/2d-game-workbench/SKILL.md) |
| Godot 资源与代码接入 | [游戏工程 Skill](../.agents/skills/forge-game-engineering/SKILL.md) |
| 工具清单、任务状态与分页读取 | [工具与任务语义](agent-client-tools.md) |
| WorkBuddy 首次开页与页面跟随 | [预览与页面跟随](agent-preview-follow.md) |
| 客户端行为验收场景 | [客户端验收](agent-client-validation.md) |
| 底层接口与字段契约 | [连接器契约](connector-contract.md) |
| 安装启动与服务排错 | [操作手册](operations-manual.md) |

## MCP 配置

仓库根目录提供通用配置 `.mcp.json`，以下为 JSON 与本机 Codex TOML 示例：

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

手工配置时填：名称 `2d-game-workbench`、传输 `STDIO`、命令 `node`、参数 `scripts/workbench-mcp.mjs`、**工作目录为仓库根目录**。终端运行 `npm run workbench:mcp` 后停在等待消息状态属正常现象。

### WorkBuddy 识别与重信任

可在配置中为本 server 添加 `env: {"FORGE_MCP_HOST":"workbuddy"}`（初始化 `clientInfo.name` 含 WorkBuddy/CodeBuddy 时也会自动识别）。仅连接 MCP 不会开页，首次对话开页规则见[预览协议](agent-preview-follow.md)。

修改命令、参数或环境变量名称会变更宿主信任指纹；若配置存在但原生工具未挂载，按以下三步处理：
1. 在宿主连接器管理中找到 `2d-game-workbench`，核对新命令后重新点击“信任 / 信任并启用”；
2. 重新连接该 server 并新建或刷新对话；
3. 在对话中直接调用原生 `workbench_get_environment` 确认挂载成功（不要手改宿主内部审批文件）。

## 按需读取指导

- `workbench_list_capabilities` 返回简短 `conversationGuidance` 与主题索引；
- `workbench_get_guidance({topic})` 按 `manifest.json` 中登记的 `agentAssets.guidanceTopics` 返回对应正文（省略 `topic` 返回概览，拒绝任意路径）；
- CLI `npm run workbench -- agent guidance --json` 与 HTTP `POST /v1/agent/guidance` 共用同一入口，只读且不创建任务。

## CLI 后备

客户端无法加载 MCP 时，在仓库根目录通过 CLI 调用同一运行时：

```powershell
npm run workbench -- list --json
npm run workbench -- agent interactable-template --input-json '{"kind":"toggle","name":"门"}' --json
npm run workbench -- describe interactable-editor --json
npm run workbench -- run interactable-editor --input examples/requests/interactable-export.json --json
npm run workbench -- status <task-id> --json
```

共享交互物工程可用 `npm run workbench -- agent documents --json` 发现，并用 `agent document-get|document-create|document-save|document-apply|document-restore|document-validate|document-simulate|document-adopt-image|document-motion-bindings` 配合 `--input <json-file>` 操作（经由 Runtime Bridge 执行，Bridge 离线时报错退出）。

关于 Browser WebMCP 页面级工具以及本地回环与远端托管的网络边界，见[系统架构](architecture.md#1-服务拓扑与调用边界)。

## 常见问题排查

| 现象 | 检查项 |
| --- | --- |
| 客户端看不到 server | 确认项目已信任、工作目录为仓库根、Node 版本符合要求，并重载配置 |
| 工具列表为空或过旧 | 运行 `npm run workbench -- doctor --json` 后重启 MCP server |
| 返回 `awaiting_configuration` | 按任务提示配置所需环境变量或凭据 |
| 序列帧任务长期 `running` | 用 `get`/`status` 查原 job，检查 `http://127.0.0.1:7860` 健康状态 |
| Web 看不到 Agent 任务 | 确认 Runtime Bridge 在 `127.0.0.1:8790` 运行，核对 `WORKBENCH_RUNTIME_URL` |
| 托管页面连不上本机任务 | 属正常网络边界；远程使用需部署带认证与 TLS 的远端 runtime |
| 产物路径缺失 | 将任务视为未完成或失败，查看 `result.json` 与适配器报错 |
