import { mkdir, readFile, writeFile, rename, rm, copyFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { normalizeProject } from '../../features/interactable-editor/contract.mjs';
import { readMapProjectPackage } from '../../features/map-stitcher/project-package.mjs';
import { readScenePackage } from '../../features/scene-composer/package.mjs';
import { ASSET_PACKAGE_LIMITS as limits, assetArchiveManifestSchema, packageCommitSchema } from './asset-package-contract.mjs';
import { safeAssetPackagePath, readBoundedAssetZip } from './asset-packages-zip.mjs';
import { assetPackageDirectories, assetPackageHash as hash, readPackageJson, confinedPackageFile, listImportedAssets, withAssetPackageCommitLock, readAssetPackageCommit } from './asset-packages-store.mjs';

export { readAssetPackageCommit } from './asset-packages-store.mjs';
const decoder = new TextDecoder('utf-8', { fatal: true });
const json = bytes => {
  if (!bytes || bytes.length > limits.jsonBytes) throw new Error('清单缺失或超过读取上限。');
  return JSON.parse(decoder.decode(bytes));
};
const mime = name => /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : /\.psd$/i.test(name) ? 'image/vnd.adobe.photoshop' : /\.json$/i.test(name) ? 'application/json' : /\.zip$/i.test(name) ? 'application/zip' : /\.wav$/i.test(name) ? 'audio/wav' : /\.ogg$/i.test(name) ? 'audio/ogg' : /\.mp3$/i.test(name) ? 'audio/mpeg' : 'application/octet-stream';
const naturalSort = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const localArchivePath = name => name.replace(/^(?:character|prop|animation|map|interactable|scene)\/[^/]+\//, '');
const basename = name => path.posix.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/[. ]+$/, '').slice(0, 150) || '素材包.zip';
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const role = name => /(^|\/)frames\/[^/]+\.png$/i.test(name) || /(^|\/)frame[_-]\d+\.png$/i.test(name) ? 'frame' : /(?:godot|sprite-frames).*\.zip$/i.test(name) ? 'godot' : /(?:source|state).*\.zip$/i.test(name) || /interactable-project\.json$/i.test(name) ? 'source' : /sprite-sheet\.png$/i.test(name) ? 'sheet' : /preview\.(png|gif)$/i.test(name) ? 'preview' : /\.(png|jpe?g|webp|gif)$/i.test(name) ? 'image' : 'attachment';
function fileRecord(name, data, fileRole = role(name), sourceMime = mime(name)) {
  safeAssetPackagePath(name);
  return { path: name, role: fileRole, bytes: data.length, mime: sourceMime, sha256: hash(data), data };
}
function candidate(kind, label, files, options = {}) {
  return { kind, label: String(label || '导入素材').slice(0, 1000), status: 'material', recoverable: [], warnings: [], missing: [], requiredParameters: [], metadata: {}, payload: {}, files, ...options };
}
async function imageInfo(bytes) {
  const info = await sharp(bytes, { limitInputPixels: 100_000_000, animated: false }).metadata();
  if (!info.width || !info.height || !['png', 'jpeg', 'webp', 'gif'].includes(info.format)) throw new Error('媒体不是可识别的图片。');
  return { width: info.width, height: info.height };
}
function dataBytes(source, expectedMime) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
  if (!match || match[1] !== expectedMime || match[2].length % 4) throw new Error('内嵌媒体编码或 MIME 无效。');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 64 * 1024 * 1024 || data.toString('base64') !== match[2]) throw new Error('内嵌媒体缺失或超过 64 MB。');
  return data;
}
async function validateProject(input, archive) {
  const project = normalizeProject(input);
  let total = 0;
  for (const asset of project.assets) {
    let data;
    if (asset.source.startsWith('data:')) data = dataBytes(asset.source, asset.mime);
    else {
      safeAssetPackagePath(asset.source);
      data = archive?.get(asset.source);
      if (!data) throw new Error(`缺少媒体依赖：${asset.name} (${asset.source})`);
      if (data.length > 64 * 1024 * 1024) throw new Error('项目媒体超过 64 MB。');
      asset.source = `data:${asset.mime};base64,${data.toString('base64')}`;
    }
    total += data.length;
    if (total > 256 * 1024 * 1024) throw new Error('项目媒体累计超过 256 MB。');
    if (asset.generation && hash(data) !== asset.generation.sha256) throw new Error(`媒体来源哈希不符：${asset.name}`);
    if (asset.mime.startsWith('image/')) await imageInfo(data);
  }
  return project;
}
function addFile(files, name, bytes, fileRole, sourceMime) {
  const existing = files.find(file => file.path === name);
  if (existing) {
    if (existing.sha256 !== hash(bytes)) throw new Error('素材附件文件名冲突。');
    return existing;
  }
  const value = fileRecord(name, bytes, fileRole, sourceMime);
  files.push(value);
  return value;
}
async function interactableCandidate(bytes, sourceName, archive, files, context) {
  const raw = json(bytes), project = await validateProject(raw, archive);
  const embedded = project.assets.every((asset, index) => asset.source === raw.assets?.[index]?.source);
  const sourcePath = embedded ? sourceName : 'recovered/interactable-project.json';
  addFile(files, sourcePath, embedded ? bytes : Buffer.from(JSON.stringify(project)), 'source');
  const exact = context.metadata?.selectedDefinitionIds || context.metadata?.definitionIds || (context.metadata?.definitionId ? [context.metadata.definitionId] : undefined);
  if (exact && (!Array.isArray(exact) || exact.some(id => !project.objects.some(object => object.definitionId === id)))) throw new Error('清单所选物件在源项目中不存在。');
  const result = candidate('interactable', project.name, files, {
    status: exact || project.objects.length === 1 ? 'editable' : 'needs-input',
    recoverable: ['项目、行为、状态、图片、动画、音效与范围'],
    metadata: { projectId: project.projectId, definitionIds: exact || (project.objects.length === 1 ? [project.objects[0].definitionId] : []), objectCount: project.objects.length },
    objects: project.objects.map(object => ({ definitionId: object.definitionId, displayName: object.displayName })),
    payload: { sourcePath, sourceFormat: 'workbench-interactable', project: { id: project.projectId, name: project.name, definitionIds: exact || [] }, groupId: `interactable:${project.projectId}:${hash(bytes)}` },
    _projectContentHash: hash(bytes),
  });
  if (!exact && project.objects.length > 1) result.requiredParameters.push({ key: 'definitionIds', label: '选择要恢复的物件' });
  const object = project.objects.find(object => (exact || [project.objects[0].definitionId]).includes(object.definitionId));
  const frame = object.visual.clips.find(clip => clip.name === object.visual.idleAnimation)?.frames[0];
  const preview = project.assets.find(asset => asset.id === (frame?.assetId || object.visual.assetId));
  if (preview?.mime.startsWith('image/')) {
    let image = sharp(dataBytes(preview.source, preview.mime), { limitInputPixels: 100_000_000 });
    if (frame?.region) image = image.extract({ left: frame.region.x, top: frame.region.y, width: frame.region.width, height: frame.region.height });
    const previewFile = addFile(files, 'recovered/preview.png', await image.resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer(), 'preview', 'image/png');
    result.payload.previewPath = previewFile.path;
  }
  return result;
}
async function mapCandidate(bytes, sourceName, archive, files) {
  if (archive.has('map-project.json')) {
    const { draft, images, preview } = await readMapProjectPackage(bytes);
    for (const data of images.values()) await imageInfo(data);
    const center = draft.snapshot.tiles.find(tile => tile.key === '0,0').images.overall;
    const result = candidate('map', '地图工程', files, { mapType: 'project', status: 'editable', recoverable: ['卡片、原图、图层、区域、锁和显示偏好'], metadata: { mapType: 'project', projectId: draft.id, format: draft.format, version: draft.version, tileCount: draft.snapshot.tiles.length, pendingCount: draft.pending.length, width: center.width, height: center.height }, payload: { sourcePath: sourceName, sourceFormat: draft.format, map: { format: draft.format, version: draft.version, pendingPaused: true } } });
    if (draft.pending.length) result.warnings.push('待处理生成请求保持暂停；导入不会执行生成。');
    const data = preview || images.get(center.path);
    const previewFile = addFile(files, 'recovered/preview.png', await sharp(data, { limitInputPixels: 100_000_000 }).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).png().toBuffer(), 'preview', 'image/png');
    result.payload.previewPath = previewFile.path;
    return result;
  }
  const state = archive.has('map_stitch_state.json') ? json(archive.get('map_stitch_state.json')) : null;
  if (state) {
    if (!((state.format === 'pixelwork-map-stitch-state' && [1, 2].includes(state.version)) || (state.format === 'scenemaker-map-stitch-state' && state.version === 5))) throw new Error('不支持此地图状态格式或版本。');
    if (state.format.startsWith('pixelwork') && (!state.source || typeof state.source.path !== 'string')) throw new Error('地图状态缺少中心图片。');
    if (state.format.startsWith('scenemaker') && (!Array.isArray(state.tiles) || !state.tiles.length)) throw new Error('地图状态缺少卡片。');
    let references = 0, preview;
    const visit = async value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.path === 'string') {
        safeAssetPackagePath(value.path);
        const data = archive.get(value.path);
        if (!data) throw new Error(`地图状态缺少图片：${value.path}`);
        if (value.size !== undefined && value.size !== data.length) throw new Error('地图图片长度与清单不符。');
        if (value.generation && hash(data) !== value.generation.sha256) throw new Error('地图图片来源哈希不符。');
        await imageInfo(data);
        preview ||= data;
        references++;
      }
      for (const child of Object.values(value)) await visit(child);
    };
    await visit(state);
    if (!references) throw new Error('地图状态没有可恢复图片。');
    const previewFile = addFile(files, 'recovered/preview.png', await sharp(preview, { limitInputPixels: 100_000_000 }).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).png().toBuffer(), 'preview', 'image/png');
    return candidate('map', '地图工程', files, { mapType: 'project', status: 'editable', recoverable: ['兼容状态中的卡片、图片、区域和编辑设置'], warnings: ['沿用地图编辑器的兼容迁移；待处理请求保持暂停。'], metadata: { mapType: 'project', format: state.format, version: state.version }, payload: { sourcePath: sourceName, sourceFormat: state.format, previewPath: previewFile.path, map: { format: state.format, version: state.version, pendingPaused: true } } });
  }
  throw new Error('地图包缺少受支持的源状态。');
}
async function sceneCandidate(bytes, sourceName, archive, files, context) {
  const manifest = json(archive.get('scene.json'));
  // Validate the embedded map container before the browser-compatible reader decodes it.
  if (manifest.map?.source) {
    safeAssetPackagePath(manifest.map.source);
    const mapBytes = archive.get(manifest.map.source);
    if (!mapBytes) throw new Error('场景缺少地图源包。');
    const map = await identifyZip(mapBytes, 'scene-map-source.zip', [fileRecord('scene-map-source.zip', mapBytes, 'source', 'application/zip')], { ...context, depth: context.depth + 1 });
    if (map.kind !== 'map') throw new Error('场景内嵌地图不是可识别的地图源或地图输出。');
  }
  const scene = await readScenePackage(bytes);
  for (const material of scene.materials) await validateProject(material.project);
  const result = candidate('scene', scene.name, files, { status: 'editable', recoverable: ['地图、物件素材、实例、排列与联动'], metadata: { sceneId: scene.id, sceneRevision: scene.revision, instanceCount: scene.instances.length, materialCount: scene.materials.length, mapName: scene.map?.name }, payload: { sourcePath: sourceName, sourceFormat: 'workbench-scene', scene: { id: scene.id, revision: scene.revision } } });
  const layer = scene.map?.layers[0];
  if (layer) {
    const preview = addFile(files, 'recovered/preview.png', await sharp(dataBytes(layer.source, 'image/png'), { limitInputPixels: 100_000_000 }).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).png().toBuffer(), 'preview', 'image/png');
    result.payload.previewPath = preview.path;
  }
  return result;
}
async function animationExportContract(archive) {
  const exports = [...archive.keys()].filter(name => name.endsWith('/export.json') || name === 'export.json');
  const known = exports.map(name => ({ name, data: json(archive.get(name)) })).filter(item => item.data.format === 'sprite-pipeline-godot');
  if (known.length !== 1) throw new Error('动画引擎包没有唯一的可识别播放清单。');
  const { name, data: contract } = known[0];
  if (contract.version !== 1 || !Number.isFinite(contract.fps) || contract.fps <= 0 || contract.fps > 1000 || typeof contract.loop !== 'boolean' || !Array.isArray(contract.source_region_px) || !Number.isInteger(contract.frame_count) || contract.frame_count < 1 || contract.frame_count > 10000 || contract.source_region_px.length !== contract.frame_count) throw new Error('动画播放参数或帧区域不完整。');
  const sheetPath = name.replace(/export\.json$/, 'sprite-sheet.png'), sheet = archive.get(sheetPath);
  if (!sheet || hash(sheet) !== contract.sheet_sha256) throw new Error('动画精灵表缺失或哈希不符。');
  const dimensions = await imageInfo(sheet);
  if (!Array.isArray(contract.cell_size) || contract.cell_size.length !== 2 || !contract.cell_size.every(value => Number.isInteger(value) && value > 0) || !Array.isArray(contract.anchor) || contract.anchor.length !== 2 || !contract.anchor.every((value, index) => Number.isFinite(value) && value >= 0 && value < contract.cell_size[index]) || !['left', 'right'].includes(contract.source_facing)) throw new Error('动画锚点、朝向或单帧尺寸无效。');
  if (contract.cell_size[0] * contract.cell_size[1] * contract.frame_count > 100_000_000) throw new Error('恢复动画的累计帧像素超过限制。');
  for (const region of contract.source_region_px) {
    if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isInteger)) throw new Error('动画帧区域必须是精确像素矩形。');
    const [x, y, width, height] = region;
    if (x < 0 || y < 0 || width !== contract.cell_size[0] || height !== contract.cell_size[1] || x + width > dimensions.width || y + height > dimensions.height) throw new Error('动画帧区域越过精灵表。');
  }
  return { contract, sheet };
}
async function exportedAnimation(archive, files, label, context) {
  const { contract, sheet } = await animationExportContract(archive);
  context.budget.files += contract.frame_count;
  if (context.budget.files > limits.files) throw new Error('恢复动画的累计文件数超过限制。');
  const frames = [];
  for (const [index, [x, y, width, height]] of contract.source_region_px.entries()) {
    const data = await sharp(sheet, { limitInputPixels: 100_000_000 }).extract({ left: x, top: y, width, height }).png().toBuffer();
    context.budget.bytes += data.length;
    if (context.budget.bytes > limits.expandedBytes) throw new Error('恢复动画的累计展开大小超过限制。');
    const frame = addFile(files, `recovered-frames/frame_${String(index).padStart(4, '0')}.png`, data, 'frame', 'image/png');
    frames.push(frame.path);
  }
  addFile(files, 'recovered/sprite-sheet.png', sheet, 'sheet', 'image/png');
  return candidate('animation', contract.animation || label, files, { recoverable: ['导出动画的精确帧区域、FPS、循环、锚点与朝向'], metadata: { fps: contract.fps, loop: contract.loop, frameCount: frames.length, width: contract.cell_size[0], height: contract.cell_size[1], anchor: contract.anchor, sourceFacing: contract.source_facing, candidateIndex: contract.candidate_index, jobId: contract.job_id }, payload: { framePaths: frames, previewPath: frames[0], primaryPath: frames[0], animation: { representation: 'sheet', fps: contract.fps, loop: contract.loop, regions: contract.source_region_px, anchor: contract.anchor, sourceFacing: contract.source_facing, visualOffset: contract.visual_offset, sheetPath: 'recovered/sprite-sheet.png', exportContract: contract } } });
}
async function pngCollection(archive, files, label) {
  const data = json(archive.get('png_manifest.json'));
  const layers = ['overall', 'surface', 'object', 'mask', 'black', 'white', 'top'];
  if (!Array.isArray(data.layers) || !data.layers.length || new Set(data.layers).size !== data.layers.length || data.layers.some(layer => !layers.includes(layer)) || ![data.width, data.height].every(value => Number.isInteger(value) && value > 0 && value <= 32768) || ![data.originX, data.originY].every(Number.isFinite)) throw new Error('地图 PNG 集合清单无效。');
  for (const name of ['map_composite.png', ...data.layers.map(layer => `map_${layer}.png`)]) {
    const bytes = archive.get(name);
    if (!bytes) throw new Error(`地图图片集合缺少 ${name}。`);
    const info = await imageInfo(bytes);
    if (info.width !== data.width || info.height !== data.height) throw new Error('地图图片尺寸与清单不符。');
    addFile(files, name, bytes, 'image', 'image/png');
  }
  return candidate('map', label, files, { mapType: 'image', recoverable: ['合成图片、输出层、尺寸与原点'], warnings: ['图片集合不包含原始卡片、羽化前素材与完整源区域。'], metadata: { ...data, mapType: 'image' }, payload: { primaryPath: 'map_composite.png', previewPath: 'map_composite.png', sourceFormat: 'forge-map-png-collection', map: { format: 'forge-map-png-collection' } } });
}
function validateKnownGodotArchive(archive, recovered) {
  const paths = [...archive.keys()];
  const portablePaths = paths.filter(name => /^forge_packages\/[^/]+\/manifest\.json$/.test(name));
  if (portablePaths.length > 1) throw new Error('引擎包含多个交付清单。');
  let known = false;
  if (portablePaths.length) {
    const manifest = json(archive.get(portablePaths[0]));
    if (manifest.format !== 'forge-godot-export' || manifest.version !== 1 || manifest.kind !== recovered.kind || !Array.isArray(manifest.files)) throw new Error('Godot 交付清单与恢复素材类型不一致。');
    const names = new Set();
    for (const file of manifest.files) {
      safeAssetPackagePath(file.path);
      const data = archive.get(file.path);
      if (names.has(file.path) || !data || file.bytes !== data.length || file.sha256 !== hash(data)) throw new Error(`Godot 交付文件校验失败：${file.path}`);
      names.add(file.path);
    }
    if (paths.some(name => name !== portablePaths[0] && !names.has(name))) throw new Error('Godot 交付包含未登记文件。');
    known = true;
  }
  const scenes = paths.filter(name => /(^|\/)scene-manifest\.json$/.test(name));
  if (scenes.length) {
    if (scenes.length !== 1 || recovered.kind !== 'scene') throw new Error('场景引擎清单与源项目不一致。');
    const manifest = json(archive.get(scenes[0]));
    if (manifest.format !== 'workbench-scene-godot' || manifest.version !== 1 || manifest.sceneId !== recovered.payload.scene.id) throw new Error('场景引擎清单身份与源项目不符。');
    known = true;
  }
  const objects = paths.filter(name => /(^|\/)package-manifest\.json$/.test(name));
  if (objects.length && recovered.kind === 'interactable') {
    if (objects.length !== 1) throw new Error('交互物引擎包含多个项目。');
    const manifest = json(archive.get(objects[0]));
    if (manifest.format !== 'workbench-interaction-kit' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.objects) || manifest.objects.length !== recovered.objects.length || manifest.objects.some(object => !recovered.objects.some(source => source.definitionId === object.definitionId))) throw new Error('交互物引擎清单物件与源项目不符。');
    known = true;
  }
  const maps = paths.filter(name => /(^|\/)map_export\.json$/.test(name));
  if (maps.length && recovered.kind === 'map') {
    if (maps.length !== 1) throw new Error('地图引擎包含多个地图。');
    const manifest = json(archive.get(maps[0]));
    if (manifest.format !== 'frame-ronin-engine-package' || manifest.version !== 1 || manifest.target !== 'godot') throw new Error('地图引擎清单无效。');
    known = true;
  }
  return known;
}
function markGodotAttachment(archive, recovered, files, name) {
  const outer = files.find(file => file.path === name);
  if (validateKnownGodotArchive(archive, recovered)) {
    recovered.payload.godotPath = name;
    if (outer) outer.role = 'godot';
    recovered.warnings.push('包内源数据用于编辑恢复；Godot 脚本和节点保留为附件。');
  } else {
    if (outer) outer.role = 'attachment';
    recovered.warnings.push('此容器没有已知 Godot 清单；已保留原件并恢复其中的源项目。');
  }
  return recovered;
}
async function identifyZip(bytes, name, files, context) {
  const archive = readBoundedAssetZip(bytes, context);
  if (archive.has('scene.json')) return sceneCandidate(bytes, name, archive, files, context);
  if (archive.has('map-project.json') || archive.has('map_stitch_state.json')) return mapCandidate(bytes, name, archive, files);
  if (archive.has('png_manifest.json')) return pngCollection(archive, files, context.label);
  const sourceZips = [...archive.keys()].filter(key => /(^|\/)(scene-source|map-source|source_state|pixelwork-state)\.zip$/i.test(key));
  if (sourceZips.length) {
    if (sourceZips.length !== 1) throw new Error('包内含多个源项目，请分别选择对应源包。');
    const source = sourceZips[0], data = archive.get(source);
    const local = `recovered/${path.posix.basename(source)}`;
    addFile(files, local, data, 'source', 'application/zip');
    const result = await identifyZip(data, local, files, { ...context, depth: context.depth + 1 });
    return markGodotAttachment(archive, result, files, name);
  }
  const projects = [...archive.keys()].filter(key => /(^|\/)interactable-project\.json$/i.test(key));
  if (projects.length) {
    if (projects.length !== 1) throw new Error('包内包含多个交互物项目。');
    const data = archive.get(projects[0]);
    const local = 'recovered/original-interactable-project.json';
    addFile(files, local, data, 'attachment', 'application/json');
    const result = await interactableCandidate(data, local, archive, files, context);
    return markGodotAttachment(archive, result, files, name);
  }
  if ([...archive.keys()].some(key => /(^|\/)export\.json$/.test(key))) {
    const result = await exportedAnimation(archive, files, context.label, context);
    result.payload.godotPath = name;
    const outer = files.find(file => file.path === name);
    if (outer) outer.role = 'godot';
    return result;
  }
  // Older map engine outputs carry only composed images, never a full source project.
  const mapManifestPath = [...archive.keys()].find(key => /(^|\/)(map_export|map_stitch_godot)\.json$/.test(key));
  if (mapManifestPath || (archive.has('map.png') && archive.has('map_stitch.tscn'))) {
    const manifest = mapManifestPath ? json(archive.get(mapManifestPath)) : {};
    const prefix = mapManifestPath?.slice(0, -path.posix.basename(mapManifestPath).length) || '';
    const imagePath = [prefix + 'assets/map_overall.png', prefix + 'map.png'].find(key => archive.has(key));
    if (!imagePath) throw new Error('旧地图引擎包缺少合成图片。');
    const image = addFile(files, 'recovered/map.png', archive.get(imagePath), 'image', 'image/png');
    const dimensions = await imageInfo(image.data);
    return candidate('map', context.label, files, { mapType: 'image', recoverable: ['地图合成图片与原引擎附件'], warnings: ['此引擎包缺少完整源数据，只恢复合成图片。'], metadata: { ...dimensions, mapType: 'image', format: manifest.format }, payload: { primaryPath: image.path, previewPath: image.path, godotPath: name, sourceFormat: manifest.format || 'legacy-map-output' } });
  }
  throw new Error('没有可识别的 Forge 源项目、引擎恢复数据或图片集合。');
}
async function identifyFiles(inputFiles, context) {
  const files = inputFiles.map(file => ({ ...file }));
  const find = predicate => files.find(file => predicate(file.path));
  const source = find(name => /(^|\/)scene-source\.zip$/i.test(name)) || find(name => /(^|\/)(map-source|pixelwork-state|source_state|map.*state)\.zip$/i.test(name)) || find(name => /(^|\/)interactable-project\.json$/i.test(name)) || files.find(file => file.role === 'source' && /\.json$/i.test(file.path));
  let result;
  if (source?.path.endsWith('.json')) result = await interactableCandidate(source.data, source.path, new Map(files.map(file => [file.path, file.data])), files, context);
  else if (source) result = await identifyZip(source.data, source.path, files, { ...context, depth: context.depth + 1 });
  if (!result) {
    const frames = files.filter(file => file.role === 'frame' || role(file.path) === 'frame');
    if (frames.length) {
      const order = context.metadata?.frameOrder;
      const ordered = order ? order.map(name => frames.find(file => file.path === name || file.originalPath === name)) : frames.sort((a, b) => naturalSort(a.path, b.path));
      if (!Array.isArray(ordered) || ordered.length !== frames.length || ordered.some(file => !file) || new Set(ordered.map(file => file.path)).size !== frames.length) throw new Error('动画帧顺序清单不完整或重复。');
      const dimensions = await Promise.all(ordered.map(file => imageInfo(file.data)));
      if (dimensions.some(info => info.width !== dimensions[0].width || info.height !== dimensions[0].height)) throw new Error('动画原始帧尺寸不一致。');
      const metadata = { ...dimensions[0], frameCount: ordered.length, fps: context.metadata?.fps, loop: context.metadata?.loop };
      const rawRepresentation = context.metadata?.animationRepresentations?.find(item => item.representation === 'frames');
      if (rawRepresentation?.framePaths && (!Array.isArray(rawRepresentation.framePaths) || rawRepresentation.framePaths.length !== ordered.length || rawRepresentation.framePaths.some((name, index) => localArchivePath(name) !== ordered[index].path))) throw new Error('原始动画表示与实际帧顺序不一致。');
      const anchor = rawRepresentation?.anchor || context.metadata?.anchor;
      const sourceFacing = rawRepresentation?.sourceFacing || context.metadata?.sourceFacing || context.metadata?.facing;
      if (anchor != null) {
        if (!Array.isArray(anchor) || anchor.length !== 2 || !anchor.every((value, index) => Number.isFinite(value) && value >= 0 && value < (index ? metadata.height : metadata.width))) throw new Error('原始动画帧锚点越过画布。');
        metadata.anchor = anchor;
      }
      if (sourceFacing != null) {
        if (!['left', 'right'].includes(sourceFacing)) throw new Error('原始动画帧朝向无效。');
        metadata.sourceFacing = sourceFacing;
      }
      for (const key of ['jobId', 'candidateIndex', 'characterId', 'actionId', 'frameDurations']) if (context.metadata?.[key] != null) metadata[key] = context.metadata[key];
      if (metadata.frameDurations && (!Array.isArray(metadata.frameDurations) || metadata.frameDurations.length !== ordered.length || !metadata.frameDurations.every(value => Number.isFinite(value) && value > 0))) throw new Error('动画帧时长不完整或无效。');
      result = candidate('animation', context.label, files, { recoverable: ['有序原始 PNG 帧与已携带附件'], metadata, payload: { framePaths: ordered.map(file => file.path), previewPath: ordered[0].path, primaryPath: ordered[0].path, animation: { representation: 'frames', fps: metadata.fps, loop: metadata.loop, ...(metadata.anchor ? { anchor: metadata.anchor } : {}), ...(metadata.sourceFacing ? { sourceFacing: metadata.sourceFacing } : {}), ...(metadata.frameDurations ? { frameDurations: metadata.frameDurations } : {}) } } });
      metadata.animationRepresentations = [{ representation: 'frames', framePaths: ordered.map(file => file.path), fps: metadata.fps, loop: metadata.loop, ...(metadata.anchor ? { anchor: metadata.anchor } : {}), ...(metadata.sourceFacing ? { sourceFacing: metadata.sourceFacing } : {}) }];
      if (!Number.isFinite(metadata.fps) || metadata.fps <= 0 || metadata.fps > 1000) result.requiredParameters.push({ key: 'fps', label: '播放速度（FPS）' });
      if (typeof metadata.loop !== 'boolean') result.requiredParameters.push({ key: 'loop', label: '循环或单次播放' });
      if (result.requiredParameters.length) result.status = 'needs-input';
      // A different exported sheet is a separate representation. Its playback
      // parameters must never silently change the raw frames.
      for (const attachment of files.filter(file => file.role === 'godot')) {
        try {
          const nested = readBoundedAssetZip(attachment.data, { ...context, depth: context.depth + 1 });
          const { contract } = await animationExportContract(nested);
          if ((metadata.jobId != null && contract.job_id !== metadata.jobId) || (metadata.candidateIndex != null && contract.candidate_index !== metadata.candidateIndex)) throw new Error('导出动画属于不同作业或候选');
          result.metadata.exportRepresentation = contract;
          result.payload.godotPath ||= attachment.path;
          metadata.animationRepresentations.push({ representation: 'sheet', godotPath: attachment.path, fps: contract.fps, loop: contract.loop, regions: contract.source_region_px, anchor: contract.anchor, sourceFacing: contract.source_facing, sheetSha256: contract.sheet_sha256, jobId: contract.job_id, candidateIndex: contract.candidate_index });
        } catch (error) {
          attachment.role = 'attachment';
          result.warnings.push(`随附动画包只保留为原件：${error.message}`);
        }
      }
    }
  }
  if (!result) {
    const archive = files.find(file => file.mime === 'application/zip' || file.path.toLowerCase().endsWith('.zip'));
    if (archive) result = await identifyZip(archive.data, archive.path, files, { ...context, depth: context.depth + 1 });
  }
  if (!result) {
    const primary = files.find(file => file.mime.startsWith('image/'));
    if (!primary) throw new Error('未找到可恢复的素材内容。');
    let dimensions;
    const photoshop = primary.mime === 'image/vnd.adobe.photoshop';
    if (photoshop) {
      const data = primary.data;
      if (data.length < 26 || data.toString('ascii', 0, 4) !== '8BPS' || ![1, 2].includes(data.readUInt16BE(4)) || data.subarray(6, 12).some(value => value !== 0) || data.readUInt16BE(12) < 1 || data.readUInt16BE(12) > 56 || ![1, 8, 16, 32].includes(data.readUInt16BE(22))) throw new Error('Photoshop 文件头无效。');
      dimensions = { width: data.readUInt32BE(18), height: data.readUInt32BE(14) };
      if (!dimensions.width || !dimensions.height || dimensions.width > 300000 || dimensions.height > 300000) throw new Error('Photoshop 图片尺寸无效。');
      primary.role = 'attachment';
    } else dimensions = await imageInfo(primary.data);
    const kind = ['character', 'prop', 'map'].includes(context.kind) ? context.kind : 'prop';
    result = candidate(kind, context.label, files, { ...(kind === 'map' ? { mapType: 'image' } : {}), recoverable: [photoshop ? 'Photoshop 原始文件附件' : '图片素材与原始附件'], warnings: [photoshop ? '保留 PSD 原件；Forge 不提供通用 PSD 图层编辑或工程恢复。' : '图片不包含原生成作业或完整编辑工程。'], metadata: { ...dimensions, attachmentOnly: photoshop, ...(kind === 'map' ? { mapType: 'image' } : {}) }, payload: { primaryPath: primary.path, ...(photoshop ? {} : { previewPath: primary.path }) } });
  }
  if (context.kind && result.kind !== context.kind) throw new Error('清单素材类型与实际源内容不一致。');
  if (context.mapType && result.mapType !== context.mapType) throw new Error('清单地图子类型与实际源内容不一致。');
  if (context.label && result.kind !== 'interactable') result.label = context.label;
  for (const attachment of files.filter(file => file.role === 'godot' && file.path !== result.payload.godotPath)) {
    try {
      const archive = readBoundedAssetZip(attachment.data, { ...context, depth: context.depth + 1 });
      if (result.kind === 'animation' && [...archive.keys()].some(name => /(^|\/)export\.json$/.test(name))) {
        await animationExportContract(archive);
        result.payload.godotPath ||= attachment.path;
      }
      else if (validateKnownGodotArchive(archive, result)) result.payload.godotPath ||= attachment.path;
      else throw new Error('没有已知 Godot 清单');
    } catch (error) {
      attachment.role = 'attachment';
      result.warnings.push(`随附 ${path.posix.basename(attachment.path)} 只保留为原件，未登记可用引擎包：${error.message}`);
    }
  }
  return result;
}
function incomplete(error, context, files = []) {
  return candidate(context.kind || 'prop', context.label, files, { ...(context.mapType ? { mapType: context.mapType } : {}), status: 'incomplete', missing: [error.message], warnings: [], recoverable: [] });
}
function publicCandidate(value) {
  const { files: _files, payload: _payload, identityKey: _identityKey, contentHash: _contentHash, baseContentHash: _baseContentHash, _projectContentHash: _projectContentHash2, ...safe } = value;
  return safe;
}
async function readCandidates(bytes, filename) {
  const packageHash = hash(bytes), budget = { bytes: 0, files: 0 }, baseContext = { depth: 0, budget, label: filename.replace(/\.[^.]+$/, '') }, candidates = [];
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const archive = readBoundedAssetZip(bytes, baseContext);
    if (archive.has('forge-assets.json')) {
      const manifest = assetArchiveManifestSchema.parse(json(archive.get('forge-assets.json')));
      const keys = new Set();
      for (const entry of manifest.entries) {
        if (keys.has(entry.key)) throw new Error('素材清单条目身份重复。');
        keys.add(entry.key);
        const context = { ...baseContext, depth: 0, kind: entry.kind, mapType: entry.mapType, label: entry.title || entry.label || entry.key, metadata: entry.metadata };
        let files = [];
        try {
          const paths = new Set(), localPaths = new Set();
          files = entry.files.map(file => {
            safeAssetPackagePath(file.path);
            const local = localArchivePath(file.path);
            if (paths.has(file.path) || localPaths.has(local.normalize('NFC').toLowerCase())) throw new Error('素材清单文件重复或本地名称冲突。');
            paths.add(file.path);
            localPaths.add(local.normalize('NFC').toLowerCase());
            const data = archive.get(file.path);
            if (!data || data.length !== file.bytes || hash(data) !== file.sha256) throw new Error(`清单文件缺失、长度或 SHA-256 不符：${file.path}`);
            return { ...fileRecord(local, data, file.role, file.mime), originalPath: file.path };
          });
          const result = await identifyFiles(files, context);
          result.sourceIdentity = entry.sourceIdentity || { packageId: manifest.packageId, entryKey: entry.key };
          result.sourceVersion = entry.sourceVersion ?? null;
          result.provenance = { ...entry.provenance, sourceMetadata: entry.metadata, archiveFormat: manifest.format, archiveVersion: manifest.version, packageId: manifest.packageId, exportedAt: manifest.exportedAt, importedClaimsAreUnverified: true };
          result._entryKey = entry.key;
          candidates.push(result);
        } catch (error) { candidates.push({ ...incomplete(error, context, files), _entryKey: entry.key }); }
      }
    } else {
      const grouped = new Map();
      for (const [name, data] of archive) {
        const match = /^(character|prop|animation|map|interactable|scene)\/([^/]+)\/(.+)$/.exec(name);
        if (!match) continue;
        const key = `${match[1]}/${match[2]}`;
        if (!grouped.has(key)) grouped.set(key, { kind: match[1], label: match[2].replace(/-[a-f0-9]{8}$/i, ''), files: [] });
        grouped.get(key).files.push(fileRecord(match[3], data));
      }
      if (grouped.size) {
        if (grouped.size > limits.candidates) throw new Error('素材包包含超过 100 个素材条目。');
        for (const [key, group] of grouped) {
          const description = group.files.find(file => file.path === '素材说明.txt');
          const text = description ? decoder.decode(description.data) : '';
          const fps = Number(/(?:播放速度[：:]\s*)?([\d.]+)\s*FPS/i.exec(text)?.[1]);
          const context = { ...baseContext, kind: group.kind, label: group.label, metadata: fps > 0 && fps <= 1000 ? { fps } : {} };
          try { candidates.push({ ...await identifyFiles(group.files, context), _entryKey: key, provenance: { archiveFormat: 'legacy-forge-assets', importedClaimsAreUnverified: true } }); }
          catch (error) { candidates.push({ ...incomplete(error, context, group.files), _entryKey: key }); }
        }
      } else {
        const files = [fileRecord(filename, bytes, 'source')];
        try { candidates.push(await identifyZip(bytes, filename, files, { ...baseContext, budget: { bytes: 0, files: 0 } })); }
        catch (error) { candidates.push(incomplete(error, baseContext, files)); }
      }
    }
  } else if (/\.json$/i.test(filename) || bytes[0] === 123) {
    const files = [fileRecord(filename, bytes, 'source', 'application/json')];
    try { candidates.push(await interactableCandidate(bytes, filename, null, files, baseContext)); }
    catch (error) { candidates.push(incomplete(error, baseContext, files)); }
  } else {
    const files = [fileRecord(filename, bytes, 'image')];
    try { candidates.push(await identifyFiles(files, baseContext)); }
    catch (error) { candidates.push(incomplete(error, baseContext, files)); }
  }
  // A whole interactable project can appear in several selected-object folders.
  const groups = new Map(), merged = [];
  for (const value of candidates) {
    const key = value.payload.groupId;
    if (key && groups.has(key)) {
      const existing = groups.get(key);
      existing._sourceIdentities ||= [existing.sourceIdentity || { packageHash, entryKey: existing._entryKey }];
      existing._sourceIdentities.push(value.sourceIdentity || { packageHash, entryKey: value._entryKey });
      const definitions = [...new Set([...existing.metadata.definitionIds, ...value.metadata.definitionIds])];
      existing.metadata.definitionIds = definitions;
      existing.payload.project.definitionIds = definitions;
      if (definitions.length) { existing.requiredParameters = []; existing.status = 'editable'; }
      for (const file of value.files) {
        const same = existing.files.find(other => other.path === file.path);
        if (!same) existing.files.push(file);
        else if (same.sha256 !== file.sha256) {
          const name = `attachments/${hash(value._entryKey || value.label).slice(0, 12)}/${path.posix.basename(file.path)}`;
          existing.files.push({ ...file, path: name });
        }
      }
      existing.provenance.groupedSources ||= [];
      existing.provenance.groupedSources.push(value.sourceIdentity || { entryKey: value._entryKey });
    } else { if (key) groups.set(key, value); merged.push(value); }
  }
  for (const [index, value] of merged.entries()) {
    value.provenance ||= {};
    value.sourceIdentity ||= { packageHash, entryKey: value._entryKey || `standalone:${index}` };
    if (value._sourceIdentities) {
      value.sourceIdentity = { projectId: value.payload.project.id, sources: [...new Map(value._sourceIdentities.map(identity => [stable(identity), identity])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, identity]) => identity) };
      delete value._sourceIdentities;
    }
    const semanticMetadata = Object.fromEntries(['width', 'height', 'mapType', 'frameCount', 'anchor', 'sourceFacing', 'frameDurations', 'format', 'version', 'sceneId', 'sceneRevision', 'jobId', 'candidateIndex', 'characterId', 'actionId'].filter(key => value.metadata[key] !== undefined).map(key => [key, value.metadata[key]]));
    value.baseContentHash = hash(stable({ kind: value.kind, source: value.files.filter(file => !localArchivePath(file.path).startsWith('recovered') && !/\.txt$/i.test(file.path)).map(({ path: filePath, sha256 }) => ({ path: localArchivePath(filePath), sha256 })).sort((a, b) => a.path.localeCompare(b.path)), metadata: semanticMetadata, frameOrder: value.payload.framePaths?.map(name => value.files.find(file => file.path === name)?.sha256) }));
    value.contentHash = effectiveContentHash(value);
    value.identityKey = hash(stable(value.sourceIdentity));
    value.id = `candidate-${hash(`${packageHash}:${value._entryKey || index}:${value.kind}`).slice(0, 24)}`;
    delete value._entryKey;
  }
  return merged;
}

export async function cleanupExpiredAssetPackageInspections(root, manifest, now = Date.now()) {
  const directory = assetPackageDirectories(root, manifest).staging;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries.filter(entry => entry.isDirectory() && /^inspection-[a-f0-9]{32}$/.test(entry.name))) {
    const base = path.join(directory, entry.name);
    if (now - (await stat(base)).mtimeMs > limits.inspectionLifetimeMs) await rm(base, { recursive: true, force: true });
  }
}
export async function inspectAssetPackage(root, manifest, { bytes: inputBytes, filename: originalName = 'forge-assets.zip' }) {
  const bytes = Buffer.isBuffer(inputBytes) ? inputBytes : Buffer.from(inputBytes);
  if (!bytes.length || bytes.length > limits.uploadBytes) throw Object.assign(new Error('素材包为空或超过 768 MiB 上传上限。'), { status: 413 });
  const filename = basename(originalName);
  const { staging } = assetPackageDirectories(root, manifest);
  await mkdir(staging, { recursive: true });
  await cleanupExpiredAssetPackageInspections(root, manifest);
  const id = `inspection-${randomUUID().replaceAll('-', '')}`, base = path.join(staging, id);
  await mkdir(base);
  try {
    await writeFile(path.join(base, 'original.bin'), bytes, { flag: 'wx' });
    const candidates = await readCandidates(bytes, filename);
    const existing = await listImportedAssets(root, manifest);
    for (const value of candidates) {
      const matchingIdentity = existing.filter(record => record.identityKey === value.identityKey);
      const match = matchingIdentity.find(record => record.contentHash === value.contentHash) || matchingIdentity[0];
      if (match) value.duplicate = { assetId: match.id, exact: match.contentHash === value.contentHash };
      if (value.payload.previewPath || value.payload.framePaths?.length) value.previewUrl = `/api/workbench/assets/packages/preview?inspectionId=${encodeURIComponent(id)}&candidateId=${encodeURIComponent(value.id)}`;
      const filesRoot = path.join(base, value.id, 'files');
      await mkdir(filesRoot, { recursive: true });
      for (const file of value.files) {
        await mkdir(path.dirname(path.join(filesRoot, file.path)), { recursive: true });
        await writeFile(path.join(filesRoot, file.path), file.data, { flag: 'wx' });
        delete file.data;
      }
    }
    const inspection = { inspectionId: id, filename, packageHash: hash(bytes), bytes: bytes.length, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + limits.inspectionLifetimeMs).toISOString(), candidates };
    await writeFile(path.join(base, 'inspection.json'), JSON.stringify(inspection), { flag: 'wx' });
    return { ...inspection, candidates: candidates.map(publicCandidate) };
  } catch (error) { await rm(base, { recursive: true, force: true }); throw error; }
}

function effectiveContentHash(value) {
  const parameters = { ...(value.kind === 'animation' ? { fps: value.metadata.fps, loop: value.metadata.loop } : {}), ...(value.kind === 'interactable' ? { definitionIds: [...(value.metadata.definitionIds || [])].sort((a, b) => a.localeCompare(b)) } : {}) };
  return hash(stable({ originalContentHash: value.baseContentHash, parameters }));
}

export async function readAssetPackagePreview(root, manifest, { inspectionId, candidateId, frame = 0 }) {
  if (!/^inspection-[a-f0-9]{32}$/.test(inspectionId) || !/^candidate-[a-f0-9]{24}$/.test(candidateId) || !Number.isInteger(frame) || frame < 0 || frame > 10000) throw new Error('素材包预览参数无效。');
  const base = path.join(assetPackageDirectories(root, manifest).staging, inspectionId), inspection = await readPackageJson(await confinedPackageFile(base, 'inspection.json'));
  if (Date.parse(inspection.expiresAt) < Date.now()) throw new Error('检查记录已过期。');
  const value = inspection.candidates.find(candidate => candidate.id === candidateId);
  const name = value?.payload.framePaths?.[frame] || (frame === 0 ? value?.payload.previewPath : null);
  const file = value?.files.find(file => file.path === name);
  if (!file || !file.mime.startsWith('image/') || file.bytes > 64 * 1024 * 1024) throw new Error('此素材没有可读取的预览帧。');
  const bytes = await readFile(await confinedPackageFile(path.join(base, candidateId, 'files'), name));
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('预览文件校验失败。');
  return { bytes, mime: file.mime };
}

export async function commitAssetPackages(root, manifest, input) {
  const request = packageCommitSchema.parse(input), requestHash = hash(stable({ selections: request.selections }));
  const previous = await readAssetPackageCommit(root, manifest, request.commandId);
  if (previous) {
    if (previous.requestHash !== requestHash) throw Object.assign(new Error('commandId 已用于不同的导入选择；请保留原请求或使用新命令。'), { status: 409 });
    return previous.result;
  }
  return withAssetPackageCommitLock(root, manifest, async ({ persistent, batchKey }) => {
    const replay = await readAssetPackageCommit(root, manifest, request.commandId);
    if (replay) {
      if (replay.requestHash !== requestHash) throw Object.assign(new Error('commandId 与原导入请求不一致。'), { status: 409 });
      return replay.result;
    }
    const { staging } = assetPackageDirectories(root, manifest), inspections = new Map(), selected = [], selectedIds = new Set();
    const existing = await listImportedAssets(root, manifest);
    for (const selection of request.selections) {
      const key = `${selection.inspectionId}:${selection.candidateId}`;
      if (selectedIds.has(key)) throw new Error('导入选择重复。');
      selectedIds.add(key);
      if (!inspections.has(selection.inspectionId)) {
        const base = path.join(staging, selection.inspectionId), inspection = await readPackageJson(await confinedPackageFile(base, 'inspection.json'));
        if (inspection.inspectionId !== selection.inspectionId || Date.parse(inspection.expiresAt) < Date.now()) throw new Error('检查记录已经过期，请重新选择素材包。');
        const original = await readFile(await confinedPackageFile(base, 'original.bin'));
        if (hash(original) !== inspection.packageHash || original.length !== inspection.bytes) throw new Error('上传原件在检查后发生变化。');
        inspections.set(selection.inspectionId, inspection);
      }
      const inspection = inspections.get(selection.inspectionId), value = structuredClone(inspection.candidates.find(candidate => candidate.id === selection.candidateId));
      if (!value || value.status === 'incomplete') throw new Error('所选素材不完整或不属于本次检查。');
      const allowed = new Set(value.requiredParameters.map(parameter => parameter.key));
      for (const parameter of Object.keys(selection.parameters)) if (!allowed.has(parameter)) throw new Error(`此素材不需要补充 ${parameter}；请重新检查后提交。`);
      for (const required of value.requiredParameters) if (selection.parameters[required.key] === undefined) throw new Error(`${value.label}：请补充${required.label}。`);
      if (value.kind === 'animation') {
        Object.assign(value.metadata, selection.parameters);
        Object.assign(value.payload.animation, selection.parameters);
        if (!Number.isFinite(value.metadata.fps) || value.metadata.fps <= 0 || typeof value.metadata.loop !== 'boolean') throw new Error('动画需要明确的 FPS 和循环设置。');
      }
      if (value.kind === 'interactable' && selection.parameters.definitionIds) {
        const ids = selection.parameters.definitionIds;
        if (new Set(ids).size !== ids.length || ids.some(id => !value.objects.some(object => object.definitionId === id))) throw new Error('所选物件不属于此交互物项目。');
        value.metadata.definitionIds = ids;
        value.payload.project.definitionIds = ids;
      }
      value.contentHash = effectiveContentHash(value);
      const old = existing.find(record => record.identityKey === value.identityKey && record.contentHash === value.contentHash);
      if (old) selected.push({ record: old, reused: true });
      else {
        const id = `imported:${hash(`${value.identityKey}:${value.contentHash}`).slice(0, 32)}`;
        const already = selected.find(item => item.record.id === id);
        if (already) { selected.push({ ...already, reused: true }); continue; }
        const now = new Date().toISOString();
        const record = { id, kind: value.kind, label: value.label, title: value.label, ...(value.mapType ? { mapType: value.mapType } : {}), createdAt: now, updatedAt: now, sourceIdentity: value.sourceIdentity, sourceVersion: value.sourceVersion ?? null, identityKey: value.identityKey, contentHash: value.contentHash, provenance: { ...value.provenance, importedAt: now, filename: inspection.filename, packageHash: inspection.packageHash, sourceStatusIsUnverified: true }, metadata: value.metadata, payload: value.payload, files: value.files, storageBatchKey: batchKey(request.commandId), originalUpload: { path: `uploads/${inspection.packageHash}.bin`, sha256: inspection.packageHash, bytes: inspection.bytes, filename: inspection.filename }, trashed: false, engineValidated: false };
        selected.push({ record, inspectionId: selection.inspectionId, candidateId: selection.candidateId, reused: false });
      }
    }
    const batch = batchKey(request.commandId), transaction = path.join(persistent, '.pending', randomUUID()), final = path.join(persistent, 'batches', batch);
    await mkdir(transaction, { recursive: true });
    try {
      const newRecords = selected.filter((item, index) => !item.reused && selected.findIndex(other => other.record.id === item.record.id) === index);
      for (const item of newRecords) {
        const destination = path.join(transaction, 'assets', item.record.id.slice(9));
        await mkdir(path.join(destination, 'files'), { recursive: true });
        for (const file of item.record.files) {
          const source = await confinedPackageFile(path.join(staging, item.inspectionId, item.candidateId, 'files'), file.path);
          const bytes = await readFile(source);
          if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('素材文件在检查后发生变化。');
          const target = path.join(destination, 'files', safeAssetPackagePath(file.path));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, bytes, { flag: 'wx' });
        }
        await writeFile(path.join(destination, 'record.json'), JSON.stringify(item.record), { flag: 'wx' });
      }
      await mkdir(path.join(transaction, 'uploads'));
      const copied = new Set();
      for (const [id, inspection] of inspections) {
        if (copied.has(inspection.packageHash)) continue;
        copied.add(inspection.packageHash);
        await copyFile(await confinedPackageFile(path.join(staging, id), 'original.bin'), path.join(transaction, 'uploads', `${inspection.packageHash}.bin`));
      }
      const resultAssets = new Map();
      for (const item of selected) {
        const old = resultAssets.get(item.record.id);
        resultAssets.set(item.record.id, { id: item.record.id, kind: item.record.kind, label: item.record.label, reused: old ? old.reused && item.reused : item.reused, viewPath: `/assets?asset=${encodeURIComponent(item.record.id)}` });
      }
      const assets = [...resultAssets.values()];
      const result = { commandId: request.commandId, status: 'completed', assets, importedCount: newRecords.length, reusedCount: assets.filter(asset => asset.reused).length };
      await writeFile(path.join(transaction, 'commit.json'), JSON.stringify({ commandId: request.commandId, requestHash, status: 'completed', completedAt: new Date().toISOString(), records: newRecords.map(item => item.record.id), result }), { flag: 'wx' });
      await mkdir(path.dirname(final), { recursive: true });
      await rename(transaction, final);
      return result;
    } catch (error) { await rm(transaction, { recursive: true, force: true }); throw error; }
  });
}
