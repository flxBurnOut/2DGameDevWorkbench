import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { instanceRect } from '../../features/scene-composer/render-model.mjs';
import JSZip from 'jszip';
import sharp from 'sharp';
import * as z from 'zod/v4';
import { listMapProjectRecords, readMapProject, saveMapProject } from './map-projects.mjs';
import { readMapProjectPackage, MAX_MAP_PROJECT_BYTES } from '../../features/map-stitcher/project-package.mjs';
import { getDocument, listDocuments, applyDocumentCommands, saveDocument } from './editor-documents.mjs';
import { inspectSceneImageSource, replaceSceneImageSource } from './image-edit-scene-sources.mjs';
import { inspectImageBytes, readImageAssetSource, MAX_IMAGE_BYTES } from './adapters/image-assets-source.mjs';
import { imageTargetRefSchema } from './image-edit-contract.mjs';
export { imageTargetRefSchema } from './image-edit-contract.mjs';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const taskId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const failure = (message, status = 400, code = 'INVALID_IMAGE_TARGET', details = {}) => Object.assign(new Error(message), { status, code, ...details });
export function checkTarget(target, input, editable = false) {
  if (target.revision !== input.expectedRevision || target.sha256 !== input.expectedSha256) throw failure('Source changed. Inspect and resolve the region again before editing.', 409, 'IMAGE_SOURCE_CONFLICT', { currentRevision: target.revision, expectedRevision: input.expectedRevision });
  if (editable && (!target.editable || target.locked)) throw failure(target.locked ? 'This image layer is locked.' : 'This target is read-only.', 409, 'IMAGE_TARGET_READ_ONLY');
}
const inside = (base, filename) => { const relative = path.relative(base, filename); return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const normalizeRef = ref => {
  const value = imageTargetRefSchema.parse(ref);
  if (['interactable', 'scene-instance'].includes(value.kind) && ((value.slot === 'visual') !== (value.index === undefined))) throw failure('默认图不接受 index；状态或序列图片需要明确 index。');
  return value;
};
export function encodeImageTarget(ref) {
  return `imgtarget:v1:${Buffer.from(JSON.stringify(canonical(normalizeRef(ref)))).toString('base64url')}`;
}
export function decodeImageTarget(targetId) {
  if (typeof targetId !== 'string' || targetId.length > 2048 || !/^imgtarget:v1:[a-zA-Z0-9_-]+$/.test(targetId)) throw failure('图片目标身份无效。');
  let ref;
  try { ref = normalizeRef(JSON.parse(Buffer.from(targetId.slice('imgtarget:v1:'.length), 'base64url').toString('utf8'))); }
  catch { throw failure('图片目标身份无法解析。'); }
  if (encodeImageTarget(ref) !== targetId) throw failure('图片目标身份不是规范编码。');
  return ref;
}
const refFor = value => typeof value === 'string' ? decodeImageTarget(value) : normalizeRef(value);
const publicTarget = ({ bytes: _bytes, ...target }) => target;

async function confinedRead(root, directory, filename, maxBytes) {
  const actualRoot = await realpath(root);
  const base = await realpath(directory);
  const file = await realpath(filename);
  if (!inside(actualRoot, base) || !inside(base, file)) throw failure('图片来源路径超出允许的目录。', 400, 'UNSAFE_IMAGE_TARGET_PATH');
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes) throw failure('图片来源文件无效或过大。');
  return readFile(file);
}
async function pixels(bytes, expected = {}) {
  const info = await inspectImageBytes(bytes);
  if ((expected.width !== undefined && info.width !== expected.width) || (expected.height !== undefined && info.height !== expected.height) || (expected.mime && info.mimeType !== expected.mime) || (expected.sha256 && info.sha256 !== expected.sha256)) throw failure('图片真实哈希、尺寸或格式与来源声明不符。', 409, 'IMAGE_SOURCE_CHANGED');
  const rgba = await sharp(bytes, { limitInputPixels: 64_000_000 }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  return { ...info, byteLength: bytes.length, rgbaSha256: hash(rgba) };
}
async function imageTask(root, manifest, selectedTaskId) {
  taskId.parse(selectedTaskId);
  const tasks = path.resolve(root, manifest.workspace.taskDirectory);
  const task = JSON.parse(await confinedRead(root, tasks, path.join(tasks, `${selectedTaskId}.json`), 128 * 1024 * 1024));
  const operation = task.input?.operation;
  const kind = operation === 'generate-prop' ? 'prop' : operation === 'generate-background' ? 'background' : ['edit-image', 'process-image'].includes(operation) ? task.input.kind || 'background' : null;
  if (task.id !== selectedTaskId || task.capabilityId !== 'image-assets' || task.status !== 'completed' || !['prop', 'background'].includes(kind) || !Array.isArray(task.outputs)) throw failure('图片目标需要已完成的 image-assets 任务。');
  const prefix = `${manifest.workspace.outputDirectory.replaceAll('\\', '/')}/${selectedTaskId}`;
  if (!['image.png', 'result.json'].every(name => task.outputs.includes(`${prefix}/${name}`))) throw failure('图片任务缺少实际图片或结果记录。');
  const outputRoot = path.resolve(root, manifest.workspace.outputDirectory);
  const directory = path.resolve(root, prefix);
  const actualDirectory = await realpath(directory);
  if (!inside(await realpath(outputRoot), actualDirectory)) throw failure('图片任务目录越界。');
  const metadata = JSON.parse(await confinedRead(root, directory, path.join(directory, 'result.json'), 1024 * 1024));
  if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width < 1 || metadata.height < 1) throw failure('图片任务缺少完整的真实尺寸记录。');
  const bytes = await confinedRead(root, directory, path.join(directory, 'image.png'), MAX_IMAGE_BYTES);
  const info = await pixels(bytes, { width: metadata.width, height: metadata.height, sha256: sha.parse(metadata.sha256), mime: 'image/png' });
  if (metadata.image !== 'image.png' || metadata.kind !== kind || (metadata.hasAlpha !== undefined && metadata.hasAlpha !== info.hasAlpha) || (metadata.hasTransparency !== undefined && metadata.hasTransparency !== info.hasTransparency)) throw failure('图片任务结果记录与实际 PNG 不符。', 409, 'IMAGE_SOURCE_CHANGED');
  return { task, metadata, bytes, info, kind, name: String(task.input.name || metadata.name || (kind === 'prop' ? '物品图片' : '背景图片')).slice(0, 200) };
}
function summary(ref, info, extra) {
  const binding = ['interactable', 'scene-instance'].includes(ref.kind) && ref.slot === 'visual'
    ? { imageBindingFingerprint: digest({ definitionId: extra.source.definitionId, ...(ref.kind === 'scene-instance' ? { instanceId: ref.instanceId, materialId: extra.source.materialId } : {}), slot: ref.slot, assetId: extra.source.assetId, sha256: info.sha256 }) } : {};
  return { targetId: encodeImageTarget(ref), targetRef: ref, sha256: info.sha256, rgbaSha256: info.rgbaSha256, width: info.width, height: info.height, mimeType: info.mimeType, hasAlpha: info.hasAlpha, hasTransparency: info.hasTransparency, ...extra, ...binding };
}
async function mapTarget(root, manifest, ref, source) {
  const { record, bytes: packageBytes } = source || await readMapProject(root, manifest, ref.projectId);
  const actualRoot = await realpath(root);
  const outputRoot = await realpath(path.resolve(root, manifest.workspace.outputDirectory));
  const projectRoot = await realpath(path.resolve(root, manifest.workspace.outputDirectory, record.id));
  if (!inside(actualRoot, outputRoot) || !inside(outputRoot, projectRoot)) throw failure('地图图片源目录越过工作区或输出目录。', 400, 'UNSAFE_IMAGE_TARGET_PATH');
  const { draft, images } = await readMapProjectPackage(packageBytes);
  const tile = draft.snapshot.tiles.find(tile => tile.key === ref.tileKey);
  const image = tile?.images[ref.layer];
  if (!image) throw failure('指定地图块中的源图片不存在。', 404, 'IMAGE_TARGET_NOT_FOUND');
  const bytes = Buffer.from(images.get(image.path));
  const info = await pixels(bytes, { width: image.width, height: image.height, mime: image.type, sha256: image.generation?.sha256 });
  const locked = draft.snapshot.imageLocks[ref.layer] === true;
  return { ...summary(ref, info, { revision: record.revision, kind: 'background', name: `${record.title} · ${ref.tileKey} · ${ref.layer}`, locked, editable: !locked, lockScope: { kind: 'image-type-all-tiles', layer: ref.layer }, generation: image.generation, source: { projectId: ref.projectId, tileKey: ref.tileKey, layer: ref.layer, path: image.path, name: image.name, projectSha256: record.sha256 }, viewPath: `/tools/map-stitcher?project=${encodeURIComponent(ref.projectId)}`, dependencies: { preview: 'recompute-on-open', objectExtractionRequired: ['black', 'white'].includes(ref.layer), surfaceIsDraft: tile.surfaceIsDraft ?? false } }), bytes };
}
function resolveSlot(document, ref) {
  if (document.kind !== 'interactable' || document.id !== ref.documentId) throw failure('目标不是指定的交互物文档。');
  const object = document.content.objects.find(object => object.definitionId === ref.definitionId);
  if (!object) throw failure('交互物定义已不存在。', 404, 'IMAGE_TARGET_NOT_FOUND');
  return resolveObjectSlot(document.content, object, ref);
}
function resolveObjectSlot(project, object, ref) {
  let entry;
  if (ref.slot === 'toggle-state') {
    if (object.behavior.kind !== 'toggle') throw failure('该物件没有切换状态图片。');
    entry = object.behavior.states[ref.index];
  } else if (ref.slot === 'sequence-entry') {
    if (object.behavior.kind !== 'sequence') throw failure('该物件没有序列条目图片。');
    entry = object.behavior.entries[ref.index];
  }
  if (ref.slot !== 'visual' && !entry) throw failure('指定状态或序列条目已不存在。', 404, 'IMAGE_TARGET_NOT_FOUND');
  const assetId = ref.slot === 'visual' ? object.visual.assetId : entry.appearance.assetId || object.visual.assetId;
  const asset = project.assets.find(asset => asset.id === assetId);
  if (!asset || !asset.mime.startsWith('image/')) throw failure('指定槽位没有可编辑的静态源图片。', 404, 'IMAGE_TARGET_NOT_FOUND');
  const animated = ref.slot !== 'visual' && Boolean(entry.appearance.animation || object.visual.idleAnimation);
  return { object, entry, asset, animated, inherited: Boolean(entry && !entry.appearance.assetId) };
}
async function documentTarget(root, manifest, ref, selectedDocument) {
  const document = selectedDocument || (await getDocument(root, manifest, { documentId: ref.documentId })).document;
  const { object, entry, asset, animated, inherited } = resolveSlot(document, ref);
  const source = await readImageAssetSource(asset.source, root);
  const info = await pixels(source.buffer, { mime: asset.mime, sha256: asset.generation?.sha256 });
  const slotFingerprint = digest({ definitionId: object.definitionId, slot: ref.slot, index: ref.index, content: entry || object.visual, assetId: asset.id, sha256: info.sha256 });
  return { ...summary(ref, info, { revision: document.revision, slotFingerprint, kind: 'prop', name: `${document.name} · ${object.displayName} · ${entry?.name || '默认外观'}`, locked: false, editable: !animated, ...(animated ? { readOnlyReason: '状态正在播放动画，请在原编辑器明确选择静态外观后再局部调整。' } : {}), inherited, generation: asset.generation, source: { documentId: document.id, definitionId: object.definitionId, assetId: asset.id, name: asset.name, slot: ref.slot, index: ref.index }, viewPath: document.viewPath, willStopDefaultAnimations: ref.slot === 'visual' && Boolean(object.visual.idleAnimation || object.visual.focusAnimation) }), bytes: source.buffer };
}
function sceneInstanceBinding(document, ref) {
  if (document.kind !== 'scene' || document.id !== ref.documentId) throw failure('目标不是指定场景文档。');
  const instance = document.content.instances.find(instance => instance.id === ref.instanceId);
  if (!instance) throw failure('场景实例已不存在。', 404, 'IMAGE_TARGET_NOT_FOUND');
  const material = document.content.materials.find(material => material.id === instance.materialId);
  if (!material || material.project.objects.length !== 1) throw failure('场景实例缺少明确的单物件素材。', 409, 'IMAGE_TARGET_NOT_FOUND');
  const slot = resolveObjectSlot(material.project, material.project.objects[0], ref);
  return { instance, material, ...slot, sharedInstanceCount: document.content.instances.filter(other => other.materialId === material.id).length };
}
async function sceneInstanceTarget(root, manifest, ref, selectedDocument) {
  const document = selectedDocument || (await getDocument(root, manifest, { documentId: ref.documentId })).document;
  const { instance, material, object, entry, asset, animated, inherited, sharedInstanceCount } = sceneInstanceBinding(document, ref);
  const source = await readImageAssetSource(asset.source, root), info = await pixels(source.buffer, { mime: asset.mime, sha256: asset.generation?.sha256 });
  const hasAnimation = animated || (ref.slot === 'visual' && Boolean(object.visual.idleAnimation || object.visual.focusAnimation));
  const slotFingerprint = digest({ instanceId: instance.id, materialId: material.id, definitionId: object.definitionId, slot: ref.slot, index: ref.index, content: entry || object.visual, assetId: asset.id, sha256: info.sha256 });
  return { ...summary(ref, info, { revision: document.revision, slotFingerprint, kind: 'prop', name: `${document.name} · ${instance.name} · ${entry?.name || '默认外观'}`,
    locked: instance.locked, editable: !instance.locked && !hasAnimation, ...(hasAnimation ? { readOnlyReason: '场景实例正在使用动画；请在源素材中明确选择静态外观后再局部调整。' } : {}), inherited,
    placement: { ...instanceRect(instance, material), instanceScale: instance.scale, visualScale: object.visual.scale,
      flipH: Boolean(instance.flipH) !== Boolean(object.visual.flipH), flipV: Boolean(object.visual.flipV) },
    scope: 'single-instance', affectedInstanceIds: [instance.id], sharedInstanceCount, generation: asset.generation,
    source: { documentId: document.id, instanceId: instance.id, materialId: material.id, definitionId: object.definitionId, assetId: asset.id, name: asset.name, slot: ref.slot, index: ref.index }, viewPath: document.viewPath }), bytes: source.buffer };
}
async function sceneLayerTarget(root, manifest, ref, selectedDocument) {
  const document = selectedDocument || (await getDocument(root, manifest, { documentId: ref.documentId })).document;
  if (document.kind !== 'scene') throw failure('指定文档不是场景。');
  const selected = document.content.map?.layers.find(layer => layer.id === ref.layerId);
  if (!selected) throw failure('场景地图层不存在。', 404, 'IMAGE_TARGET_NOT_FOUND');
  const image = await inspectSceneImageSource(root, document.content, ref.layerId);
  const info = await pixels(image.bytes, { width: selected.width, height: selected.height });
  const { bytes: _bytes, ...mapping } = image;
  const slotFingerprint = digest({ layerId: selected.id, sourceSha256: image.sourceEntry?.sha256 || hash(document.content.map.source) });
  return { ...summary(ref, info, { ...mapping, revision: document.revision, slotFingerprint, kind: 'background', name: `${document.name} · ${selected.name}`, locked: selected.locked || image.locked,
    placement: { x: document.content.map.origin.x + document.content.map.offset.x, y: document.content.map.origin.y + document.content.map.offset.y,
      width: selected.width, height: selected.height, flipH: false, flipV: false },
    editable: !selected.locked && image.editable, scope: 'scene-snapshot-layer', affectedInstanceIds: [],
    source: { documentId: document.id, layerId: selected.id, name: selected.name }, viewPath: document.viewPath }), bytes: image.bytes };
}
async function splitPartTarget(root,manifest,ref,selectedDocument) {
  const document=selectedDocument || (await getDocument(root,manifest,{documentId:ref.documentId})).document;
  const split=document.content.mapSplit;
  const element=split?.elements.find(item=>item.id===ref.elementId);
  const part=element?.parts.find(item=>item.id===ref.partId);
  if (document.kind!=='scene' || !document.content.map || !part) throw failure('场景分层绘制片不存在。',404,'IMAGE_TARGET_NOT_FOUND');
  const full=Buffer.from(part.source.slice(part.source.indexOf(',')+1),'base64');
  const box=ref.window || {x:0,y:0,width:part.width,height:part.height};
  if (box.x+box.width>part.width || box.y+box.height>part.height) throw failure('局部窗口超出绘制片原图。');
  const tooLarge=box.width>3840 || box.height>3840 || box.width*box.height>8_294_400;
  if (tooLarge && ref.window) throw failure('请选择不超过 8,294,400 像素的局部窗口。');
  const bytes=ref.window ? await sharp(full,{limitInputPixels:64_000_000}).extract({left:box.x,top:box.y,width:box.width,height:box.height}).png().toBuffer() : full;
  let info;
  if (tooLarge && full.length>MAX_IMAGE_BYTES) {
    const raw=await sharp(full,{limitInputPixels:64_000_000}).toColourspace('srgb').ensureAlpha().raw().toBuffer();
    let hasTransparency=false;
    for(let i=3;i<raw.length;i+=4) if(raw[i]<255){hasTransparency=true;break;}
    info={width:box.width,height:box.height,sha256:hash(full),rgbaSha256:hash(raw),mimeType:'image/png',hasAlpha:true,hasTransparency};
  } else info=await pixels(bytes,{width:box.width,height:box.height});
  const reason=split.stale?'地图已替换，需先迁移分层。':tooLarge?'图层超过单次精修尺寸，请传入绘制片像素坐标 window。':null;
  const {origin,offset}=document.content.map;
  const slotFingerprint=digest({candidateId:split.candidateId,sourceHash:split.sourceHash,elementId:element.id,partId:part.id,
    mask:part.mask && hash(part.mask),partSha256:hash(full),window:ref.window});
  return {...summary(ref,info,{revision:document.revision,slotFingerprint,kind:element.kind==='object'?'prop':'background',
    name:`${document.name} · ${element.name} · ${part.id}`,scope:'scene-split-part',editable:!reason && !element.locked,locked:element.locked,
    ...(reason?{readOnlyReason:reason}:{}),placement:{x:origin.x+offset.x+element.x+part.x+box.x,y:origin.y+offset.y+element.y+part.y+box.y,width:box.width,height:box.height,flipH:false,flipV:false},
    source:{documentId:ref.documentId,candidateId:split.candidateId,elementId:element.id,partId:part.id,name:element.name,fullWidth:part.width,fullHeight:part.height},viewPath:document.viewPath}),bytes};
}
export async function readImageTarget(root, manifest, targetIdOrRef) {
  const ref = refFor(targetIdOrRef);
  if (ref.kind === 'map-layer') return mapTarget(root, manifest, ref);
  if (ref.kind === 'interactable') return documentTarget(root, manifest, ref);
  if (ref.kind === 'scene-instance') return sceneInstanceTarget(root, manifest, ref);
  if (ref.kind === 'scene-split-part') return splitPartTarget(root,manifest,ref);
  if (ref.kind === 'image-task') {
    const image = await imageTask(root, manifest, ref.taskId);
    return { ...summary(ref, image.info, { revision: image.info.sha256, kind: image.kind, name: image.name, locked: false, editable: true, immutableSource: true, adoptionMode: 'saved_variant', source: { taskId: ref.taskId }, viewPath: `${image.kind === 'prop' ? '/tools/interactable-editor' : '/tools/map-stitcher'}?imageTask=${encodeURIComponent(ref.taskId)}` }), bytes: image.bytes };
  }
  return sceneLayerTarget(root, manifest, ref);
}

export async function listImageTargets(root, manifest, input = {}) {
  const parsed = z.object({ scope: z.object({ kind: z.enum(['map-layer', 'interactable', 'image-task', 'scene-layer', 'scene-instance', 'scene-split-part']).optional(), projectId: z.string().max(101).optional(), documentId: id.optional(), taskId: taskId.optional() }).strict().optional(), query: z.string().max(2000).default(''), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }).strict().parse(input);
  const scope = parsed.scope || {}; const refs = []; const issues = [];
  const add = (ref, name) => {
    if (scope.kind && ref.kind !== scope.kind) return;
    if (scope.projectId && ref.projectId !== scope.projectId) return;
    if (scope.documentId && ref.documentId !== scope.documentId) return;
    if (scope.taskId && ref.taskId !== scope.taskId) return;
    if (parsed.query && !`${name} ${JSON.stringify(ref)}`.toLowerCase().includes(parsed.query.toLowerCase())) return;
    refs.push({ ref, name });
  };
  if (!scope.kind || scope.kind === 'map-layer') for (const record of await listMapProjectRecords(root, manifest, issues)) {
    if (scope.projectId && scope.projectId !== record.projectId) continue;
    try {
      const { bytes } = await readMapProject(root, manifest, record.projectId);
      const { draft } = await readMapProjectPackage(bytes);
      for (const tile of draft.snapshot.tiles) for (const imageLayer of Object.keys(tile.images)) add({ kind: 'map-layer', projectId: record.projectId, tileKey: tile.key, layer: imageLayer }, `${record.title} ${tile.key} ${imageLayer}`);
    } catch (error) { issues.push({ source: 'map-layer', id: record.projectId, message: error.message }); }
  }
  if (!scope.kind || ['interactable', 'scene-layer', 'scene-instance', 'scene-split-part'].includes(scope.kind)) {
    let offset = 0;
    do {
      const page = await listDocuments(root, manifest, { limit: 200, offset });
      for (const record of page.documents) {
        if (scope.documentId && scope.documentId !== record.id) continue;
        if ((scope.kind === 'interactable' && record.kind !== 'interactable') || (['scene-layer', 'scene-instance', 'scene-split-part'].includes(scope.kind) && record.kind !== 'scene')) continue;
        try {
          const { document } = await getDocument(root, manifest, { documentId: record.id });
          if (document.kind === 'scene') {
            for (const element of document.content.mapSplit?.elements || []) for (const part of element.parts)
              add({kind:'scene-split-part',documentId:document.id,elementId:element.id,partId:part.id},`${document.name} ${element.name} ${part.id}`);
            for (const mapLayer of document.content.map?.layers || []) add({ kind: 'scene-layer', documentId: document.id, layerId: mapLayer.id }, `${document.name} ${mapLayer.name}`);
            for (const instance of document.content.instances) {
              const material = document.content.materials.find(material => material.id === instance.materialId), object = material?.project.objects[0];
              if (!object) continue;
              const base = { kind: 'scene-instance', documentId: document.id, instanceId: instance.id };
              if (object.visual.assetId) add({ ...base, slot: 'visual' }, `${document.name} ${instance.name} 默认外观`);
              const entries = object.behavior.kind === 'toggle' ? object.behavior.states : object.behavior.kind === 'sequence' ? object.behavior.entries : [];
              for (const [index, entry] of entries.entries()) if (entry.appearance.assetId || object.visual.assetId) add({ ...base, slot: object.behavior.kind === 'toggle' ? 'toggle-state' : 'sequence-entry', index }, `${document.name} ${instance.name} ${entry.name}`);
            }
          } else for (const object of document.content.objects) {
            if (object.visual.assetId) add({ kind: 'interactable', documentId: document.id, definitionId: object.definitionId, slot: 'visual' }, `${document.name} ${object.displayName} 默认外观`);
            const entries = object.behavior.kind === 'toggle' ? object.behavior.states : object.behavior.kind === 'sequence' ? object.behavior.entries : [];
            for (const [index, entry] of entries.entries()) if (entry.appearance.assetId || object.visual.assetId) add({ kind: 'interactable', documentId: document.id, definitionId: object.definitionId, slot: object.behavior.kind === 'toggle' ? 'toggle-state' : 'sequence-entry', index }, `${document.name} ${object.displayName} ${entry.name}`);
          }
        } catch (error) { issues.push({ source: 'document', id: record.id, message: error.message }); }
      }
      offset = page.nextOffset;
    } while (offset !== null && offset !== undefined);
  }
  if (!scope.kind || scope.kind === 'image-task') {
    let entries = [];
    try { entries = await readdir(path.resolve(root, manifest.workspace.taskDirectory)); } catch (error) { if (error.code !== 'ENOENT') issues.push({ source: 'image-task', message: error.message }); }
    for (const entry of entries.filter(entry => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}\.json$/.test(entry))) {
      const selectedTaskId = entry.slice(0, -5);
      if (scope.taskId && scope.taskId !== selectedTaskId) continue;
      try {
        const tasks = path.resolve(root, manifest.workspace.taskDirectory);
        const record = JSON.parse(await confinedRead(root, tasks, path.join(tasks, entry), 128 * 1024 * 1024));
        if (record.id === selectedTaskId && record.capabilityId === 'image-assets' && record.status === 'completed') add({ kind: 'image-task', taskId: selectedTaskId }, String(record.input?.name || selectedTaskId));
      } catch (error) { issues.push({ source: 'image-task', id: selectedTaskId, message: error.message }); }
    }
  }
  refs.sort((a, b) => encodeImageTarget(a.ref).localeCompare(encodeImageTarget(b.ref)));
  const targets = [];
  for (const { ref } of refs.slice(parsed.offset, parsed.offset + parsed.limit)) try {
    const { bytes: _bytes, ...target } = await readImageTarget(root, manifest, ref);
    targets.push(target);
  } catch (error) { issues.push({ source: ref.kind, targetId: encodeImageTarget(ref), message: error.message }); }
  return { targets, total: refs.length, nextOffset: parsed.offset + parsed.limit < refs.length ? parsed.offset + parsed.limit : null, ...(issues.length ? { issues } : {}) };
}

async function adoptedMapTarget(root, manifest, ref, record, marker, fingerprint) {
  if (marker.fingerprint !== fingerprint || marker.targetId !== encodeImageTarget(ref)) throw failure('采用命令 ID 已用于不同的图片请求。', 409, 'COMMAND_ID_REUSED');
  const base = path.join(root, manifest.workspace.outputDirectory, record.id);
  const bytes = await confinedRead(root, base, path.resolve(root, marker.sourcePath), MAX_MAP_PROJECT_BYTES);
  if (hash(bytes) !== marker.projectSha256) throw failure('原地图采用版本已损坏。', 409, 'IMAGE_SOURCE_CHANGED');
  const target = await mapTarget(root, manifest, ref, { record: { ...record, revision: marker.revision, sha256: marker.projectSha256 }, bytes });
  return { target: publicTarget(target), revision: marker.revision, currentRevision: record.revision, replayed: true, adoption: { status: 'adopted', targetId: target.targetId, sourceTaskId: marker.sourceTaskId, sha256: marker.sha256, revision: marker.revision, commandId: marker.commandId, previewInvalidated: true } };
}
export async function applyImageTarget(root, manifest, input) {
  const parsed = z.object({ targetId: z.string().min(1).max(2048), expectedRevision: z.union([z.number().int().positive(), sha]), expectedSha256: sha, expectedSlotFingerprint: sha.optional(), bytes: z.custom(value => Buffer.isBuffer(value) || value instanceof Uint8Array), candidate: z.object({ taskId, sha256: sha }).strict(), commandId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/), name: z.string().min(1).max(200).optional() }).strict().parse(input);
  const ref = decodeImageTarget(parsed.targetId);
  const candidate = await imageTask(root, manifest, parsed.candidate.taskId);
  const candidateBytes = Buffer.from(parsed.bytes);
  if (hash(candidateBytes) !== parsed.candidate.sha256 || candidate.info.sha256 !== parsed.candidate.sha256 || !candidateBytes.equals(candidate.bytes)) throw failure('采用图片与候选任务的真实 PNG 不一致。', 409, 'IMAGE_CANDIDATE_CHANGED');
  const fingerprint = digest({ targetId: parsed.targetId, expectedRevision: parsed.expectedRevision, expectedSha256: parsed.expectedSha256, expectedSlotFingerprint: parsed.expectedSlotFingerprint, candidate: parsed.candidate, name: parsed.name });
  if (ref.kind === 'image-task') {
    const source = await readImageTarget(root, manifest, ref);
    if (source.revision !== parsed.expectedRevision || source.sha256 !== parsed.expectedSha256) throw failure('独立图片源已变化。', 409, 'IMAGE_TARGET_CONFLICT');
    if (source.width !== candidate.info.width || source.height !== candidate.info.height) throw failure('局部调整不能改变源图尺寸。');
    const target = await readImageTarget(root, manifest, { kind: 'image-task', taskId: candidate.task.id });
    return { target: publicTarget(target), revision: target.revision, currentRevision: source.revision, replayed: false, adoption: { status: 'saved_variant', assetId: `image:${candidate.task.id}`, sourceTaskId: candidate.task.id, sourceTargetId: source.targetId, sha256: target.sha256, commandId: parsed.commandId, sourceChanged: false } };
  }
  if (!Number.isSafeInteger(parsed.expectedRevision)) throw failure('工程图片采用需要整数版本。');
  if (ref.kind === 'scene-split-part') {
    const {document}=await getDocument(root,manifest,{documentId:ref.documentId,revision:parsed.expectedRevision});
    const source=await splitPartTarget(root,manifest,ref,document);
    checkSource(source,parsed,candidate);
    const content=document.content;
    const part=content.mapSplit.elements.find(el=>el.id===ref.elementId).parts.find(p=>p.id===ref.partId);
    let png=candidateBytes;
    if (ref.window) {
      const box=ref.window;
      const decode=buffer=>sharp(buffer,{limitInputPixels:64_000_000}).toColourspace('srgb').ensureAlpha().raw().toBuffer();
      const full=await decode(Buffer.from(part.source.split(',')[1],'base64')), replacement=await decode(png);
      for(let y=0;y<box.height;y++) replacement.copy(full,((box.y+y)*part.width+box.x)*4,y*box.width*4,(y+1)*box.width*4);
      png=await sharp(full,{raw:{width:part.width,height:part.height,channels:4}}).png().toBuffer();
    }
    part.source='data:image/png;base64,'+png.toString('base64');
    content.mapSplit.review='unverified';
    const result=await saveDocument(root,manifest,{documentId:ref.documentId,expectedRevision:parsed.expectedRevision,commandId:parsed.commandId,content},{respectLocks:true});
    const target=await splitPartTarget(root,manifest,ref,result.document);
    return {target:publicTarget(target),revision:result.document.revision,currentRevision:result.currentRevision,replayed:result.replayed,
      adoption:{status:'adopted',targetId:target.targetId,documentId:ref.documentId,elementId:ref.elementId,partId:ref.partId,scope:'scene-split-part',sourceTaskId:candidate.task.id,sha256:target.sha256,revision:target.revision,commandId:parsed.commandId}};
  }
  if (ref.kind === 'interactable') {
    const { document } = await getDocument(root, manifest, { documentId: ref.documentId, revision: parsed.expectedRevision });
    const source = await documentTarget(root, manifest, ref, document);
    checkSource(source, parsed, candidate);
    const assetId = `image_${hash(candidate.task.id).slice(0, 32)}`;
    const asset = { id: assetId, name: parsed.name || source.source.name, mime: 'image/png', source: `data:image/png;base64,${candidate.bytes.toString('base64')}`, generation: { sourceTaskId: candidate.task.id, sha256: candidate.info.sha256 } };
    const existing = document.content.assets.find(asset => asset.id === assetId);
    if (existing && (existing.source !== asset.source || existing.generation?.sourceTaskId !== candidate.task.id || existing.generation?.sha256 !== asset.generation.sha256)) throw failure('候选素材身份冲突。', 409, 'IMAGE_ASSET_ID_CONFLICT');
    const commands = [...(!existing ? [{ type: 'add-asset', asset }] : []), { type: 'bind-asset', definitionId: ref.definitionId, assetId, target: ref.slot, ...(ref.index !== undefined ? { index: ref.index } : {}) }, ...(ref.slot === 'visual' ? [{ type: 'set-visual', definitionId: ref.definitionId, visual: { idleAnimation: '', focusAnimation: '' } }] : [])];
    const result = await applyDocumentCommands(root, manifest, { documentId: ref.documentId, expectedRevision: parsed.expectedRevision, commandId: parsed.commandId, commands });
    const target = await documentTarget(root, manifest, ref, result.document);
    return { target: publicTarget(target), revision: result.document.revision, currentRevision: result.currentRevision, replayed: result.replayed, adoption: { status: 'adopted', targetId: target.targetId, documentId: ref.documentId, definitionId: ref.definitionId, slot: ref.slot, index: ref.index, assetId, sourceTaskId: candidate.task.id, sha256: target.sha256, revision: target.revision, commandId: parsed.commandId } };
  }
  if (ref.kind === 'scene-instance' || ref.kind === 'scene-layer') {
    const { document } = await getDocument(root, manifest, { documentId: ref.documentId, revision: parsed.expectedRevision });
    const source = ref.kind === 'scene-instance' ? await sceneInstanceTarget(root, manifest, ref, document) : await sceneLayerTarget(root, manifest, ref, document);
    checkSource(source, parsed, candidate);
    let content, materialId, assetId;
    if (ref.kind === 'scene-instance') {
      const binding = sceneInstanceBinding(document, ref);
      content = structuredClone(document.content);
      const material = structuredClone(binding.material);
      materialId = `material_image_${digest({ targetId: parsed.targetId, commandId: parsed.commandId, candidate: parsed.candidate }).slice(0, 32)}`;
      material.id = materialId;
      assetId = `image_${hash(candidate.task.id).slice(0, 32)}`;
      const asset = { id: assetId, name: parsed.name || source.source.name, mime: 'image/png', source: `data:image/png;base64,${candidate.bytes.toString('base64')}`, generation: { sourceTaskId: candidate.task.id, sha256: candidate.info.sha256 } };
      const existing = material.project.assets.find(asset => asset.id === assetId);
      if (existing && (existing.source !== asset.source || existing.generation?.sourceTaskId !== candidate.task.id || existing.generation?.sha256 !== asset.generation.sha256)) throw failure('候选素材身份冲突。', 409, 'IMAGE_ASSET_ID_CONFLICT');
      if (!existing) material.project.assets.push(asset);
      const object = material.project.objects[0];
      if (ref.slot === 'visual') object.visual.assetId = assetId;
      else (ref.slot === 'toggle-state' ? object.behavior.states : object.behavior.entries)[ref.index].appearance.assetId = assetId;
      const collision = content.materials.find(existing => existing.id === materialId);
      if (collision && digest(collision) !== digest(material)) throw failure('派生素材身份冲突。', 409, 'IMAGE_MATERIAL_ID_CONFLICT');
      if (!collision) content.materials.push(material);
      content.instances.find(instance => instance.id === ref.instanceId).materialId = materialId;
    } else content = await replaceSceneImageSource(root, document.content, ref.layerId, { bytes: candidate.bytes, sha256: candidate.info.sha256, taskId: candidate.task.id, width: candidate.info.width, height: candidate.info.height, mimeType: 'image/png' });
    const result = await saveDocument(root, manifest, { documentId: ref.documentId, expectedRevision: parsed.expectedRevision, commandId: parsed.commandId, content }, { respectLocks: true });
    const target = ref.kind === 'scene-instance' ? await sceneInstanceTarget(root, manifest, ref, result.document) : await sceneLayerTarget(root, manifest, ref, result.document);
    return { target: publicTarget(target), revision: result.document.revision, currentRevision: result.currentRevision, replayed: result.replayed,
      adoption: { status: 'adopted', targetId: target.targetId, documentId: ref.documentId, sourceTaskId: candidate.task.id, sha256: target.sha256, revision: target.revision, commandId: parsed.commandId,
        scope: source.scope, affectedInstanceIds: source.affectedInstanceIds, ...(ref.kind === 'scene-instance' ? { instanceId: ref.instanceId, sourceMaterialId: source.source.materialId, materialId, assetId, sharedInstanceCount: source.sharedInstanceCount, slot: ref.slot, index: ref.index } : { layerId: ref.layerId, sourceEntry: target.sourceEntry }) } };
  }
  const source = await readMapProject(root, manifest, ref.projectId);
  const previous = source.record.imageAdoptions?.find(marker => marker.commandId === parsed.commandId);
  if (previous) return adoptedMapTarget(root, manifest, ref, source.record, previous, fingerprint);
  const target = await mapTarget(root, manifest, ref, source);
  checkSource(target, parsed, candidate);
  const { draft, images } = await readMapProjectPackage(source.bytes);
  const selected = draft.snapshot.tiles.find(tile => tile.key === ref.tileKey).images[ref.layer];
  const references = draft.snapshot.tiles.flatMap(tile => Object.values(tile.images));
  const zip = await JSZip.loadAsync(source.bytes);
  let imagePath = selected.path;
  if (references.filter(image => image.path === selected.path).length > 1) {
    let next = 0; while (zip.file(`images/${next}.bin`)) next++;
    imagePath = `images/${next}.bin`;
  }
  Object.assign(selected, { path: imagePath, name: parsed.name || selected.name, type: 'image/png', size: candidate.bytes.length, width: candidate.info.width, height: candidate.info.height, generation: { sourceTaskId: candidate.task.id, sha256: candidate.info.sha256 } });
  // Source image records and all geometry remain intact; this derived preview
  // belongs to the old version and must be rebuilt by the editor.
  zip.file(imagePath, candidate.bytes); zip.file('map-project.json', JSON.stringify(draft)); zip.remove('preview.png');
  for (const entry of Object.values(zip.files)) entry.date = new Date('1980-01-01T00:00:00Z');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  // Read back before commit, including provenance and untouched-image bytes.
  const checked = await readMapProjectPackage(bytes);
  for (const image of references.filter(image => image !== selected)) if (!Buffer.from(checked.images.get(image.path)).equals(Buffer.from(images.get(image.path)))) throw failure('未选中的地图源图片发生变化。');
  const marker = { commandId: parsed.commandId, fingerprint, targetId: parsed.targetId, tileKey: ref.tileKey, layer: ref.layer, sourceSha256: parsed.expectedSha256, sourceTaskId: candidate.task.id, sha256: candidate.info.sha256 };
  let record;
  try { record = await saveMapProject(root, manifest, ref.projectId, parsed.expectedRevision, bytes, { imageAdoption: marker }); }
  catch (error) {
    if (error.status !== 409) throw error;
    const current = await readMapProject(root, manifest, ref.projectId);
    const adopted = current.record.imageAdoptions?.find(entry => entry.commandId === parsed.commandId);
    if (adopted) return adoptedMapTarget(root, manifest, ref, current.record, adopted, fingerprint);
    throw error;
  }
  const adopted = await mapTarget(root, manifest, ref, { record, bytes });
  return { target: publicTarget(adopted), revision: record.revision, currentRevision: record.revision, replayed: false, adoption: { status: 'adopted', targetId: parsed.targetId, sourceTaskId: candidate.task.id, sha256: candidate.info.sha256, revision: record.revision, commandId: parsed.commandId, previewInvalidated: true, objectExtractionRequired: ['black', 'white'].includes(ref.layer) } };
}
function checkSource(source, input, candidate) {
  if (source.revision !== input.expectedRevision || source.sha256 !== input.expectedSha256 || (input.expectedSlotFingerprint !== undefined && source.slotFingerprint !== input.expectedSlotFingerprint)) throw failure('图片目标版本、源哈希或槽位绑定已变化，请保留候选并重新读取。', 409, 'IMAGE_TARGET_CONFLICT', { currentRevision: source.revision });
  if (source.locked) throw failure('目标图片类型已锁定；地图锁定覆盖该图片类型的所有图块。', 409, 'IMAGE_TARGET_LOCKED');
  if (!source.editable) throw failure(source.readOnlyReason || '该图片目标目前只读。', 400, 'IMAGE_TARGET_READ_ONLY');
  if (source.width !== candidate.info.width || source.height !== candidate.info.height) throw failure('局部调整不能改变源图尺寸。', 400, 'IMAGE_DIMENSIONS_CHANGED');
}
