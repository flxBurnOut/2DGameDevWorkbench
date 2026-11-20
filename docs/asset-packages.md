# Forge 素材包导入合同

统一清单由 `lib/workbench/asset-package-contract.mjs` 定义；检查、提交及 Web 代理共用 `lib/workbench/asset-packages.mjs`。导入只保存已有文件和源数据，不创建生产任务、不执行包内脚本，也不启动暂停的生成请求。

## 检查、预览与提交

`POST /api/workbench/assets/packages/inspect`（Bridge 对应 `/v1/assets/packages/inspect`）接收单个文件的原始二进制请求体。`x-forge-filename` 使用 URI 编码的文件名。多文件逐个检查，提交时可组合选项；上传不经过 JSON/Base64 通道。

返回 `inspectionId`、`filename`、`packageHash`、`expiresAt` 以及 `candidates`。每个候选包含 `id`、`kind`、`label`、`status`、`metadata`、`recoverable`、`warnings`、`missing`、`requiredParameters`。状态为 `editable`、`material`、`needs-input` 或 `incomplete`。交互物包含 `objects[{definitionId,displayName}]`，按相同项目内容分组。`duplicate{assetId,exact}` 仅比较明确的来源身份和规范化内容；审核声明始终只是来源说明。

可预览候选含 `previewUrl`。`GET /api/workbench/assets/packages/preview?inspectionId=…&candidateId=…&frame=0` 读取暂存的准确帧，不采用用户指定的文件路径。预览每次重新校验登记的 SHA-256。

`POST /api/workbench/assets/packages/commit` 接收：

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

`inspectionIds` 为可选的界面上下文；实际选中集合以 `selections` 为准。`parameters` 只填写该候选 `requiredParameters` 中的键：`fps`、`loop` 或 `definitionIds`。明确的已有参数不要求再次填写。缺少参数、不完整候选及未知选择返回 400，不发布部分资产。

成功返回 `{commandId,status:"completed",assets:[{id,kind,label,reused,viewPath}],importedCount,reusedCount}`。同一命令及选择可安全重试；同命令改动选择返回 409。`GET …/commit?commandId=…` 查询原回执，不存在时返回 404。丢失响应后沿用原命令和选择，避免将未知结果当成失败重新导入。

## 格式与恢复边界

先检查 `forge-assets.json`（`format=forge-asset-archive, version=1`），再识别旧分类目录或独立源包。统一清单损坏时不降级为旧格式。每个文件的相对路径、长度及 SHA-256 均重新验证。

角色与物品图片保留原图。动画原始帧按明确清单或自然序号排序；FPS 和循环未知时必须补齐。Godot 动画按 `sprite-pipeline-godot` 的精灵表哈希和精确像素区域恢复，保留独立播放表示、锚点及适用的角色朝向，不把其参数套到另一组原始帧上。现代清单的 object_id/object_type 对应导入元数据 objectId/objectType，并与兼容 character_id 核对。交互物动画省略 source_facing；对象类型、身份、原始帧表示和随附引擎包不一致时拒绝关联。旧角色包不强加新字段。

交互物验证完整项目与图片、动画、音效引用；外部依赖缺失时只报告不完整项，不访问包外路径。

已知 Godot 清单包括通用交付包装 `forge-godot-export`、序列帧 `sprite-pipeline-godot` 与交互物 `workbench-interaction-kit`。源数据决定编辑恢复，Godot 脚本和节点原样保留。无已知引擎清单的源容器仍可恢复其中源数据，但不登记为可交付 Godot 包。损坏或未知的引擎侧文件保存为附件并显示原因。PSD 仅保存原始附件，不声称支持图层编辑。

## 限制、隔离与原子发布

二进制上传上限 768 MiB。每个 ZIP 容器展开上限 768 MiB，单项上限 512 MiB；既有源格式继续保留各自更严格的 256 MiB 限制。已知嵌套最大深度为 3，跨层累计展开上限 3 GiB、累计条目上限 24000。较大的累计限额允许同一下载包中的源 ZIP、Godot 内嵌源 ZIP 及其媒体重复展开；检查器不会递归探索任意 ZIP 附件。

解析器在解压前读取原始中央目录，拒绝越界路径、重名（含大小写和 Unicode 归一化碰撞）、文件/目录冲突、链接、加密、ZIP64、分卷、重叠数据区及不一致的文件头；只支持 STORE 和 DEFLATE，并校验 CRC 与实际展开长度。

`workspace.packageImportDirectory` 默认 `work/asset-package-imports`，未提交检查保留 24 小时并在后续检查时清理。上传原件、每项原始文件和派生预览分开登记。提交重新验证原件和所有选中文件，构造完整暂存事务，再以目录重命名一次发布资产集合及命令回执。

`workspace.importedAssetDirectory` 默认 `work/imported-assets`，持久布局为 `batches/<command-sha256>/commit.json`、`assets/<id>/record.json`、`assets/<id>/files/…` 和 `uploads/<upload-sha256>.bin`。扫描器只读取已发布批次。跨进程提交锁通过目录重命名一次发布 PID 和随机所有权标记。确认进程已退出后可回收遗留锁，包括旧版留下空恢复目录的锁。

导入资产使用 `imported:<32hex>` 身份。原来源身份不成为本机可写工程身份。打开编辑副本时由内部选用合同分配新工程身份，保留包内引用和原件；原 Godot 附件不会成为编辑后版本的新导出。`WORKBENCH_TEST_RUN` 始终把暂存和持久目录放到对应的隔离测试命名空间。

验证入口为 `tests/asset-packages/core.mjs`、`catalog.mjs` 和 `http.mjs`；覆盖混合包、真实交互物导出器、离线往返、原字节、精确动画区域、参数补全、项目分组、损坏包、原子幂等提交及超过 50 MiB 的二进制 HTTP 上传。
