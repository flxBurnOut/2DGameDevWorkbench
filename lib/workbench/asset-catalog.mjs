import { createHash, randomUUID } from 'node:crypto';
import { animationTitle } from './animation-title.mjs';
import { readFile, readdir, realpath, stat, open } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { repositoryRoot, findCapability } from './workbench-manifest.mjs';
import {
  endpointUrl,
  bearerHeaders,
  requestJson,
  requestBinary,
} from './adapters/http.mjs';
import { readAssetTrash, trashEntry, updateAssetTrash } from './asset-trash.mjs';
import { readProjection, catalogTask, catalogResult } from './asset-projections.mjs';
import { assetInputs } from './asset-contract.mjs';
import { assetImportInput, importPurposes, importPurposeIssue, imageMimeFromHeader } from './asset-import-contract.mjs';
import { listImportedAssets, readImportedAsset, resolveImportedAssetFile } from './asset-packages-store.mjs';
import { assetKindEnabled, requireAssetKind } from './asset-type-registry.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const safeId = (value) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(value);
const imageExt = /\.(png|gif|jpe?g|webp)$/i;
const statusLabels = {
  saved: '已保存',
  review_required: '待检查',
  approved: '已检查，可导出',
  exported: '已导出',
  failed: '保留画面，需处理',
};
const route = (manifest, capabilityId) =>
  [...manifest.capabilities, ...(manifest.editorModules || [])].find((c) => c.id === capabilityId)?.ui?.route;
async function confined(root, file) {
  const [base, resolved] = await Promise.all([realpath(root), realpath(file)]);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('文件越过资产目录。');
  return resolved;
}
async function readJson(file, maxBytes = 64 * 1024 * 1024) {
  if ((await stat(file)).size > maxBytes) throw new Error('记录超过读取上限。');
  return JSON.parse(await readFile(file, 'utf8'));
}
function connection(manifest) {
  const { connector } = findCapability(manifest, 'sprite-generator');
  return {
    base: process.env[connector.urlEnv] || connector.defaultUrl,
    headers: bearerHeaders(process.env[connector.tokenEnv]),
  };
}
async function nativeRequest(manifest, suffix) {
  const c = connection(manifest);
  return requestJson(endpointUrl(c.base, suffix), {
    headers: c.headers,
    timeoutMs: 10000,
  });
}
async function taskFile(manifest, task, file, withHash = false) {
  const entry = {
    key: file,
    name: path.basename(file),
    path: file,
    available: false,
  };
  try {
    if (!task.outputs.includes(file) || !safeId(task.id))
      throw new Error('未登记的文件。');
    const outputRoot = path.resolve(
      repositoryRoot,
      manifest.workspace.outputDirectory,
    );
    const taskRoot = await confined(outputRoot, path.join(outputRoot, task.id));
    const resolved = await confined(
      taskRoot,
      path.resolve(repositoryRoot, file),
    );
    const info = await stat(resolved);
    const maxBytes = 64 * 1024 * 1024;
    if (!info.isFile() || info.size > maxBytes)
      throw new Error('文件不可读取。');
    Object.assign(entry, {
      available: true,
      bytes: info.size,
      absolutePath: resolved,
    });
    if (withHash) {
      entry.sha256 = hash(await readFile(resolved));
    }
  } catch {
    entry.available = false;
    entry.issue = '文件缺失、过大或不在此任务目录中。';
  }
  return entry;
}
async function importedFile(manifest, record, filePath, withHash = false) {
  const registered = record.files.find((file) => file.path === filePath);
  const entry = { key: filePath, name: path.posix.basename(filePath), path: filePath, role: registered?.role, mime: registered?.mime, available: false };
  try {
    if (!registered) throw new Error('未登记的导入素材文件。');
    const absolutePath = await resolveImportedAssetFile(repositoryRoot, record, filePath, manifest);
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size !== registered.bytes || info.size > 768 * 1024 * 1024) throw new Error('文件大小不匹配。');
    const sha256 = withHash ? hash(await readFile(absolutePath)) : undefined;
    if (withHash && sha256 !== registered.sha256) throw new Error('文件哈希不匹配。');
    Object.assign(entry, { available: true, bytes: info.size, absolutePath, ...(withHash ? { sha256 } : {}) });
  } catch {
    entry.issue = '导入素材文件缺失、内容已变化或不在资产目录中。';
  }
  return entry;
}
async function localFile(manifest, catalog, source, key, withHash = false) {
  const record = localRecord(catalog, source);
  return source.origin === 'imported-package' ? importedFile(manifest, record, key, withHash) : taskFile(manifest, record, key, withHash);
}
async function localImageMime(file) {
  if (!file?.available || !file.absolutePath) return null;
  try {
    const handle = await open(file.absolutePath, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0);
      return imageMimeFromHeader(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  } catch { return null; }
}
const metadataKeys = ['width', 'height', 'facing', 'fps', 'loop', 'frameCount', 'candidateIndex', 'candidateCount', 'characterId', 'actionId', 'jobId', 'productionRevision', 'definitionId', 'definitionIds', 'projectId', 'anchor', 'sourceFacing', 'frameDurations', 'animationRepresentations', 'objectId', 'objectType'];
const sourceMetadata = (asset) => Object.fromEntries(metadataKeys.filter(key => !['objectId', 'objectType'].includes(key) || asset[key] != null).map((key) => [key, asset[key] ?? null]));
async function catalogFileBytes(manifest, catalog, source, file, maxBytes = 768 * 1024 * 1024) {
  let bytes;
  if (source.origin === 'sprite-pipeline') {
    const c = connection(manifest);
    ({ buffer: bytes } = await requestBinary(endpointUrl(c.base, '/v1/artworks/file?' + new URLSearchParams({ asset_id: source.nativeId, key: file.key })), { headers: c.headers, maxBytes, timeoutMs: 30000 }));
  } else {
    const actual = await localFile(manifest, catalog, source, file.key);
    if (!actual.available || actual.bytes > maxBytes) throw new Error('素材文件缺失、过大或已无法读取。');
    bytes = await readFile(actual.absolutePath);
  }
  if (!file.sha256 || hash(bytes) !== file.sha256) throw new Error('素材文件内容发生变化，请刷新后重新选择。');
  return bytes;
}
async function records(manifest, issues) {
  const directory = path.resolve(
    repositoryRoot,
    manifest.workspace.taskDirectory,
  );
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT')
      issues.push({ source: 'runtime', message: '本地任务目录暂不可读。' });
    return [];
  }
  const tasks = [];
  for (const entry of entries.filter(
    (e) => e.isFile() && /^[a-z0-9][a-z0-9_-]*\.json$/i.test(e.name),
  )) {
    try {
      const task = await readProjection(
        await confined(directory, path.join(directory, entry.name)), 64 * 1024 * 1024, catalogTask,
      );
      if (
        !safeId(task.id) ||
        entry.name !== `${task.id}.json` ||
        !Array.isArray(task.outputs) ||
        !task.input
      )
        throw new Error();
      tasks.push(task);
    } catch {
      issues.push({
        source: 'runtime',
        record: entry.name,
        message: '记录损坏或过大，未纳入资产目录。',
      });
    }
  }
  return tasks.sort(
    (a, b) =>
      (a.updatedAt || '').localeCompare(b.updatedAt || '') ||
      a.id.localeCompare(b.id),
  );
}

function localRecord(catalog, asset) {
  return asset.origin === 'imported-package' ? catalog.importedById.get(asset.id)
    : catalog.taskById.get(asset.taskId);
}

const earliest = (...values) => values.filter((v) => typeof v === 'string' && v).sort((a, b) => a.localeCompare(b))[0];

function decorate(manifest, asset) {
  asset.viewPath = `${manifest.agentAssets.assetCatalog.route}?asset=${encodeURIComponent(asset.id)}`;
  asset.viewUrl = new URL(asset.viewPath, manifest.workspace.frontend.url).href;
  const params = new URLSearchParams({ assetId: asset.id });
  if (asset.origin === 'runtime') params.set('task', asset.taskId);
  if (asset.storageBatchKey) params.set('batch', asset.storageBatchKey);
  asset.previewUrl = '/api/workbench/assets/preview?' + params;
  asset.statusLabel ||= statusLabels[asset.status] || '请查看详情';
  asset.engineValidated = false;
  return asset;
}
async function scan(manifest, selection) {
  const issues = [];
  const assets = new Map();
  const tasks = selection?.tasks ?? await records(manifest, issues);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const imported = (selection?.imported ?? await listImportedAssets(repositoryRoot, manifest)).filter(record => assetKindEnabled(manifest, record.kind));
  const importedById = new Map(imported.map((record) => [record.id, record]));
  const native = selection ? { data: { assets: [] } } : await nativeRequest(manifest, '/v1/artworks').catch(
    () => null,
  );
  if (!Array.isArray(native?.data?.assets))
    issues.push({
      source: 'sprite-pipeline',
      message:
        '序列帧资产接口离线或版本过旧；当前仅展示本地已保存记录，请勿据此判断原生资产不存在。',
    });
  else issues.push(...(native.data.issues || []));
  const transfers = new Map();
  const jobTasks = new Map();
  const jobRecords = new Map();
  for (const task of tasks) {
    const jobId = task.adapter?.remoteJobId || task.input.jobId;
    if (jobId && task.capabilityId === 'sprite-generator' && task.input.provider !== 'fixture' &&
        task.input.characterId !== 'diagnostic_dummy' && !task.input.diagnosticOnly)
      jobRecords.set(jobId, [...(jobRecords.get(jobId) || []), task]);
  }
  const objectHistory = new Map();
  const put = (a) => { if (assetKindEnabled(manifest, a.kind)) assets.set(a.id, a); };
  for (const task of tasks) {
    if (
      task.input.provider === 'fixture' ||
      task.input.characterId === 'diagnostic_dummy' ||
      task.input.diagnosticOnly
    )
      continue;
    if (task.capabilityId === 'sprite-generator') {
      const jobId = task.adapter?.remoteJobId || task.input.jobId;
      if (jobId) jobTasks.set(jobId, [...(jobTasks.get(jobId) || []), task.id]);
    }
    if (!task.outputs.length) continue;
    let result = {};
    const resultPath = task.outputs.find((p) => p.endsWith('/result.json'));
    if (resultPath) {
      const f = await taskFile(manifest, task, resultPath);
      if (f.available) {
        try {
          result = await readProjection(f.absolutePath, 8 * 1024 * 1024, catalogResult);
        } catch {
          issues.push({
            source: 'runtime',
            record: task.id,
            message: '结果元数据不可读取。',
          });
        }
      }
    }
    if (
      task.capabilityId === 'reference-art' &&
      task.input.operation === 'transfer' &&
      task.status === 'completed' &&
      result.characterId
    ) {
      transfers.set(result.characterId, {
        sourceTaskId: task.input.sourceTaskId,
        taskId: task.id,
      });
      continue;
    }
    const base = {
      taskId: task.id,
      taskIds: [task.id],
      origin: 'runtime',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      status: 'saved',
      files: task.outputs,
      hasArtwork: true,
    };
    if (
      task.capabilityId === 'reference-art' &&
      ['generate','import','convert-prop'].includes(task.input.operation)
    ) {
      const primary = task.outputs.find((p) => p.endsWith('/reference.png'));
      if (primary)
        put({
          ...base,
          id: `reference:${task.id}`,
          kind: (task.input.subject === 'prop' || task.input.operation === 'convert-prop') ? 'prop' : 'character',
          title: task.input.name || ((task.input.subject === 'prop' || task.input.operation === 'convert-prop') ? '物品原图' : '角色原图'),
          primary,
          width: result.width,
          height: result.height,
          facing: task.input.facing || 'right',
          editorPath: (task.input.subject === 'prop' || task.input.operation === 'convert-prop')
            ? `${route(manifest, 'interactable-editor')}?artTask=${encodeURIComponent(task.id)}`
            : `${route(manifest, task.capabilityId)}?task=${encodeURIComponent(task.id)}`,
        });
    }
    if (task.capabilityId === 'image-assets' && task.status === 'completed') {
      const primary = task.outputs.find((p) => p.endsWith('/image.png'));
      if (primary && result.kind === 'prop') {
        put({
          ...base,
          id: `image:${task.id}`,
          kind: 'prop',
          title: task.input.name || '透明物品候选',
          primary,
          width: result.width,
          height: result.height,
          provider: result.provider,
          model: result.model,
          requiresAdoption: true,
          editorPath: `${route(manifest, 'interactable-editor')}?imageTask=${encodeURIComponent(task.id)}`,
        });
      }
    }
    if (
      task.capabilityId === 'sprite-generator' &&
      result.jobId &&
      result.jobRecord?.request?.provider !== 'fixture' &&
      !result.jobRecord?.request?.motion_repair &&
      result.jobRecord?.character?.character_id !== 'diagnostic_dummy'
    ) {
      for (const candidate of result.candidates || []) {
        const ci = candidate.candidateIndex;
        const prefix = `/frames/candidate-${String(ci).padStart(2, '0')}/`;
        const frames = task.outputs
          .filter((p) => p.includes(prefix) && p.endsWith('.png'))
          .sort();
        if (!frames.length) continue;
        const exported = result.jobRecord?.export?.candidate_index === ci;
        const preview =
          exported && task.outputs.find((p) => p.endsWith('/preview.gif'));
        const id = `animation:${result.jobId}:${ci}`;
        const previous = assets.get(id);
        const relatedTasks = jobRecords.get(result.jobId) || [];
        put({
          ...base,
          id,
          createdAt: result.jobRecord?.created_at || earliest(previous?.createdAt, ...relatedTasks.map((t) => t.createdAt), task.createdAt),
          taskIds: [...new Set([...(previous?.taskIds || []), ...relatedTasks.map((t) => t.id), task.id])],
          kind: 'animation',
          title: animationTitle(result.jobRecord?.character?.display_name || task.input.characterId, result.jobRecord?.action?.display_name || task.input.actionId),
          jobId: result.jobId,
          characterId: result.jobRecord?.character?.character_id ?? result.jobRecord?.character?.object_id,
          ...(result.jobRecord?.character?.object_id ? { objectId: result.jobRecord.character.object_id, objectType: result.jobRecord.character.object_type || 'character' } : {}),
          actionId: result.jobRecord?.action?.action_id,
          candidateIndex: ci,
          candidateCount: result.candidates.length,
          frameCount: frames.length,
          fps: result.jobRecord?.action?.fps,
          loop: result.jobRecord?.action?.loop,
          primary: preview || frames[0],
          files: [
            ...frames,
            ...(exported
              ? task.outputs.filter((p) =>
                  /\/(preview\.gif|sprite-sheet\.png|sprite-frames\.godot\.zip)$/.test(p),
                )
              : []),
          ],
          status: exported ? 'exported' : candidate.status,
          freshness: 'saved_snapshot',
          editorPath: `${route(manifest, task.capabilityId)}?job=${encodeURIComponent(result.jobId)}&candidate=${ci}`,
        });
      }
    }
    if (
      task.capabilityId === 'interactable-editor' &&
      task.status === 'completed'
    ) {
      const project = task.input.project;
      const primary = task.outputs.find((p) =>
        p.endsWith('/interactable-project.json'),
      );
      if (!project?.projectId || !primary) continue;
      // A full save replaces that project's current object set; subset exports do not remove siblings.
      if (task.input.operation === 'save-project')
        for (const [id, a] of assets)
          if (a.kind === 'interactable' && a.projectId === project.projectId)
            assets.delete(id);
      const selected = task.input.selectedDefinitionIds;
      for (const o of project.objects || []) {
        if (selected?.length && !selected.includes(o.definitionId)) continue;
        const id = `interactable:${project.projectId}:${o.definitionId}`;
        const previous = objectHistory.get(id);
        const history = {
          createdAt: earliest(previous?.createdAt, task.createdAt),
          taskIds: [...new Set([...(previous?.taskIds || []), task.id])],
        };
        objectHistory.set(id, history);
        put({
          ...base,
          ...history,
          id,
          kind: 'interactable',
          projectId: project.projectId,
          definitionId: o.definitionId,
          title: o.displayName || project.name,
          width: o.visual?.width,
          height: o.visual?.height,
          behavior: o.behavior?.kind,
          hasArtwork: Boolean(o.visual?.assetId || o.animated),
          visualAssetId: o.visual?.assetId || null,
          primary,
          status:
            task.input.operation === 'export-godot' ? 'exported' : 'saved',
          editorPath: `${route(manifest, task.capabilityId)}?task=${encodeURIComponent(task.id)}&object=${encodeURIComponent(o.definitionId)}`,
        });
      }
    }
  }
  for (const row of native?.data?.assets || []) {
    if (
      !(['character', 'animation'].includes(row.kind) || (row.kind === 'prop' && row.motionSource === 'state')) ||
      typeof row.id !== 'string'
    )
      continue;
    const previous = assets.get(row.id);
    const editorPath = row.motionSource ? `${route(manifest, 'interactable-motion')}?work=${encodeURIComponent(row.workId)}&version=${row.workRevision}&candidate=${row.candidateIndex}` : row.jobId
      ? `${route(manifest, 'sprite-generator')}?job=${encodeURIComponent(row.jobId)}&candidate=${row.candidateIndex}`
      : row.characterId
        ? `${route(manifest, 'sprite-generator')}?character=${encodeURIComponent(row.characterId)}`
        : undefined;
    put({
      ...previous,
      ...row,
      createdAt: row.createdAt || previous?.createdAt,
      origin: 'sprite-pipeline',
      freshness: 'live',
      nativeId: row.id,
      editorPath,
      taskIds: [...new Set([...(previous?.taskIds || []), ...(jobTasks.get(row.jobId) || [])])],
      files: undefined,
    });
  }
  for (const [characterId, transfer] of transfers) {
    const a = assets.get(`reference:${transfer.sourceTaskId}`);
    const nativeAsset = assets.get(`character:${characterId}`);
    if (a) {
      a.characterId = characterId;
      a.aliases = [`character:${characterId}`];
      a.taskIds.push(transfer.taskId);
      if (nativeAsset) {
        a.relatedNativeId = nativeAsset.id;
        assets.delete(nativeAsset.id);
      }
    }
  }
  for (const record of imported) {
    const metadata = record.metadata || {};
    const payload = record.payload || {};
    const primary = payload.primaryPath || payload.previewPath || payload.framePaths?.[0] || payload.sourcePath || record.files[0]?.path;
    const purpose = record.kind === 'interactable' ? 'interactable' : record.kind === 'animation' ? 'animation' : 'image';
    const target = 'interactable-editor';
    const targetRoute = [...manifest.capabilities, ...(manifest.editorModules || [])].find((capability) => capability.id === target)?.ui.route;
    const files = await Promise.all(record.files.map((file) => importedFile(manifest, record, file.path)));
    const primaryMime = ['prop', 'character'].includes(record.kind) && !metadata.attachmentOnly
      ? await localImageMime(files.find((file) => file.key === primary)) : undefined;
    put({ ...metadata, id: record.id, kind: record.kind,
      primaryMime,
      title: record.label || record.title || '导入素材', origin: 'imported-package', storageBatchKey: record.storageBatchKey,
      createdAt: record.createdAt, updatedAt: record.updatedAt, importedAt: record.createdAt,
      sourceIdentity: record.sourceIdentity, sourceVersion: record.sourceVersion, provenance: record.provenance,
      recovery: record.recovery, contentHash: record.contentHash,
      fps: payload.animation?.fps ?? metadata.fps, loop: payload.animation?.loop ?? metadata.loop,
      frameCount: payload.framePaths?.length || metadata.frameCount,
      projectId: payload.project?.id || metadata.projectId,
      definitionId: metadata.definitionId || payload.project?.definitionIds?.[0],
      status: 'saved', statusLabel: '已导入', taskIds: [], files: record.files.map((file) => file.path), primary,
      hasArtwork: metadata.hasArtwork ?? Boolean(payload.previewPath || payload.framePaths?.length || imageExt.test(primary || '')),
      previewKind: record.kind === 'animation' && payload.framePaths?.length > 1 ? 'animation'
        : imageExt.test(payload.previewPath || primary || '') || record.kind === 'interactable' ? 'image' : 'none',
      availability: files.every((file) => file.available) ? 'available' : 'missing',
      editorPath: targetRoute && !importPurposeIssue({ kind: record.kind, attachmentOnly: metadata.attachmentOnly, primaryMime }, purpose) ? `${targetRoute}?${new URLSearchParams({ importAsset: record.id, importPurpose: purpose })}` : undefined,
    });
  }
  for (const a of assets.values()) {
    if (a.origin === 'runtime') {
      const f = await taskFile(manifest, taskById.get(a.taskId), a.primary);
      a.availability = f.available ? 'available' : 'missing';
      if (['prop', 'character'].includes(a.kind)) a.primaryMime = await localImageMime(f);
      a.previewKind = a.primary.endsWith('.gif')
        ? 'animation'
        : a.kind === 'interactable' ? (a.hasArtwork ? 'image' : 'none')
          : 'image';
    }
    decorate(manifest, a);
  }
  const trash = selection ? { entries: [] } : await readAssetTrash(manifest);
  for (const asset of assets.values()) {
    const entry = trashEntry(trash, asset);
    if (entry) asset.trashedAt = entry.trashedAt;
  }
  for (const entry of trash.entries) {
    if (assetKindEnabled(manifest, entry.asset.kind) && ![...assets.values()].some((asset) => trashEntry({ entries: [entry] }, asset))) {
      assets.set(entry.asset.id, { ...entry.asset, trashedAt: entry.trashedAt, availability: 'unknown', sourceUnavailable: true });
    }
  }
  return {
    assets: [...assets.values()],
    taskById,
    importedById,
    coverage: {
      complete: issues.length === 0,
      runtimeRecords: tasks.length,
      importedAssetRecords: imported.length,
      nativeAvailable: Boolean(native?.data?.assets),
      browserDrafts: 'not_indexed',
      issues,
      note: '已保存的角色、物品、动画和交互物素材会收录。浏览器独有的交互物草稿和下载文件不自动收录。',
    },
  };
}
function publicRow(a) {
  const {
    primary: _primary,
    files: _files,
    nativeId: _nativeId,
    visualAssetId: _visualAssetId,
    storageBatchKey: _storageBatchKey,
    ...row
  } = a;
  return row;
}
export async function listAssets(manifest, input) {
  const q = assetInputs.assets.parse(input);
  const catalog = await scan(manifest);
  const snapshot = hash(
    JSON.stringify(
      catalog.assets.map((a) => [a.id, a.updatedAt, a.status, a.availability, a.trashedAt, a.primaryMime]),
    ) + JSON.stringify(catalog.coverage),
  );
  if (q.snapshot && q.snapshot !== snapshot)
    throw new Error('资产目录已变化，请从第一页重新查询以避免漏项。');
  const rows = catalog.assets.filter(
    (a) =>
      (q.scope === 'trashed' ? Boolean(a.trashedAt) : !a.trashedAt) &&
      (!q.kind || a.kind === q.kind) && (!q.motionSource || a.motionSource === q.motionSource) &&
      (!(q.purposes || q.target) || importPurposes(manifest, a).some((rule) =>
        (!q.purposes || q.purposes.includes(rule.id)) && (!q.target || rule.targets.includes(q.target)))) &&
      (!q.query ||
        `${a.title} ${a.id} ${a.characterId || ''} ${a.objectId || ''} ${a.actionId || ''}`
          .toLowerCase()
          .includes(q.query.toLowerCase())) &&
      [
        'characterId',
        'actionId',
        'candidateIndex',
        'candidateCount',
        'status',
        'availability',
      ].every((k) => q[k] === undefined || a[k] === q[k]),
  );
  rows.sort(
    (a, b) =>
      (b[q.sortBy] || '').localeCompare(a[q.sortBy] || '') ||
      a.id.localeCompare(b.id),
  );
  const next = q.offset + q.limit;
  return {
    schemaVersion: 1,
    assets: rows.slice(q.offset, next).map(publicRow),
    total: rows.length,
    snapshot,
    nextOffset: next < rows.length ? next : null,
    coverage: catalog.coverage,
    createsTask: false,
  };
}
async function detail(manifest, catalog, assetId) {
  const a = catalog.assets.find(
    (a) => a.id === assetId || a.aliases?.includes(assetId),
  );
  if (!a)
    throw new Error(
      catalog.coverage.complete
        ? '所选资产不存在，请重新查询目录。'
        : '当前可读取的目录中未找到该资产；部分来源离线或不可读，不能据此判断资产已删除。',
    );
  if (a.sourceUnavailable) return { ...publicRow(a), files: [], readiness: { filesAvailable: false, issues: ['素材来源暂不可读取，仍可从回收站恢复；恢复不会修复丢失的文件。'] } };
  let fields = {};
  let files;
  if (a.origin === 'sprite-pipeline') {
    fields = (
      await nativeRequest(
        manifest,
        `/v1/artworks/${encodeURIComponent(a.nativeId)}`,
      )
    ).data.asset;
    if (fields.id !== a.id) throw new Error('原生资产身份不匹配。');
    files = fields.files;
  } else if (a.origin === 'imported-package') {
    const record = localRecord(catalog, a);
    files = await Promise.all(record.files.map((file) => importedFile(manifest, record, file.path, true)));
    fields = Object.fromEntries(Object.entries(sourceMetadata(record.metadata || {})).filter(([, value]) => value !== null));
    fields.fps = record.payload?.animation?.fps ?? record.metadata?.fps;
    fields.loop = record.payload?.animation?.loop ?? record.metadata?.loop;
  } else {
    const task = localRecord(catalog, a);
    files = await Promise.all(
      a.files
        .filter(
          (f) => !f.endsWith('/result.json') && !f.includes('diagnostics'),
        )
        .map((f) => taskFile(manifest, task, f, true)),
    );
    const primary = files.find((f) => f.key === a.primary);
    if (primary?.available && imageExt.test(primary.name)) {
      try {
        const m = await sharp(primary.absolutePath).metadata();
        fields = { width: m.width, height: m.height };
      } catch {
        primary.available = false;
        primary.issue = '图片损坏。';
      }
    }
  }
  const issues = [];
  if (['prop', 'character'].includes(a.kind) && !a.attachmentOnly) {
    const primary = files.find((file) => file.key === (a.origin === 'sprite-pipeline' ? 'source' : a.primary));
    fields.primaryMime = null;
    if (primary?.available && primary.bytes <= 64 * 1024 * 1024) {
      try {
        const bytes = await catalogFileBytes(manifest, catalog, a, primary, 64 * 1024 * 1024);
        fields.primaryMime = imageMimeFromHeader(bytes.subarray(0, 16));
        if (fields.primaryMime) primary.mime = fields.primaryMime;
      } catch { /* An unverified source has no eligible image import. */ }
    }
    const issue = importPurposeIssue({ ...a, ...fields }, 'image');
    if (issue) issues.push(issue);
  }
  if (files.some((f) => !f.available))
    issues.push('部分源文件缺失或不可读取。');
  if (a.kind === 'animation' && !a.motionSource && a.status !== 'exported' && a.origin !== 'imported-package')
    issues.push(
      a.status === 'approved'
        ? '动画已检查，尚未导出。'
        : '动画尚未完成检查与导出。',
    );
  if (a.kind === 'interactable' && !a.hasArtwork)
    issues.push('此交互物只有逻辑，尚未绑定外观美术。');
  if (a.origin === 'imported-package') issues.push('来源审核与导出状态仅作来源说明；打开工程会创建本机编辑副本，原文件保留。');
  const importedGodotPath = a.origin === 'imported-package' ? localRecord(catalog, a).payload?.godotPath : undefined;
  const importedGodotAvailable = a.origin === 'imported-package' ? files.some((file) => file.key === importedGodotPath && file.role === 'godot' && file.available) : undefined;
  if (a.origin === 'imported-package' && !importedGodotAvailable) issues.push('未携带可直接交付的 Godot 包；可在工具中打开编辑副本后按现有流程导出。');
  const asset = {
    ...publicRow(a),
    ...fields,
    engineValidated: false,
    history: (a.taskIds || []).map((id) => catalog.taskById.get(id)).filter(Boolean).map((task) => ({
      taskId: task.id,
      operation: task.input.operation,
      createdAt: task.createdAt,
      status: task.status,
      viewPath: `/advanced?tab=records&task=${encodeURIComponent(task.id)}`,
    })),
    files,
    readiness: {
      filesAvailable: files.every((f) => f.available),
      engineValidated: false,
      ...(a.origin === 'imported-package' ? { godotPackageAvailable: importedGodotAvailable } : {}),
      issues,
    },
  };
  asset.revision = hash(
    JSON.stringify({ files: files.map((f) => [f.key, f.sha256 || null, f.available]),
      metadata: sourceMetadata(asset), primaryMime: asset.primaryMime, ...(asset.motionSource ? {motionSource: asset.motionSource, workId: asset.workId, revision: asset.workRevision, stage: asset.stageIndex, token: asset.checkpointToken, state: asset.stateSha256, input: asset.inputSha256, plan: asset.planSha256} : {}), contentHash: a.contentHash ?? null,
      sourceVersion: a.sourceVersion ?? null }),
  );
  return asset;
}
export async function getAsset(manifest, input) {
  const { assetId } = assetInputs.asset.parse(input);
  const catalog = await scan(manifest);
  return {
    asset: await detail(manifest, catalog, assetId),
    coverage: catalog.coverage,
    createsTask: false,
  };
}
export async function assetManifest(manifest, input) {
  const q = assetInputs['asset-manifest'].parse(input);
  const catalog = await scan(manifest);
  const assets = [];
  for (const id of new Set(q.assetIds)) {
    const a = await detail(manifest, catalog, id);
    if (!assets.some((row) => row.id === a.id)) assets.push(a);
  }
  const value = {
    format: 'forge-asset-manifest',
    schemaVersion: 1,
    projectName: q.projectName,
    generatedAt: new Date().toISOString(),
    assets,
    coverage: catalog.coverage,
    engineValidated: false,
  };
  const escape = (s) => String(s).replace(/[\r\n|<>]/g, ' ');
  const markdown =
    `# ${escape(q.projectName)}\n\n${assets.length} 件已选资产。清单引用已有文件；未复制素材或验证游戏引擎。\n\n| 资产 | 类型 | 状态 | 文件 | 待处理 |\n| --- | --- | --- | --- | --- |\n` +
    assets
      .map(
        (a) =>
          `| ${escape(a.title)}${a.candidateIndex ? ` · 候选 ${a.candidateIndex}` : ''} | ${a.kind} | ${escape(a.statusLabel)} | ${a.files.filter((f) => f.available).length}/${a.files.length} | ${escape(a.readiness.issues.join('；')) || '—'} |`,
      )
      .join('\n') +
    '\n\n' +
    catalog.coverage.note +
    '\n';
  return {
    manifest: value,
    markdown,
    createsTask: false,
    summary: `已整理 ${assets.length} 件资产的交接清单；未修改源文件。`,
  };
}
export async function readAssetPreview(manifest, assetId, { task, batch } = {}) {
  const [kind, identity] = assetId.split(':');
  let selection;
  if (kind === 'imported') {
    const record = await readImportedAsset(repositoryRoot, assetId, manifest, batch);
    selection = { tasks: [], imported: record ? [record] : [] };
  } else if (task || kind === 'reference' || kind === 'image') {
    const id = task || identity;
    if (!safeId(id)) throw new Error('资产任务身份无效。');
    const dir = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
    const saved = await readProjection(await confined(dir, path.join(dir, id + '.json')), 64 * 1024 * 1024, catalogTask);
    if (saved.id !== id) throw new Error('资产任务身份不匹配。');
    selection = { tasks: [saved], imported: [] };
  } else {
    const nativeKind = { character: 'character', animation: 'animation', 'motion-state': 'prop', 'motion-transition': 'animation' }[kind];
    if (nativeKind || kind === 'motion-derived') {
      const c = connection(manifest);
      try {
        if (nativeKind) requireAssetKind(manifest, nativeKind);
        else if (!assetKindEnabled(manifest, 'prop') || !assetKindEnabled(manifest, 'animation')) {
          const detail = await nativeRequest(manifest, '/v1/artworks/' + encodeURIComponent(assetId));
          requireAssetKind(manifest, detail.data.asset.kind);
        }
        const result = await requestBinary(endpointUrl(c.base, '/v1/artworks/file?' + new URLSearchParams({ asset_id: assetId, key: 'preview' })),
          { headers: c.headers, maxBytes: 40 * 1024 * 1024, timeoutMs: 10000 });
        if (!/^image\/(png|gif|jpeg|webp)(;|$)/i.test(result.contentType)) throw new Error('不是可预览的图片。');
        return { bytes: result.buffer, mime: result.contentType };
      } catch (error) {
        // Old animation links may refer to a locally materialized Job while Python is offline.
        if (kind !== 'animation' || (error.status && error.status !== 404 && error.status < 500)) throw error;
      }
    } else if (kind !== 'interactable') throw new Error('资产预览不存在。');
    selection = { imported: [] };
  }
  const catalog = await scan(manifest, selection);
  const a = catalog.assets.find(row => row.id === assetId);
  if (!a) throw new Error('资产预览不存在。');
  if (a.origin === 'imported-package' && a.kind !== 'interactable') {
    const record = localRecord(catalog, a);
    if (a.kind === 'animation' && record.payload?.framePaths?.length > 1 && record.payload.framePaths.length <= 256) {
      const frameFiles = await Promise.all(record.payload.framePaths.map(framePath => importedFile(manifest, record, framePath)));
      if (frameFiles.every(file => file.available) && frameFiles.reduce((total, file) => total + file.bytes, 0) <= 64 * 1024 * 1024) {
        const frames = [];
        const registered = new Map(record.files.map(file => [file.path, file.sha256]));
        for (const file of frameFiles) {
          const bytes = await readFile(file.absolutePath);
          if (hash(bytes) !== registered.get(file.key)) break;
          frames.push(await sharp(bytes, { limitInputPixels: 32_000_000 })
            .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).png().toBuffer());
        }
        const fps = record.payload.animation?.fps;
        if (frames.length === frameFiles.length && Number.isFinite(fps) && fps > 0 && typeof record.payload.animation?.loop === 'boolean') {
          const durations = record.metadata?.frameDurations;
          const delay = frames.map((_, index) => Math.max(10, Math.round((durations?.[index] || 1) * 1000 / fps)));
          return { bytes: await sharp(frames, { join: { animated: true } }).gif({ loop: record.payload.animation.loop ? 0 : 1, delay }).toBuffer(), mime: 'image/gif' };
        }
      }
    }
    const previewPath = record.payload?.previewPath || record.payload?.framePaths?.[0] || record.payload?.primaryPath;
    if (previewPath && imageExt.test(previewPath)) {
      const file = record.files.find(file => file.path === previewPath);
      if (!file) throw new Error('导入素材预览未登记。');
      return { bytes: await catalogFileBytes(manifest, catalog, a, { key: file.path, sha256: file.sha256 }), mime: file.mime || mimeForName(file.path) };
    }
    throw new Error('此导入素材没有可读取的图片预览。');
  }
  if (a.kind === 'interactable') {
    const file = await localFile(manifest, catalog, a, a.origin === 'imported-package' ? localRecord(catalog, a).payload?.sourcePath || a.primary : a.primary, a.origin === 'imported-package');
    if (!file.available) throw new Error('交互物源文件不可读取。');
    const project = await readJson(file.absolutePath);
    const object = project.objects?.find(o => o.definitionId === a.definitionId);
    const clip = object?.visual?.clips?.find(c => c.name === object.visual.idleAnimation);
    const frame = clip?.frames?.[0];
    const asset = project.assets?.find(image => image.id === (frame?.assetId || object?.visual?.assetId));
    // Preview portable embedded images only; never follow project-supplied filesystem paths.
    const match = asset && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(asset.source);
    if (!match || match[1] !== asset.mime) throw new Error('此交互物没有可读取的内嵌图片。');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 64*1024*1024 || (asset.generation && hash(bytes)!==asset.generation.sha256)) throw new Error('交互物图片内容无效或已变化。');
    let image = sharp(bytes, {limitInputPixels: 32_000_000});
    if (frame?.region) {
      const {x,y,width,height} = frame.region;
      if (![x,y,width,height].every(Number.isInteger)||x<0||y<0||width<1||height<1) throw new Error('动画预览区域无效。');
      image = image.extract({left:x,top:y,width,height});
    }
    return {bytes: await image.resize({width:256,height:256,fit:'inside',withoutEnlargement:true}).png().toBuffer(),mime:'image/png'};
  }
  if (!imageExt.test(a.primary)) throw new Error('此资产没有图像预览。');
  const f = await taskFile(manifest, localRecord(catalog, a), a.primary);
  if (!f.available) throw new Error('资产图片缺失。');
  return {
    bytes: await readFile(f.absolutePath),
    mime: a.primary.endsWith('.gif') ? 'image/gif' : 'image/png',
  };
}

// Download saved material bytes; this does not run the production/export adapter.
function archiveFiles(asset, source) {
  return asset.files.flatMap((file) => {
    let name;
    if (source.origin === 'imported-package') return [{ file, name: file.key.replace(/^(character|prop|animation|interactable)\/[^/]+\/(.+)$/, '$2') }];
    if (asset.kind === 'animation') {
      const frame =
        /^frame-(\d+)$/.exec(file.key) ||
        (source.origin === 'runtime'
          ? /^frame[_-](\d+)\.png$/i.exec(file.name)
          : null);
      if (frame && file.key !== 'source')
        name = `frames/frame_${frame[1].padStart(3, '0')}.png`;
      else if (file.key === 'sheet' || file.name === 'sprite-sheet.png')
        name = 'export/sprite-sheet.png';
      else if (file.key === 'export-preview') name = 'export/preview.gif';
      else if (file.key === 'godot' || file.name === 'sprite-frames.godot.zip') name = 'godot/sprite-frames.zip';
      else if (file.key === 'recipe') name = 'export/recipe.json';
      else if (file.name.endsWith('.gif')) name = 'preview.gif';
    } else if (asset.kind === 'character' || asset.kind === 'prop') {
      if (file.key === 'source' || file.key === source.primary)
        name = `${asset.kind === 'character' ? 'reference' : 'prop'}${path.extname(file.name).toLowerCase()}`;
    } else if (asset.kind === 'interactable') {
      if (
        file.name.endsWith('.zip') ||
        file.name === 'interactable-project.json' ||
        imageExt.test(file.name)
      )
        name = file.name;
    }
    return name ? [{ file, name }] : [];
  });
}
function mimeForName(name) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json', '.zip': 'application/zip' })[path.extname(name).toLowerCase()] || 'application/octet-stream';
}
function archiveRole(asset, file, name) {
  if (file.role) return file.role;
  if (name.startsWith('frames/')) return 'frame';
  if (/godot|sprite-frames\.zip/.test(name)) return 'godot';
  if (name.includes('sprite-sheet')) return 'sheet';
  if (name.includes('preview')) return 'preview';
  if (name.endsWith('recipe.json')) return 'export-recipe';
  if (/source\.zip$|state\.zip$|interactable-project\.json$/.test(name)) return 'source';
  if (asset.kind === 'character') return 'reference';
  if (imageExt.test(name)) return 'image';
  return 'attachment';
}

export async function buildAssetArchive(manifest, input) {
  const { assetIds } = assetInputs['asset-manifest'].parse(input);
  const catalog = await scan(manifest);
  const zip = new JSZip();
  const archiveManifest = { format: 'forge-asset-archive', version: 1, packageId: `archive:${randomUUID()}`, exportedAt: new Date().toISOString(), entries: [] };
  const seen = new Set();
  const lines = [
    'Forge 素材包',
    '',
    '每个文件夹对应一件所选资产。PNG 帧按文件名顺序播放；已有引擎包可另行解压。',
    '这些是当前保存的素材，下载不会执行生成、审核或引擎导出。',
    '',
  ];
  let totalBytes = 0;
  let fileCount = 0;
  const maxMB = 128;
  const maxBytes = maxMB * 1024 * 1024;
  for (const id of new Set(assetIds)) {
    const asset = await detail(manifest, catalog, id);
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    const source = catalog.assets.find((a) => a.id === asset.id);
    const files = archiveFiles(asset, source);
    const title = `${asset.title}${asset.candidateIndex ? ` · 候选 ${asset.candidateIndex}` : ''}`;
    if (!files.length)
      throw new Error(
        `${title}：暂无可下载的素材文件，请回到原工具保存或导出。`,
      );
    const label =
      title
        .replace(/[^\p{L}\p{N} _·（）()-]/gu, '_')
        .slice(0, 60)
        .replace(/[. ]+$/, '') || 'asset';
    const folder = `${asset.kind}/${label}-${hash(asset.id).slice(0, 8)}`;
    const names = new Set();
    const manifestFiles = [];
    for (const { file, name } of files) {
      if (!file.available || !file.sha256)
        throw new Error(
          `${title}：${file.name} 缺失或不可读取，请检查源文件后重试。`,
        );
      if (totalBytes + file.bytes > maxBytes)
        throw new Error(`所选素材超过 ${maxMB} MB，请减少选择后分批下载。`);
      const bytes = await catalogFileBytes(manifest, catalog, source, file, maxBytes - totalBytes);
      if (hash(bytes) !== file.sha256)
        throw new Error(`${title}：文件在打包期间发生变化，请刷新后重新下载。`);
      totalBytes += bytes.length;
      if (totalBytes > maxBytes)
        throw new Error(`所选素材超过 ${maxMB} MB，请减少选择后分批下载。`);
      // Entry names are derived from known roles, never filesystem paths supplied by a client.
      if (
        name.includes('..') ||
        name.includes('\\') ||
        name.startsWith('/') ||
        names.has(name)
      )
        throw new Error('素材文件名称冲突，请回到原工具检查。');
      names.add(name);
      zip.file(`${folder}/${name}`, bytes);
      manifestFiles.push({ path: `${folder}/${name}`, role: archiveRole(asset, file, name), bytes: bytes.length, mime: file.mime || mimeForName(name), sha256: file.sha256 });
      fileCount++;
    }
    const record = source.origin === 'imported-package' ? localRecord(catalog, source) : null;
    const metadata = sourceMetadata(asset);
    if (asset.kind === 'animation') metadata.frameOrder = files.filter(({ name, file }) => archiveRole(asset, file, name) === 'frame')
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(({ name }) => `${folder}/${name}`);
    if (Array.isArray(metadata.animationRepresentations)) metadata.animationRepresentations = metadata.animationRepresentations.map((representation) => {
      const named = (key) => files.find(({ file }) => file.key === key)?.name;
      return { ...representation,
        ...(representation.frameKeys ? { framePaths: representation.frameKeys.map(named).filter(Boolean).map((name) => `${folder}/${name}`) } : {}),
        ...(named(representation.sheetKey) ? { sheetPath: `${folder}/${named(representation.sheetKey)}` } : {}),
        ...(named(representation.godotKey) ? { godotPath: `${folder}/${named(representation.godotKey)}` } : {}) };
    });
    if (record?.payload?.project) metadata.project = record.payload.project;
    archiveManifest.entries.push({ key: `asset-${archiveManifest.entries.length + 1}`, kind: asset.kind,
      title: asset.title,
      sourceIdentity: record?.sourceIdentity || { assetId: asset.id, origin: asset.origin },
      sourceVersion: record?.sourceVersion || asset.revision,
      metadata, files: manifestFiles,
      provenance: { ...record?.provenance, createdAt: record?.provenance?.createdAt ?? asset.createdAt ?? null, updatedAt: record?.provenance?.updatedAt ?? asset.updatedAt ?? null,
        sourceStatus: record?.provenance?.sourceStatus || { value: asset.status || null, label: asset.statusLabel || null, engineValidated: false },
        downloadedAssetId: asset.id, downloadedRevision: asset.revision } });
    const info = [
      title,
      `状态：${asset.statusLabel}`,
      asset.width ? `尺寸：${asset.width} × ${asset.height}` : '',
      asset.frameCount ? `帧数：${asset.frameCount}` : '',
      asset.fps ? `播放速度：${asset.fps} FPS` : '',
      typeof asset.loop === 'boolean' ? `循环播放：${asset.loop ? '是' : '否'}` : '',
      ...(asset.readiness?.issues || []),
    ]
      .filter(Boolean)
      .join('\n');
    zip.file(`${folder}/素材说明.txt`, info + '\n');
    lines.push(`${folder} — ${files.length} 个素材文件`);
  }
  zip.file('使用说明.txt', lines.join('\n') + '\n');
  zip.file('forge-assets.json', JSON.stringify(archiveManifest, null, 2));
  return {
    bytes: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE',
    }),
    filename: 'forge-assets.zip',
    assetCount: seen.size,
    fileCount,
  };
}

// Internal reuse copies verified source bytes only; it never exports, approves or generates.
export async function readAssetGodotPackage(manifest, {assetId, revision}) {
  const catalog = await scan(manifest);
  const asset = await detail(manifest, catalog, assetId);
  const source = catalog.assets.find(a=>a.id===asset.id);
  if (asset.revision !== revision) throw new Error('资产版本已变化，请刷新后重新选择。');
  const importedGodotPath = source.origin === 'imported-package' ? localRecord(catalog, source).payload?.godotPath : undefined;
  const candidates = asset.files.filter(f=> source.origin === 'imported-package'
    ? f.key === importedGodotPath && f.role === 'godot'
    : f.name.endsWith('.zip') && (f.key==='godot' || /godot|interactable/i.test(f.name)) && !/source|state/i.test(f.name));
  if (candidates.length !== 1) throw new Error('此资产还没有唯一的 Godot 包，请先回原工具导出；不会自动生成或审批。');
  const file = candidates[0];
  if (!file.available || !file.sha256 || file.bytes>256*1024*1024) throw new Error('Godot 包缺失或超过 256 MB。');
  const bytes = await catalogFileBytes(manifest, catalog, source, file, 256 * 1024 * 1024);
  if (hash(bytes)!==file.sha256) throw new Error('Godot 包已改变，请重新选择。');
  return {bytes,title:asset.title,source:{assetId:asset.id,revision:asset.revision,kind:asset.kind,candidateIndex:asset.candidateIndex,sha256:file.sha256}};
}

// Editable copies receive local identities; stored package bytes and provenance stay immutable.
async function editablePackageCopy(bytes, purpose, identityMap, definitionIds) {
  const allocate = (oldId, prefix) => {
    if (!oldId) return oldId;
    const key = `${prefix}:${oldId}`;
    return identityMap[key] ||= `${prefix}_${randomUUID().replaceAll('-', '')}`;
  };
  if (purpose === 'interactable') {
    const project = JSON.parse(bytes.toString('utf8'));
    if (definitionIds?.length) {
      if (definitionIds.some((id) => !project.objects.some((object) => object.definitionId === id))) throw new Error('所选物件不在源项目中。');
      project.objects = project.objects.filter((object) => definitionIds.includes(object.definitionId));
    }
    project.projectId = allocate(project.projectId, 'project');
    return Buffer.from(JSON.stringify(project));
  }
  return bytes;
}

export async function readConfirmedMotionAsset(manifest, input) {
  const catalog = await scan(manifest);
  const asset = await detail(manifest, catalog, input.assetId);
  const source = catalog.assets.find(a => a.id === input.assetId);
  if (source?.origin !== 'sprite-pipeline' || !['state', 'transition'].includes(asset.motionSource))
    throw new Error('请选择状态链中已确认的状态图或过渡。');
  if (asset.revision !== input.assetRevision) throw Object.assign(new Error('所选状态链素材版本已变化，请重新选择。'), {status:409, code:'ASSET_REVISION_CONFLICT'});
  const keys = asset.motionSource === 'state' ? ['source'] : Array.from({length:asset.frameCount}, (_, i) => 'frame-' + i);
  if (!keys.length || keys.length > 64 || (asset.motionSource === 'transition' && !(asset.fps >= 0.1 && asset.fps <= 120 && asset.loop === false)))
    throw new Error('已确认过渡的播放范围或速度无效。');
  const frames = [];
  for (const key of keys) {
    const file = asset.files.find(f => f.key === key);
    if (!file?.available) throw new Error('已确认的状态链帧缺失。');
    frames.push({bytes:await catalogFileBytes(manifest, catalog, source, file, 1024*1024), sha256:file.sha256});
  }
  if (frames.at(-1).sha256 !== asset.stateSha256) throw new Error('状态图与已确认的末帧不一致。');
  return {asset, frames};
}

export async function buildAssetImport(manifest, input) {
  const { assetId, purpose, revision } = assetImportInput.parse(input);
  const catalog = await scan(manifest);
  const asset = await detail(manifest, catalog, assetId);
  const source = catalog.assets.find((a) => a.id === asset.id);
  if (!importPurposes(manifest, asset).some((rule) => rule.id === purpose)) throw new Error(importPurposeIssue(asset, purpose) || '此素材不能用于所选导入方式。');
  if (asset.revision !== revision) throw new Error('素材版本已变化，请刷新资产库后重新选择。');
  const candidates = archiveFiles(asset, source);
  const importedRecord = source.origin === 'imported-package' ? localRecord(catalog, source) : null;
  let selected = [];
  if (importedRecord) {
    const paths = purpose === 'animation' ? importedRecord.payload?.framePaths : [purpose === 'image'
      ? importedRecord.payload?.primaryPath : importedRecord.payload?.sourcePath || importedRecord.payload?.primaryPath];
    selected = (paths || []).map((filePath) => candidates.find((candidate) => candidate.file.key === filePath)).filter(Boolean);
    if (purpose === 'animation' && (!Number.isFinite(asset.fps) || asset.fps <= 0 || typeof asset.loop !== 'boolean')) throw new Error('动画缺少明确的播放速度或循环设置。');
  } else if (purpose === 'interactable') selected = candidates.filter((f) => f.file.name === 'interactable-project.json');
  else if (purpose === 'animation') {
    selected = candidates.filter((f) => f.name.startsWith('frames/')).sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!Number.isFinite(asset.fps) || asset.fps <= 0 || typeof asset.loop !== 'boolean') throw new Error('动画缺少明确的播放速度或循环设置，请回原工具保存完整结果。');
  } else selected = candidates.filter((f) => (f.file.key === source.primary || f.file.key === 'source') && imageExt.test(f.file.name)).slice(0,1);
  if (!selected.length) throw new Error('素材缺少可复用的源文件，请回原工具保存完整源项目。');
  const zip = new JSZip();
  const entries = [];
  const identityMap = {};
  let total = 0;
  for (const { file, name } of selected) {
    if (!file.available || !file.sha256) throw new Error('所选素材文件缺失，不能导入。');
    if (file.bytes > 256 * 1024 * 1024 || total + file.bytes > 256 * 1024 * 1024) throw new Error('导入素材超过 256 MB，请分批处理。');
    let bytes = await catalogFileBytes(manifest, catalog, source, file, 256 * 1024 * 1024);
    if (hash(bytes) !== file.sha256) throw new Error('素材文件在导入期间已变化，请重新选择。');
    if (importedRecord) bytes = await editablePackageCopy(bytes, purpose, identityMap, importedRecord.payload?.project?.definitionIds);
    total += bytes.length;
    if (total > 256 * 1024 * 1024) throw new Error('导入素材超过 256 MB。');
    const entryPath = 'files/' + name;
    if (entryPath.includes('..') || entryPath.includes('\\') || entries.some((f) => f.path === entryPath)) throw new Error('素材文件名称无效。');
    zip.file(entryPath, bytes);
    entries.push({ path: entryPath, name: file.name, mime: purpose === 'image' ? asset.primaryMime : file.mime || mimeForName(file.name), sha256: hash(bytes), sourceSha256: file.sha256 });
  }
  const metadata = { format: 'forge-asset-import', version: 1, purpose, asset: {
    id: asset.id, revision: asset.revision, kind: asset.kind, title: asset.title, primaryMime: asset.primaryMime,
    taskId: asset.taskId, projectId: identityMap[`project:${asset.projectId}`] || asset.projectId, definitionId: asset.definitionId,
    candidateIndex: asset.candidateIndex, fps: asset.fps, loop: asset.loop, width: asset.width, height: asset.height,
    ...(asset.objectId != null ? { objectId: asset.objectId, objectType: asset.objectType } : {}),
    frameDurations: asset.frameDurations, anchor: asset.anchor, sourceFacing: asset.sourceFacing || asset.facing,
    ...(importedRecord?.payload?.project?.definitionIds ? { definitionIds: importedRecord.payload.project.definitionIds } : {}),
  }, files: entries, ...(importedRecord ? { editableCopy: { identityMap, sourceIdentity: importedRecord.sourceIdentity, sourceVersion: importedRecord.sourceVersion, sourceAssetId: asset.id, sourceRevision: asset.revision } } : {}) };
  zip.file('import.json', JSON.stringify(metadata));
  return { bytes: await zip.generateAsync({type:'nodebuffer',compression:'STORE'}), filename: 'forge-import.zip' };
}

// Management never prepares a production task or modifies shared source files.
export async function manageAssets(manifest, input) {
  const { operation, assetIds } = assetInputs['asset-manage'].parse(input);
  return updateAssetTrash(manifest, async (index) => {
    const needsCatalog = operation === 'trash' || assetIds.some((id) => !index.entries.some((entry) => entry.ids.includes(id)));
    const catalog = needsCatalog ? await scan(manifest) : null;
    const selected = [...new Set(assetIds)].map((id) => {
      const current = catalog?.assets.find((asset) => asset.id === id || asset.aliases?.includes(id));
      const entry = index.entries.find((entry) => entry.ids.includes(id)) || (current && trashEntry(index, current));
      if (operation === 'restore') {
        if (!entry) throw new Error('所选资产不在回收站，请刷新后重试。');
        requireAssetKind(manifest, entry.asset.kind);
        return entry.asset;
      }
      const asset = current;
      if (!asset) throw new Error('所选资产当前不可读取，请刷新并核对选择；未更改回收站。');
      return asset;
    });
    const unique = [...new Map(selected.map((asset) => [asset.id, asset])).values()];
    for (const asset of unique) {
      const entry = trashEntry(index, asset);
      if (operation === 'restore') index.entries = index.entries.filter((item) => item !== entry);
      else if (!entry) index.entries.push({ ids: [asset.id, ...(asset.aliases || [])], trashedAt: new Date().toISOString(), asset: publicRow(asset) });
    }
    return { operation, assetIds: unique.map((asset) => asset.id), count: unique.length, createsTask: false, sourceFilesChanged: false };
  });
}
