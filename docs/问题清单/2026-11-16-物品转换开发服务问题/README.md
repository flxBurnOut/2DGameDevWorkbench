# 物品转换验收中的开发服务问题

> 返回[问题清单索引](../README.md)。按[目录指引](../AGENTS.md)记录；当前状态以索引为准。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | 2026-11-16T18:31:25-05:00 |
| 基准 | 工作区基于 `d12f46298e2d` |
| 提交 | `ae05a87bd275` |
| 登记问题 | DEV-01 |

vinext dev 启动失败，生产构建可用；待定位。

## 问题条目

状态截至本次整理；最新状态以[索引](../README.md)为准，后续变化记在之后的记录目录。

| 编号 | 状态 | 现象与影响 | 验证方法 |
| --- | --- | --- | --- |
| DEV-01 | 已登记（待定位） | 本机 vinext dev 的 RSC 依赖在 Vite/Cloudflare 转换后含两个 default export，开发服务器启动失败；生产构建与 vinext start 可用。 | 隔离 WORKBENCH_TEST_RUN 启动 dev 复现 Parse failure；同版本 build/start 浏览器导入与转换链路通过。 |

## 记录

2026-11-16T18:31:25-05:00，分支 paper-vbyc，工作区基于 `d12f46298e2d`，物品导入/PixelProp 转换实现尚未提交。登记 DEV-01：在隔离命名空间执行 vinext dev 时，`vite-cache/deps_rsc/react-server-dom-webpack_server__edge.js` 同时出现预打包 `export default require_server_edge()` 与 commonjs 插件附加的默认导出，Cloudflare worker 解析报 “A module cannot have multiple default exports”。尚未确定依赖预打包与插件交互的根因，未修改开发服务器配置或依赖版本。

同一工作区 `npm run build` 与 `vinext start` 正常，物品导入、转换调参、保存、确认移送、对象来源、GPT 候选深链和 430 px 对话框验收通过，无真实付费请求。DEV-01 保持待定位，不能以生产页面通过视为开发启动问题已修复。复现入口为 `node node_modules/vinext/dist/cli.js dev --host 127.0.0.1 --port <隔离端口>`；浏览器流程见 `tests/prop-art/browser.mjs`，使用生产模式以完成本次功能验收。

**物品转换实现与 DEV-01 登记归档。** 2026-11-16T18:59:12-05:00，提交 `ae05a87bd275` 收录物品导入、PixelProp 工具与工作台转换实现，以及 DEV-01 的复现记录。独立工具 28 项、原图服务 17 项、对象身份/资产目录 16 项、交互物动画 29 项 Python 专项通过；相关 Node/MCP/HTTP、浏览器验收、类型检查、lint、构建和公开范围检查通过。DEV-01 未修复，继续待定位。真实付费调用为零。
