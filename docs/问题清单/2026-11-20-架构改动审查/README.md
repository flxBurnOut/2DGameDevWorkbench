# 架构改动审查

> 返回[问题清单索引](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | 2026-11-20T00:58:35-05:00，美东时间 |
| 基准提交 | `c24f9bd3a806`，分支 `paper-vbyc`；审查范围 `b9cf677edd5e..c24f9bd3a806`，共 12 个提交 |
| 归档提交 | 本目录随登记提交入库；编号见 `git log -- docs/问题清单/2026-11-20-架构改动审查` |
| 登记问题 | DEV-02、EXP-03、DATA-06、DATA-07、MCP-03、SEC-03 |
| 跟进问题 | — |

## 问题条目

本批问题都由代码审查发现，尚未修改实现。没有发现阻断合入的缺陷。

| 编号 | 级别 | 可观察现象与影响环节 | 证据 | 验证方法 |
| --- | --- | --- | --- | --- |
| DEV-02 | 中 | 最低 Node 版本与新代码依赖未经验证。`package.json` 声明 `node >=22.13.0`，任务锁与工程锁都依赖 `node:sqlite`；本轮 CI 从 22.13.0 改为只测 Node 24，22.x 上 `node:sqlite` 仍为实验特性。影响任务执行、历史归档和 Godot 交付。 | [package.json](../../../package.json) `engines`；[CI](../../../.github/workflows/ci.yml) 的 `node-version: 24`；[task-runtime.mjs](../../../lib/workbench/task-runtime.mjs) `withTaskLock`；[game-export.mjs](../../../lib/workbench/game-export.mjs) `withDeliveryLock` | 在 CI 增加 Node 22.13 一列，运行 `test:task-isolation`、`test:game-export`、`test:http`；或把 `engines` 提到实际测试的版本并同步操作手册。 |
| EXP-03 | 中 | 工程锁的门禁文件 `forge_imports/.install-gate.sqlite` 写进用户的游戏工程。`.gdignore` 只让 Godot 忽略该目录，git 仍会看到它，用户可能把锁文件提交进游戏仓库。影响 Godot 交付与目标工程的版本管理。 | [game-export.mjs](../../../lib/workbench/game-export.mjs) 中 `.gdignore` 写入与 `.install-gate.sqlite` 路径；[交付文档](../../godot-delivery.md)“导出、安装和完成接入共用工程内的操作系统锁”一节 | 在临时 git 工程完成一次安装后执行 `git status --porcelain`，确认门禁文件及其日志文件不出现；同时确认 `backups/`、交付记录等需要保留的内容仍按原约定处理。 |
| DATA-06 | 低 | 派生摘要不会清理。任务文件消失后，内存缓存会剪掉对应条目，`.summaries-v1/` 中的磁盘摘要一直保留，长期使用后目录持续增长。影响任务历史的存储占用，不影响查询正确性。 | [task-history-index.mjs](../../../lib/workbench/task-history-index.mjs) `readTaskSummaries` 只修剪 `cache` | 建任务、删除任务文件、再列出历史，检查 `.summaries-v1/` 中对应文件是否被移除，且不影响其他摘要的命中。 |
| DATA-07 | 低 | 读取任务文件时若恰好遇到原子替换，读取前后 `fstat` 戳记可能不一致，该记录被报为读取失败。Web 会短暂显示历史不完整，`archiveTaskHistory` 会以“部分任务记录无法读取”拒绝归档，下一次读取恢复正常。原因为推断：被替换的旧 inode 链接数变化会更新 ctime，待复现。影响历史显示与归档。 | [task-history-index.mjs](../../../lib/workbench/task-history-index.mjs) `readIndex` 中 `before !== after` 抛出无 `code` 的错误，`readTaskSummaries` 将其列入 `unavailable` | 一个进程持续原子改写同一任务，另一进程循环调用 `listTaskPage` 与 `archiveTaskHistory({ checkOnly: true })`，统计 `coverage.complete === false` 和归档拒绝的次数；修复后应为 0 或改为有限重读。 |
| MCP-03 | 低 | 带 `detail=true` 的历史分页按文件版本精确重读正文。任务在制作中被改写（例如适配器检查点）时，同页读取会返回 409 `STALE_TASK_SNAPSHOT`，要求从第一页重新查询。Web 默认不带 `detail`，不受影响；MCP 与 CLI 的明细查询受影响。 | [task-runtime.mjs](../../../lib/workbench/task-runtime.mjs) `listTaskPage` 中 `readTaskAtVersion` 失败即 `throw stale()`；[agent-api.mjs](../../../lib/workbench/agent-api.mjs) `searchTasks` | 后台任务持续写检查点时用 MCP 以 `detail: true` 查询历史，记录 409 频率；评估改为返回最新版本并标记已变化，或只在跨页时校验快照。 |
| SEC-03 | 低 | `detail=true` 的任务正文带出 `execution.owner.token`。该令牌用于后台执行者核对自己仍持有任务，不需要对调用方公开。目前只在本机回环地址可见。影响 Bridge HTTP 与 MCP 任务查询。 | [task-runtime.mjs](../../../lib/workbench/task-runtime.mjs) `publicTaskRecord(task, true)` 原样返回；[workbench-http.mjs](../../../scripts/workbench-http.mjs) `GET /v1/tasks` | 以 `detail=true` 查询运行中的任务，确认响应中不含 `execution.owner`，而执行者核对与崩溃恢复回归仍通过。 |

## 记录

- **审查范围与方法。** 审查 `612e4b8` 至 `c24f9bd` 共 12 个提交，142 个文件，+8161 / −3543 行。逐模块阅读 Node 任务运行时拆分、发布恢复、历史摘要、Bridge 工作区配对、Godot 工程锁，以及 Python 执行授权、作业执行拆分和论文绘图计量。改动概览、核心变化与已核对的设计点见[审查报告](./审查报告.md)。
- **本机复验。** macOS arm64、Node 24.18.0：`test:task-isolation`、`test:adapters`、`test:http`（含工作区配对）、`test:game-export`（含 16 项工程锁检查）全部通过。Python 3.13：`test_open_motion_recovery_media.py`、`test_paper_experiment.py`、`test_open_motion_repairs.py`、`test_motion_adjustments.py`、`test_asset_catalog.py` 共 77 项通过。未在本机复跑全量 Python 套件、浏览器验收和 Godot 引擎验收；这几项以[架构审计分阶段复验](../2026-11-19-架构审计分阶段复验/README.md)的记录与 CI 结果为准。
- **不登记为问题的边界。** 工程锁要求目标文件系统支持 SQLite 文件锁和同目录硬链接，exFAT 等环境会拒绝安装。该限制已写入[交付文档](../../godot-delivery.md)，并提供“仅下载 ZIP”退路，属于设计取舍。

## 本目录文档

- [审查报告](./审查报告.md)：本轮架构改动的概览、核心变化、已核对的设计点、升级与回退注意事项。
