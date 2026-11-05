import path from 'node:path';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import * as z from 'zod/v4';
import { validateScene, materialFor, sceneBounds, sceneWarnings } from '../../features/scene-composer/model.mjs';
import { objectRenderState, instanceRect, sceneDisplayOrder, mapSplitElementOrigin, mapSplitElementRect, activeMapCollisions } from '../../features/scene-composer/render-model.mjs';
import { simulationEventsSchema, createDocumentSimulation, replaySimulationEvents, simulationInstanceState } from '../../features/scene-composer/simulation-replay.mjs';

const coordinate = z.number().min(-1e7).max(1e7);
const optionsSchema = z.object({
  revision: z.number().int().positive().optional(),
  region: z.object({ x: coordinate, y: coordinate, width: z.number().positive().max(60000), height: z.number().positive().max(60000) }).strict().optional(),
  maxWidth: z.number().int().min(128).max(2048).default(1280),
  maxHeight: z.number().int().min(128).max(2048).default(1024),
  time: z.number().min(0).max(3600).default(0),
  events: simulationEventsSchema.optional(),
  mode: z.enum(['editor', 'export']).default('export'),
  overlay: z.boolean().default(true),
}).strict();
const sha = (value) => createHash('sha256').update(value).digest('hex');
const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const contained = (base, target) => {
  const relative = path.relative(base, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

async function observationDirectory(base, segments) {
  await mkdir(base, { recursive: true });
  const actualBase = await realpath(base);
  let directory = actualBase;
  // Validate each existing parent before creating children; a junction must not
  // move observation writes outside the configured output root.
  for (const segment of segments) {
    const next = path.join(directory, segment);
    await mkdir(next).catch(error => { if (error.code !== 'EEXIST') throw error; });
    directory = await realpath(next);
    if (!contained(actualBase, directory) || !(await stat(directory)).isDirectory()) throw new Error('观察输出路径超出允许的目录。');
  }
  return directory;
}

async function imageResource(root, manifest, source) {
  let bytes;
  const inline = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source);
  if (inline) {
    if (inline[2].length > 90_000_000) throw new Error('观察图片超过大小限制。');
    bytes = Buffer.from(inline[2], 'base64');
  } else {
    let relative = source;
    if (source.startsWith('/api/workbench/artifacts?')) {
      relative = new URL(source, 'http://localhost').searchParams.get('path');
    }
    if (!relative || path.isAbsolute(relative) || /^[a-z][a-z0-9+.-]*:/i.test(relative))
      throw new Error('观察只读取已嵌入的图片或工作台 outputs 内的素材；请先导入外部图片。');
    const outputRoot = await realpath(path.resolve(root, manifest.workspace.outputDirectory));
    const filename = await realpath(path.resolve(root, relative));
    if (!contained(outputRoot, filename)) throw new Error('观察素材不在工作台输出目录中。');
    const info = await stat(filename);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('观察图片大小无效。');
    bytes = await readFile(filename);
  }
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('观察图片大小无效。');
  const decoder = sharp(bytes, { limitInputPixels: 64_000_000, animated: false });
  const metadata = await decoder.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height || (metadata.pages || 1) > 1)
    throw new Error('观察素材必须是单帧 PNG、JPEG 或 WebP。');
  const png = await decoder.ensureAlpha().png().toBuffer();
  return { width: metadata.width, height: metadata.height, sha256: sha(bytes), png, tiles: new Map(), bytes: bytes.length };
}

// Reference each texture once. Large textures are supplied to librsvg in
// bounded tiles, including only source tiles that intersect the requested view.
const textureTile = 1024;
function textureReference(resource, world, viewport, frame, flipH = false, flipV = false) {
  const src = frame || { x: 0, y: 0, width: resource.width, height: resource.height };
  const range = (pos, length, start, size, viewPos, viewSize, flipped) => {
    const lo = Math.max(0, (viewPos - pos) / length);
    const hi = Math.min(1, (viewPos + viewSize - pos) / length);
    if (lo >= hi) return [0, 0];
    return [Math.floor((start + (flipped ? 1 - hi : lo) * size) / textureTile),
      Math.ceil((start + (flipped ? 1 - lo : hi) * size) / textureTile)];
  };
  const view = viewport || world;
  const [left, right] = range(world.x, world.width, src.x, src.width, view.x, view.width, flipH);
  const [top, bottom] = range(world.y, world.height, src.y, src.height, view.y, view.height, flipV);
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++)
    resource.tiles.set(`${x},${y}`, { left: x * textureTile, top: y * textureTile });
  return `<use href="#${resource.id}"/>`;
}

async function textureDefinitions(resources) {
  const definitions = [];
  for (const resource of resources) {
    const images = [];
    // Multiple crops of a large PNG should inflate it only once per render.
    const raw = resource.tiles.size > 1
      ? await sharp(resource.png).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      : null;
    for (const { left, top } of resource.tiles.values()) {
      const width = Math.min(textureTile, resource.width - left);
      const height = Math.min(textureTile, resource.height - top);
      let png = resource.png;
      if (width !== resource.width || height !== resource.height) {
        const input = raw ? sharp(raw.data, { raw: raw.info }) : sharp(png);
        png = await input.extract({ left, top, width, height }).png().toBuffer();
      }
      images.push(`<image x="${left}" y="${top}" width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}" style="image-rendering:pixelated"/>`);
    }
    definitions.push(`<g id="${resource.id}">${images.join('')}</g>`);
  }
  return `<defs>${definitions.join('')}</defs>`;
}

function shapeBounds(shape, instance, origin) {
  const sx = instance.scale * (instance.flipH ? -1 : 1);
  const width = (shape.type === 'circle' ? shape.radius * 2 : shape.width) * instance.scale;
  const height = (shape.type === 'circle' ? shape.radius * 2 : shape.type === 'capsule' ? Math.max(shape.height, shape.width) : shape.height) * instance.scale;
  return { x: origin.x + shape.offset.x * sx - width / 2, y: origin.y + shape.offset.y * instance.scale - height / 2, width, height };
}

function shapeSvg(shape, color) {
  const common = `fill="${color}" fill-opacity="0.1" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke"`;
  if (shape.type === 'circle') return `<circle cx="${shape.offset.x}" cy="${shape.offset.y}" r="${shape.radius}" ${common}/>`;
  const height = shape.type === 'capsule' ? Math.max(shape.height, shape.width) : shape.height;
  return `<rect x="${shape.offset.x - shape.width / 2}" y="${shape.offset.y - height / 2}" width="${shape.width}" height="${height}" rx="${shape.type === 'capsule' ? shape.width / 2 : 0}" ${common}/>`;
}

function unionBounds(rectangles) {
  if (!rectangles.length) return { x: 0, y: 0, width: 640, height: 480 };
  const x = Math.min(...rectangles.map((r) => r.x));
  const y = Math.min(...rectangles.map((r) => r.y));
  return { x, y, width: Math.max(1, ...rectangles.map((r) => r.x + r.width - x)), height: Math.max(1, ...rectangles.map((r) => r.y + r.height - y)) };
}

/** Renders saved content, never the browser's unsaved draft or its view transform. */
export async function observeScene(root, manifest, document, input = {}) {
  const options = optionsSchema.parse(input);
  if (document.kind !== 'scene') throw new Error('视觉观察目前支持场景文档。');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(document.id) || !Number.isSafeInteger(document.revision) || document.revision < 1)
    throw new Error('观察文档身份或版本无效。');
  if (options.revision !== undefined && options.revision !== document.revision) throw new Error('观察版本与文档不匹配。');
  const scene = validateScene(document.content);
  if (input.time !== undefined && options.events !== undefined) throw new Error('事件观察请用 tick 指定时间，不要同时传 time。');
  const replay = options.events === undefined ? null : replaySimulationEvents(createDocumentSimulation('scene', scene), options.events);
  if (replay && (replay.truncated || replay.linkDiagnostics.length)) throw new Error('事件回放未完整完成，请先解决联动诊断或缩小场景事件范围。');
  const renderTime = replay?.simulation.time ?? options.time;
  const replayEvidence = replay ? Object.fromEntries(Object.entries(replay).filter(([key]) => key !== 'simulation')) : null;
  const preview = options.mode === 'export';
  const selected = (node) => preview ? node.included : !node.hidden;
  const instances = scene.instances.filter(selected);
  const display = sceneDisplayOrder(scene);
  const layers = display.filter(entry => entry.kind === 'layer').map(entry => entry.layer).filter(selected);
  const splitParts = display.filter(entry => entry.kind === 'map-split-part' && selected(entry.element));
  const objects = [];
  const draws = new Map();
  const overlays = [];
  const diagnostics = sceneWarnings(scene).map((message) => ({ severity: 'warning', code: 'scene-warning', message }));
  const resources = [];
  const cache = new Map();
  let totalBytes = 0;
  const load = async (source, id) => {
    let resource = cache.get(source);
    if (!resource) {
      try { resource = await imageResource(root, manifest, source); }
      catch (error) { throw new Error(`素材 ${id} 无法完整加载：${error.message}`, { cause: error }); }
      totalBytes += resource.bytes;
      if (totalBytes > 256 * 1024 * 1024) throw new Error('观察素材总量超过 256 MiB，请减少源素材大小。');
      resource.id = `texture-${cache.size}`;
      cache.set(source, resource);
    }
    resources.push({ id, sha256: resource.sha256, width: resource.width, height: resource.height });
    return resource;
  };
  const mapBounds = sceneBounds(scene);
  for (const layer of layers) {
    const resource = await load(layer.source, layer.id);
    const rect = { ...mapBounds, width: layer.width, height: layer.height };
    draws.set(layer.id, `<g transform="translate(${rect.x} ${rect.y}) scale(${rect.width / resource.width} ${rect.height / resource.height})" opacity="${!preview && !layer.included ? 0.25 : 1}">${textureReference(resource, rect, options.region)}</g>`);
  }
  for (const entry of splitParts) {
    const { element, part, rect, key } = entry;
    const resource = await load(part.source, key);
    if (resource.width !== part.width || resource.height !== part.height) throw new Error(`场景分层子片 ${key} 的尺寸与清单不一致。`);
    draws.set(key, `<g transform="translate(${rect.x} ${rect.y})" opacity="${!preview && !element.included ? 0.25 : 1}">${textureReference(resource, rect, options.region)}</g>`);
  }
  for (const element of scene.mapSplit && !scene.mapSplit.stale ? scene.mapSplit.elements.filter(selected) : []) {
    const origin = mapSplitElementOrigin(scene, element);
    const parts = splitParts.filter(entry => entry.id === element.id).map(entry => ({ id: entry.part.id, role: entry.part.role, plane: entry.part.plane, rect: entry.rect, enabled: entry.part.enabled, zIndex: entry.zIndex }));
    const rect = mapSplitElementRect(scene, element);
    const collision = { enabled: element.collision.enabled, polygons: element.collision.polygons.map(points => points.map(point => ({ x: point.x + origin.x, y: point.y + origin.y }))), mapIndices: element.collision.mapIndices };
    objects.push({ id: element.id, name: element.name, kind: element.kind, mapSplit: true, rect, selectionRect: rect, anchor: origin, parts, collision, visible: parts.length > 0, enabled: true, solidEnabled: element.collision.enabled, included: element.included, locked: element.locked });
    if (element.collision.enabled) for (const points of collision.polygons) overlays.push(`<polygon points="${points.map(point => `${point.x},${point.y}`).join(' ')}" fill="#d97706" fill-opacity="0.1" stroke="#d97706" vector-effect="non-scaling-stroke"/>`);
    overlays.push(`<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="none" stroke="#7c3aed" vector-effect="non-scaling-stroke"/><text x="${rect.x}" y="${rect.y - 5}" fill="#111827" stroke="#ffffff" stroke-width="3" paint-order="stroke" font-size="12">${xml(element.id)}</text>`);
  }
  for (const instance of instances) {
    const material = materialFor(scene, instance);
    const simulated = replay?.simulation.objects.find(entry => entry.id === instance.id);
    const state = objectRenderState(instance, material, { time: renderTime, simulated, preview });
    const { visual: v, object, appearance, frame, asset, rgb } = state;
    const effective = simulated ? simulationInstanceState(replay.simulation, instance.id) : null;
    const solidEnabled = effective?.solidEnabled ?? ((appearance.solidEnabled ?? object.solid.enabled) && !state.completedHidden);
    const selectionRect = instanceRect(instance, material);
    const rect = state.renderRect;
    const shapes = {
      detection: shapeBounds(object.detection.shape, instance, state.origin),
      pointer: shapeBounds(object.pointer, instance, state.origin),
      ...(solidEnabled ? { solid: shapeBounds(object.solid.shape, instance, state.origin) } : {}),
    };
    objects.push({ id: instance.id, name: instance.name, materialId: instance.materialId, rect, selectionRect, anchor: { x: instance.x, y: instance.y }, shapes, visible: state.visible, enabled: state.enabled, solidEnabled, included: instance.included, ...(effective ? { state: effective } : {}) });
    const tint = `observe-tint-${instance.id}`;
    let art;
    if (asset) {
      const resource = await load(asset.source, `${instance.id}:${asset.id}`);
      const region = frame?.region;
      if (region && (region.x + region.width > resource.width || region.y + region.height > resource.height))
        throw new Error(`素材 ${instance.id} 的动画区域超出图片边界。`);
      const viewBox = region ? `${region.x} ${region.y} ${region.width} ${region.height}` : `0 0 ${resource.width} ${resource.height}`;
      const texture = textureReference(resource, rect, options.region, region, instance.flipH !== v.flipH, v.flipV);
      art = `<svg x="${-v.width / 2}" y="${-v.height / 2}" width="${v.width}" height="${v.height}" viewBox="${viewBox}" preserveAspectRatio="none"><g filter="url(#${tint})">${texture}</g></svg>`;
    } else {
      if (state.assetId) throw new Error(`物件 ${instance.id} 缺少引用的图片 ${state.assetId}。`);
      art = `<rect x="${v.dot ? -5 : -v.width / 2}" y="${v.dot ? -5 : -v.height / 2}" width="${v.dot ? 10 : v.width}" height="${v.dot ? 10 : v.height}" rx="${v.dot ? 5 : 3}" fill="${state.placeholderFill}"/>`;
    }
    const filter = `<defs><filter id="${tint}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${rgb[0]} 0 0 0 0 0 ${rgb[1]} 0 0 0 0 0 ${rgb[2]} 0 0 0 0 0 1 0"/></filter></defs>`;
    draws.set(instance.id, `<g opacity="${!preview && !instance.included ? 0.25 : 1}" transform="${state.outerTransform}"><g opacity="${state.opacity}" transform="${state.innerTransform}">${filter}${art}</g></g>`);
    overlays.push(`<g transform="${state.outerTransform}">${shapeSvg(object.detection.shape, '#16a34a')}${shapeSvg(object.pointer, '#2563eb')}${shapes.solid ? shapeSvg(object.solid.shape, '#d97706') : ''}</g>`);
    overlays.push(`<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="none" stroke="#e11d48" vector-effect="non-scaling-stroke"/><circle cx="${instance.x}" cy="${instance.y}" r="3" fill="#e11d48"/><text x="${rect.x}" y="${rect.y - 5}" fill="#111827" stroke="#ffffff" stroke-width="3" paint-order="stroke" font-size="12">${xml(instance.id)}</text>`);
  }
  for (const { points } of activeMapCollisions(scene)) {
    overlays.push(`<polygon points="${points.map((q) => `${q.x + scene.map.offset.x},${q.y + scene.map.offset.y}`).join(' ')}" fill="#d97706" fill-opacity="0.1" stroke="#d97706" vector-effect="non-scaling-stroke"/>`);
  }
  const region = options.region || unionBounds([
    ...layers.map((layer) => ({ x: mapBounds.x, y: mapBounds.y, width: layer.width, height: layer.height })),
    ...objects.map((object) => object.rect),
  ]);
  const scale = Math.min(options.maxWidth / region.width, options.maxHeight / region.height, 1);
  const width = Math.max(1, Math.round(region.width * scale));
  const height = Math.max(1, Math.round(region.height * scale));
  const content = await textureDefinitions(cache.values()) + [...display].reverse().map(entry => draws.get(entry.key) || '').join('');
  const render = async (overlay) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${region.x} ${region.y} ${region.width} ${region.height}" preserveAspectRatio="none">${content}${overlay ? overlays.join('') : ''}</svg>`)).png().toBuffer();
  // Finish both decodes before saving any claimed observation evidence.
  const clean = await render(false);
  const annotated = options.overlay ? await render(true) : null;
  const segments = ['observations', document.id, String(document.revision), randomUUID()];
  const relative = path.posix.join(manifest.workspace.outputDirectory.replaceAll('\\', '/'), ...segments);
  const directory = await observationDirectory(path.resolve(root, manifest.workspace.outputDirectory), segments);
  const images = [];
  for (const role of ['scene', 'overlay']) {
    const bytes = role === 'scene' ? clean : annotated;
    if (!bytes) continue;
    const filename = `${role}.png`;
    await writeFile(path.join(directory, filename), bytes);
    images.push({ role, artifactPath: `${relative}/${filename}`, mimeType: 'image/png', width, height, data: bytes.toString('base64'), sha256: sha(bytes) });
  }
  const evidence = {
    documentId: document.id, revision: document.revision, contentHash: document.contentHash || sha(JSON.stringify(scene)),
    complete: true, mode: options.mode, time: renderTime,
    viewport: { ...region, widthPx: width, heightPx: height, worldToImage: [width / region.width, 0, 0, height / region.height, -region.x * width / region.width, -region.y * height / region.height] },
    objects, diagnostics, resources, images, engineValidated: false,
    ...(scene.mapSplit ? { mapSplit: { candidateId: scene.mapSplit.candidateId, sourceHash: scene.mapSplit.sourceHash, review: scene.mapSplit.review, stale: scene.mapSplit.stale, conflicts: scene.mapSplit.conflicts.map(({ baseline: _baseline, current: _current, incoming: _incoming, ...conflict }) => conflict) } } : {}),
    ...(replayEvidence ? { simulation: replayEvidence } : {}),
    limitations: [replay ? '图片使用指定版本与有界事件回放后的状态；不是实际 Godot 运行或浏览器未保存内容。' : '静态渲染使用指定时间点与初始交互状态；不代表浏览器未保存内容或 Godot 运行验证。', '几何范围是显示与碰撞的包围框，未进行可达性或像素遮挡推断。'],
  };
  await writeFile(path.join(directory, 'observation.json'), `${JSON.stringify({ ...evidence, images: images.map(({ data: _data, ...metadata }) => metadata) }, null, 2)}\n`);
  return evidence;
}
