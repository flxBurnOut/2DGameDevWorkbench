import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { repositoryRoot, findCapability } from './runtime.mjs';
import {
  endpointUrl,
  bearerHeaders,
  requestJson,
  requestBinary,
} from './adapters/http.mjs';
import { listMapProjectRecords, readMapProjectPreview } from './map-projects.mjs';
import { readAssetTrash, trashEntry, updateAssetTrash } from './asset-trash.mjs';
import { assetInputs } from './asset-contract.mjs';
import { assetImportInput, importPurposes } from './asset-import-contract.mjs';
import { listImportedAssets, resolveImportedAssetFile } from './asset-packages-store.mjs';
import { readScenePackage, createScenePackage } from '../../features/scene-composer/package.mjs';

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
  manifest.capabilities.find((c) => c.id === capabilityId)?.ui?.route;
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
    const maxBytes = (task.exportId || task.projectId) ? 512 * 1024 * 1024 : 64 * 1024 * 1024;
    if (!info.isFile() || info.size > maxBytes)
      throw new Error('文件不可读取。');
    Object.assign(entry, {
      available: true,
      bytes: info.size,
      absolutePath: resolved,
    });
    if (withHash || task.projectId) {
      entry.sha256 = hash(await readFile(resolved));
      if (task.projectId && entry.sha256 !== task.sha256) throw new Error('地图工程文件已变化。');
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
const metadataKeys = ['width', 'height', 'facing', 'fps', 'loop', 'frameCount', 'candidateIndex', 'candidateCount', 'characterId', 'actionId', 'jobId', 'productionRevision', 'definitionId', 'definitionIds', 'projectId', 'projectRevision', 'sceneId', 'sceneRevision', 'exportId', 'tileCount', 'instanceCount', 'materialCount', 'mapName', 'anchor', 'sourceFacing', 'frameDurations', 'animationRepresentations'];
const sourceMetadata = (asset) => Object.fromEntries(metadataKeys.map((key) => [key, asset[key] ?? null]));
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
      const task = await readJson(
        await confined(directory, path.join(directory, entry.name)),
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
// Scene exports have their own durable records, not fabricated production tasks.
async function sceneRecords(manifest, issues) {
  const directory = path.resolve(repositoryRoot, manifest.workspace.sceneExportDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') issues.push({ source: 'scene-exports', message: '场景导出目录暂不可读。' });
    return [];
  }
  const rows = [];
  for (const entry of entries.filter((e) => e.isFile() && /^scene-export-[a-z0-9_-]+\.json$/i.test(e.name))) {
    try {
      const record = await readJson(await confined(directory, path.join(directory, entry.name)), 1024 * 1024);
      if (!safeId(record.exportId) || entry.name !== `${record.exportId}.json` ||
          typeof record.sceneId !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(record.sceneId) ||
          !Number.isInteger(record.revision) || record.revision < 0 || record.status !== 'completed' ||
          !Array.isArray(record.outputs) || !record.outputs.every((p) => typeof p === 'string')) throw new Error();
      const files = ['scene-source.zip', 'scene-godot.zip'].map((name) => `${manifest.workspace.outputDirectory}/${record.exportId}/${name}`);
      if (!files.every((f) => record.outputs.includes(f))) throw new Error();
      rows.push({ ...record, id: record.exportId, outputs: files });
    } catch {
      issues.push({ source: 'scene-exports', record: entry.name, message: '场景导出记录损坏或身份不匹配。' });
    }
  }
  return rows.sort((a, b) => a.exportId.localeCompare(b.exportId));
}

async function sceneMetadata(manifest, record) {
  if (typeof record.sceneName === 'string') return record;
  // Legacy exports did not persist display metadata. Read it from their saved source ZIP.
  const file = await taskFile(manifest, record, record.outputs[0]);
  if (!file.available) return {};
  const zip = await JSZip.loadAsync(await readFile(file.absolutePath));
  const source = zip.file('scene.json');
  if (!source || source._data.uncompressedSize > 8 * 1024 * 1024) throw new Error('场景元数据不可读取。');
  const scene = JSON.parse(await source.async('string'));
  if (scene.format !== 'workbench-scene' || scene.id !== record.sceneId || scene.revision !== record.revision) throw new Error('场景身份不匹配。');
  return {
    sceneName: typeof scene.name === 'string' ? scene.name : undefined,
    instanceCount: Array.isArray(scene.instances) ? scene.instances.length : undefined,
    materialCount: Array.isArray(scene.materials) ? scene.materials.length : undefined,
    mapName: typeof scene.map?.name === 'string' ? scene.map.name : undefined,
  };
}

function localRecord(catalog, asset) {
  return asset.origin === 'imported-package' ? catalog.importedById.get(asset.id) : asset.origin === 'map-project' ? catalog.mapById.get(asset.projectId) : asset.origin === 'scene-export'
    ? catalog.sceneById.get(asset.exportId)
    : catalog.taskById.get(asset.taskId);
}

const earliest = (...values) => values.filter((v) => typeof v === 'string' && v).sort((a, b) => a.localeCompare(b))[0];

function decorate(manifest, asset) {
  asset.viewPath = `${manifest.agentAssets.assetCatalog.route}?asset=${encodeURIComponent(asset.id)}`;
  asset.viewUrl = new URL(asset.viewPath, manifest.workspace.frontend.url).href;
  asset.previewUrl = `/api/workbench/assets/preview?assetId=${encodeURIComponent(asset.id)}`;
  if (asset.origin === 'map-project') asset.previewUrl += `&projectRevision=${asset.projectRevision}`;
  asset.statusLabel ||= statusLabels[asset.status] || '请查看详情';
  asset.engineValidated = false;
  return asset;
}
async function scan(manifest) {
  const issues = [];
  const assets = new Map();
  const tasks = await records(manifest, issues);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const scenes = await sceneRecords(manifest, issues);
  const imported = await listImportedAssets(repositoryRoot, manifest);
  const importedById = new Map(imported.map((record) => [record.id, record]));
  const maps = await listMapProjectRecords(repositoryRoot, manifest, issues);
  const mapById = new Map(maps.map((m) => [m.projectId, m]));
  const sceneById = new Map(scenes.map((s) => [s.exportId, s]));
  const native = await nativeRequest(manifest, '/v1/artworks').catch(
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
  const put = (a) => assets.set(a.id, a);
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
          result = await readJson(f.absolutePath, 8 * 1024 * 1024);
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
      ['generate','import'].includes(task.input.operation)
    ) {
      const primary = task.outputs.find((p) => p.endsWith('/reference.png'));
      if (primary)
        put({
          ...base,
          id: `reference:${task.id}`,
          kind: task.input.subject === 'prop' ? 'prop' : 'character',
          title: task.input.name || (task.input.subject === 'prop' ? '物品原图' : '角色原图'),
          primary,
          width: result.width,
          height: result.height,
          facing: task.input.facing || 'right',
          editorPath: task.input.subject === 'prop'
            ? `${route(manifest, 'interactable-editor')}?artTask=${encodeURIComponent(task.id)}`
            : `${route(manifest, task.capabilityId)}?task=${encodeURIComponent(task.id)}`,
        });
    }
    if (task.capabilityId === 'image-assets' && task.status === 'completed') {
      const primary = task.outputs.find((p) => p.endsWith('/image.png'));
      if (primary && ['background', 'prop'].includes(result.kind)) {
        const prop = result.kind === 'prop';
        put({
          ...base,
          id: `image:${task.id}`,
          kind: prop ? 'prop' : 'map',
          ...(prop ? {} : { mapType: 'image' }),
          title: task.input.name || (prop ? '透明物品候选' : '背景候选'),
          primary,
          width: result.width,
          height: result.height,
          provider: result.provider,
          model: result.model,
          requiresAdoption: true,
          editorPath: `${route(manifest, prop ? 'interactable-editor' : 'map-stitcher')}?imageTask=${encodeURIComponent(task.id)}`,
        });
      }
    }
    if (task.capabilityId === 'map-stitcher') {
      for (const primary of task.outputs.filter((p) =>
        /\/(stitched-map|generated-origin|generated-layer)\.png$/.test(p),
      )) {
        put({
          ...base,
          id: `map:${task.id}:${path.basename(primary, '.png')}`,
          kind: 'map',
          mapType: 'image',
          title:
            task.input.name ||
            (primary.endsWith('generated-origin.png')
              ? '地图原图'
              : primary.endsWith('generated-layer.png')
                ? '地图扩图'
                : '拼接地图'),
          primary,
          width: result.width || result.metadata?.width,
          height: result.height || result.metadata?.height,
          manualWorkflow: true,
          editorPath: route(manifest, task.capabilityId),
          status: 'saved',
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
          title: `${result.jobRecord?.character?.display_name || task.input.characterId || '角色'} · ${result.jobRecord?.action?.display_name || task.input.actionId || '动作'}`,
          jobId: result.jobId,
          characterId: result.jobRecord?.character?.character_id,
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
          hasArtwork: Boolean(o.visual?.assetId || o.visual?.clips?.some(clip => clip.frames?.length)),
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
      !['character', 'animation'].includes(row.kind) ||
      typeof row.id !== 'string'
    )
      continue;
    const previous = assets.get(row.id);
    const editorPath = row.jobId
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
  for (const record of maps) {
    const files = await Promise.all(record.outputs.map((file) => taskFile(manifest, record, file)));
    const previewAvailable = record.preview && await readMapProjectPreview(repositoryRoot, manifest, record).then(() => true, () => false);
    put({ id: `map-project:${record.projectId}`, kind: 'map', mapType: 'project', origin: 'map-project',
      projectId: record.projectId, projectRevision: record.revision, title: record.title,
      tileCount: record.tileCount, createdAt: record.createdAt, updatedAt: record.updatedAt,
      status: 'saved', files: record.outputs, primary: record.outputs[0], hasArtwork: true,
      previewKind: previewAvailable ? 'image' : 'none', availability: files.every((f) => f.available) ? 'available' : 'missing',
      manualWorkflow: true, taskIds: [],
      editorPath: `${route(manifest, 'map-stitcher')}?map=${encodeURIComponent(record.projectId)}&saved=1`,
    });
  }
  for (const record of scenes) {
    let metadata = {};
    try { metadata = await sceneMetadata(manifest, record); }
    catch { issues.push({ source: 'scene-exports', record: record.exportId, message: '场景源包元数据不可读取，请检查源文件。' }); }
    const files = await Promise.all(record.outputs.map((file) => taskFile(manifest, record, file)));
    put({
      id: `scene:${record.exportId}`,
      kind: 'scene',
      origin: 'scene-export',
      exportId: record.exportId,
      sceneId: record.sceneId,
      sceneRevision: record.revision,
      title: metadata.sceneName || `完整场景 · ${record.sceneId}`,
      instanceCount: metadata.instanceCount,
      materialCount: metadata.materialCount,
      mapName: metadata.mapName,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      status: 'exported',
      files: record.outputs,
      primary: record.outputs[0],
      hasArtwork: true,
      previewKind: 'none',
      availability: files.every((f) => f.available) ? 'available' : 'missing',
      taskIds: [],
    });
  }
  for (const record of imported) {
    const metadata = record.metadata || {};
    const payload = record.payload || {};
    const primary = payload.primaryPath || payload.previewPath || payload.framePaths?.[0] || payload.sourcePath || record.files[0]?.path;
    const purpose = record.kind === 'map' ? 'map' : record.kind === 'scene' ? 'scene' : record.kind === 'interactable' ? 'interactable' : record.kind === 'animation' ? 'animation' : 'image';
    const target = record.kind === 'map' ? 'map-stitcher' : record.kind === 'scene' ? 'scene-composer' : 'interactable-editor';
    const targetRoute = [...manifest.capabilities, ...(manifest.editorModules || [])].find((capability) => capability.id === target)?.ui.route;
    put({ ...metadata, id: record.id, kind: record.kind, mapType: record.mapType || metadata.mapType,
      title: record.label || record.title || '导入素材', origin: 'imported-package',
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
        : imageExt.test(payload.previewPath || primary || '') || record.kind === 'interactable' || record.mapType === 'project' ? 'image' : 'none',
      availability: (await Promise.all(record.files.map((file) => importedFile(manifest, record, file.path)))).every((file) => file.available) ? 'available' : 'missing',
      editorPath: targetRoute && !metadata.attachmentOnly ? `${targetRoute}?${new URLSearchParams({ importAsset: record.id, importPurpose: purpose })}` : undefined,
    });
  }
  for (const a of assets.values()) {
    if (a.origin === 'runtime') {
      const f = await taskFile(manifest, taskById.get(a.taskId), a.primary);
      a.availability = f.available ? 'available' : 'missing';
      a.previewKind = a.primary.endsWith('.gif')
        ? 'animation'
        : a.kind === 'interactable' ? (a.hasArtwork ? 'image' : 'none')
          : 'image';
    }
    decorate(manifest, a);
  }
  const trash = await readAssetTrash(manifest);
  for (const asset of assets.values()) {
    const entry = trashEntry(trash, asset);
    if (entry) asset.trashedAt = entry.trashedAt;
  }
  for (const entry of trash.entries) {
    if (![...assets.values()].some((asset) => trashEntry({ entries: [entry] }, asset))) {
      assets.set(entry.asset.id, { ...entry.asset, trashedAt: entry.trashedAt, availability: 'unknown', sourceUnavailable: true });
    }
  }
  return {
    assets: [...assets.values()],
    taskById,
    sceneById,
    mapById,
    importedById,
    coverage: {
      complete: issues.length === 0,
      runtimeRecords: tasks.length,
      sceneExportRecords: scenes.length,
      mapProjectRecords: maps.length,
      importedAssetRecords: imported.length,
      nativeAvailable: Boolean(native?.data?.assets),
      browserDrafts: 'not_indexed',
      issues,
      note: '地图工程与已保存的地图原图、扩图及拼接图片均保留，可按地图类型筛选。旧浏览器独有的地图草稿需在原浏览器打开并保存后收录。浏览器独有的场景、交互物草稿和下载文件不自动收录；地图制作仍由人工操作。',
    },
  };
}
function publicRow(a) {
  const {
    primary: _primary,
    files: _files,
    nativeId: _nativeId,
    visualAssetId: _visualAssetId,
    ...row
  } = a;
  return row;
}
export async function listAssets(manifest, input) {
  const q = assetInputs.assets.parse(input);
  const catalog = await scan(manifest);
  const snapshot = hash(
    JSON.stringify(
      catalog.assets.map((a) => [a.id, a.updatedAt, a.status, a.availability, a.trashedAt]),
    ) + JSON.stringify(catalog.coverage),
  );
  if (q.snapshot && q.snapshot !== snapshot)
    throw new Error('资产目录已变化，请从第一页重新查询以避免漏项。');
  const rows = catalog.assets.filter(
    (a) =>
      (q.scope === 'trashed' ? Boolean(a.trashedAt) : !a.trashedAt) &&
      (!q.kind || a.kind === q.kind) &&
      (!q.mapType || (a.kind === 'map' && (a.mapType || (a.origin === 'map-project' ? 'project' : 'image')) === q.mapType)) &&
      (!(q.purposes || q.target) || importPurposes(manifest, a).some((rule) =>
        (!q.purposes || q.purposes.includes(rule.id)) && (!q.target || rule.targets.includes(q.target)))) &&
      (!q.query ||
        `${a.title} ${a.id} ${a.characterId || ''} ${a.actionId || ''}`
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
  if (files.some((f) => !f.available))
    issues.push('部分源文件缺失或不可读取。');
  if (a.kind === 'animation' && a.status !== 'exported' && a.origin !== 'imported-package')
    issues.push(
      a.status === 'approved'
        ? '动画已检查，尚未导出。'
        : '动画尚未完成检查与导出。',
    );
  if (a.kind === 'interactable' && !a.hasArtwork)
    issues.push('此交互物只有逻辑，尚未绑定外观美术。');
  if (a.origin === 'map-project')
    issues.push('完整地图草稿，可打开继续编辑；下载提供 map-source.zip，未自动生成 PNG、PSD 或 Godot 包。');
  if (a.kind === 'map' && a.origin !== 'map-project' && a.mapType !== 'project')
    issues.push('地图图片与历史素材已保留；可下载或导入编辑器，只有已有完整源包时才能恢复原编辑状态。');
  if (a.kind === 'scene')
    issues.push('请将已有源包导入场景组装器继续编辑；随素材携带的 Godot 附件不代表当前编辑副本已通过引擎验证。');
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
      metadata: sourceMetadata(asset), contentHash: a.contentHash ?? null,
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
export async function readAssetPreview(manifest, assetId, projectRevision) {
  const catalog = await scan(manifest);
  const a = catalog.assets.find((a) => a.id === assetId);
  if (!a) throw new Error('资产预览不存在。');
  if (a.origin === 'map-project') {
    if (projectRevision !== undefined && String(a.projectRevision) !== String(projectRevision)) throw new Error('地图工程版本已更新，请刷新资产库。');
    return readMapProjectPreview(repositoryRoot, manifest, localRecord(catalog, a));
  }
  if (a.origin === 'sprite-pipeline') {
    const c = connection(manifest);
    const result = await requestBinary(
      endpointUrl(
        c.base,
        `/v1/artworks/file?${new URLSearchParams({ asset_id: a.nativeId, key: 'preview' })}`,
      ),
      { headers: c.headers, maxBytes: 40 * 1024 * 1024, timeoutMs: 10000 },
    );
    if (!/^image\/(png|gif|jpeg|webp)(;|$)/i.test(result.contentType))
      throw new Error('不是可预览的图片。');
    return { bytes: result.buffer, mime: result.contentType };
  }
  if (a.origin === 'imported-package' && a.kind !== 'interactable') {
    const record = localRecord(catalog, a);
    if (a.kind === 'animation' && record.payload?.framePaths?.length > 1 && record.payload.framePaths.length <= 256) {
      const frameFiles = await Promise.all(record.payload.framePaths.map((framePath) => importedFile(manifest, record, framePath, true)));
      if (frameFiles.every((file) => file.available) && frameFiles.reduce((total, file) => total + file.bytes, 0) <= 64 * 1024 * 1024) {
        const frames = [];
        for (const file of frameFiles) frames.push(await sharp(await catalogFileBytes(manifest, catalog, a, file), { limitInputPixels: 32_000_000 })
          .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).png().toBuffer());
        const fps = record.payload.animation?.fps;
        if (Number.isFinite(fps) && fps > 0 && typeof record.payload.animation?.loop === 'boolean') {
          const durations = record.metadata?.frameDurations;
          const delay = frames.map((_, index) => Math.max(10, Math.round((durations?.[index] || 1) * 1000 / fps)));
          return { bytes: await sharp(frames, { join: { animated: true } }).gif({ loop: record.payload.animation.loop ? 0 : 1, delay }).toBuffer(), mime: 'image/gif' };
        }
      }
    }
    const previewPath = record.payload?.previewPath || record.payload?.framePaths?.[0] || record.payload?.primaryPath;
    if (previewPath && imageExt.test(previewPath)) {
      const file = await importedFile(manifest, record, previewPath, true);
      return { bytes: await catalogFileBytes(manifest, catalog, a, file), mime: file.mime || mimeForName(file.name) };
    }
    if (a.mapType === 'project' && record.payload?.sourcePath) {
      const file = await importedFile(manifest, record, record.payload.sourcePath, true);
      const zip = await JSZip.loadAsync(await catalogFileBytes(manifest, catalog, a, file));
      const preview = zip.file('preview.png');
      if (preview && preview._data?.uncompressedSize <= 2 * 1024 * 1024) return { bytes: await preview.async('nodebuffer'), mime: 'image/png' };
      const info = zip.file('map-project.json');
      const data = info && JSON.parse(await info.async('string'));
      const image = data?.snapshot?.tiles?.find((tile) => tile.key === '0,0')?.images?.overall;
      if (image && /^images\/\d+\.bin$/.test(image.path) && zip.file(image.path)) return { bytes: await zip.file(image.path).async('nodebuffer'), mime: image.type };
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
    if (source.origin === 'imported-package') return [{ file, name: file.key.replace(/^(character|prop|animation|map|interactable|scene)\/[^/]+\/(.+)$/, '$2') }];
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
    } else if (source.origin === 'map-project') {
      if (file.name === 'map-source.zip') name = file.name;
    } else if (asset.kind === 'character' || asset.kind === 'prop' || asset.kind === 'map') {
      if (file.key === 'source' || file.key === source.primary)
        name = `${asset.kind === 'character' ? 'reference' : asset.kind === 'prop' ? 'prop' : 'map'}${path.extname(file.name).toLowerCase()}`;
      else if (asset.kind === 'map' && file.name.endsWith('.zip'))
        name = file.name;
    } else if (asset.kind === 'scene') {
      if (file.name === 'scene-source.zip' || file.name === 'scene-godot.zip') name = file.name;
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
  const maxMB = assetIds.some((id) => catalog.assets.some((a) => a.id === id && ['scene', 'map'].includes(a.kind))) ? 768 : 128;
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
    if (asset.kind === 'map') metadata.mapType = asset.mapType || (source.origin === 'map-project' ? 'project' : 'image');
    if (record?.payload?.map) metadata.map = record.payload.map;
    else if (source.origin === 'map-project') metadata.map = { format: 'forge-map-project', version: 1 };
    if (record?.payload?.project) metadata.project = record.payload.project;
    archiveManifest.entries.push({ key: `asset-${archiveManifest.entries.length + 1}`, kind: asset.kind,
      ...(asset.kind === 'map' ? { mapType: metadata.mapType } : {}), title: asset.title,
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
      asset.kind === 'scene' ? `场景版本：${asset.sceneRevision}；导出记录：${asset.exportId}` : '',
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
  if (purpose === 'map') {
    if (!bytes.subarray(0, 2).equals(Buffer.from('PK'))) return bytes;
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file('map-project.json');
    if (!entry) return bytes;
    const draft = JSON.parse(await entry.async('string'));
    draft.id = allocate(draft.id, 'map');
    // The map reader always restores pending jobs in a paused queue.
    zip.file('map-project.json', JSON.stringify(draft));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  }
  if (purpose === 'scene') {
    const scene = await readScenePackage(bytes);
    scene.id = allocate(scene.id, 'scene');
    scene.revision = 0;
    for (const material of scene.materials) material.project.projectId = allocate(material.project.projectId, 'project');
    if (scene.map?.source?.startsWith('data:application/zip;base64,')) {
      const source = Buffer.from(scene.map.source.slice(scene.map.source.indexOf(',') + 1), 'base64');
      scene.map.source = `data:application/zip;base64,${Buffer.from(await editablePackageCopy(source, 'map', identityMap)).toString('base64')}`;
    }
    return Buffer.from(await createScenePackage(scene));
  }
  return bytes;
}

export async function buildAssetImport(manifest, input) {
  const { assetId, purpose, revision } = assetImportInput.parse(input);
  const catalog = await scan(manifest);
  const asset = await detail(manifest, catalog, assetId);
  const source = catalog.assets.find((a) => a.id === asset.id);
  if (!importPurposes(manifest, asset).some((rule) => rule.id === purpose)) throw new Error('此素材不能用于所选导入方式。');
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
  else if (purpose === 'scene') selected = candidates.filter((f) => f.file.name === 'scene-source.zip');
  else if (purpose === 'animation') {
    selected = candidates.filter((f) => f.name.startsWith('frames/')).sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!Number.isFinite(asset.fps) || asset.fps <= 0 || typeof asset.loop !== 'boolean') throw new Error('动画缺少明确的播放速度或循环设置，请回原工具保存完整结果。');
  } else if (purpose === 'map') {
    for (const name of ['map-source.zip', 'pixelwork-state.zip', 'source_state.zip', 'godot-package.zip']) {
      const found = candidates.find((f) => f.file.name === name); if (found) { selected = [found]; break; }
    }
    if (!selected.length) selected = candidates.filter((f) => f.file.key === source.primary || f.file.key === 'source').slice(0,1);
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
    entries.push({ path: entryPath, name: file.name, sha256: hash(bytes), sourceSha256: file.sha256 });
  }
  const metadata = { format: 'forge-asset-import', version: 1, purpose, asset: {
    id: asset.id, revision: asset.revision, kind: asset.kind, title: asset.title,
    taskId: asset.taskId, projectId: identityMap[`project:${asset.projectId}`] || asset.projectId, definitionId: asset.definitionId,
    candidateIndex: asset.candidateIndex, fps: asset.fps, loop: asset.loop, width: asset.width, height: asset.height,
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
