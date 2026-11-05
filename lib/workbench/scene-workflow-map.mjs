import { crc32 } from 'node:zlib';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
  readMapProjectPackage,
  MAX_MAP_PROJECT_BYTES,
} from '../../features/map-stitcher/project-package.mjs';
import {
  validateScene,
  replaceMap,
} from '../../features/scene-composer/model.mjs';
import { getDocument, saveDocument } from './editor-documents.mjs';
import {
  inspectImageBytes,
  readImageAssetSource,
} from './adapters/image-assets-source.mjs';
import { preserveMapTemplatePixels } from './adapters/map-generation-image.mjs';
import { hash, workflowError } from './scene-workflow-store.mjs';

const MAX_PIXELS = 64_000_000;
const MAX_EDGE = 30000;
const imageLayers = ['overall', 'surface', 'object', 'black', 'white'];
const epoch = new Date('1980-01-01T00:00:00Z');
import { mapStepSchema } from './scene-workflow-production-contract.mjs';
export { mapStepSchema } from './scene-workflow-production-contract.mjs';

const fail = (message, code = 'SCENE_MAP_INVALID', status = 409) => {
  throw workflowError(message, code, status);
};
const record = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const fingerprint = (value) => hash(JSON.stringify(canonical(value)));
const same = (left, right) => fingerprint(left) === fingerprint(right);
export const workflowMapHash = (map) => fingerprint(map);
export const workflowMapTileKey = (step) => {
  const id = typeof step === 'string' ? step : step.id;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id || ''))
    fail(
      '地图步骤 ID 最长为 96 个字符，以便保存完整的 wf_<step.id> 地图块身份。',
    );
  return `wf_${id}`;
};
export const workflowMapLayerId = (step) =>
  `mapwf_${hash(typeof step === 'string' ? step : step.id).slice(0, 24)}`;
const inputFor = (step) =>
  mapStepSchema.parse(
    typeof step.input === 'string'
      ? JSON.parse(step.input)
      : step.input || step,
  );
const dataImage = (bytes) =>
  `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const zipSource = (bytes) =>
  `data:application/zip;base64,${Buffer.from(bytes).toString('base64')}`;
const emptyFeather = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
const projectionSummaries = new WeakMap();
const checkFrame = (frame) => {
  if (
    ![frame.x, frame.y, frame.width, frame.height].every(
      Number.isSafeInteger,
    ) ||
    Math.abs(frame.x) > 1e7 ||
    Math.abs(frame.y) > 1e7 ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.width > MAX_EDGE ||
    frame.height > MAX_EDGE ||
    frame.width * frame.height > MAX_PIXELS
  )
    fail('地图合成画布超过 6400 万像素、30000 像素边长或使用了无效坐标。');
  return frame;
};
const intersect = (a, b) => {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    right = Math.min(a.x + a.width, b.x + b.width),
    bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
};
const union = (a, b) =>
  checkFrame({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
    height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y),
  });

function inlineBytes(value, mime, max) {
  const match =
    typeof value === 'string' &&
    new RegExp(`^data:${mime};base64,([A-Za-z0-9+/]*={0,2})$`).exec(value);
  if (!match || !match[1] || match[1].length > Math.ceil(max / 3) * 4)
    fail('地图缺少可验证的完整内嵌源文件。');
  const bytes = Buffer.from(match[1], 'base64');
  if (
    !bytes.length ||
    bytes.length > max ||
    bytes.toString('base64') !== match[1]
  )
    fail('地图源文件编码或大小无效。');
  return bytes;
}
const safeName = (value) =>
  typeof value === 'string' &&
  !/[\\:]/.test(value) &&
  !value.startsWith('/') &&
  !value.split('/').some((part) => part === '..' || part === '.') &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32);
async function readZip(bytes) {
  const zip = await JSZip.loadAsync(bytes),
    entries = Object.values(zip.files),
    files = new Map();
  if (entries.length > 22000) fail('地图源包文件数量超过限制。');
  let total = 0;
  for (const entry of entries) {
    if (
      !safeName(entry.name) ||
      (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)
    )
      fail('地图源包包含无效路径。');
    if (entry.dir) continue;
    if (
      !['map-project.json', 'map_stitch_state.json', 'preview.png'].includes(
        entry.name,
      ) &&
      !/^images\/[^/]+$/.test(entry.name)
    )
      fail('地图源包包含不支持的文件；请使用完整 Forge 或 Pixelwork v2 源包。');
    const declared = entry._data?.uncompressedSize;
    const max = entry.name.endsWith('.json')
      ? 16 * 1024 * 1024
      : entry.name === 'preview.png'
        ? 2 * 1024 * 1024
        : 40 * 1024 * 1024;
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > max ||
      total + declared > MAX_MAP_PROJECT_BYTES
    )
      fail('地图源包解压尺寸超过限制。');
    const chunks = [];
    let size = 0,
      checksum = 0;
    await new Promise((resolve, reject) => {
      const stream = entry.nodeStream('nodebuffer');
      let stopped = false;
      stream.on('data', (chunk) => {
        if (stopped) return;
        size += chunk.length;
        total += chunk.length;
        if (size > declared || total > MAX_MAP_PROJECT_BYTES) {
          stopped = true;
          stream.pause();
          stream.destroy();
          reject(
            workflowError(
              '地图源包实际解压尺寸超过限制。',
              'SCENE_MAP_INVALID',
              409,
            ),
          );
          return;
        }
        chunks.push(chunk);
        checksum = crc32(chunk, checksum);
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    if (size !== declared || checksum !== entry._data.crc32 >>> 0)
      fail('地图源包 CRC 或尺寸校验失败。');
    files.set(entry.name, Buffer.concat(chunks, size));
  }
  for (const [filename, content] of files)
    zip.file(filename, content, { date: zip.file(filename).date });
  return { zip, files };
}
async function pixels(bytes) {
  return sharp(bytes, { limitInputPixels: MAX_PIXELS })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}
async function png(data, width, height) {
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}
function copyRect(
  source,
  sourceWidth,
  sourceFrame,
  target,
  targetWidth,
  targetFrame,
  bounds,
) {
  const area = intersect(
    intersect(sourceFrame, targetFrame) || { x: 0, y: 0, width: 0, height: 0 },
    bounds || targetFrame,
  );
  if (!area) return;
  for (let y = area.y; y < area.y + area.height; y++) {
    const start =
      ((y - sourceFrame.y) * sourceWidth + area.x - sourceFrame.x) * 4;
    const at = ((y - targetFrame.y) * targetWidth + area.x - targetFrame.x) * 4;
    source.copy(target, at, start, start + area.width * 4);
  }
}
async function padded(bytes, before, after) {
  const decoded = await pixels(bytes),
    target = Buffer.alloc(after.width * after.height * 4);
  if (
    decoded.info.width !== before.width ||
    decoded.info.height !== before.height
  )
    fail('地图层真实尺寸与画布不一致。');
  copyRect(decoded.data, before.width, before, target, after.width, after);
  return png(target, after.width, after.height);
}
function polygon(shape) {
  if (
    !record(shape) ||
    !Array.isArray(shape.points) ||
    shape.points.some(
      (p) => !record(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y),
    )
  )
    fail('地图区域包含无效几何。');
  if (shape.mode === 'rectangle' && shape.points.length >= 2) {
    const xs = shape.points.map((p) => p.x),
      ys = shape.points.map((p) => p.y),
      left = Math.min(...xs),
      right = Math.max(...xs),
      top = Math.min(...ys),
      bottom = Math.max(...ys);
    if (left === right || top === bottom) fail('地图碰撞矩形面积为零。');
    return [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
  }
  if (
    !['polygon', 'free'].includes(shape.mode) ||
    shape.points.length < 3 ||
    shape.points.length > 10000
  )
    fail('地图碰撞多边形无效。');
  return shape.points.map(({ x, y }) => ({ x, y }));
}
function tileBounds(tile, base) {
  const values = [
    tile.x * base.width,
    tile.y * base.height,
    tile.w * base.width,
    tile.h * base.height,
  ];
  if (values.some((value) => !Number.isFinite(value)))
    fail('地图块几何包含无效坐标。');
  // Match layer-engine tilePixelSize and drawImage placement, independently of
  // the shared frame's floor/ceil rounding below.
  return checkFrame({
    x: Math.round(values[0]),
    y: Math.round(values[1]),
    width: Math.round(values[2]),
    height: Math.round(values[3]),
  });
}
function packageFrame(source) {
  const included = source.tiles.filter(
    (tile) => !tile.hidden && Object.keys(tile.images).length,
  );
  if (!included.length) fail('地图源包没有参与输出的图片。');
  const x = Math.floor(
      Math.min(...included.map((tile) => tile.x)) * source.base.width,
    ),
    y = Math.floor(
      Math.min(...included.map((tile) => tile.y)) * source.base.height,
    );
  return checkFrame({
    x,
    y,
    width: Math.max(
      1,
      Math.ceil(
        Math.max(...included.map((tile) => tile.x + tile.w)) *
          source.base.width,
      ) - x,
    ),
    height: Math.max(
      1,
      Math.ceil(
        Math.max(...included.map((tile) => tile.y + tile.h)) *
          source.base.height,
      ) - y,
    ),
  });
}
function sourceCollisions(source) {
  return source.shapes
    .filter((shape) => shape.layer === 'collision')
    .flatMap((shape) => {
      const tile = source.tiles.find((tile) => tile.key === shape.tileKey);
      if (!tile) fail('地图区域引用了不存在的地图块。');
      if (tile.hidden) return [];
      return [
        polygon(shape).map((p) => ({
          x: tile.x * source.base.width + p.x,
          y: tile.y * source.base.height + p.y,
        })),
      ];
    });
}
async function loadSource(map) {
  const bytes = inlineBytes(
      map.source,
      'application/zip',
      MAX_MAP_PROJECT_BYTES,
    ),
    parsed = await readZip(bytes);
  if (
    parsed.files.has('map-project.json') ===
    parsed.files.has('map_stitch_state.json')
  )
    fail('地图源包清单缺失或有冲突。');
  const filename = parsed.files.has('map-project.json')
    ? 'map-project.json'
    : 'map_stitch_state.json';
  const data = JSON.parse(parsed.files.get(filename).toString('utf8'));
  let tiles, shapes, locks;
  if (filename === 'map-project.json') {
    await readMapProjectPackage(bytes);
    tiles = data.snapshot.tiles;
    shapes = data.snapshot.shapes;
    locks = data.snapshot.imageLocks;
  } else {
    if (
      data.format !== 'pixelwork-map-stitch-state' ||
      data.version !== 2 ||
      !record(data.tiles) ||
      !record(data.tileUploads) ||
      !record(data.tileLayerUploads) ||
      !record(data.tileFeathers) ||
      !record(data.hiddenPreviewTiles) ||
      !Array.isArray(data.drawShapes) ||
      Object.keys(data.tiles).length > 4095 ||
      Object.keys(data.tileLayerUploads).some(
        (key) => ![...imageLayers, 'mask'].includes(key),
      ) ||
      data.tileLayerUploads.overall
    )
      fail('地图扩展需要结构完整的 Pixelwork v2 源包。');
    tiles = [
      { key: '0,0', x: 0, y: 0, w: 1, h: 1 },
      ...Object.entries(data.tiles).map(([key, tile]) => ({ ...tile, key })),
    ].map((tile) => ({
      ...tile,
      images: {
        ...(tile.key === '0,0'
          ? { overall: data.source }
          : data.tileUploads[tile.key]
            ? { overall: data.tileUploads[tile.key] }
            : {}),
        ...Object.fromEntries(
          imageLayers
            .filter(
              (layer) =>
                layer !== 'overall' && data.tileLayerUploads[layer]?.[tile.key],
            )
            .map((layer) => [layer, data.tileLayerUploads[layer][tile.key]]),
        ),
      },
      feather: data.tileFeathers[tile.key],
      hidden: data.hiddenPreviewTiles[tile.key] === true,
    }));
    shapes = data.drawShapes;
    locks = data.workbench?.layerLocks || {};
  }
  const keys = new Set(tiles.map((tile) => tile.key));
  if (
    keys.size !== tiles.length ||
    shapes.length > 100000 ||
    shapes.some((shape) => !keys.has(shape.tileKey))
  )
    fail('地图块身份重复或区域引用无效。');
  const images = new Map();
  for (const tile of tiles) {
    if (
      typeof tile.key !== 'string' ||
      tile.key.length > 100 ||
      !record(tile.images) ||
      Object.keys(tile.images).some((layer) => !imageLayers.includes(layer))
    )
      fail('地图块图片索引无效。');
    for (const ref of Object.values(tile.images)) {
      if (
        !record(ref) ||
        !/^images\/[^/]+$/.test(ref.path) ||
        !safeName(ref.path) ||
        !Number.isSafeInteger(ref.size) ||
        ref.size < 1
      )
        fail('地图源图片引用无效。');
      const image = parsed.files.get(ref.path);
      if (!image || image.length !== ref.size) fail('地图源包缺少完整图片。');
      if (!images.has(ref.path))
        images.set(ref.path, {
          bytes: image,
          info: await inspectImageBytes(image),
        });
      const info = images.get(ref.path).info;
      if (
        info.width !== ref.width ||
        info.height !== ref.height ||
        info.mimeType !== ref.type ||
        (ref.generation && info.sha256 !== ref.generation.sha256)
      )
        fail('地图源图片的真实尺寸、格式或哈希与清单不一致。');
    }
  }
  const center = tiles.find((tile) => tile.key === '0,0')?.images.overall;
  if (!center) fail('地图源包缺少中心整体图。');
  const source = {
    ...parsed,
    bytes,
    filename,
    format:
      filename === 'map-project.json' ? 'forge-map-project' : 'pixelwork-v2',
    data,
    tiles,
    shapes,
    locks,
    images,
    base: { width: center.width, height: center.height },
    sourceSha256: hash(bytes),
  };
  source.canvas = packageFrame(source);
  for (const tile of tiles) tileBounds(tile, source.base);
  if (
    !same(
      { x: map.origin.x, y: map.origin.y },
      { x: source.canvas.x, y: source.canvas.y },
    ) ||
    map.layers.some(
      (layer) =>
        layer.width !== source.canvas.width ||
        layer.height !== source.canvas.height,
    )
  )
    fail('场景地图的原点或图层尺寸与完整源包几何不一致。');
  if (!same(sourceCollisions(source), map.collisions))
    fail('场景地图碰撞与嵌入源包不一致。');
  return source;
}
async function renderSourceLayer(source, type) {
  // These are exact source-over/nearest operations. Ambiguous browser masks and
  // fractional feather gradients are refused instead of guessed or flattened.
  if (
    source.shapes.some((shape) => shape.layer !== 'collision') ||
    source.tiles.some(
      (tile) =>
        !record(tile.feather) ||
        Object.values(tile.feather).some((value) => value !== 0),
    )
  )
    fail(
      '该地图包含羽化、遮挡扣除或顶层派生；现有源数据不能证明服务器逐像素映射，请先在地图编辑器处理。',
      'SCENE_MAP_SOURCE_READ_ONLY',
    );
  const frame = source.canvas,
    overlays = [];
  for (const tile of source.tiles) {
    const ref = tile.images[type];
    if (tile.hidden || !ref) continue;
    const bounds = tileBounds(tile, source.base),
      image = source.images.get(ref.path);
    overlays.push({
      input: await sharp(image.bytes, { limitInputPixels: MAX_PIXELS })
        .resize(bounds.width, bounds.height, { kernel: 'nearest' })
        .toColourspace('srgb')
        .ensureAlpha()
        .png()
        .toBuffer(),
      left: bounds.x - frame.x,
      top: bounds.y - frame.y,
    });
  }
  return sharp({
    create: {
      width: frame.width,
      height: frame.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(overlays)
    .png()
    .toBuffer();
}
async function verifyLayerBindings(root, map, source) {
  const binding = source.data.workbench?.sceneWorkflowMap;
  if (binding) {
    if (
      binding.format !== 'forge-scene-workflow-map' ||
      binding.version !== 1 ||
      !same(binding.canvas, source.canvas) ||
      !Array.isArray(binding.layers) ||
      binding.layers.length !== map.layers.length ||
      !Array.isArray(binding.operations)
    )
      fail('地图工作流源映射清单无效。');
    for (const layer of map.layers) {
      const ref = binding.layers.find((item) => item.id === layer.id),
        actual = await readImageAssetSource(layer.source, root);
      if (
        !ref ||
        ref.width !== layer.width || ref.height !== layer.height ||
        !source.files.has(ref.path) ||
        hash(source.files.get(ref.path)) !== ref.sha256 ||
        hash(actual.buffer) !== ref.sha256 ||
        actual.width !== layer.width ||
        actual.height !== layer.height
      )
        fail('场景地图层与源包的已固定图片身份不一致。');
      await inspectImageBytes(source.files.get(ref.path), { pngOnly: true });
    }
    return;
  }
  for (const layer of map.layers) {
    const type =
      layer.id === 'overall'
        ? 'overall'
        : /^map_(overall|surface|object)$/.exec(layer.id)?.[1];
    if (!type)
      fail(
        '地图层缺少明确源映射；不能根据图层名字推断源图片。',
        'SCENE_MAP_SOURCE_READ_ONLY',
      );
    const rendered = await pixels(await renderSourceLayer(source, type)),
      actual = await pixels(
        (await readImageAssetSource(layer.source, root)).buffer,
      );
    if (
      actual.info.width !== source.canvas.width ||
      actual.info.height !== source.canvas.height ||
      !rendered.data.equals(actual.data)
    )
      fail(
        '场景地图像素与完整源包渲染不一致；请先重新保存地图来源。',
        'SCENE_MAP_SOURCE_READ_ONLY',
      );
  }
}
function sourceSummary(source, map) {
  const readOnlyReason =
    source.locks.overall === true
      ? '源地图整体图片类型已锁定，不能新增或生成地图块。'
      : map.layers.length >= 8
        ? '场景地图已达到八个图片层上限。'
        : null;
  return {
    format: source.format,
    sourceSha256: source.sourceSha256,
    base: source.base,
    canvas: source.canvas,
    tiles: source.tiles.map((tile) => ({
      key: tile.key,
      bounds: tileBounds(tile, source.base),
      hidden: Boolean(tile.hidden),
      layers: Object.keys(tile.images),
    })),
    layers: map.layers.map(({ id, name, locked, hidden, included }) => ({
      id,
      name,
      locked,
      hidden,
      included,
    })),
    canExtend: !readOnlyReason,
    ...(readOnlyReason ? { readOnlyReason } : {}),
  };
}
/** Returns bounded model context; never exposes ZIP/image bytes or provider keys. */
export async function inspectMapSource(root, map) {
  if (!map)
    return {
      format: 'empty',
      canExtend: false,
      tiles: [],
      layers: [],
      readOnlyReason: '场景尚未创建地图。',
    };
  try {
    const source = await loadSource(map);
    await verifyLayerBindings(root, map, source);
    return sourceSummary(source, map);
  } catch (error) {
    return {
      format: 'unverified',
      canExtend: false,
      tiles: [],
      layers: map.layers.map(({ id, name, locked, hidden, included }) => ({
        id,
        name,
        locked,
        hidden,
        included,
      })),
      readOnlyReason: error.message || '地图源包无法校验。',
    };
  }
}
const projectionPrefix = 'data:application/x-forge-map-projection;base64,';
export function projectedMapSource(scene) {
  if (!scene.map?.source.startsWith(projectionPrefix)) return null;
  return JSON.parse(
    Buffer.from(
      scene.map.source.slice(projectionPrefix.length),
      'base64',
    ).toString('utf8'),
  );
}
function extensionBounds(summary, input) {
  const neighbor = summary.tiles.find(
    (tile) => tile.key === input.neighborTileKey,
  );
  if (!neighbor || neighbor.hidden || !neighbor.layers.includes('overall'))
    fail('扩图需要当前已验证且有整体图的相邻地图块。');
  const b = neighbor.bounds,
    horizontal = ['left', 'right'].includes(input.direction),
    edge = horizontal ? b.width : b.height;
  const overlap = Math.max(1, Math.round((edge * input.overlapPercent) / 100));
  if (overlap >= edge) fail('地图块过小，无法保留有效重叠区。');
  const target = { ...b };
  if (input.direction === 'left') target.x -= b.width - overlap;
  if (input.direction === 'right') target.x += b.width - overlap;
  if (input.direction === 'up') target.y -= b.height - overlap;
  if (input.direction === 'down') target.y += b.height - overlap;
  const canvas = union(summary.canvas, target);
  if (same(canvas, summary.canvas))
    fail('所选扩展块完全位于当前画布内；请使用边缘地图块向外扩展。');
  return { target: checkFrame(target), canvas, overlap };
}
/** Synchronous plan guard. Execution independently re-reads the frozen package. */
export function validateMapStep(
  work,
  scene,
  step,
  summary = projectedMapSource(scene) || work.mapSource,
) {
  const input = inputFor(step),
    mode = work.spec.mapMode || 'preserve';
  const tileKey = workflowMapTileKey(step),
    layerId =
      input.operation === 'create' ? 'map_overall' : workflowMapLayerId(step);
  if (mode === 'preserve') fail('本任务未授权创建或扩展地图。');
  if (
    (work.spec.budget.mapTiles || 0) < 1 ||
    (work.spec.budget.generationCalls || 0) < 1
  )
    fail('地图制作需要已授权的 mapTiles 与 generationCalls 总额度。');
  if (input.operation === 'create') {
    if (mode !== 'create' || scene.map)
      fail('新地图只能在获准创建的空场景中建立，不能替换已有地图。');
  } else {
    if (scene.map?.layers.length >= 8)
      fail('地图扩展将超过场景八个图片层上限。');
    if (!scene.map || !summary?.canExtend)
      fail(summary?.readOnlyReason || '扩图需要可验证的完整地图源包。');
    if (mode === 'create' && !summary.createdByWorkflow)
      fail('创建模式不能扩展任务开始前已有的地图。');
    extensionBounds(summary, input);
    const producer = summary.tiles.find(
      (tile) => tile.key === input.neighborTileKey,
    )?.producedBy;
    if (producer && !step.dependsOn?.includes(producer))
      fail('扩图步骤必须直接依赖生成相邻地图块的步骤。');
    if (summary.tiles.some((tile) => tile.key === tileKey))
      fail('地图派生块身份已存在，不能覆盖已有地图块。');
  }
  if (
    scene.order.includes(layerId) ||
    scene.instances.some((instance) => instance.id === layerId) ||
    scene.materials.some((material) => material.id === layerId)
  )
    fail('地图派生图层身份与场景中已有的节点或素材冲突；请调整地图步骤身份。');
  if (summary) projectionSummaries.set(scene, summary);
  return input;
}
/** Planning-only shape projection. Its marker is rejected by every production read. */
export function projectMapStep(scene, step, initialSummary) {
  const input = inputFor(step),
    next = structuredClone(scene);
  let summary =
    projectedMapSource(scene) ||
    initialSummary ||
    projectionSummaries.get(scene);
  if (input.operation === 'create') {
    const sizes = {
        '1:1': [1024, 1024],
        '3:2': [1536, 1024],
        '2:3': [1024, 1536],
      },
      [width, height] = sizes[input.aspectRatio];
    const canvas = { x: 0, y: 0, width, height };
    replaceMap(next, {
      name: input.name,
      origin: { x: 0, y: 0 },
      offset: input.origin,
      layers: [
        {
          id: 'map_overall',
          name: input.name,
          source: '<planning-only-map-image>',
          width,
          height,
          locked: true,
          hidden: false,
          included: true,
        },
      ],
      collisions: [],
      source: '<planning-only-map-source>',
      warnings: [],
    });
    summary = {
      format: 'projection',
      base: { width, height },
      canvas,
      tiles: [
        {
          key: '0,0',
          bounds: canvas,
          hidden: false,
          layers: ['overall'],
          producedBy: step.id,
        },
      ],
      canExtend: true,
      createdByWorkflow: true,
    };
  } else {
    if (!summary) fail('地图计划缺少已验证的源摘要。');
    const { target, canvas } = extensionBounds(summary, input),
      id = workflowMapLayerId(step);
    next.map.origin = { x: canvas.x, y: canvas.y };
    for (const layer of next.map.layers)
      Object.assign(layer, {
        width: canvas.width,
        height: canvas.height,
        source: '<planning-only-padded-image>',
      });
    next.map.layers.push({
      id,
      name: input.name,
      source: '<planning-only-map-image>',
      width: canvas.width,
      height: canvas.height,
      locked: true,
      hidden: false,
      included: true,
    });
    next.order.push(id);
    summary = {
      ...summary,
      canvas,
      tiles: [
        ...summary.tiles,
        {
          key: workflowMapTileKey(step),
          bounds: target,
          hidden: false,
          layers: ['overall'],
          producedBy: step.id,
        },
      ],
      canExtend: next.map.layers.length < 8,
    };
  }
  next.map.source = `${projectionPrefix}${Buffer.from(JSON.stringify(summary)).toString('base64')}`;
  return validateScene(next);
}

function sourceReference(source, bytes, title) {
  let filename;
  if (source.filename === 'map-project.json') {
    let index = 0;
    while (source.files.has(`images/${index}.bin`)) index++;
    filename = `images/${index}.bin`;
  } else {
    let index = 0;
    do {
      filename = `images/workflow-${hash(bytes)}${index ? `-${index}` : ''}.png`;
      index++;
    } while (source.files.has(filename));
  }
  source.files.set(filename, bytes);
  source.zip.file(filename, bytes, { date: epoch });
  return {
    path: filename,
    name: title,
    fileName: title,
    type: 'image/png',
    size: bytes.length,
  };
}
async function bindSceneLayers(source, map, operation) {
  const layers = [];
  for (const layer of map.layers) {
    const bytes = inlineBytes(layer.source, 'image/png', 40 * 1024 * 1024),
      ref = sourceReference(source, bytes, `${layer.id}.png`);
    const { source: _source, ...metadata } = layer;
    layers.push({ ...metadata, path: ref.path, sha256: hash(bytes) });
  }
  source.data.workbench ||= {};
  const prior = source.data.workbench.sceneWorkflowMap;
  source.data.workbench.sceneWorkflowMap = {
    format: 'forge-scene-workflow-map',
    version: 1,
    canvas: {
      x: map.origin.x,
      y: map.origin.y,
      width: map.layers[0].width,
      height: map.layers[0].height,
    },
    layers,
    operations: [...(prior?.operations || []), operation],
  };
  source.zip.remove('preview.png');
  source.zip.file(source.filename, JSON.stringify(source.data), {
    date: source.zip.file(source.filename)?.date || epoch,
  });
  const bytes = await source.zip.generateAsync({
    type: 'nodebuffer',
    compression: 'STORE',
  });
  if (bytes.length > MAX_MAP_PROJECT_BYTES) fail('派生地图源包超过 256 MiB。');
  map.source = zipSource(bytes);
  return hash(bytes);
}
async function createMap(image, input, work, step) {
  const info = await inspectImageBytes(image.bytes, { pngOnly: true });
  const [aw, ah] = input.aspectRatio.split(':').map(Number);
  if (Math.abs(info.width / info.height - aw / ah) / (aw / ah) > 0.03)
    fail('生成背景的画幅比例与地图创建要求不一致。');
  const zip = new JSZip(),
    ref = {
      path: 'images/source.png',
      fileName: 'source.png',
      type: 'image/png',
      size: image.bytes.length,
      width: info.width,
      height: info.height,
      generation: {
        sourceTaskId: image.generation.sourceTaskId,
        sha256: info.sha256,
      },
    };
  zip.file(ref.path, image.bytes, { date: epoch });
  const data = {
    format: 'pixelwork-map-stitch-state',
    version: 2,
    source: ref,
    tiles: {},
    tileUploads: {},
    tileLayerUploads: {
      surface: {},
      object: {},
      mask: {},
      black: {},
      white: {},
    },
    tileFeathers: { '0,0': emptyFeather() },
    hiddenPreviewTiles: { '0,0': false },
    selectedKey: '0,0',
    horizontalOverlapPercent: 15,
    verticalOverlapPercent: 15,
    expandSplit: 4,
    pan: { x: 0, y: 0 },
    zoom: 1,
    activeMapLayer: 'overall',
    hidePreviewBorders: false,
    hidePreviewCards: false,
    surfaceLayerPrompt: input.prompt,
    blackLayerPrompt: '',
    whiteLayerPrompt: '',
    drawShapes: [],
    workbench: {
      layerLocks: Object.fromEntries(
        [...imageLayers, 'collision', 'occlusion', 'adjust', 'top'].map(
          (key) => [key, false],
        ),
      ),
      tileImageOrigins: { '0,0': { overall: 'api-generated' } },
      surfaceDrafts: { '0,0': false },
      tileAdditionalPrompts: { '0,0': '' },
    },
  };
  const map = {
    name: input.name,
    origin: { x: 0, y: 0 },
    offset: input.origin,
    layers: [
      {
        id: 'map_overall',
        name: input.name,
        source: dataImage(image.bytes),
        width: info.width,
        height: info.height,
        locked: true,
        hidden: false,
        included: true,
      },
    ],
    collisions: [],
    source: '',
    warnings: ['此背景尚未配置地图碰撞。请设置并检查碰撞后再验证游戏行为。'],
  };
  const operation = {
    workId: work.id,
    stepId: step.id,
    operation: 'create',
    inputHash: fingerprint(input),
    sourceTaskId: image.generation.sourceTaskId,
    generatedSha256: info.sha256,
    stitchedSha256: info.sha256,
    tileKey: '0,0',
    layerId: 'map_overall',
    tileBounds: { x: 0, y: 0, width: info.width, height: info.height },
    beforeMapHash: workflowMapHash(null),
  };
  const source = {
    zip,
    files: new Map([[ref.path, image.bytes]]),
    filename: 'map_stitch_state.json',
    data,
  };
  await bindSceneLayers(source, map, operation);
  return { map, operation };
}
async function mapComposite(scene) {
  const map = scene.map,
    overlays = [];
  for (const id of [...scene.order].reverse()) {
    const layer = map.layers.find((layer) => layer.id === id);
    if (layer?.included)
      overlays.push({
        input: inlineBytes(layer.source, 'image/png', 40 * 1024 * 1024),
        left: 0,
        top: 0,
      });
  }
  return sharp({
    create: {
      width: map.layers[0].width,
      height: map.layers[0].height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(overlays)
    .png()
    .toBuffer();
}
export async function mapGenerationTemplate(scene, target) {
  const map = scene.map,
    before = {
      x: map.origin.x,
      y: map.origin.y,
      width: map.layers[0].width,
      height: map.layers[0].height,
    },
    image = await pixels(await mapComposite(scene)),
    data = Buffer.alloc(target.width * target.height * 4);
  copyRect(image.data, before.width, before, data, target.width, target);
  return png(data, target.width, target.height);
}
/** Overlap is provider context; the old canvas remains byte-exact, including holes. */
export async function stitchMapExtension(
  template,
  generated,
  target,
  beforeCanvas,
) {
  const restored = await pixels(
    await preserveMapTemplatePixels(template, generated),
  );
  if (
    restored.info.width !== target.width ||
    restored.info.height !== target.height
  )
    fail('扩图结果与目标地图块尺寸不一致。');
  const overlap = intersect(target, beforeCanvas);
  if (overlap)
    for (let y = overlap.y; y < overlap.y + overlap.height; y++)
      restored.data.fill(
        0,
        ((y - target.y) * target.width + overlap.x - target.x) * 4,
        ((y - target.y) * target.width + overlap.x - target.x + overlap.width) *
          4,
      );
  return png(restored.data, target.width, target.height);
}
async function extendMap(
  before,
  source,
  image,
  input,
  work,
  step,
  target,
  canvas,
  template,
) {
  const map = structuredClone(before.map),
    oldCanvas = source.canvas,
    key = workflowMapTileKey(step),
    layerId = workflowMapLayerId(step);
  const tileBytes = await stitchMapExtension(
      template,
      image.bytes,
      target,
      oldCanvas,
    ),
    ref = {
      ...sourceReference(source, tileBytes, `${key}.png`),
      width: target.width,
      height: target.height,
    };
  const geometry = {
    x: target.x / source.base.width,
    y: target.y / source.base.height,
    w: target.width / source.base.width,
    h: target.height / source.base.height,
  };
  const separated =
    map.layers.some((layer) => layer.id === 'map_surface') &&
    map.layers.some((layer) => layer.id === 'map_object');
  if (source.filename === 'map-project.json') {
    const images = { overall: ref };
    if (separated) {
      images.surface = ref;
      images.object = {
        ...sourceReference(
          source,
          await png(
            Buffer.alloc(target.width * target.height * 4),
            target.width,
            target.height,
          ),
          `${key}-object.png`,
        ),
        width: target.width,
        height: target.height,
      };
    }
    source.data.snapshot.tiles.push({
      key,
      ...geometry,
      images,
      imageOrigins: {
        overall: 'pixel-edited',
        ...(separated
          ? { surface: 'pixel-edited', object: 'pixel-edited' }
          : {}),
      },
      surfaceIsDraft: false,
      feather: emptyFeather(),
      hidden: false,
    });
  } else {
    source.data.tiles[key] = geometry;
    source.data.tileUploads[key] = ref;
    source.data.tileFeathers[key] = emptyFeather();
    source.data.hiddenPreviewTiles[key] = false;
    if (separated) {
      source.data.tileLayerUploads.surface[key] = ref;
      source.data.tileLayerUploads.object[key] = {
        ...sourceReference(
          source,
          await png(
            Buffer.alloc(target.width * target.height * 4),
            target.width,
            target.height,
          ),
          `${key}-object.png`,
        ),
        width: target.width,
        height: target.height,
      };
    }
  }
  for (const layer of map.layers) {
    layer.source = dataImage(
      await padded(
        inlineBytes(layer.source, 'image/png', 40 * 1024 * 1024),
        oldCanvas,
        canvas,
      ),
    );
    layer.width = canvas.width;
    layer.height = canvas.height;
  }
  map.origin = { x: canvas.x, y: canvas.y };
  map.layers.push({
    id: layerId,
    name: input.name,
    source: dataImage(await padded(tileBytes, target, canvas)),
    width: canvas.width,
    height: canvas.height,
    locked: true,
    hidden: false,
    included: true,
  });
  const overlap = intersect(target, oldCanvas),
    radius = Math.max(1, Math.floor(Math.min(target.width, target.height) / 4));
  const detail = intersect(canvas, {
    x: overlap.x - radius,
    y: overlap.y - radius,
    width: overlap.width + radius * 2,
    height: overlap.height + radius * 2,
  });
  const reviewRegion = {
    x: detail.x + map.offset.x,
    y: detail.y + map.offset.y,
    width: detail.width,
    height: detail.height,
  };
  const operation = {
    workId: work.id,
    stepId: step.id,
    operation: 'extend',
    inputHash: fingerprint(input),
    sourceTaskId: image.generation.sourceTaskId,
    generatedSha256: hash(image.bytes),
    stitchedSha256: hash(tileBytes),
    method: 'preserve-overlap-and-clip-old-canvas-v1',
    tileKey: key,
    layerId,
    tileBounds: target,
    beforeCanvas: oldCanvas,
    beforeSourceSha256: source.sourceSha256,
    beforeMapHash: workflowMapHash(before.map),
    reviewRegion,
  };
  await bindSceneLayers(source, map, operation);
  return { map, operation };
}

function stripAddedTiles(source, addedKeys) {
  const data = structuredClone(source.data);
  if (source.filename === 'map-project.json')
    data.snapshot.tiles = data.snapshot.tiles.filter(
      (tile) => !addedKeys.has(tile.key),
    );
  else {
    for (const key of addedKeys) {
      delete data.tiles[key];
      delete data.tileUploads[key];
      delete data.tileFeathers[key];
      delete data.hiddenPreviewTiles[key];
      for (const uploads of Object.values(data.tileLayerUploads))
        delete uploads[key];
    }
  }
  if (data.workbench) {
    delete data.workbench.sceneWorkflowMap;
    if (!Object.keys(data.workbench).length) delete data.workbench;
  }
  return data;
}
async function assertPixelPreservation(root, beforeMap, afterMap, additions) {
  const oldFrame = {
      x: beforeMap.origin.x,
      y: beforeMap.origin.y,
      width: beforeMap.layers[0].width,
      height: beforeMap.layers[0].height,
    },
    finalFrame = {
      x: afterMap.origin.x,
      y: afterMap.origin.y,
      width: afterMap.layers[0].width,
      height: afterMap.layers[0].height,
    };
  if (!same(union(oldFrame, finalFrame), finalFrame))
    fail('扩图缩小了已有地图范围。');
  for (const beforeLayer of beforeMap.layers) {
    const afterLayer = afterMap.layers.find(
      (layer) => layer.id === beforeLayer.id,
    );
    if (
      !afterLayer ||
      !same(
        {
          ...beforeLayer,
          source: undefined,
          width: undefined,
          height: undefined,
        },
        {
          ...afterLayer,
          source: undefined,
          width: undefined,
          height: undefined,
        },
      )
    )
      fail('地图制作改变了已有图层身份、锁、显示或参与标记。');
    const expected = await pixels(
        await padded(
          (await readImageAssetSource(beforeLayer.source, root)).buffer,
          oldFrame,
          finalFrame,
        ),
      ),
      actual = await pixels(
        (await readImageAssetSource(afterLayer.source, root)).buffer,
      );
    if (!actual.data.equals(expected.data))
      fail('地图扩展改变了旧图层像素或世界坐标。');
  }
  const expectedIds = [
    ...beforeMap.layers.map((layer) => layer.id),
    ...additions.map((item) => item.layerId),
  ];
  if (
    !same(
      expectedIds,
      afterMap.layers.map((layer) => layer.id),
    )
  )
    fail('地图增加了未授权图层或改变了图层顺序。');
  for (const item of additions) {
    const layer = afterMap.layers.find((layer) => layer.id === item.layerId),
      actual = await pixels(
        (await readImageAssetSource(layer.source, root)).buffer,
      ),
      tile = item.tileBounds;
    if (!layer.locked || layer.hidden || !layer.included)
      fail('新地图层的保护或参与标记与执行回执不一致。');
    const overlap = intersect(finalFrame, item.beforeCanvas);
    for (let y = finalFrame.y; y < finalFrame.y + finalFrame.height; y++)
      for (let x = finalFrame.x; x < finalFrame.x + finalFrame.width; x++) {
        const inTile =
          x >= tile.x &&
          x < tile.x + tile.width &&
          y >= tile.y &&
          y < tile.y + tile.height;
        const inOld =
          overlap &&
          x >= overlap.x &&
          x < overlap.x + overlap.width &&
          y >= overlap.y &&
          y < overlap.y + overlap.height;
        const offset =
          ((y - finalFrame.y) * finalFrame.width + x - finalFrame.x) * 4;
        if (
          (!inTile || inOld) &&
          (actual.data[offset] ||
            actual.data[offset + 1] ||
            actual.data[offset + 2] ||
            actual.data[offset + 3])
        )
          fail('新增地图层覆盖了旧画布或超出已授权地图块。');
      }
  }
}
function receiptOutputs(work, receipts) {
  return (receipts || work.steps || [])
    .filter((receipt) => receipt.mapOutput)
    .map((receipt) => receipt.mapOutput);
}
function assertTileBudget(work, receipt) {
  const mapIds = new Set(
    (work.plans || [])
      .flatMap((record) => record.plan?.steps || [])
      .filter((step) => step.kind === 'map')
      .map((step) => step.id),
  );
  const intents = new Set(
    (work.steps || [])
      .filter(
        (item) =>
          item.kind === 'map' ||
          item.mapJob ||
          item.mapOutput ||
          mapIds.has(item.id),
      )
      .map((item) => item.id),
  );
  intents.add(receipt.id);
  if (intents.size > (work.spec.budget.mapTiles || 0))
    fail('地图块制作意图超过已授权总额度；失败或未知请求仍占用原额度。');
}
/** Audits private execution receipts, full source bytes and unchanged world pixels. */
export async function assertMapPolicy(
  root,
  sourceMap,
  candidateMap,
  work,
  receipts,
) {
  const outputs = receiptOutputs(work, receipts),
    mode = work.spec.mapMode || 'preserve';
  if (!outputs.length) {
    const before = structuredClone(sourceMap),
      after = structuredClone(candidateMap);
    if (before && after) {
      for (const layer of before.layers)
        if (work.spec.editableMapLayerIds?.includes(layer.id)) {
          const target = after.layers.find((item) => item.id === layer.id);
          if (!target || layer.locked) fail('允许改图的原地图层缺失或锁定。');
          layer.source = target.source = '<authorized-image-edit>';
        }
      if (work.spec.editableMapLayerIds?.length)
        before.source = after.source = '<versioned-source-package>';
    }
    if (!same(before, after)) fail('地图变化缺少本任务已保存的制作回执。');
    return;
  }
  if (mode === 'preserve' || outputs.length > (work.spec.budget.mapTiles || 0))
    fail('地图变化超出冻结策略或地图块总额度。');
  if (!candidateMap || !candidateMap.layers.length)
    fail('地图制作结果缺少完整地图。');
  const plans = (work.plans || []).flatMap(
      (record) => record.plan?.steps || [],
    ),
    identities = new Set();
  let expected = workflowMapHash(sourceMap);
  for (const output of outputs) {
    if (
      identities.has(output.stepId) ||
      output.beforeMapHash !== expected ||
      !/^[a-f0-9]{64}$/.test(output.afterMapHash || '')
    )
      fail('地图执行回执链不完整或顺序冲突。');
    identities.add(output.stepId);
    const step = plans.find(
      (step) => step.id === output.stepId && step.kind === 'map',
    );
    if (!step || fingerprint(inputFor(step)) !== output.inputHash)
      fail('地图执行回执与冻结方案不一致。');
    if (
      output.operation === 'create' &&
      (sourceMap || output !== outputs[0] || mode !== 'create')
    )
      fail('地图创建不能替换原地图。');
    if (
      output.operation === 'extend' &&
      !sourceMap &&
      outputs[0].operation !== 'create'
    )
      fail('地图扩展缺少已授权来源。');
    expected = output.afterMapHash;
  }
  if (workflowMapHash(candidateMap) !== expected)
    fail('地图候选与确切执行结果哈希不一致。');
  const finalSource = await loadSource(candidateMap);
  await verifyLayerBindings(root, candidateMap, finalSource);
  const operations = finalSource.data.workbench?.sceneWorkflowMap?.operations;
  for (const output of outputs) {
    const operation = operations?.find(
      (item) => item.workId === work.id && item.stepId === output.stepId,
    );
    const {
      afterMapHash: _after,
      afterSourceSha256: _source,
      resultName: _result,
      ...intent
    } = output;
    if (!operation || !same(operation, intent))
      fail('地图候选源包缺少确切的生成与拼接来源。');
  }
  if (outputs.at(-1).afterSourceSha256 !== finalSource.sourceSha256)
    fail('地图候选源包哈希与执行回执不一致。');
  if (sourceMap) {
    if (
      !same(sourceMap.offset, candidateMap.offset) ||
      !same(sourceMap.collisions, candidateMap.collisions) ||
      sourceMap.name !== candidateMap.name ||
      !same(sourceMap.warnings, candidateMap.warnings)
    )
      fail('扩图改变了地图偏移、碰撞、名称或原有警告。');
    const original = await loadSource(sourceMap),
      added = new Set(
        outputs
          .filter((item) => item.operation === 'extend')
          .map((item) => item.tileKey),
      );
    if (
      original.filename !== finalSource.filename ||
      !same(
        stripAddedTiles(original, new Set()),
        stripAddedTiles(finalSource, added),
      )
    )
      fail('地图扩展改写了已有源地图块、几何、区域、锁或编辑设置。');
    for (const [filename, bytes] of original.files)
      if (
        filename !== original.filename &&
        filename !== 'preview.png' &&
        (!finalSource.files.has(filename) ||
          !bytes.equals(finalSource.files.get(filename)))
      )
        fail('地图扩展替换了已有源图片字节。');
    await assertPixelPreservation(
      root,
      sourceMap,
      candidateMap,
      outputs.filter((item) => item.operation === 'extend'),
    );
  }
}

/** Uses only the candidate document and the existing exactly-once image stack. */
export async function executeMapStep(store, work, step, receipt, persist) {
  const input = inputFor(step),
    manifest = store.candidateManifest(work);
  assertTileBudget(work, receipt);
  const finish = async (document) => {
    work.mapSource = await inspectMapSource(store.root, document.content.map);
    if ((work.spec.mapMode || 'preserve') === 'create')
      work.mapSource.createdByWorkflow = receiptOutputs(work).some(
        (item) => item.operation === 'create',
      );
    return { document, mapEvidence: receipt.mapEvidence || receipt.mapOutput };
  };
  if (!receipt.beforeRevision) {
    const document = (
      await getDocument(store.root, manifest, {
        documentId: work.spec.documentId,
      })
    ).document;
    receipt.beforeRevision = document.revision;
    receipt.beforeHash = document.contentHash;
    receipt.commandId = `scene:${work.id}:${work.plans.length}:${step.id}`;
    await persist();
  }
  const before = (
    await getDocument(store.root, manifest, {
      documentId: work.spec.documentId,
      revision: receipt.beforeRevision,
    })
  ).document;
  if (before.contentHash !== receipt.beforeHash)
    fail('地图步骤的候选来源版本哈希不一致。');
  if (receipt.mapOutput) {
    if (
      receipt.mapOutput.inputHash !== fingerprint(input) ||
      !/^map-result-[a-f0-9]{32}$/.test(receipt.mapOutput.resultName)
    )
      fail(
        '同一地图步骤的原请求意图或快照身份发生变化。',
        'SCENE_MAP_INTENT_CHANGED',
      );
    const saved = await store.read(
      path.join(
        store.directory(work.id),
        `${receipt.mapOutput.resultName}.json`,
      ),
    );
    if (workflowMapHash(saved.content.map) !== receipt.mapOutput.afterMapHash)
      fail('地图制作快照哈希不一致。');
    const source = await store.source(work);
    await assertMapPolicy(
      store.root,
      source.document.content.map,
      saved.content.map,
      work,
      [...(work.steps || []).filter((item) => item !== receipt), receipt],
    );
    return finish(
      (
        await saveDocument(
          store.root,
          manifest,
          {
            documentId: before.id,
            expectedRevision: before.revision,
            commandId: receipt.commandId,
            content: saved.content,
          },
          { respectLocks: true },
        )
      ).document,
    );
  }
  const summary = await inspectMapSource(store.root, before.content.map);
  if ((work.spec.mapMode || 'preserve') === 'create' && before.content.map)
    summary.createdByWorkflow = (
      await loadSource(before.content.map)
    ).data.workbench?.sceneWorkflowMap?.operations.some(
      (item) => item.workId === work.id && item.operation === 'create',
    );
  validateMapStep(work, before.content, step, summary);
  if (receiptOutputs(work).length >= (work.spec.budget.mapTiles || 0))
    fail('地图块总额度已用完。');
  let source, bounds, template;
  if (input.operation === 'extend') {
    source = await loadSource(before.content.map);
    await verifyLayerBindings(store.root, before.content.map, source);
    bounds = extensionBounds(summary, input);
    template = await mapGenerationTemplate(before.content, bounds.target);
  }
  const request =
    input.operation === 'create'
      ? {
          purpose: `${step.id}:map-origin`,
          capability: 'map-stitcher',
          input: {
            operation: 'generate-origin',
            prompt: input.prompt,
            aspectRatio: input.aspectRatio,
          },
        }
      : {
          purpose: `${step.id}:map-extension`,
          capability: 'map-stitcher',
          input: {
            operation: 'generate-layer',
            image: dataImage(template),
            prompt: `${input.prompt}\n\nContinue the neighboring 2D environment into the transparent area toward ${input.direction}. Preserve all supplied overlap pixels, camera, scale and ground continuity. Do not add interface, borders or labels.`,
            tile: {
              key: workflowMapTileKey(step),
              x: bounds.target.x / source.base.width,
              y: bounds.target.y / source.base.height,
              w: bounds.target.width / source.base.width,
              h: bounds.target.height / source.base.height,
            },
            layer: 'overall',
            mask_mode: 'white',
          },
        };
  receipt.mapJob ||= {
    id: `${step.id}-map`,
    commandId: `${receipt.commandId}:map`,
  };
  const { runWorkflowImageJob } =
    await import('./scene-workflow-generation.mjs');
  const job = await runWorkflowImageJob(
    store,
    work,
    receipt.mapJob,
    request,
    persist,
  );
  if (job.paused) return job;
  const made =
    input.operation === 'create'
      ? await createMap(job.image, input, work, step)
      : await extendMap(
          before.content,
          source,
          job.image,
          input,
          work,
          step,
          bounds.target,
          bounds.canvas,
          template,
        );
  const content = structuredClone(before.content);
  if (input.operation === 'create') replaceMap(content, made.map);
  else {
    content.map = made.map;
    content.order.push(made.operation.layerId);
  }
  const clean = validateScene(content),
    resultName = `map-result-${hash(receipt.commandId).slice(0, 32)}`;
  receipt.mapOutput = {
    ...made.operation,
    afterMapHash: workflowMapHash(clean.map),
    afterSourceSha256: hash(
      inlineBytes(clean.map.source, 'application/zip', MAX_MAP_PROJECT_BYTES),
    ),
    resultName,
  };
  receipt.mapEvidence = {
    ...receipt.mapOutput,
    generation: receipt.mapJob.generationEvidence,
  };
  await store.freeze(work.id, resultName, { content: clean });
  await persist();
  const frozen = await store.source(work);
  await assertMapPolicy(
    store.root,
    frozen.document.content.map,
    clean.map,
    work,
    [...(work.steps || []).filter((item) => item !== receipt), receipt],
  );
  return finish(
    (
      await saveDocument(
        store.root,
        manifest,
        {
          documentId: before.id,
          expectedRevision: before.revision,
          commandId: receipt.commandId,
          content: clean,
        },
        { respectLocks: true },
      )
    ).document,
  );
}
