import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { sourceMapCollisions } from '../../features/scene-composer/map-collisions.mjs';
import { readMapProjectPackage, MAX_MAP_PROJECT_BYTES } from '../../features/map-stitcher/project-package.mjs';
import { readImageAssetSource, inspectImageBytes } from './adapters/image-assets-source.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const fail = (message, code = 'IMAGE_SCENE_SOURCE_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const readonly = message => { throw fail(message, 'IMAGE_SCENE_SOURCE_READ_ONLY', 409); };
const safeName = name => typeof name === 'string' && !/[\\:]/.test(name) && !Array.from(name).some(character => character.charCodeAt(0) < 32) && !name.startsWith('/') && !name.split('/').some(part => part === '..' || part === '.');
const imagePath = name => safeName(name) && /^images\/[^/]+$/.test(name);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const sourceFields = ['overall', 'surface', 'object', 'black', 'white'];
const epoch = new Date('1980-01-01T00:00:00Z');
const zipContents = new WeakMap();

function inlineZip(source) {
  const match = typeof source === 'string' && /^data:application\/zip;base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
  if (!match || match[1].length > Math.ceil(MAX_MAP_PROJECT_BYTES / 3) * 4) throw fail('场景地图缺少可校验的内嵌源 ZIP；请从场景的源文件入口继续编辑。');
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length || bytes.length > MAX_MAP_PROJECT_BYTES || bytes.toString('base64') !== match[1]) throw fail('场景地图源 ZIP 编码或大小无效。');
  return bytes;
}
async function boundedZip(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > 22000) throw fail('场景地图源 ZIP 文件过多。');
  let total = 0;
  for (const entry of entries) {
    if (!safeName(entry.name) || (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)) throw fail('场景地图源 ZIP 路径无效。');
    if (entry.dir) continue;
    if (!['map-project.json', 'map_stitch_state.json', 'preview.png'].includes(entry.name) && !imagePath(entry.name)) throw fail('场景地图源 ZIP 包含不支持的文件。');
    const size = entry._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0) throw fail('场景地图源 ZIP 缺少可靠的解压尺寸。');
    total += size;
    if (total > MAX_MAP_PROJECT_BYTES) throw fail('场景地图源 ZIP 解压超过 256 MiB。');
  }
  const contents = new Map();
  let actualTotal = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const max = entry.name.endsWith('.json') ? 16 * 1024 * 1024 : entry.name === 'preview.png' ? 2 * 1024 * 1024 : 40 * 1024 * 1024;
    const declared = entry._data.uncompressedSize, chunks = [];
    if (declared > max) throw fail('场景地图源 ZIP 单个文件过大。');
    let size = 0, crc = 0;
    const stream = entry.nodeStream('nodebuffer');
    await new Promise((resolve, reject) => {
      let stopped = false;
      stream.on('data', chunk => {
        if (stopped) return;
        size += chunk.length;
        actualTotal += chunk.length;
        if (size > max || size > declared || actualTotal > MAX_MAP_PROJECT_BYTES) {
          stopped = true;
          stream.pause();
          stream.destroy();
          reject(fail('场景地图源 ZIP 实际解压尺寸超过限制。'));
          return;
        }
        chunks.push(chunk);
        crc = crc32(chunk, crc);
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    if (size !== declared || crc !== (entry._data.crc32 >>> 0)) throw fail('场景地图源 ZIP 文件尺寸或 CRC 校验失败。');
    contents.set(entry.name, Buffer.concat(chunks, size));
  }
  // Any later ZIP generation consumes these bounded, verified buffers rather
  // than lazily inflating unreferenced original entries.
  for (const [name, content] of contents) zip.file(name, content, { date: zip.file(name).date });
  zipContents.set(zip, contents);
  return zip;
}
async function manifestJson(zip, filename) {
  const content = zipContents.get(zip)?.get(filename);
  if (!content || content.length > 16 * 1024 * 1024) throw fail('场景地图源清单缺失或过大。');
  return JSON.parse(content.toString('utf8'));
}
async function decoded(bytes, expected) {
  const info = await inspectImageBytes(bytes);
  if (expected && (info.width !== expected.width || info.height !== expected.height || (expected.mime && info.mimeType !== expected.mime) || (expected.sha256 && info.sha256 !== expected.sha256))) throw fail('源图片真实尺寸、格式或哈希与源包声明不一致。');
  const pixels = await sharp(bytes, { limitInputPixels: 64_000_000 }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  return { ...info, rgbaSha256: hash(pixels) };
}
async function sourcePackage(bytes) {
  const zip = await boundedZip(bytes);
  if (zip.file('map-project.json') && zip.file('map_stitch_state.json')) throw fail('地图源 ZIP 包含两种冲突清单。');
  if (zip.file('map-project.json')) {
    // Validate against the real loader, but retain unknown source metadata
    // instead of rewriting the schema parser's stripped projection.
    await readMapProjectPackage(bytes);
    const draft = await manifestJson(zip, 'map-project.json');
    const refs = draft.snapshot.tiles.flatMap(tile => Object.entries(tile.images).map(([layer, ref]) => ({ tileKey: tile.key, layer, ref })));
    return { zip, format: 'forge-map-project', filename: 'map-project.json', data: draft, tiles: draft.snapshot.tiles,
      shapes: draft.snapshot.shapes, locks: draft.snapshot.imageLocks, refs, masks: [] };
  }
  const data = await manifestJson(zip, 'map_stitch_state.json');
  if (data.format !== 'pixelwork-map-stitch-state' || data.version !== 2 || !record(data.tiles) || !record(data.tileUploads) || !record(data.tileLayerUploads) || !record(data.tileFeathers) || !record(data.hiddenPreviewTiles) || !Array.isArray(data.drawShapes)) throw fail('仅支持结构完整的实际 Pixelwork v2 源 ZIP。');
  if (Object.keys(data.tileLayerUploads).some(key => ![...sourceFields, 'mask'].includes(key)) || data.tileLayerUploads.overall) throw fail('Pixelwork 图片层索引不明确。');
  const tiles = [{ key: '0,0', x: 0, y: 0, w: 1, h: 1 }, ...Object.entries(data.tiles).map(([key, tile]) => ({ ...tile, key }))]
    .map(tile => ({ ...tile, feather: data.tileFeathers[tile.key], hidden: data.hiddenPreviewTiles[tile.key] === true }));
  const refs = [{ tileKey: '0,0', layer: 'overall', ref: data.source }];
  for (const [tileKey, ref] of Object.entries(data.tileUploads)) refs.push({ tileKey, layer: 'overall', ref });
  const masks = [];
  for (const [layer, uploads] of Object.entries(data.tileLayerUploads)) {
    if (!record(uploads)) throw fail('Pixelwork 图片索引不是对象。');
    for (const [tileKey, ref] of Object.entries(uploads)) (layer === 'mask' ? masks : refs).push({ tileKey, layer, ref });
  }
  return { zip, format: 'pixelwork-v2', filename: 'map_stitch_state.json', data, tiles,
    shapes: data.drawShapes, locks: data.workbench?.layerLocks || {}, refs, masks };
}
async function readReferences(source) {
  const keys = new Set(source.tiles.map(tile => tile.key));
  if (keys.size !== source.tiles.length) throw fail('地图块身份重复。');
  const files = new Map();
  for (const item of [...source.refs, ...source.masks]) {
    const ref = item.ref;
    if (!keys.has(item.tileKey) || !record(ref) || !imagePath(ref.path) || !Number.isSafeInteger(ref.size) || ref.size < 1 || ref.size > 40 * 1024 * 1024 || !Number.isSafeInteger(ref.width) || !Number.isSafeInteger(ref.height) || ref.width < 1 || ref.height < 1 || !['image/png', 'image/jpeg', 'image/webp'].includes(ref.type)) throw fail('地图源图片引用、尺寸或路径无效。');
    const bytes = zipContents.get(source.zip)?.get(ref.path);
    if (!bytes || bytes.length !== ref.size) throw fail('地图源包缺少完整图片。');
    if (!files.has(ref.path)) {
      files.set(ref.path, { bytes, info: await decoded(bytes) });
    }
    const file = files.get(ref.path);
    if (file.info.width !== ref.width || file.info.height !== ref.height || file.info.mimeType !== ref.type || (ref.generation && file.info.sha256 !== ref.generation.sha256)) throw fail('地图源图片与元数据不一致。');
  }
  return files;
}
function collisionPoints(shape) {
  if (!record(shape) || shape.tileKey !== '0,0' || !Array.isArray(shape.points) || shape.points.some(point => !record(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw fail('地图区域几何无效。');
  if (shape.layer !== 'collision') readonly('含遮挡扣除、调整或顶层区域的地图层不能证明单源像素映射；请编辑地图源文件。');
  if (shape.mode === 'rectangle' && shape.points.length >= 2) {
    const xs = shape.points.map(point => point.x), ys = shape.points.map(point => point.y);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  }
  if (!['polygon', 'free'].includes(shape.mode) || shape.points.length < 3) throw fail('地图碰撞多边形无效。');
  return shape.points.map(({ x, y }) => ({ x, y }));
}
function layerType(layer) {
  if (['map_overall', 'map_surface', 'map_object'].includes(layer.id)) return layer.id.slice(4);
  // Early single-image imports used "overall"; no name-based guessing.
  if (layer.id === 'overall') return 'overall';
  readonly('该场景层是派生层或缺少明确源图片映射；请编辑地图源文件。');
}
async function proof(root, scene, layerId, bytes, onSource) {
  const source = await sourcePackage(inlineZip(scene.map.source));
  onSource?.(source.format);
  const files = await readReferences(source);
  if (source.tiles.length !== 1) readonly('多地图块源包不能安全反向映射单张场景烘焙层；请编辑地图源文件。');
  const tile = source.tiles[0];
  if (tile.key !== '0,0' || tile.x !== 0 || tile.y !== 0 || tile.w !== 1 || tile.h !== 1 || tile.hidden || !record(tile.feather) || ['top', 'right', 'bottom', 'left'].some(side => tile.feather[side] !== 0)) readonly('源地图存在缩放、偏移、隐藏或羽化，无法证明单源 identity 映射。');
  if (scene.map.origin.x !== 0 || scene.map.origin.y !== 0) readonly('场景地图原点与单源坐标不一致。');
  const collisions = source.shapes.map(collisionPoints);
  if (!same(collisions, sourceMapCollisions(scene.map))) readonly('场景与嵌入源包碰撞基线不一致；请先在源编辑器协调。');
  const byLayer = new Map();
  for (const item of source.refs) {
    const file = files.get(item.ref.path);
    const previous = byLayer.get(item.layer);
    if (previous && previous.info.rgbaSha256 !== file.info.rgbaSha256) readonly('同一源图片槽存在冲突的重复引用。');
    byLayer.set(item.layer, { ...file, items: [...(previous?.items || []), item] });
  }
  const base = byLayer.get('overall');
  if (!base) throw fail('地图源包缺少中心整体图。');
  const mappedTypes = new Set();
  for (const layer of scene.map.layers) {
    const type = layerType(layer), original = byLayer.get(type);
    if (mappedTypes.has(type)) readonly('多个场景层指向同一源图片槽，不能只更新其中一个别名。');
    mappedTypes.add(type);
    if (!original || original.info.width !== base.info.width || original.info.height !== base.info.height || layer.width !== original.info.width || layer.height !== original.info.height) readonly('场景层尺寸与源图片 identity 映射不一致。');
    const actual = layer.id === layerId ? bytes : (await readImageAssetSource(layer.source, root)).buffer;
    const info = await decoded(actual, { width: layer.width, height: layer.height });
    if (info.rgbaSha256 !== original.info.rgbaSha256) readonly('场景层像素与嵌入源图片不一致；不能伪造源包同步。');
  }
  const selected = scene.map.layers.find(layer => layer.id === layerId), type = layerType(selected);
  if (selected.locked || source.locks[type] === true) throw fail('场景层或源图片类型已锁定，请明确解锁后再调整。', 'IMAGE_TARGET_LOCKED', 409);
  return { source, files, selected, type, original: byLayer.get(type), sourceSha256: hash(inlineZip(scene.map.source)) };
}

/** Reads pinned layer pixels even when its embedded source cannot safely map. */
export async function inspectSceneImageSource(root, scene, layerId) {
  const selected = scene.map?.layers.find(layer => layer.id === layerId);
  if (!selected) throw fail('场景地图层不存在。');
  const image = await readImageAssetSource(selected.source, root), info = await decoded(image.buffer, { width: selected.width, height: selected.height });
  const sourceEntry = { kind: 'embedded-map-source', documentId: scene.id, layerId, sourceField: 'map.source', filename: 'map-source.zip', format: 'unknown',
    viewPath: `/tools/scene-composer?document=${encodeURIComponent(scene.id)}`, action: 'edit-map-source' };
  try { sourceEntry.sha256 = hash(inlineZip(scene.map.source)); } catch { /* A damaged source must not hide existing layer pixels. */ }
  try {
    const mapped = await proof(root, scene, layerId, image.buffer, format => { sourceEntry.format = format; });
    sourceEntry.format = mapped.source.format;
    const mapping = { format: mapped.source.format, manifestFile: mapped.source.filename, tileKey: '0,0', imageLayer: mapped.type,
      imagePath: mapped.original.items[0].ref.path, sourceSha256: mapped.sourceSha256, imageSha256: mapped.original.info.sha256, rgbaSha256: info.rgbaSha256 };
    return { ...info, bytes: image.buffer, width: selected.width, height: selected.height, name: selected.name, locked: false, editable: true, sourceEntry, mapping,
      generation: mapped.original.items[0].ref.generation, dependencies: { previewInvalidatedOnAdoption: true, maskCacheInvalidatedOnAdoption: mapped.source.format === 'pixelwork-v2' } };
  } catch (error) {
    return { ...info, bytes: image.buffer, width: selected.width, height: selected.height, name: selected.name, locked: selected.locked || error.code === 'IMAGE_TARGET_LOCKED', editable: false, sourceEntry,
      readOnlyReason: error.message || '无法证明嵌入源包的像素映射。', readOnlyCode: error.code || 'IMAGE_SCENE_SOURCE_INVALID' };
  }
}

async function replaceSource(root, scene, layerId, candidate) {
  const selected = scene.map?.layers.find(layer => layer.id === layerId);
  if (!selected) throw fail('场景地图层不存在。');
  const current = await readImageAssetSource(selected.source, root);
  const mapped = await proof(root, scene, layerId, current.buffer);
  const bytes = Buffer.from(candidate.bytes || []);
  if (candidate.mimeType !== 'image/png' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(candidate.taskId || '') || !/^[a-f0-9]{64}$/.test(candidate.sha256 || '')) throw fail('场景图片候选缺少真实来源身份。');
  const info = await decoded(bytes, { width: selected.width, height: selected.height, mime: 'image/png', sha256: candidate.sha256 });
  if (candidate.width !== info.width || candidate.height !== info.height) throw fail('场景图片候选尺寸声明不匹配。');
  const { source, type, original } = mapped;
  const selectedRefs = new Set(original.items.map(item => item.ref));
  const otherRefs = source.refs.filter(item => !selectedRefs.has(item.ref));
  let imagePath = original.items[0].ref.path;
  if (otherRefs.some(item => item.ref.path === imagePath)) {
    if (source.format === 'forge-map-project') {
      let index = 0; while (source.zip.file(`images/${index}.bin`)) index++;
      imagePath = `images/${index}.bin`;
    } else {
      let index = 0;
      do { imagePath = `images/scene-edit-${candidate.sha256}${index ? `-${index}` : ''}.png`; index++; } while (source.zip.file(imagePath));
    }
  }
  const imageDate = source.zip.file(imagePath)?.date || epoch;
  source.zip.file(imagePath, bytes, { date: imageDate });
  for (const { ref } of original.items) Object.assign(ref, { path: imagePath, size: bytes.length, type: 'image/png', width: info.width, height: info.height, generation: { sourceTaskId: candidate.taskId, sha256: info.sha256 } });
  source.zip.remove('preview.png');
  if (source.format === 'pixelwork-v2') {
    // Masks are import/export caches, never independent source images.
    for (const mask of source.masks) {
      delete source.data.tileLayerUploads.mask[mask.tileKey];
      if (!source.refs.some(item => item.ref.path === mask.ref.path)) source.zip.remove(mask.ref.path);
    }
  }
  source.zip.file(source.filename, JSON.stringify(source.data), { date: source.zip.file(source.filename).date || epoch });
  const packageBytes = await source.zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  if (packageBytes.length > MAX_MAP_PROJECT_BYTES) throw fail('更新后的地图源包超过 256 MiB。');
  const next = structuredClone(scene);
  next.map.layers.find(layer => layer.id === layerId).source = `data:image/png;base64,${bytes.toString('base64')}`;
  next.map.source = `data:application/zip;base64,${packageBytes.toString('base64')}`;
  // Re-read the full source and every presented layer before returning a clone.
  const checked = await proof(root, next, layerId, bytes);
  if (checked.type !== type || checked.original.info.sha256 !== candidate.sha256) throw fail('写回后的源包未绑定候选原图。');
  return next;
}

/** Returns one coherent clone; the caller publishes it with document CAS. */
export async function replaceSceneImageSource(root, scene, layerId, candidate) {
  try { return await replaceSource(root, scene, layerId, candidate); }
  catch (error) {
    if (['IMAGE_SCENE_SOURCE_INVALID', 'IMAGE_SCENE_SOURCE_READ_ONLY', 'IMAGE_TARGET_LOCKED'].includes(error.code)) throw error;
    throw fail(error.message || '地图源包或候选图片校验失败。');
  }
}
