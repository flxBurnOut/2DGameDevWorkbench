# 架构提交复审与修复

> 返回[问题清单索引](../README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | 2026-11-20T11:18:23-05:00，美东时间 |
| 基准提交 | `c88329e0dcf0`，`paper-vbyc`。复审范围为 `b9cf677..c88329e` 的 15 个提交。 |
| 归档提交 | `5bb695567142`（实现、回归测试及本批记录，提交时间 2026-11-20T11:54:20-05:00）· `ea33a4b1a486`（Windows 备份检查，提交时间 2026-11-20T12:01:14-05:00） |
| 登记问题 | REC-07、EXP-04、E1-02、REC-08、REC-09、EXP-05、E3-02、PROV-02、DEV-03、API-03、ASSET-01、MEDIA-01 |
| 跟进问题 | EXP-01、EXP-03、DATA-06、MCP-03、E4-01 |

## 问题条目

| 编号 | 优先级 | 可观察现象 | 处理与验证 |
| --- | --- | --- | --- |
| REC-07 | 高 | 同源切换工作区后恢复付费命令会重复提交 | 通用任务、AI 图片修改和视觉分析绑定 Bridge 的实际数据存储，角色和交互物规划绑定原生动画数据目录。服务重启沿用原身份，在同一路径换入新库后拒绝旧请求。升级前的日志按原键与载荷只读核验。[通用命令](../../../tests/task-isolation/paid-recovery.mjs) · [Bridge 配对](../../../tests/workbench-http/pairing.mjs) · [图片编辑](../../../tests/image-edit/workspace-regression.tsx) · [角色规划](../../../tests/open-motion/browser.mjs) · [交互物规划](../../../tests/interactable-motion/browser.mjs) |
| EXP-04 | 高 | 另一交付更新共享资源后，旧预检仍可覆盖新资源 | 安装前在工程锁内核对受影响文件和账本条目的计划摘要。[交叉安装](../../../tests/game-export/install-lock.mjs) |
| E1-02 | 高 | 模型组补绘可超过实验副本冻结的总请求帧数 | 补绘前核算正常分段、历次补绘和本次请求。回顾导出标识历史超额样本。[预算边界](../../../Tools/SpritePipeline/tests/test_paper_experiment.py) |
| E4-01 | 高 | 首轮视觉服务失败被归作模型拒绝，较长片段还会进入重绘 | 驱动和回顾核对审查完成状态，技术中断进入盲评排除记录和总分母。[首审与回顾](../../../Tools/SpritePipeline/tests/test_paper_experiment.py) |
| REC-08 | 高 | 另一命令的原生候选变化会被误认作本次生成已接单 | 原生作业在同一次写入中记录原命令、候选、分段和版本。接单后发生超时或坏帧仍保留已知用量，额度预检拒绝保留未提交的快照。缺少接单证据时保留待核验状态。[适配器恢复](../../../tests/workbench-adapters/native-recovery.mjs) · [并发与中断](../../../Tools/SpritePipeline/tests/test_interactable_state_chain.py) · [额度边界](../../../Tools/SpritePipeline/tests/test_quota_result_safety.py) |
| REC-09 | 中 | 修复片段或创建修改备选丢失回包后，已接单的任务会过早结案 | 统一付费操作定义并持久化预提交信息，按原键和请求内容核验编辑回执。[原生编辑回执](../../../tests/open-motion/run.mjs) |
| MCP-03 | 中 | 按刷新后的状态分页时游标与切片集合不同，任务可重复出现 | 显式状态筛选先刷新范围内的活动任务，再从同一集合生成游标、总数与分页。[状态过滤续页](../../../tests/task-isolation/history.mjs) |
| EXP-05 | 中 | 回装中断后安装账本领先旧收据，待处理列表遗漏恢复操作 | 在线查询检查安装账本与交付回执版本，标出需恢复的交付。账本损坏或已安装交付的记录缺失时，历史与预检提示核验。[崩溃窗口](../../../tests/game-export/install-lock.mjs) |
| EXP-01 | 中 | 主机改名后 v2 安装锁无法回收 | v2 按同一 SQLite 写锁和门禁身份回收，v1 继续验证同机进程。[锁回收](../../../tests/game-export/install-lock.mjs) |
| DATA-06 | 中 | 摘要目录是符号链接时，读写会访问其他目录 | 磁盘摘要读取与发布检查目录身份。不能安全使用磁盘时，按权威任务正文和进程内摘要返回。[目录与同名文件](../../../tests/task-isolation/history-index.mjs) |
| E3-02 | 中 | 提供方返回一个坏帧时，其余有效原帧和序号会从回顾中丢失 | 逐帧记录有效证据和错误索引，保持整段验收失败，回顾读取原始证据。[混合坏帧](../../../Tools/SpritePipeline/tests/test_paper_experiment.py) |
| PROV-02 | 中 | PixelLab 显式返回其他作业 ID 时，帧与用量可能归错 | 提供方适配器先检查响应作业身份，错配返回合同错误，回顾同时核验旧 HTTP 错误内的响应。[错配 ID](../../../Tools/SpritePipeline/tests/test_paper_experiment.py) |
| DEV-03 | 中 | API-only 安装由 MCP 或 CLI 冷启动时选择了 Gradio | 自动启动按项目 Python 可用的组件选择服务，显式 API 或面板命令保持原有含义。[启动模式](../../../Tools/SpritePipeline/tests/test_service_launch.py) |
| API-03 | 中 | 旧服务缺少回执接口仍被诊断为兼容 | 按实际 HTTP 路径和方法探测能力，区分缺少接口与原生任务未接单。[服务兼容性](../../../tests/open-motion/run.mjs) |
| ASSET-01 | 中 | 原生动画文件读取失败会向实时目录行返回旧本地帧 | 新预览链接固定原生来源，旧的无来源动画链接可继续读取本地快照。[预览来源](../../../tests/workbench-assets/run.mjs) |
| MEDIA-01 | 中 | 媒体代理转发已解压的 RGBA 时仍声明压缩字节数 | 上游带内容编码时去除传输长度，实际像素长度和哈希继续由客户端核验。[压缩和原始媒体](../../../tests/image-edit/frontend.mjs) |
| EXP-03 | 低 | 首次安装因忽略规则失败时留下 Git 可见的门禁文件 | 先准备目标工程的 Git 忽略规则，再创建正式 SQLite 门禁。[首次规则写入](../../../tests/game-export/install-lock.mjs) |

## 记录

开发验证在系统临时目录的独立源码副本、临时游戏工程和模拟供应商中进行。任务历史、素材输出、实验档案和游戏数据均由夹具创建。

**恢复证据。** 在同一个原生作业中让两个命令先后写入同一候选。第一条命令取得上游回执后发生超时或收到坏 PNG，按原命令重读仍得到其上游 ID、候选 1、分段 1 和模拟用量 3.5 美元。第二条命令写入的不同用量保留在自己的版本。额度预检失败时，原回执记录 `not_submitted`，供应商提交次数为 0。[原生状态链](../../../Tools/SpritePipeline/tests/test_interactable_state_chain.py) · [额度用例](../../../Tools/SpritePipeline/tests/test_quota_result_safety.py)

**Godot 交付。** 同一资源被两次交付交叉更新时，旧预检收到 409。仅修改不相关文件时，原预检仍可用。临时工程覆盖了安装后发布回执前中断、账本缺失或损坏、编辑过的 Git 忽略规则和重复安装。26 项安装锁用例通过，Godot 4.7.2 实际完成导入、播放、重新开始和暂停。[交付回归](../../../tests/game-export/install-lock.mjs) · [引擎验收](../../../tests/game-engineering/run.mjs)

**历史基准。** 在同一台 macOS arm64、Node 25.8.1 上按表内顺序运行 `node tests/task-isolation/benchmark.mjs 10000 8 50`。每次从新数据目录开始。四轮冷读均为 5,000 条、41,890,000 字节，单条变化重读 8,377 字节。基线第一次冷重建耗时较长，两轮样本无法据以估算长期提速比例。[基准脚本](../../../tests/task-isolation/benchmark.mjs)

| 版本 | 轮次 | 冷重建 ms | 稳定轮询 p50 ms | p95 ms | 稳定轮询任务正文 |
| --- | ---: | ---: | ---: | ---: | ---: |
| c88329e | 1 | 556.3 | 24.0 | 25.8 | 0 B |
| 修复版 | 1 | 401.0 | 23.9 | 24.2 | 0 B |
| c88329e | 2 | 407.1 | 23.7 | 24.6 | 0 B |
| 修复版 | 2 | 390.4 | 23.8 | 24.4 | 0 B |

`node tests/task-isolation/history-stress.mjs 128 500 0` 在基线和修复版各完成 500 次列表查询和 500 次归档预检。查询期间分别发生 2,232 和 2,343 次原子替换，两次覆盖失败与归档误拒均为 0。另用网页实际分页读取入口验证 205 条任务跨页无重复，六页状态过滤验证了租约变化和权威文件变化。[压力脚本](../../../tests/task-isolation/history-stress.mjs) · [分页回归](../../../tests/task-isolation/history.mjs)

**存量实验。** 旧 v3 模型组可以向新目录重新导出，检查 `drawing_frame_budget`、首审状态与盲评排除原因。历史回执中缺失的原始帧无法从档案还原。本批用留存故障形状的夹具验证重新导出和排除，实际论文数据保持原样。[回顾导出说明](../../motion-experiments.md#人工时间与回顾性导出)

**浏览器与原生验证。** 全新 Chrome 会话通过角色动画与交互物规划的丢回包、重载和恢复验收，图片编辑另覆盖了 AI 修改、部件定位和视觉检查的换库重试。模拟请求均在临时数据目录中执行。macOS 使用 Python 3.13 和 Godot 4.7.2 运行两个原生项目的完整测试，912 项通过，另有 57 项子测试通过，1 项 Windows 文件共享专用用例按平台跳过。[角色动画](../../../tests/open-motion/browser.mjs) · [交互物动画](../../../tests/interactable-motion/browser.mjs) · [图片请求绑定](../../../tests/image-edit/workspace-regression.tsx) · [平台用例](../../../Tools/SpritePipeline/tests/test_quota_result_safety.py)

**版本门禁。** 在独立源码副本分别用 Node 22.13.0 和 24.18.0 通过 lint、typecheck、check:public，以及 task-isolation、game-export、assets、http、mcp、adapters、image-edit、open-motion、interactable-motion。Node 24 另通过生产构建、生产 Web 代理、MCP 冷启动和实际引擎验收。Python 3.11 的无 Gradio 安装运行 CI 原生清单，204 项通过，另有 2 项子测试通过，4 项原生 UI 用例及 1 项 Windows 专用用例按环境跳过。[门禁命令](../../../.github/workflows/ci.yml) · [生产 Web 验收](../../../tests/interactable-editor/http.mjs) · [MCP 冷启动](../../../tests/agent-acceptance/run.mjs)

**Windows 复验。** 提交 `344fa7660957` 的平台验收已逐字节读回更新前的两档备份，但 Windows 的默认 `git status` 没有列出较深的哈希备份。安装锁测试增加默认 Git 可见性与绝对路径长度的诊断，并用单次 `core.longpaths=true` 校验两档备份的跟踪资格。[首次平台验收](https://github.com/aaaarthur666-design/2DGameDevWorkbench/actions/runs/44778117483) · [回归用例](../../../tests/game-export/install-lock.mjs)

## 本目录文档

本页记录本批 17 项复审发现、修复和复验。
