# Forge 素材包导入合同

本页是素材包格式与导入 API 的规范文档。统一清单定义在 `lib/workbench/asset-package-contract.mjs`，检查、提交与 Web 代理共用 `lib/workbench/asset-packages.mjs`。导入仅保存已有文件与源数据，不创建生成任务、不执行包内脚本。

## 1. 检查、预览与提交接口

- **上传检查**：`POST /api/workbench/assets/packages/inspect`（Bridge `/v1/assets/packages/inspect`）接收单个文件的原始二进制请求体，请求头 `x-forge-filename` 传 URI 编码文件名。多文件逐个检查、提交时可组合。
- **检查响应**：返回 `inspectionId`、`filename`、`packageHash`、`expiresAt` 与 `candidates`（含 `id`、`kind`、`label`、`status`、`metadata`、`recoverable`、`warnings`、`missing`、`requiredParameters`）。状态为 `editable`、`material`、`needs-input` 或 `incomplete`；交互物按同项目内容分组返回 `objects[{definitionId,displayName}]`；`duplicate{assetId,exact}` 仅按明确来源 ID 与规范化内容比对（包内附带的审核文字仅作来源说明）。
- **预览**：`GET /api/workbench/assets/packages/preview?inspectionId=...&candidateId=...&frame=0` 读取暂存帧并重校验 SHA-256。
- **提交入库**：`POST /api/workbench/assets/packages/commit`：

```json
{
  "commandId": "stable-client-command",
  "inspectionIds": ["inspection-32hex"],
  "selections": [
    {
      "inspectionId": "inspection-32hex",
      "candidateId": "candidate-24hex",
      "parameters": { "fps": 12, "loop": false }
    }
  ]
}
```

- `parameters` 仅填写 `requiredParameters` 要求的缺项（`fps`、`loop` 或 `definitionIds`）。缺参或含不完整项返回 `400`，不发布部分资产。
- 成功返回 `{commandId, status:"completed", assets:[{id,kind,label,reused,viewPath}], importedCount, reusedCount}`。同 `commandId` 同选择安全幂等重试，改动选择返回 `409`；`GET .../commit?commandId=...` 可找回原回执（不存在返回 `404`）。

## 2. 包格式与恢复规则

- **格式识别**：优先读根目录 `forge-assets.json`（`format=forge-asset-archive`, `version=1`），其次识别旧分类目录或独立源包；统一清单损坏时直接报错，不降级解析。所有文件的相对路径、长度与 SHA-256 均重新校验。
- **角色与物品原图**：保留原文件。
- **动画恢复**：
  - 原始帧按清单或自然序号排序，缺 `fps` / `loop` 时须补齐；
  - Godot 动画按 `sprite-pipeline-godot` 精灵表哈希与精确像素区域恢复，独立保留播放配置、锚点与角色朝向；
  - 清单的 `object_id` / `object_type` 映射为导入元数据 `objectId` / `objectType`（与旧 `character_id` 核对）；交互物动画省略 `source_facing`，对象类型或帧表示与随附引擎包不一致时拒绝关联。
- **交互物与引擎包**：校验项目及其图片、动画、音效引用，缺外部依赖时标为不完整。已知 Godot 清单为 `forge-godot-export`、`sprite-pipeline-godot` 与 `workbench-interaction-kit`（源数据决定可编辑恢复，脚本与节点原样保留；无已知清单的容器不登记为可交付 Godot 包）。PSD 仅作原始附件保存。

## 3. 安全限制、原子发布与隔离

- **体积与解压上限**：单文件上传 ≤ 768 MiB；单 ZIP 展开 ≤ 768 MiB（单项 ≤ 512 MiB，既有源格式维持 256 MiB）；嵌套深度 ≤ 3，跨层累计展开 ≤ 3 GiB、≤ 24,000 条目（不递归探索任意附件 ZIP）。
- **ZIP 安全解析**：解压前校验中央目录，拒绝越界路径、重名（含大小写与 Unicode 碰撞）、文件/目录冲突、符号链接、加密、ZIP64、分卷、重叠数据区与坏头；仅支持 STORE 与 DEFLATE，校验 CRC 与实际长度。
- **暂存与持久化**：
  - 暂存目录默认 `work/asset-package-imports`，未提交检查保留 24 小时后清理；
  - 持久目录默认 `work/imported-assets`（含 `batches/<command-sha256>/commit.json`、`assets/<id>/record.json`、`assets/<id>/files/...`、`uploads/<upload-sha256>.bin`）；
  - 跨进程提交锁经目录重命名原子写入 PID 与所有权标记，确认进程退出后自动回收遗留锁；提交通过目录重命名一次发布。
- **本机 ID 隔离**：导入资产 ID 为 `imported:<32hex>`。打开编辑副本时分配新的本机工程 ID，保留包内引用与原件；编辑新副本后，原随包 Godot 附件仍属于原导入快照。

验证入口：`npm run test:asset-packages`（覆盖混合包、真实交互物导出、损坏包、原子幂等提交与 > 50 MiB 二进制上传）。
