# 序列帧实验支撑

当前命令只执行免费模拟或本地导出。真实实验的对象、规模、费用上限和盲评人数尚未定；模拟调用与归档帧回放不能作为生成质量的实验结果。运行目录必须为新建隔离目录，不能指向已有作业目录。

## 四种模拟接续策略

从 `Tools/SpritePipeline` 目录使用项目虚拟环境：

```sh
.venv/bin/python -m sprite_pipeline.collaboration.experiment simulate blind /absolute/reference.png /absolute/protocol.json /absolute/new-run
```

Windows 使用 `.venv\Scripts\python.exe`。协议示例：

```json
{
  "seed": 42,
  "fps": 8,
  "stages": [
    {"prompt": "Raise the arm", "frames": 4},
    {"prompt": "Lower the arm", "frames": 4}
  ],
  "mock_verdicts": ["pass", "pass"]
}
```

| 模式 | 行为 |
| --- | --- |
| `single` | 单次画完整动作；合计超过 16 帧拒绝，不裁短其他组来凑齐 |
| `blind` | 使用上一段真实最后一帧接续，不调用复核 |
| `keyframe_first` | 先为每段执行一条 4 帧姿势提案，冻结其真实末帧，再以首末图填充各段。姿势调用单独计数，不计入播放帧 |
| `model_only` | 逐段调用传入的判定器，只有 pass 才接续；fail 或 uncertain 最多再画一次该段，仍不通过则停止 |

CLI 的判定器只读取 `mock_verdicts`，明确标记 `diagnostic_only`。模块的 `run_arm` 接受提供方和判定器依赖，供后续已授权的真实实验注入；CLI 不接受付费服务或密钥。网络失败、中断与未知结果均停止，不自动重发；输出目录已存在时拒绝新运行。模型复核拒绝后的第二次绘制是固定实验策略，不是对未知请求的恢复重试。

各组使用相同参考、段级描述、帧数、FPS 和种子。`run.json` 保存模式、实际首末图摘要、调用状态、用量、复核结果和顺序帧。关键帧策略的姿势生成方式仍需在真实实验协议中明确报告，不能称其为一次静态图生成。

## 人工时间与回顾性导出

片段确认、完整候选确认及修改备选采用页面可填写实际人工检查秒数。API 接收 `human_seconds`，MCP 的片段/备选裁决使用 `humanSeconds`。未测量时留空，导出保持未知；不会用页面打开时间冒充人工工作时间。

```sh
.venv/bin/python -m sprite_pipeline.collaboration.experiment export /absolute/jobs/JOB /absolute/open-motion/WORK/work.json /absolute/new-export
```

历史版本使用对应的 `version-N.json`，必须与作业中的作品版本一致。导出逐段原始帧、已确认帧、视觉报告与历史、人工裁决、局部修复和修改备选，以及完整候选播放帧。每个复制的 PNG 都核验来源哈希；不修改作业、不调用模型。

`retrospective.json` 的 `cost` 包含与原生预算账本相同口径的调用次数，加上属于本作业的独立修改调用；保留绘图及视觉回执的原生用量。Token、额度单位和美元分别保存，不用估计汇率混算。没有明确 `cost_usd` 的请求计入 `unpriced_calls`，存在未定价请求时 `total_usd` 为 null。未知人工用时单独计数，`known_human_seconds` 只是已记录小计。派生作业包含来源作业继承的预算记录，跨多个版本统计时需按来源请求去重，不能简单累加这些汇总。

## 匿名播放包

```sh
.venv/bin/python -m sprite_pipeline.collaboration.experiment blind /absolute/new-blind-pack /absolute/run-A /absolute/run-B
```

输入可以是完整模拟运行目录，或上一步的回顾性导出目录。每个候选随机命名、打乱顺序，PNG 重新编码清除元数据；公开包只含匿名编号、帧数、FPS、像素和离线播放页面。打开 `index.html` 即可播放。编号对应表写到包目录旁的 `new-blind-pack-private-key.json`，不要交给盲评者。可见画面本身可能透露方法特征，匿名打包不等于消除所有盲评偏差。
