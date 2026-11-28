# 角色视觉结构与规划策略

本文覆盖动作制作中的可选视觉结构能力（原图解析、跨帧追踪与结构辅助制作），以及开放动作的规划与绘图策略版本规则。可见性核对与争议复核规则统一见[视觉复核文档](sprite-review-evaluation.md#可见性核对版本-4)。

## 1. 原图静态结构解析与历史恢复

在角色准备页展开 **结构解析与纠正**：

1. 点击 **解析角色结构**（最多调 1 次语义模型 + 本地 SAM 分割，不改原图）。
2. 点击 **查看结构** 检查部件与锚点：青色为可见位置，黄色为推断位置，未知项不画确定坐标。
3. 需要调整时进入 **纠正位置或关系**，重放锚点或增删保留/排除点与框选区域；保存仅在本地重算受影响部件，不再次调用语义模型。这里的区域属于结构观察数据，不是动画编辑蒙版。
4. 核对无误后点击 **确认结构**（坐标落入透明区或关键区域缺失会阻止确认）。
5. **结构历史版本**：原图与跨帧面板均可只读预览任意历史版本，并用当前 revision/token 恢复为新版本（保留全部历史，恢复后需重新核对；存在未保存草稿、计算中或来源变更时禁止恢复）。

### 持久化与本地接口

分析记录存于 `<data_root>/visual-structures/<analysis-id>/`（含不可变来源快照、语义回执、蒙版与 `revision-N.json`）。同源重复请求复用原记录；语义已存而本地分割失败时可直接在本地重算，不重复扣费。Web 经白名单代理访问 `/v1/open-motion` 下的 `GET /structure-runtime`、`GET /references/{character_id}/structure`、`POST /structures`、`GET /structures/{id}`、`POST /structures/{id}/corrections`、`GET /structures/{id}/source`、`GET /structures/{id}/masks/{part_id}`。

## 2. 独立 SAM 2.1 运行环境

结构解析模型在 **模型设置 → 角色结构解析** 指定（默认沿用规划模型与受保护 Key）。本地分割/追踪使用独立的 Python 3.12 环境（不改动 SpritePipeline 现有 venv）：

```powershell
npm run visual-structure:setup
npm run visual-structure:check
```

- 首次安装下载锁定版本 PyTorch、SAM 2 代码与 Tiny 权重到忽略的 `work/visual-structure-runtime/`（版本与哈希见 `Tools/VisualStructure/runtime-profile.json`）。Windows/Linux 默认装 CUDA 12.8，macOS 支持 Apple MPS；加 `-- --cpu` 可默认 CPU，用 `FORGE_STRUCTURE_BOOTSTRAP_PYTHON` 指定 Python 3.12。
- **设备优先级**：作业内冻结 `device` > 环境变量 `FORGE_STRUCTURE_DEVICE`（`auto|mps|cpu|cuda`）> 运行目录 `device.json`；`auto` 按 CUDA → MPS → CPU 选 FP32 推理。显式指定设备不可用时直接报错，不静默回退 CPU。
- **推理隔离与回执**：单图与跨帧共用本地推理锁；Apple MPS 下追踪帧保留在 CPU 并采用分块注意力与连续布局池化以控制显存与兼容 Torch 2.7.1。回执记录设备、精度、耗时与内存快照（`mps_allocated_bytes` / `mps_driver_bytes` 或 CUDA `peak_gpu_bytes`）。
- 离线数值回归：`work/visual-structure-runtime/venv/bin/python -m unittest discover -s Tools/VisualStructure`。

## 3. 结构辅助制作与跨帧观察

### 使用已核对结构辅助制作

准备页勾选 **使用已核对的结构辅助本次制作**（默认关闭，须先确认原图结构；MCP 通过既有 `motionSpec.visual_structure` 传入 `analysis_id` 与 `token`）：

- 规划与绘图冻结原图哈希、结构版本与可见部件清单，仅可见部件、锚点和关系进入枚举与 `motion.generation_hint`（未知或推断项单独留作不确定证据，不作为控制事实）。
- 当前 PixelLab 接口仍接收图片与文本，不提供骨骼或逐部件硬锁定；结构或原图变化时阻止提交新规划，选帧修改继承结构且以用户本次要求优先。

### 实际动画的跨帧结构观察

在完整或分段播放器下展开 **结构观察**：默认仅做免费本地追踪（可显式勾选 1 次关键帧语义核对），复用该动画对应的已确认原图结构。

- 原始 PNG 是唯一播放来源，参考图仅作追踪上下文；语义锚点只在已核对关键帧显示，未知或遮挡区域不生成确定坐标。
- **首帧纠正规则（`manual_first_frame_v2`）**：在第 1 帧手动纠正某个可见部件时，该部件改用本次纠正重新初始化后续追踪（其他部件沿用各自参考区）。新分析冻结规则，旧记录不迁移。
- **结构辅助复核**：可显式点击 **用结构辅助专家复核**（复用已有两次基础检查，最多追加 3 次调用，结论另存且不改原生动画审批状态）。要求来源必须严格溯源到用户原话，规划建议不可升格为用户硬要求。
- 记录存于 `<data_root>/temporal-structures/<id>/`，对应接口位于 `/v1/open-motion` 下的 `GET/POST /{work_id}/temporal`、`GET /temporal-structures/{id}`、`POST .../corrections`、`POST .../review` 及帧/蒙版读取路由。

## 规划与绘图策略

新建与显式修订的工作冻结三个协议版本号，旧任务与导出按各自冻结版本执行：

| 字段 | 当前默认 | 作用 |
| --- | --- | --- |
| `generation_policy_version` | `6` | 决定每段绘图文本的生成方式 |
| `planning_format_version` | `4` | 专家提示格式、角色合同、可见结构枚举与单次校验修正 |
| `visibility_review_version` | `4`（`experts_v1` 任务） | 见[可见性核对](sprite-review-evaluation.md#可见性核对版本-4) |

### 策略 6（当前默认）与历史版本

| 策略 | 绘图文本来源 | 状态 |
| --- | --- | --- |
| 6 | 协调专家定稿段目标 `stage.goal` 与全片关键姿势 `quality.key_poses`，服务端按段换算局部帧号并组装 12 行绘图文本 | **当前默认** |
| 4 / 5 | 策略专家出分析草案、协调专家手写完整 12 段 `stage.prompt`（策略 5 起为后续专家预留额度） | 历史旧默认（旧任务沿用） |
| 3 | 协调专家直写 `stage.prompt` | 历史旧版 |
| 1 / 2 | 本机逐项拼装 v4 运动字段 | 隔离实验，未启用 |

- **策略 6 组装规则**：每段 12 行（外观、动作、相机、朝向、发力、支撑、轨迹、节奏、姿势、关系、结束、边界）共享 **1,000 字符上限**；服务计入标题、换行与停顿区间，超限时将逐项长度退回定稿角色修正，不静默截断。实现追踪见 [PLAN-01](问题清单/2026-11-17-规划首次定稿提示长度复验/README.md)。
- **规划格式 v4 与严格 JSON**：策略专家仅输出 `proposal`，协调专家发布最终 `plan`；结构引用 Schema 仅枚举已确认的可见标识并做本地二次校验；单角色单版规划最多按校验反馈修正 1 次。TokenHub `kimi-k3.1-pro` 规划默认启用 `json_schema` 严格模式（参考[腾讯云协议说明](https://cloud.tencent.com/document/product/1823/135872)）。
- **绘图条件审计**：原生 `submit.intent.json` 的 `drawing_conditions` 保存每段提示哈希、结构引用与首末图哈希（`target_mode=text_only` 表示未绑段末目标图）。

## 4. 回归测试

- Python：`tests/test_visual_structures.py`、`test_structure_tracking.py`、`test_temporal_structures.py`、`test_tracking_review.py`、`test_structure_control.py`；
- Node 与浏览器夹具：`node tests/authoring-gaps/run.mjs`、`node tests/authoring-gaps/web-server.mjs`（覆盖历史版本恢复与外观约束隔离）。
