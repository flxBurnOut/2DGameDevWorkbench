# Forge — 论文分支 `paper-vbyc`

本分支面向 *Verify Before You Chain* 论文开发，保留序列帧、交互物编辑器、图片局部调整与共用底座。完整工作台及原参赛功能存档在 [new-arch](https://github.com/aaaarthur666-design/2DGameDevWorkbench/tree/new-arch)；当前研究进度见[论文方向与方法](docs/论文方向与方法.md)，工程追踪见[问题清单](docs/问题清单/README.md)。

**本分支的论文方向**　以一次交互事件为单位，协同生成角色与物件的两套序列帧。研究问题、拟议方法与验收标准见[交互事件动画研究说明](RESEARCH.md)。

完整流程见 [使用与操作手册](docs/operations-manual.md)，公开功能文档见 [文档中心](docs/README.md)。外部 Agent 通过 MCP discovery 与项目 Skills 获取使用流程。

## 当前能力

| 模块 | 用户可完成的工作 | Agent 协作边界 |
| --- | --- | --- |
| 角色原图 | PixelLab 生成 128×128 透明角色图，或导入本地 PNG 并移送为动画参考 | MCP 生成、查询与移送，共用序列帧 Key |
| 序列帧 | 规划与分段生成候选、播放检查、选帧修补、复核，导出 PNG 与 Godot SpriteFrames ZIP | MCP 覆盖清单内生成、检查、复核、恢复与导出；像素手绘在原生界面 |
| 交互物动画 | 以状态图制作开关、点亮等状态过渡，用固定部件回填、对齐、倒放等工具修正并写回物件 | 共用 `sprite-generator` 作品；MCP 支持骨架、分段检查、写回与绑定查询；派生素材在网页面板创建 |
| 交互物 | 查看、切换、拾取、序列行为编辑，保存源工程与导出 Godot 资源包 | MCP 模板、共享文档命令、`save-project`、`export-godot` |
| 图片生成与局部调整 | 生成透明物品；对已有图片做换色、擦除、蒙版内 AI 编辑；导入 128 px 物品图或经 PixelProp 转换大图 | `image-assets` 与图片编辑工具（见[图片局部调整](docs/image-editing.md)）；PixelProp 亦可单独命令行调用 |
| 资产库 | 分页检索已有作品、定位候选、勾选下载真实素材 ZIP | 三个只读资产工具（不含浏览器未保存草稿与外部工程） |
| Godot 交付与工程 Skill | 在导出窗口选择目标游戏项目，由外部 Agent 接入资源并编写 Godot 4.7 脚本 | 经[交付流程](docs/godot-delivery.md)与工程 Skill 在获授权目标工程内实施 |

## 本地启动

需要 Node.js 22.13+（角色原图与序列帧另需 Python 3.11+）。在仓库根目录运行：

```sh
npm ci
npm run sprite-pipeline:setup
npm run dev
```

首次 `sprite-pipeline:setup` 创建隔离的 `Tools/SpritePipeline/.venv`，不改动系统 Python；后续直接运行 `npm run dev`。只使用交互物与静态图片编辑时可运行 `npm run dev:interactable`。

| 服务 | 默认地址 | 用途 |
| --- | --- | --- |
| 前端 | http://localhost:3000 | 工作台与各编辑器界面 |
| Runtime Bridge | http://127.0.0.1:8790 | 共享任务、文件与本地导出 |
| SpritePipeline | http://127.0.0.1:7860 | 角色原图、序列帧 API 与原生 UI |

单独启动原生 UI 与 API 用 `npm run sprite-pipeline`；仅调试 API 用 `npm run sprite-pipeline:api`。启动器会按规则复用已有服务，遇到端口或版本冲突见[操作手册](docs/operations-manual.md)。

## 界面入口

- `/`：首页，直达角色原图 `/tools/reference-art`、角色动画 `/tools/sprite-generator`、交互物动画 `/tools/interactable-motion` 和交互物编辑器 `/tools/interactable-editor`，并展示最近作品。
- `/assets`：资产库；`/advanced`：服务状态与执行详情。

## Agent 与 Skills 接入

仓库根目录提供通用 MCP 配置 `.mcp.json`（启动命令 `node scripts/workbench-mcp.mjs`）；各宿主配置、WorkBuddy 预览连接与排错见[客户端接入](docs/agent-clients.md)和[预览与跟随](docs/agent-preview-follow.md)。

内置项目 Skills：

- [2d-game-workbench](.agents/skills/2d-game-workbench/SKILL.md)：资产制作、检查、查找、预览与交付。
- [forge-game-engineering](.agents/skills/forge-game-engineering/SKILL.md)：将就绪资产接入目标 Godot 工程并编写游戏代码。

MCP 不可用时可使用等效 CLI：

```sh
npm run workbench -- list --json
npm run workbench -- describe sprite-generator --json
npm run workbench -- doctor --json
```

## 配置、数据与目录

- **凭据**：PixelLab Key 在原图或序列帧设置中保存一次即共用，可用 `PIXELLAB_API_KEY` 覆盖；图片服务设置同样保存在被 Git 忽略的本机受保护存储中（Windows 使用当前账户加密、macOS 使用钥匙串、其他系统使用受限权限文件），也支持本机 `.env`（参考 [.env.example](.env.example)）。服务端不会把密钥回传页面或写入任务与日志。
- **本地数据**：`work/tasks/` 存共享执行记录，`work/sprite-pipeline/` 存原生作业与角色配置，`outputs/` 存产物，交互物草稿存浏览器 IndexedDB。迁移前请导出编辑源并备份磁盘目录，详见[资产目录](docs/asset-catalog.md)。
- **源码结构**：`workbench/manifest.json` 定义公共能力，`lib/workbench/` 为运行时与适配器，`app/` 与 `components/` 为前端，`features/` 为图片编辑/交互物/交付逻辑，`Tools/SpritePipeline/` 与 `Tools/PixelProp/` 为集成工具。完整接口协议见[连接器契约](docs/connector-contract.md)。

## 许可、安全与仓库范围

安全边界见[安全策略](SECURITY.md)，项目采用 [MIT](LICENSE) 许可，第三方来源与参考见[第三方声明](THIRD_PARTY_NOTICES.md)。

本仓库只提交源码、测试夹具、文档与产品 Skills；个人游戏工程、生成素材、凭据和本地记录均由 `.gitignore` 排除。CI 在 Node.js 22.13.0 与 24 上运行 `npm run check:public` 及功能门禁，完整开发与测试指引见[开发导航](workbench/guides/development.md)。
