# 导出到游戏项目与 WorkBuddy 接入

本流程将 Forge 已导出的 Godot 资源包写入用户选定的 Godot 项目，由外部 Agent（如 WorkBuddy）依据目标工程代码完成挂载与脚本接入。打包与安装均纯本地执行，不调用外部模型。

## 1. 用户操作流程

1. **选择目标项目**：在交互物编辑器点“导出 Godot”、在序列帧点“导出 PNG + Godot 包”，或在资产库详情点“导出到游戏项目”，于弹出窗口中点击 **选择项目…**（页面内只读浏览文件夹识别 `project.godot`，也可直接粘贴绝对路径；导出后记住路径，随时可换）。仍可点击 **仅下载 ZIP** 手动解压。
2. **交付到项目**：点击 **导出到此项目**，将标准包与记录写入目标工程的 `forge_imports/<delivery-id>/`，状态记为“等待 WorkBuddy 接入”。
3. **触发外部 Agent 接入**：网页只负责落盘交付包，不会主动唤醒外部 Agent。在正在使用的 WorkBuddy 会话中点击 **复制给 WorkBuddy** 粘贴接入请求，或直接说“接入刚导出的资源”。
4. **查看历史与进度**：导出窗口可刷新接入进度；关闭后可在 **工作台管理 → 游戏交付**（`?tab=deliveries&delivery=<id>`）查看全部/待处理记录、接入文件与引擎证据，并可对未接入记录再次复制精确请求。

> 序列帧已导出动画的再次复用与补包说明见[Godot SpriteFrames 包导出](sprite-generator.md#godot-spriteframes-包导出)。

## 2. 导出包格式（`forge-godot-export` v1）

机器清单位于 `forge_packages/<package-id>/manifest.json`，记录文件字节数、SHA-256、动作标识与运行时信息（上限 256 MB、6,000 文件，拒绝越界路径、链接、重名与 `project.godot`；同项目的同一标准包复用交付）：

| 资产类型 | 目标资源目录 | 接入契约 |
| --- | --- | --- |
| 角色动画 | `forge_sprites/<角色>/<作业与候选>/` | 原样保留 `SpriteFrames`、PNG、帧序、FPS、loop 与锚点；每包单个动作 |
| 交互物 | `addons/workbench_interaction/` | 选中物件场景、素材、定义、源工程与共享运行时；保留对象 ID |

## 3. Agent 接入步骤

完整工程守则见[游戏工程 Skill](../.agents/skills/forge-game-engineering/SKILL.md)及目标工程自身文档（当前导出基线为 **Godot 4.7.x**，`GODOT_47_BIN` 指定引擎程序）：

1. **发现交付**：调 `workbench_list_game_exports` 分页查询（`workbench_get_environment.gameExports` 仅含前 5 条摘要），按用户指定的项目与交付匹配。
2. **检查目标工程**：调 `workbench_get_game_export(deliveryId)` 获取原包校验、项目路径、主场景、autoload、目录摘要与安装冲突计划，并阅读目标项目自身架构文档。
3. **安装资源**：把同次检查返回的 `packageSha256`、`deliveryRevision`、`installPlanRevision` 与 `inspection.projectRevision` 传给 `workbench_install_game_export`（新增直装，同字节复用，Forge 管理的未改旧文件先备份再更新；遇未知同名文件、用户手改文件或并发冲突返回 `409`）。
4. **编写接入代码**：自定义代码写在目标游戏既有脚本目录，不放进可替换生成目录：
   - **角色动作**：找到角色 `AnimatedSprite2D` 与控制器映射，用 `sprite_frames_merge.gd` 的 `merge_clips(existing, incoming)` 只合并本次动作，保留其余动画、朝向、脚底偏移、碰撞与攻击时序（QA 关键帧不是伤害判定点）。网页“复制给 WorkBuddy”的提示词会自动带齐交付 ID、路径、动作、候选、帧数、FPS 与 loop。
   - **交互物**：每关仅放一个 `InteractionRuntime`；靠近检测将实际物理角色加入 `interaction_actor` 组并匹配 detection mask；通过 `picked_up`、`toggled`、`interaction_finished` 等信号（携带 `context` Dictionary）接入已有系统，避免重复连接。
5. **验证并结项**：运行目标项目自己的 Godot 校验资源加载、动画播放与交互（非 4.7.x 版本如实记录实际版本，不擅自升级工程），然后调用 `workbench_complete_game_export` 记录修改文件哈希与引擎证据（未跑引擎填 `not_run`）。

## 4. MCP 与 HTTP 契约

| MCP 工具 | CLI `agent` 操作 | 说明 |
| --- | --- | --- |
| `workbench_list_game_exports` | `game-exports` | 只读分页查询交付摘要（支持 `snapshot`） |
| `workbench_get_game_export` | `game-export` | 读取包、目标工程配置与安装计划 |
| `workbench_export_to_game` | `export-to-game` | 将指定 `assetId`/`revision` 的已有 Godot 包写入选定工程 |
| `workbench_install_game_export` | `install-game-export` | 锁内校验并安装资源、备份旧版本 |
| `workbench_complete_game_export` | `complete-game-export` | 记录接入结果与引擎证据 |

- 网页接口 `/api/workbench/game-export/`（代理 `/v1/game-export/`）提供 `settings`、`browse`（5s 服务端 / 8s 客户端超时，已移除旧 `pick` 系统弹窗）、`select`、`package`、`deliver` 及只读 `history` / `record`（写操作需同源与会话令牌）。
- 仓库交付索引默认在 `work/game-exports/`；目标工程内的原始包、回执、账本与备份在 `forge_imports/`（带 `.gdignore`，请勿手动删除）。Windows 核对深层备份可用 `git -c core.longpaths=true status --untracked-files=all`。

## 5. 并发锁、`.gitignore` 与异常恢复

- **操作系统锁**：导出、安装与结项共用 `forge_imports/.install-gate.sqlite` 写锁并在 `forge_imports/install.lock` 原子写入持有者记录（v2 按 SQLite 写锁与 `gateId` 恢复，兼容主机改名；v1 目录锁需核对主机名与原 PID 已退出）。文件系统须支持 SQLite 文件锁与同目录硬链接（如 exFAT 不支持时可改用“仅下载 ZIP”）。
- **自动忽略锁文件**：首次写入锁库前，若 `forge_imports/.gitignore` 不含 `# Forge delivery locks` 标记，会经 `.install-bootstrap/` 串行追加锁文件与日志忽略规则（保留该标记即可自定义后续行；若 `.gitignore` 不可读写则返回 `409 INSTALL_LOCK_IGNORE_UNAVAILABLE`）。
- **异常恢复状态**：
  - 以目标工程内 `forge_imports/<delivery-id>/delivery.json` 为准，再同步工作台历史副本；
  - 若安装账本已更新但回执写入前进程退出，记录标为 `install_recovery_required`，重新预检并安装即可补齐回执；
  - 若账本损坏、缺失或回执清单格式异常，标为 `install_verification_required`，修复账本或从 `backups/` 恢复后重新预检安装。

## 6. 验证

运行 `npm run test:game-export`，并按需结合 `test:interactable`、`test:asset-import`、`test:assets`、`test:engineering` 回归。
