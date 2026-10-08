# Forge — 2D game dev workbench

Forge 是面向 2D 游戏美术制作与工程交接的本地工作台，也是 2026 腾讯云黑客松参赛项目。创作者通过“角色美术”和“场景”制作资产，通过“资产库”查找与下载已有作品；WorkBuddy、Codex 等外部 Agent 通过项目 MCP 和 Skills 协作。网页负责编辑、预览、审查和导出，主 Agent 在外部客户端运行。

完整流程见 [使用与操作手册](docs/operations-manual.md)，公开功能文档见 [文档中心](docs/README.md)。外部 Agent 通过 MCP discovery 与项目 Skills 获取使用流程。

## 当前能力

| 模块 | 用户可以完成什么 | Agent 边界 |
| --- | --- | --- |
| 角色原图 | PixelLab 生成 128×128 透明角色图，移送为动画参考 | MCP 生成、查询和移送；共用序列帧 Key |
| 序列帧 | 生成候选、播放检查、逐帧修补、审核，导出 PNG 和 Godot SpriteFrames ZIP | MCP 覆盖清单内生成、检查、审核、恢复和导出；像素编辑等操作在原生界面 |
| 地图 | 生成中心原图、参考扩图、手动拼接、分层与碰撞，导出编辑源和 Godot 包 | 手动前端流程；MCP 不执行地图制作 |
| 交互物 | 查看、切换、拾取、序列行为，源工程与 Godot 资源包 | MCP 模板、save-project、export-godot；通用或 CopyWorms 兼容包 |
| 场景组装 | 摆放已完成地图和交互物、调整遮挡、导出完整场景 | 手动网页模块，不是 MCP 生产能力 |
| 资产库 | 分页查找已有作品、准确定位候选、勾选下载真实素材 ZIP | 三个只读资产工具；范围不含浏览器草稿和外部工程 |
| 游戏工程 Skill | 按 CopyWorms 方法整理已就绪资产、设计架构并写 Godot 4.7 脚本 | 外部 Agent 在获授权目标工程中实施；不是新的 MCP 生图工具 |

地图原图与扩图支持清单配置的 Nano Banana 2、GPT Image 2 和混元 Image 3.0（`hy-image-v3`）。混元生图适配范围是地图，角色原图和动画继续使用 PixelLab。地图手动边界同样适用于 CLI、HTTP 和浏览器工具。

## 本地启动

需要 Node.js 22.13+。角色原图与序列帧还需要 Python 3.11+；CI 使用 Python 3.12。在仓库根目录运行：

```sh
npm ci
npm run sprite-pipeline:setup
npm run dev
```

首次 setup 创建 `Tools/SpritePipeline/.venv` 并安装锁定的 Python 依赖，不修改系统 Python。后续通常只需 `npm run dev`。只使用地图、交互物和场景时可跳过 Python setup，运行 `npm run dev:interactable`。

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| 前端 | http://localhost:3000 | 工作台及编辑器 |
| Runtime Bridge | http://127.0.0.1:8790 | 共享任务、文件及本地导出 |
| SpritePipeline | http://127.0.0.1:7860 | 角色原图、动画 API 和原生 UI |

`npm run sprite-pipeline` 单独启动 UI 与 API；`npm run sprite-pipeline:api` 只适合 API 调试，其根地址 404 不表示网页就绪。已有服务按启动器规则复用；接口不兼容时需检查进程、待执行工作和数据目录，再有针对性地重启。详见 [使用与排错](docs/operations-manual.md)。

## 界面入口

- `/player`：角色美术，进入 `/tools/reference-art` 或 `/tools/sprite-generator`。
- `/scene`：地图原图、地图拼接、交互物和场景组装入口。
- `/tools/map-stitcher`：手动地图编辑器；`/tools/interactable-editor`：交互物编辑器。
- `/tools/scene-composer`：场景组装；`/assets`：资产库；`/advanced`：服务与执行详情。

单纯打开功能、浏览作品或讨论方案不创建任务。制作记录汇总可继续的工作，资产库面向实际作品，二者数量不相等。

## WorkBuddy 与其他 Agent

项目提供通用 MCP 配置 `.mcp.json`；宿主专用配置按客户端接入文档在本机创建。客户端以仓库根目录启动 `node scripts/workbench-mcp.mjs`。完整名单和配置见 [Agent 客户端接入](docs/agent-clients.md)；实际工具面以清单与连接后的 discovery 为准。

WorkBuddy 在首次用户消息后检查并启动前端，再调用它自己的 `present_files` 打开内部预览；MCP 握手本身不会打开浏览器。已有作品使用精确详情链接，同一对话复用预览。宿主未暴露浏览器或提问工具时应说明限制，不伪造操作。

两个项目 Skills 分工如下：

- [2d-game-workbench](.agents/skills/2d-game-workbench/SKILL.md)：资产制作、审查、查找、预览、下载和交接。
- [forge-game-engineering](.agents/skills/forge-game-engineering/SKILL.md)：消费已有资产，保留 CopyWorms 角色帧、动作计时、地图实例化与生命周期契约。

MCP 不可用时可用同一运行时 CLI（仍遵守用户限制及手动地图边界）：

```sh
npm run workbench -- list --json
npm run workbench -- describe sprite-generator --json
npm run workbench -- doctor --json
```

`prepare` 会保存准备记录，适用于明确的输入校验；讨论、浏览和等待授权不用 prepare/run。实际执行仅使用已授权的 `run`，进度用 `status` 或 `workbench_get_task` 查询原任务。

## 配置与数据

PixelLab Key 在原图或序列帧设置中保存一次，两处共用；由 SpritePipeline 受保护存储持久保存，`PIXELLAB_API_KEY` 可覆盖。地图设置中的 Key 目前只在 Bridge 进程内；需要跨重启保留时将对应变量写入未提交的本机 `.env`，参考 [.env.example](.env.example)。混元使用 `TOKENHUB_API_KEY` 和 `MAP_STITCHER_IMAGE_PROVIDER=hunyuan-image-3`。密钥不得写入浏览器存储、任务、产物或日志。

`work/tasks/` 保存共享执行记录；`work/sprite-pipeline/` 保存原生作业、角色及配置；`outputs/` 保存真实产物；地图、交互物和场景草稿在当前浏览器 origin 的 IndexedDB。迁移前导出编辑源，并备份磁盘数据。列表缺项或服务离线不等于文件丢失。详见 [资产目录](docs/asset-catalog.md)。

## 目录与维护

`workbench/manifest.json` 是公共能力清单；`lib/workbench/` 提供运行时和适配器；`app/` 与 `components/` 是界面；`features/` 是地图、交互物与场景算法；`Tools/SpritePipeline/` 为集成组件。生产数据 `work/`、`outputs/` 和凭据不提交。

`sprite-pipeline` 适配器把 Manifest 的 camelCase 输入转换成 Python `/v1/jobs` 协议；`map-stitcher` 适配器在本地执行 `compose`，仅在 `generate-layer` 时调用所选官方图片 API。也可以在地图设置窗口保存密钥：它持久保存在被 Git 忽略的本机配置文件中，重启后自动恢复；Windows 使用当前账户加密，macOS 使用钥匙串保护，其他系统使用权限受限的文件。服务端不会把密钥回传给页面，也不会写入任务记录或日志。完整请求与响应约定见 [`docs/connector-contract.md`](docs/connector-contract.md)。

安全与凭据说明见 [安全策略](SECURITY.md)。本仓库以 [MIT](LICENSE) 发布；组件来源、上游同步基线与 CopyWorms 复用边界见 [第三方声明](THIRD_PARTY_NOTICES.md)。本地集成更新不代表独立上游仓库已同步。

导出到已有游戏：在 Godot 导出窗口选择项目，后续资源安装、场景挂载和脚本连接由 WorkBuddy 按 [游戏交付流程](docs/godot-delivery.md)完成。

## 公开仓库范围

本仓库分发工作台源码、测试夹具、使用文档和产品 Skills。个人游戏工程、生成资产、导入包、演示材料、内部开发说明及工作记录保留在本机，不随源码分发。首次使用请上传自己的角色参考图或通过原图模块创建；`diagnostic_dummy` 仅用于测试。

忽略规则阻止本机资料被常规提交；`npm run check:public` 与 CI 同时检查已跟踪文件，拦截误用强制添加的情况。
