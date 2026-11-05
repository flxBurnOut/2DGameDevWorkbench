import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { rasterizeMapPolygon } from './map-split-raster.mjs';
import { segmentMapSelection } from './map-split-sam.mjs';
import {
  MAP_SPLIT_MAX_PIXELS,
  mapSplitIdSchema,
  mapSplitSelectionSchema,
  mapSplitSpecsSchema,
} from './map-split-spec.mjs';
export {
  MAP_SPLIT_MAX_PIXELS,
  MAP_SPLIT_SPEC_SCHEMA,
  mapSplitSpecsSchema,
  mapSplitSelectionSchema,
} from './map-split-spec.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function mapSplitError(
  message,
  code = 'MAP_SPLIT_INVALID',
  status = 400,
) {
  return Object.assign(new Error(message), { code, status });
}

function dimensions(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 30000 ||
    height > 30000 ||
    width * height > MAP_SPLIT_MAX_PIXELS
  )
    throw mapSplitError('地图尺寸超出限制（最长边 30000，最多 6400 万像素）。');
}
function pngSource(source) {
  if (
    typeof source !== 'string' ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(source)
  )
    throw mapSplitError('地图像素必须是内嵌 PNG，不接受路径或远程地址。');
  if (source.length > 360 * 1024 * 1024)
    throw mapSplitError('地图 PNG 超出限制。');
  return Buffer.from(source.slice(source.indexOf(',') + 1), 'base64');
}
async function decode(png, expected) {
  const image = sharp(png, { limitInputPixels: MAP_SPLIT_MAX_PIXELS });
  const meta = await image.metadata();
  dimensions(meta.width, meta.height);
  if (
    meta.format !== 'png' ||
    (expected &&
      (meta.width !== expected.width || meta.height !== expected.height))
  )
    throw mapSplitError('地图 PNG 尺寸与清单不符。');
  return {
    width: meta.width,
    height: meta.height,
    pixels: await image.toColourspace('srgb').ensureAlpha().raw().toBuffer(),
  };
}

/** Saved map layers already contain stitch overlap/feathering. order is front
 * first; hidden is an editor-only flag, while included controls map output.
 * Scene instances, actor and aids are deliberately outside this renderer. */
export async function freezeMapPixels(scene) {
  const map = scene?.map;
  if (!map || !Array.isArray(map.layers) || !Array.isArray(scene.order))
    throw mapSplitError('场景没有可分层的地图。');
  const selected = map.layers.filter((layer) => layer.included === true);
  if (!selected.length) throw mapSplitError('地图没有参与输出的图层。');
  if (
    new Set(scene.order).size !== scene.order.length ||
    new Set(selected.map((layer) => layer.id)).size !== selected.length ||
    selected.some(
      (layer) => scene.order.filter((value) => value === layer.id).length !== 1,
    )
  )
    throw mapSplitError('地图图层的绘制顺序不完整或重复。');
  const width = Math.max(...selected.map((layer) => layer.width)),
    height = Math.max(...selected.map((layer) => layer.height));
  dimensions(width, height);
  const origin = {
    x: map.origin?.x + map.offset?.x,
    y: map.origin?.y + map.offset?.y,
  };
  if (![origin.x, origin.y].every(Number.isFinite))
    throw mapSplitError('地图世界原点无效。');
  const layers = [];
  const actorRank = scene.order.indexOf('actor');
  for (const key of [...scene.order].reverse()) {
    const layer = selected.find((item) => item.id === key);
    if (!layer) continue;
    const png = pngSource(layer.source);
    const decoded = await decode(png, layer);
    layers.push({
      id: layer.id,
      width: decoded.width,
      height: decoded.height,
      png,
      sha256: hash(png),
      plane:
        actorRank >= 0 && scene.order.indexOf(key) < actorRank
          ? 'front'
          : 'back',
    });
  }
  const png = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers.map((layer) => ({ input: layer.png, left: 0, top: 0 })))
    .png()
    .toBuffer();
  return { png, width, height, sourceHash: hash(png), origin, layers };
}

async function context(frozen) {
  dimensions(frozen?.width, frozen?.height);
  if (
    !Buffer.isBuffer(frozen.png) ||
    !/^[a-f0-9]{64}$/.test(frozen.sourceHash ?? '') ||
    hash(frozen.png) !== frozen.sourceHash
  )
    throw mapSplitError(
      '冻结地图的像素已改变。',
      'MAP_SPLIT_SOURCE_CHANGED',
      409,
    );
  return {
    ...(await decode(frozen.png, frozen)),
    frozen,
    alphaCache: new Map(),
  };
}
function checkBox(value, width, height) {
  if (
    value.x < 0 ||
    value.y < 0 ||
    value.x + value.width > width ||
    value.y + value.height > height
  )
    throw mapSplitError('选区超出冻结地图。');
  return value;
}
async function sourcePixels(ctx, layerId) {
  if (!layerId) return ctx;
  if (ctx.alphaCache.has(layerId)) return ctx.alphaCache.get(layerId);
  const layer = ctx.frozen.layers?.find((item) => item.id === layerId);
  if (!layer || hash(layer.png) !== layer.sha256)
    throw mapSplitError(
      '找不到可核验的地图来源图层。',
      'MAP_SPLIT_SOURCE_CHANGED',
      409,
    );
  const result = await decode(layer.png, layer);
  ctx.alphaCache.set(layerId, result);
  return result;
}
function offsetIn(source, x, y) {
  return x < source.width && y < source.height
    ? (y * source.width + x) * 4
    : -4;
}

async function resolve(ctx, value, options, depth = 0) {
  if (depth > 12) throw mapSplitError('组合选区嵌套过深。');
  const { width, height, pixels } = ctx,
    mask = new Uint8Array(width * height);
  if (
    value.type === 'rect' ||
    value.type === 'rectangle' ||
    value.type === 'rle'
  ) {
    const bounds = checkBox(value, width, height);
    if (value.type === 'rle') {
      const total = value.counts.reduce((a, b) => a + b, 0);
      if (
        !Number.isSafeInteger(total) ||
        total !== bounds.width * bounds.height
      )
        throw mapSplitError(
          'RLE 必须完整覆盖声明的窗口，按行优先、从 0 开始交替计数。',
        );
      let at = 0;
      for (let run = 0; run < value.counts.length; run++) {
        const end = at + value.counts[run];
        if (run % 2)
          for (; at < end; at++)
            mask[
              (bounds.y + Math.floor(at / bounds.width)) * width +
                bounds.x +
                (at % bounds.width)
            ] = 1;
        at = end;
      }
    } else
      for (let y = bounds.y; y < bounds.y + bounds.height; y++)
        mask.fill(1, y * width + bounds.x, y * width + bounds.x + bounds.width);
  } else if (value.type === 'polygon') {
    if (value.points.some((p) => p.x > width || p.y > height))
      throw mapSplitError('多边形超出地图。');
    await rasterizeMapPolygon(mask, width, value.points);
  } else if (value.type === 'combine') {
    for (const [index, child] of value.selections.entries()) {
      const operand = await resolve(ctx, child, options, depth + 1);
      for (let i = 0; i < mask.length; i++)
        mask[i] =
          index === 0
            ? operand[i]
            : value.operation === 'union'
              ? mask[i] | operand[i]
              : value.operation === 'subtract'
                ? mask[i] & (1 - operand[i])
                : mask[i] & operand[i];
    }
  } else if (value.type === 'alpha') {
    const source = await sourcePixels(ctx, value.layerId);
    for (let y = 0; y < source.height; y++)
      for (let x = 0; x < source.width; x++)
        if (source.pixels[(y * source.width + x) * 4 + 3] >= value.threshold)
          mask[y * width + x] = 1;
  } else if (value.type === 'auto') {
    const bounds = checkBox(
        value.bounds ?? { x: 0, y: 0, width, height },
        width,
        height,
      ),
      source = await sourcePixels(ctx, value.layerId);
    const { x, y } = value.seed;
    if (
      x < bounds.x ||
      y < bounds.y ||
      x >= bounds.x + bounds.width ||
      y >= bounds.y + bounds.height
    )
      throw mapSplitError('自动选区种子必须在窗口内。');
    const start = offsetIn(source, x, y);
    if (start < 0 || !source.pixels[start + 3]) return mask;
    const accepted = (px, py) => {
      const i = offsetIn(source, px, py);
      return (
        i >= 0 &&
        source.pixels[i + 3] > 0 &&
        (value.method === 'alpha' ||
          Math.max(
            ...[0, 1, 2].map((c) =>
              Math.abs(source.pixels[i + c] - source.pixels[start + c]),
            ),
          ) <= value.tolerance)
      );
    };
    // A typed queue bounds memory by this explicit window; pixels are enqueued once.
    const queue = new Int32Array(bounds.width * bounds.height);
    let head = 0,
      tail = 1;
    queue[0] = y * width + x;
    mask[queue[0]] = 1;
    while (head < tail) {
      const index = queue[head++],
        px = index % width,
        py = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (value.connectivity === 4 && dx && dy)) continue;
          const nx = px + dx,
            ny = py + dy,
            next = ny * width + nx;
          if (
            nx < bounds.x ||
            ny < bounds.y ||
            nx >= bounds.x + bounds.width ||
            ny >= bounds.y + bounds.height ||
            mask[next] ||
            !accepted(nx, ny)
          )
            continue;
          mask[next] = 1;
          queue[tail++] = next;
        }
    }
  } else if (value.type === 'sam') {
    const predicted = await segmentMapSelection(
      options.root,
      ctx.frozen,
      value,
      options,
    );
    mask.set(predicted.mask);
  }
  // A transparent source pixel never becomes new artwork through selection.
  for (let i = 0; i < mask.length; i++) if (!pixels[i * 4 + 3]) mask[i] = 0;
  return mask;
}

export async function resolveMapSelection(frozen, input, options = {}) {
  return {
    mask: await resolve(
      await context(frozen),
      mapSplitSelectionSchema.parse(input),
      options,
    ),
    width: frozen.width,
    height: frozen.height,
  };
}
export function mapMaskBounds(mask, width, height) {
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      const x = i % width,
        y = Math.floor(i / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  return right < left
    ? null
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
/** Compact, JSON-safe and exact; counts alternate 0,1 starting with 0. */
export function encodeMapMaskRle(
  mask,
  width,
  height,
  bounds = mapMaskBounds(mask, width, height),
) {
  if (!bounds) return null;
  const counts = [];
  let bit = 0,
    count = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y++)
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      const next = Number(Boolean(mask[y * width + x]));
      if (next !== bit) {
        counts.push(count);
        count = 0;
        bit = next;
      }
      count++;
    }
  counts.push(count);
  return { type: 'rle', ...bounds, counts };
}
const dataUrl = (png) => 'data:image/png;base64,' + png.toString('base64');
function erodeMask(mask, width, height) {
  const result = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (
        mask[i] &&
        mask[i - 1] &&
        mask[i + 1] &&
        mask[i - width] &&
        mask[i + width] &&
        mask[i - width - 1] &&
        mask[i - width + 1] &&
        mask[i + width - 1] &&
        mask[i + width + 1]
      )
        result[i] = 1;
    }
  return result;
}
async function artwork(ctx, mask, bounds, controls) {
  const { width, height } = bounds,
    local = new Uint8Array(width * height),
    rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const a = (y + bounds.y) * ctx.width + x + bounds.x,
        b = y * width + x;
      if (mask[a]) {
        local[b] = 1;
        ctx.pixels.copy(rgba, b * 4, a * 4, a * 4 + 4);
      }
    }
  if (controls) {
    let inner = local;
    for (let n = 0; n < controls.erode; n++)
      inner = erodeMask(inner, width, height);
    const depth = new Uint8Array(local.length);
    for (let n = 0, current = inner; n <= Math.max(1, controls.feather); n++) {
      for (let i = 0; i < depth.length; i++) if (current[i]) depth[i] = n + 1;
      current = erodeMask(current, width, height);
    }
    for (let i = 0; i < local.length; i++) {
      if (!inner[i]) {
        rgba.fill(0, i * 4, i * 4 + 4);
        continue;
      }
      const factor = controls.feather
        ? Math.min(1, depth[i] / (controls.feather + 1))
        : 1;
      const oldAlpha = rgba[i * 4 + 3] / 255,
        alpha = oldAlpha * factor;
      if (
        controls.decontaminate &&
        depth[i] <= Math.max(1, controls.feather) &&
        alpha > 0 &&
        alpha < 1
      ) {
        const { background, strength } = controls.decontaminate;
        for (let c = 0; c < 3; c++) {
          const original = rgba[i * 4 + c],
            clean = Math.max(
              0,
              Math.min(255, (original - background[c] * (1 - alpha)) / alpha),
            );
          rgba[i * 4 + c] = Math.round(
            original * (1 - strength) + clean * strength,
          );
        }
      }
      rgba[i * 4 + 3] = Math.round(alpha * 255);
    }
  }
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  const ownership = Buffer.from(local.map((value) => value * 255));
  const maskPng = await sharp(ownership, {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toBuffer();
  return { source: dataUrl(png), mask: dataUrl(maskPng) };
}

// Suggest supports from the lowest visible body pixels. Separate feet leave a
// gap under an arch, and the canopy of a tree does not widen its trunk collider.
function supportPolygons(bottoms, parts) {
  const body = parts.filter((part) => part.role === 'art');
  const visible = body.length ? body : parts;
  const bottom = Math.max(...visible.map((part) => part.y + part.height));
  const top = Math.min(...visible.map((part) => part.y));
  const band = Math.max(1, Math.ceil((bottom - top) * 0.15));
  const spans = [];
  let left;
  for (let x = 0; x <= bottoms.length; x++) {
    if (x < bottoms.length && bottoms[x] > bottom - band) {
      left ??= x;
    } else if (left !== undefined) {
      spans.push({ left, right: x });
      left = undefined;
    }
  }
  const widest = spans.reduce(
    (n, span) => Math.max(n, span.right - span.left),
    0,
  );
  return spans
    .filter((span) => span.right - span.left >= widest * 0.1)
    .sort((a, b) => b.right - b.left - (a.right - a.left))
    .slice(0, 8)
    .map(({ left, right }) => [
      { x: left, y: bottom - band },
      { x: right, y: bottom - band },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ]);
}

/** Ownership priority: objects, surface, background; within a class the first
 * declared part owns overlaps. Merge/split/refine by submitting revised specs
 * against the same frozen source. No generation or hidden-pixel reconstruction. */
export async function buildSplitElements(frozen, input, options = {}) {
  const specs = mapSplitSpecsSchema.parse(input),
    ctx = await context(frozen),
    grouped = new Map();
  for (const spec of specs) {
    const previous = grouped.get(spec.id);
    if (
      previous &&
      (previous.name !== spec.name ||
        previous.kind !== spec.kind ||
        previous.sourceKey !== spec.sourceKey ||
        previous.x !== spec.x ||
        previous.y !== spec.y)
    )
      throw mapSplitError(
        '同一对象 ID 的跨窗口声明必须具有相同名字、种类、锚点和来源。',
      );
    const group = previous ?? { ...spec, parts: [], collision: { polygons: [], mapIndices: [] } };
    group.parts.push(...spec.parts);
    const indices = spec.collision?.mapIndices || [];
    const priorIndices = new Set(group.collision.mapIndices);
    if (new Set(indices).size !== indices.length) throw mapSplitError('同一声明中重复指定了地图碰撞区域。');
    const newIndices = indices.filter(index => !priorIndices.has(index));
    const inherited = newIndices.map(index => {
      const shape = options.map?.collisions[index];
      if (!shape) throw mapSplitError('待转移的地图碰撞不存在。');
      return shape.map(point => ({ x: point.x - options.map.origin.x, y: point.y - options.map.origin.y }));
    });
    group.collision.polygons.push(...(spec.collision?.polygons.length ? spec.collision.polygons : inherited));
    group.collision.mapIndices.push(...newIndices);
    grouped.set(spec.id, group);
  }
  const ranked = [...grouped.values()].toSorted(
    (a, b) =>
      ({ object: 0, surface: 1, background: 2 })[a.kind] -
      { object: 0, surface: 1, background: 2 }[b.kind],
  );
  const claimed = new Uint8Array(ctx.width * ctx.height),
    records = [];
  for (const spec of ranked) {
    const parts = [],
      seen = new Set();
    const bottoms =
      spec.kind === 'object' && !spec.collision?.polygons.length
        ? new Uint16Array(ctx.width)
        : null;
    let hasBody = false;
    for (const [index, piece] of spec.parts.entries()) {
      const partId = piece.id ?? `part_${index + 1}`;
      if (seen.has(partId))
        throw mapSplitError(
          '同一对象的子片 ID 重复；跨窗口请使用不同子片 ID。',
        );
      seen.add(partId);
      const mask = await resolve(ctx, piece.selection, options);
      let selected = 0,
        overlap = 0;
      for (let i = 0; i < mask.length; i++)
        if (mask[i]) {
          selected++;
          if (claimed[i]) {
            mask[i] = 0;
            overlap++;
          }
        }
      options.onOwnership?.({
        elementId: spec.id,
        partId,
        selected,
        overlap,
        assigned: selected - overlap,
      });
      const bounds = mapMaskBounds(mask, ctx.width, ctx.height);
      if (!bounds) continue;
      if (bottoms && piece.role === 'art' && !hasBody) {
        bottoms.fill(0);
        hasBody = true;
      }
      for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
        for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
          const i = y * ctx.width + x;
          if (!mask[i]) continue;
          claimed[i] = 1;
          if (bottoms && (!hasBody || piece.role === 'art'))
            bottoms[x] = Math.max(bottoms[x], y + 1);
        }
      }
      parts.push({
        id: partId,
        role: piece.role,
        plane: piece.plane,
        ...bounds,
        ...(await artwork(ctx, mask, bounds, piece.edge)),
        enabled: true,
      });
    }
    if (parts.length)
      records.push({
        spec,
        parts,
        polygons: bottoms
          ? supportPolygons(bottoms, parts)
          : spec.collision?.polygons,
      });
  }
  const remainderKind =
    options.remainderKind === undefined ? 'surface' : options.remainderKind;
  if (![false, 'surface', 'background'].includes(remainderKind))
    throw mapSplitError('余图只能作为地表、背景或明确关闭。');
  if (remainderKind) {
    const mask = new Uint8Array(claimed.length);
    for (let i = 0; i < mask.length; i++)
      if (!claimed[i] && ctx.pixels[i * 4 + 3]) mask[i] = 1;
    const bounds = mapMaskBounds(mask, ctx.width, ctx.height);
    if (bounds) {
      const remainderId = options.remainderId ?? `split_${remainderKind}`;
      if (grouped.has(remainderId))
        throw mapSplitError('余图 ID 与声明对象重复，请指定 remainderId。');
      const front = new Uint8Array(mask.length);
      for (const layer of frozen.layers ?? [])
        if (layer.plane === 'front') {
          const source = await sourcePixels(ctx, layer.id);
          for (let y = 0; y < source.height; y++)
            for (let x = 0; x < source.width; x++)
              if (source.pixels[(y * source.width + x) * 4 + 3])
                front[y * ctx.width + x] = 1;
        }
      const remainderParts = [];
      for (const plane of ['back', 'front']) {
        const selected = new Uint8Array(mask.length);
        for (let i = 0; i < mask.length; i++)
          if (mask[i] && Boolean(front[i]) === (plane === 'front'))
            selected[i] = 1;
        const partBounds = mapMaskBounds(selected, ctx.width, ctx.height);
        if (partBounds)
          remainderParts.push({
            id: plane === 'back' ? 'remainder' : 'remainder_front',
            role: 'art',
            plane,
            ...partBounds,
            ...(await artwork(ctx, selected, partBounds)),
            enabled: true,
          });
      }
      records.push({
        spec: {
          id: mapSplitIdSchema.parse(remainderId),
          name:
            remainderKind === 'surface'
              ? '地图地表（余图）'
              : '地图背景（余图）',
          kind: remainderKind,
        },
        parts: remainderParts,
      });
    }
  }
  return records.map(({ spec, parts, polygons = [] }) => {
    const x = spec.x ?? Math.min(...parts.map((value) => value.x)),
      y = spec.y ?? Math.min(...parts.map((value) => value.y));
    return {
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      x,
      y,
      positionMode: 'relative',
      hidden: false,
      locked: false,
      included: true,
      parts: parts.map((value) => ({
        ...value,
        x: value.x - x,
        y: value.y - y,
      })),
      collision: {
        enabled: Boolean(spec.collision?.mapIndices.length),
        polygons: polygons.map((poly) =>
          poly.map((p) => ({ x: p.x - x, y: p.y - y })),
        ),
        mapIndices: spec.collision?.mapIndices ?? [],
      },
      ...(spec.sourceKey ? { sourceKey: spec.sourceKey } : {}),
    };
  });
}
