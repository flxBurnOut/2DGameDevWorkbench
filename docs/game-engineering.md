# 游戏工程接入

[工程 Skill](../.agents/skills/forge-game-engineering/SKILL.md)负责把已有素材接入目标 Godot 工程，以及实现已授权的游戏代码。接入以目标工程自己的场景、控制器和生命周期为准。

## 按输入选择参考

| 输入或任务 | 参考 |
| --- | --- |
| 选定动画、PNG 或 atlas | [帧与动作](../.agents/skills/forge-game-engineering/references/frames.md)，topic engineering-frames |
| 已选择目标项目的 Forge 交付 | [Godot 交付](godot-delivery.md)，topic delivery |

MCP `workbench_get_guidance({topic:"engineering"})` 可读取 Skill；引用主题也可按表读取。旧 discovery 中的 engineering.skill 路径继续有效。实际接入由宿主文件/命令工具完成，读取指导不自动启动 Agent 或修改游戏。

用户提供目标工程和所选素材即可；资源路径、动画别名和节点接线由 Agent 根据实际文件确定。只有讨论请求时交付设计，实施请求则完成对应文件和验证。

## 现有辅助工具

- `inspect_source.py ROOT`：只读列出 CopyWorms 参考工程的固定文件、哈希与直接资源引用；Skill 正文不再引用，仅为已有回归保留。
- `stage_assets.py sprite`：从已核实动画元数据建立独立暂存目录，保留源包，不自动合并目标工程。
- `sprite_frames_merge.gd`：合并选定动作，保留原资源中的其他动画。
- `character_visual.gd`：可选的角色表现 helper；目标已有控制器或关卡管理方式优先。

这些工具位于工程 Skill 的 scripts/ 与 assets/，具体参数、导出格式和使用条件见对应参考。已有合适 Godot 包可直接走交付流程。

## 验证

目标工程使用其实际 Godot 版本，不因资产接入隐式升级。Forge helper 回归基线为 4.7.x：

```powershell
$env:GODOT_47_BIN = '你的 Godot 4.7.x 可执行文件绝对路径'
npm run test:engineering
```

测试使用隔离目录和合成素材，不需要模型 Key。未提供符合基线的引擎时明确报告跳过；夹具通过不代表用户实际关卡已验证。

按改动检查实际行为：动画帧序/FPS/loop、重复触发与中断、原攻击计时与命中次数；交互物状态与真实交互信号。资源导入、视觉播放与玩法回归分别报告。详细检查点在上表对应参考中。

交付记录用 complete_game_export 关联实际修改文件与引擎证据；缺少引擎时如实填 not_run。维护已有 ID、路径和用户修改，安装冲突按[交付流程](godot-delivery.md)处理。
