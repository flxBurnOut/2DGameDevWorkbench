# 示例素材工具修复与复验

> 返回[问题清单索引](../README.md)。原始现象与当时的任务见[首次登记](../2026-11-17-示例素材生成工具问题/README.md)。

| 项目 | 内容 |
| --- | --- |
| 记录时间 | 2026-11-17T13:24:56-05:00 起（美国底特律） |
| 基准提交 | `55ee99898d2f`，分支 `paper-vbyc` |
| 实现与归档提交 | 本目录首次提交 |
| 登记问题 | 无 |
| 跟进问题 | PLAN-01、REV-01、PROV-01、MCP-01、REF-01、CFG-01、API-01、UI-06 |

## 问题条目

本批沿用上述八个编号。

## 记录

### PLAN-01、CFG-01、API-01　规划、修订和模型选择

新任务通过 `plan-motion` 的 `planningModels` 给指定角色选模型。选择固化在作品中，修订沿用同一配置。规划模型完整返回但未通过合同校验时，只将具体字段错误交回对应角色，一次修正计入原预算；有截止、通信中断或未知提交结果时保留回执。修订可以复用仍与参考图、需求、模型和预算相符的已通过观察，并保存其来源。初次 `plan-motion` 可按授权设置 `autoExecute=true`；`revise-motion` 只接受省略或 false，修订后用新 revision 和 planSha256 确认。原生 OpenAPI、工作台 schema 和提交前校验均覆盖此差异。[规划实现](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/workspace.py) · [规划回归](../../../Tools/SpritePipeline/tests/test_planning_correction.py) · [Agent 操作说明](../../../workbench/guides/motion.md)

真实重放选用橙发剑士第 1 版的原始需求和 PNG。两组都使用原先的帧数与余额快照、同一 TokenHub 服务、low 推理档位和 16,384 输出 token 上限，四个规划角色在组内使用同一款模型。每款最多授权 8 次真实规划调用，生成调用为 0。两份就绪方案均通过绘图前合同校验。

| 模型 | 首轮各角色首次返回通过结构校验 | 回执和结果 |
| --- | --- | --- |
| glm-5.3-flash | 3/4；协调角色超长 | 第一轮共 6 次，协调角色的两段绘图提示在修正后仍超过 1,000 字符，停止。增加逐段长度提示，并在修正时仅向出错角色提供原无效草案。隔离复验使用相同输入和之前保存的 4 条合格专家回复，只实际调用协调角色 2 次，第 2 次通过。两段提示分别为 975 和 966 字符，计划 8+4 帧。两轮共 8 次真实调用。 |
| kimi-k3.1-pro | 3/4；协调角色超长 | 第一轮在第 6 次调用发现第二段提示超长，协调角色于第 7 次调用修正并就绪。两段提示分别为 779 和 843 字符，计划 8+8 帧。 |

按“整份方案无需结构修正即就绪”计，两款模型在这一个输入上均为 0/1。本次只重放了剑士挥剑这一份需求，无法估计其他角色和动作的通过率。私有调用记录、费用回执与模型输出留在本机隔离目录 `work/test-runs/example-plan-replay-q_nbcm_d/`。原登记的七个历史作品版本中，五个规划失败，两个最终执行。各版本使用的模型和修订输入不同。

### REV-01、MCP-01　复核进度与结果大小

`workbench_get_task` 可在同一个开放动作任务上跨越片段确认，返回复核的候选、片段或整段、当前检查项、已用调用数和可裁决状态。隔离验收把执行暂停在实际视觉请求上，读到观察阶段 1/5 次。片段就绪后取得精确 token 并一次确认，整段就绪后一次采用，提交动作时遇到 busy 的次数为 0。[进度与采用条件](../../../lib/workbench/sprite-review.mjs) · [端到端回归](../../../tests/open-motion/run.mjs)

用原登记中的两份已保存结果只读重放 MCP 投影。默认结果给出候选问题数、错误与提醒摘要、下一步和待裁决 token；完整证据可用 `detail:true` 按 JSON Pointer 分区和快照分页。[结果投影](../../../lib/workbench/sprite-result.mjs) · [客户端说明](../../agent-client-tools.md)

| 历史操作 | 原 structuredContent（字符） | 当前 structuredContent（字符） | 当前整个工具响应（UTF-8 字节） |
| --- | ---: | ---: | ---: |
| generate-motion | 134,587 | 1,866 | 4,166 |
| review-motion-stage | 167,791 | 1,619 | 3,590 |

### PROV-01　PixelLab 的排队与提交回执

原图和动画在提交前读取额度，共用同一 PixelLab 凭据的任务空位。原图队列保存原请求 ID，服务在页面关闭后继续处理。服务拿到上游任务 ID 后保存回执，重启可接续查询。明确被拒且无产物或用量的请求在历史中显示“未提交”，首页“继续制作”过滤该状态。上游已给出任务 ID、报告用量或提交结果不确定时，保留原请求供核对。[账户空位与提交回执](../../../Tools/SpritePipeline/sprite_pipeline/providers/account.py) · [原图队列](../../../Tools/SpritePipeline/sprite_pipeline/reference_queue.py)

只读检查首次登记的 6 条历史任务，6/6 均显示“未提交”，原记录保留。隔离测试使用模拟 PixelLab，覆盖原图先提交、动画先提交、关闭客户端后自动续接，以及取得上游回执后本地写入中断。工作台适配器和 MCP 同时验证了排队与未提交的状态及可用操作。[原生回归](../../../Tools/SpritePipeline/tests/test_reference_art.py) · [适配器回归](../../../tests/workbench-adapters/run.mjs)

试用次数为零且美元余额为零时，规划和生成均阻止超额请求。有美元余额时保留用户设定的帧数上限，实际价格由 PixelLab 确认。旧原图客户端未传请求 ID 时继续使用即时提交契约，账号忙时返回明确拒绝。需要用户确认的局部修复在账号忙时返还尝试次数与预算，由用户在原片段再次发起。[规划帧预算](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/frame_budget.py) · [局部修复](../../../Tools/SpritePipeline/sprite_pipeline/collaboration/repairs.py)

### REF-01、UI-06　原图朝向与动画标题

角色原图可选择出图后用 reviewer 看实际 PNG，分辨纯侧视、四分之三视角、正面、背面及朝向。核对回执绑定任务、原图哈希和要求的方向。未启用模型、结果不一致或无法判定时，页面和 MCP 显示核对要求，移送时记录采用者的实际观察；相同请求复查会读取已有回执。隔离回归覆盖侧视朝右、侧视朝左、背面、四分之三视角和无法辨认，使用模拟视觉结果。[原图核对](../../../Tools/SpritePipeline/sprite_pipeline/reference_orientation.py) · [使用说明](../../reference-art.md)

原生作品库、工作台任务快照和任务显示在组装动画标题时检查动作名是否已包含角色名。通过本机 Chrome 打开生产构建的首页和资产库，两处都显示“红袍法师原地举杖施法循环”。同次浏览器验收还核对了原图视角不符时的提示，以及填写观察前后的移送按钮状态。[原生作品库](../../../Tools/SpritePipeline/sprite_pipeline/artwork_library.py) · [任务快照回归](../../../tests/workbench-assets/run.mjs)

## 本目录文档

本页保存本批修复与验证结论。
