# 动画视觉复核、可见性守卫与离线评估

本文前半部分定义生产流程中的视觉复核与确定性探针守卫（全库唯一规范），后半部分说明开发者离线评估 CLI 与评测口径。

---

## 第一部分：生产视觉复核机制

正式动画检查由 `production_review.py` 接入，新建前端任务默认启用增强协议 `review_protocol=experts_v1`（保存时冻结协议、模型与预算，旧任务保持原基础协议不自动升级）。复核仅产出报告与待确认项，不自动改帧、重画或采用。

### 1. 五步复核流程与调用预算

单次分段或整段检查最多 5 次 VLM 调用（无争议时省去第 5 次；基础协议为 2 次）。各角色共用本机配置的 `reviewer` 模型与受保护 Key（上下文隔离的多视角审计，并非调用多个不同模型）：

1. **基线观察与审核（2 次）**：使用 `review_inputs.py` 先按实际帧序观察，再对照合同审核。
2. **独立多视角意见（2 次）**：外观与运动两个角色在隔离上下文中分别检查（互不可见彼此与基线意见）。
3. **保留基线与分歧**：独立意见仅补充证据与争议，不用投票或平均置信度覆写基线。
4. **有界争议复核（最多 1 次）**：当三方结论不全为高置信通过（含分歧、不确定以及三方同判失败需核实缺陷）时触发。复核附带最多 12 张共享源坐标裁切的聚焦放大图（联合包围盒 ≤ `320×320` 时采用整数倍最近邻缩放居中留白），只输出单一分类：`满足要求` / `明确缺陷` / `审美偏好` / `证据不足`。
5. **翻案强制留人审**：争议复核试图取消原有缺陷或疑点时，该项仍保持待人工确认并保留双方原意见。

- **预算规则**：前端默认每候选预留 `5 ×（分段数 + 1）× 候选数`（单候选默认 25，总上限 200）；MCP 新请求未传协议和上限时默认增强协议，仅显式传旧预算上限时兼容基础协议。修复前后的报告均计入原任务账本，图片证据保存在作业内 `review-evidence/`，失败或帧变更时保留旧回执不自动重发。
- **返回入口**：通过现有 `get-motion`（`quality_review`）与 `get-motion-stage`（`stage.review`）返回，无需新 MCP operation。

### 可见性核对（版本 4）

新任务默认冻结 `visibility_review_version=4`，记录帧内可见程度、遮挡/透视说明与具体矛盾，并在本地执行三项硬规则：
- 共用边界帧是合法上下文证据（证据集不要求互斥区间），所有帧号必须对应实际帧。
- “未知”既不能证明部位丢失，也不能证明形状正确。
- 独立专家指出具体外观矛盾、而争议复核试图清除（含返回空证据）时，一律保留待人工裁决。

### 2. 角色与交互物确定性探针守卫

复核同步运行零生成费的确定性测量，若模型判通过但探针越界则强制转为待人工裁决：

| 资产类型 | 实现模块 | 测量指标与守卫规则 |
| --- | --- | --- |
| 角色 | [character_measurements.py](../Tools/SpritePipeline/sprite_pipeline/collaboration/character_measurements.py)（复用 [frame_checks.py](../Tools/SpritePipeline/sprite_pipeline/processing/frame_checks.py)） | 地面基线偏移（仅 `grounded=true`）、前景面积变化、调色板偏离、质心/位置跳变；以 `character_probes` 接入 `guard_measurements`，**不注入独立专家提示词** |
| 交互物 | [prop_measurements.py](../Tools/SpritePipeline/sprite_pipeline/collaboration/prop_measurements.py) | 扣除运动遮挡后的固定部件像素变化；铰接结构带 `rotation_plane`（默认 `in_plane` 检验 2D 半径守恒并保持旧哈希兼容，`out_of_plane` 跳过半径校验并保留固定部件检测） |

---

## 第二部分：离线评估 CLI 与评测规范

原开发验收工具保留为离线评估入口，与正式流程共用证据和判断逻辑，有独立结果目录与预算，不改写正式作业。素材、标注与对比结果放在忽略的 `work/` 中。

```powershell
$env:PYTHONPATH = "$PWD\Tools\SpritePipeline"
Tools/SpritePipeline/.venv/Scripts/python.exe -m sprite_pipeline.collaboration.review_cli --help
```

### 免费本地子命令

| 子命令 | 用途 |
| --- | --- |
| `snapshot --job <ID> --candidate <号> --token <令牌> --output <新目录> [--stage <段号>]` | 冻结完整动画或单段 `ReviewEvidence` 快照（可加 `--data-root`） |
| `inspect --evidence <快照目录>` | 校验冻结快照完整性和哈希 |
| `combine --baseline <基线.json> --independent <独立.json> --output <新报告.json>` | 合并同证据、同模型快照的基线与独立意见 |
| `score --labels <标签.json> --reports <映射.json> [--risk-coverage]` | 本地评分：按 `pass\|fail\|uncertain` 输出防退步计数、3×3 `confusion_matrix` 与 `rates`（覆盖率、弃权率、总体/选择性错误放行与错误拒绝率）；加 `--risk-coverage` 扫描置信度阈值绘制风险–覆盖率曲线（保留结构化人工升级项不随阈值下调） |

### 收费对比子命令（需显式 `--authorize-review`）

| 子命令 | 行为与调用上限 |
| --- | --- |
| `baseline --evidence <目录> --output <结果目录>` | 执行 2 次基线观察与审核 |
| `independent --evidence <目录> --output <结果目录> --model-snapshot <快照.json>` | 执行 2 次独立外观/运动视角检查 |
| `resolve --evidence <目录> --parent <合并报告.json> --output <结果目录>` | 存在争议时执行至多 1 次争议复核 |
| `self-consistency --evidence <目录> --output <结果目录> [--calls 5]` | 等调用次数（默认 5 次）盲独立采样，关闭置信度与帧数守卫，按多数票裁决（平票转 `uncertain`） |
| `experts-no-guard --evidence <目录> --output <结果目录>` | 等调用次数（至多 5 次）基线 + 双专家 + 争议流程，关闭不沉默覆盖、可见性守卫、置信度/帧数门槛与确定性探针 |

- `ReviewExperiment` 在调用前落盘请求 ID、输入摘要与模型快照（不含 Key）；超时或失败不自动重试，重复使用同一结果目录不重发，修正后须新建输出目录保留旧结果。

### 评测原则与回归

- **冻结与独立标注**：调用前冻结样本、判断依据与标签，明确区分用户反馈、Agent 判断与独立人工研究标签，并划分开发集与保留集。
- **完整三态统计**：同时报告误报（错误拒绝）、漏报（错误放行）、未识别缺陷、不必要拦截、过早定论、调用成本、3×3 混淆矩阵与 Risk–Coverage 曲线；`uncertain` 单独统计，不折算为正确。
- **防退步门禁（`comparison_gate`）**：要求标签和源文件一致、不利指标不上升，且逐项保护原本正确的判断，防止拆东墙补西墙。
- **模块与测试**：核心位于 `Tools/SpritePipeline/sprite_pipeline/collaboration/`（`review_inputs.py`、`review_evaluation.py`、`review_sources.py`、`character_measurements.py`、`prop_measurements.py`、`independent_review.py`、`dispute_review.py`、`review_cli.py`）。回归运行 `tests/test_review_evaluation.py`、`tests/test_production_review.py`、`npm run test:open-motion` 及相关 MCP/HTTP 检查。
