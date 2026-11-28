// Thin, DOM-free adapter over the independently distributed SpritePipeline core.
import { MAX_PALETTE_PAIRS } from './edit-intent.mjs';
import {
  diffRgbaSummary,
  floodFillRgba,
  normalizeSelection,
  opaqueBoundsRgba,
  translateSelectionRgba,
} from '../../Tools/SpritePipeline/sprite_pipeline/static/pixel_editor_core.js';

export {
  alphaGeometryRgba, applyRgbaChanges, clearSelectionRgba, diffRgbaSummary,
  floodFillRgba, normalizeSelection, opaqueBoundsRgba, rasterIntegerLine,
  screenToPixel, stampSquareRgba, threeWayMergeRgba, translateSelectionRgba,
} from '../../Tools/SpritePipeline/sprite_pipeline/static/pixel_editor_core.js';

export const LOCAL_EDIT_LIMITS = Object.freeze({ maxEdge: 3840, maxPixels: 8_294_400, maxPolygonPoints: 1024, maxMaskRuns: 65_536, sharedChangeListPixels: 65_536, maxPatchBytes: 512 * 1024 });
const operations = new Set(['palette-map', 'clean-alpha', 'replace-color', 'fill', 'erase', 'translate', 'restore-region', 'pixel-patch']);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_IMAGE_EDIT' }); };

function dimensions(pixels, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > LOCAL_EDIT_LIMITS.maxEdge || height > LOCAL_EDIT_LIMITS.maxEdge || width * height > LOCAL_EDIT_LIMITS.maxPixels)
    fail('图片尺寸须为正整数，最长边不超过3840，总计不超过8294400像素。');
  if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length !== width * height * 4)
    fail('图片必须为尺寸匹配的RGBA8字节数组。');
  return width * height;
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('区域或操作包含不支持的字段。');
}
function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${name}须为${minimum}–${maximum}的整数。`);
  return value;
}
function point(value, width, height) {
  integer(value.x, 0, width - 1, 'x');
  integer(value.y, 0, height - 1, 'y');
}
function rectangle(value, width, height) {
  point(value, width, height);
  integer(value.width, 1, width, 'width'); integer(value.height, 1, height, 'height');
  if (value.x + value.width > width || value.y + value.height > height) fail('矩形超出原图范围；不会自动裁切。');
  return normalizeSelection(value, { x: value.x + value.width - 1, y: value.y + value.height - 1 }, width, height);
}
export function maskSummary(mask, width, height) {
  if (!(mask instanceof Uint8Array) || mask.length !== width * height) fail('选区须为尺寸匹配的Uint8Array，1可改、0保护。');
  let count = 0, left = width, top = height, right = -1, bottom = -1;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] !== 0 && mask[index] !== 1) fail('核心选区只接受1可改、0保护，不接受PNG Alpha或软蒙版。');
    if (!mask[index]) continue;
    const x = index % width, y = Math.floor(index / width);
    count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { mask, count, bounds: count ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null };
}
function fillRectangle(mask, width, rect) {
  for (let y = rect.y; y < rect.y + rect.height; y++) mask.fill(1, y * width + rect.x, y * width + rect.x + rect.width);
}
function rgbaEqual(pixels, offset, rgba, rightOffset = 0) {
  return pixels[offset] === rgba[rightOffset] && pixels[offset + 1] === rgba[rightOffset + 1] && pixels[offset + 2] === rgba[rightOffset + 2] && pixels[offset + 3] === rgba[rightOffset + 3];
}
function connectedMask(pixels, width, height, seed, tolerance, allowed) {
  const count = width * height;
  const selected = new Uint8Array(count);
  const target = pixels.subarray(seed * 4, seed * 4 + 4);
  // The character implementation records one JS history object per pixel.
  // Large/tolerant/masked selections instead use bounded typed storage without
  // a change history. Connectivity is four-way and relative to the seed RGBA.
  const queue = new Uint32Array(count);
  let head = 0, tail = 1;
  queue[0] = seed; selected[seed] = 1;
  const enqueue = index => {
    if (selected[index] || (allowed && !allowed[index])) return;
    const offset = index * 4;
    for (let channel = 0; channel < 4; channel++) if (Math.abs(pixels[offset + channel] - target[channel]) > tolerance) return;
    selected[index] = 1; queue[tail++] = index;
  };
  while (head < tail) {
    const index = queue[head++], x = index % width;
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (index >= width) enqueue(index - width);
    if (index + width < count) enqueue(index + width);
  }
  return selected;
}

/** Resolves original-image pixel coordinates. This function never reads files. */
export function resolveRegion(pixels, width, height, spec) {
  const count = dimensions(pixels, width, height);
  if (!spec || typeof spec !== 'object') fail('需要明确的区域类型。');
  let mask = new Uint8Array(count);
  if (spec.type === 'all') { fields(spec, ['type']); mask.fill(1); }
  else if (spec.type === 'rectangle') {
    fields(spec, ['type', 'x', 'y', 'width', 'height']);
    fillRectangle(mask, width, rectangle(spec, width, height));
  } else if (spec.type === 'mask-runs') {
    fields(spec, ['type', 'spans']);
    if (!Array.isArray(spec.spans) || spec.spans.length > LOCAL_EDIT_LIMITS.maxMaskRuns) fail('蒙版需要至多65536个有序片段。');
    let end = 0, total = 0;
    for (const span of spec.spans) {
      fields(span, ['startPixel', 'length']);
      integer(span.startPixel, 0, count - 1, 'startPixel'); integer(span.length, 1, count, 'length');
      if (span.startPixel < end || span.startPixel + span.length > count) fail('蒙版片段须按像素排序、不重叠且不越界。');
      end = span.startPixel + span.length; total += span.length;
      if (total > count) fail('蒙版片段总长度超过原图像素数。');
      mask.fill(1, span.startPixel, end);
    }
  } else if (spec.type === 'alpha-bounds') {
    fields(spec, ['type', 'threshold']);
    const threshold = integer(spec.threshold ?? 1, 0, 255, 'threshold');
    const bounds = opaqueBoundsRgba(pixels, width, height, threshold);
    if (bounds) fillRectangle(mask, width, bounds);
  } else if (spec.type === 'alpha-selection') {
    fields(spec, ['type', 'minAlpha', 'maxAlpha']);
    const min = integer(spec.minAlpha ?? 0, 0, 255, 'minAlpha'), max = integer(spec.maxAlpha ?? 255, 0, 255, 'maxAlpha');
    if (min > max) fail('minAlpha不能大于maxAlpha。');
    for (let index = 0; index < count; index++) if (pixels[index * 4 + 3] >= min && pixels[index * 4 + 3] <= max) mask[index] = 1;
  } else if (spec.type === 'connected-color') {
    fields(spec, ['type', 'x', 'y', 'tolerance']); point(spec, width, height);
    const tolerance = integer(spec.tolerance ?? 0, 0, 255, 'tolerance');
    if (count <= LOCAL_EDIT_LIMITS.sharedChangeListPixels && tolerance === 0) {
      const copy = new Uint8ClampedArray(pixels);
      const offset = (spec.y * width + spec.x) * 4;
      const replacement = Array.from(copy.subarray(offset, offset + 4)); replacement[0] = (replacement[0] + 1) % 256;
      for (const change of floodFillRgba(copy, width, height, spec, replacement)) mask[change.offset / 4] = 1;
    } else mask = connectedMask(pixels, width, height, spec.y * width + spec.x, tolerance);
  } else if (spec.type === 'polygon') {
    fields(spec, ['type', 'points']);
    if (!Array.isArray(spec.points) || spec.points.length < 3 || spec.points.length > LOCAL_EDIT_LIMITS.maxPolygonPoints) fail('多边形需要3–1024个点。');
    for (const p of spec.points) {
      fields(p, ['x', 'y']);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > width || p.y > height) fail('多边形点须位于原图边界内。');
    }
    const intersections = new Float64Array(spec.points.length);
    // Scanline even-odd rasterisation at pixel centres. Left/top boundaries
    // are inclusive, right/bottom exclusive, matching a rectangle's pixels.
    for (let y = 0; y < height; y++) {
      const center = y + 0.5;
      let length = 0;
      for (let i = 0; i < spec.points.length; i++) {
        const a = spec.points[i], b = spec.points[(i + 1) % spec.points.length];
        if ((a.y <= center && b.y > center) || (b.y <= center && a.y > center)) intersections[length++] = a.x + (center - a.y) * (b.x - a.x) / (b.y - a.y);
      }
      const row = intersections.subarray(0, length); row.sort();
      for (let i = 0; i + 1 < length; i += 2) {
        const start = Math.max(0, Math.ceil(row[i] - 0.5)), end = Math.min(width, Math.ceil(row[i + 1] - 0.5));
        if (end > start) mask.fill(1, y * width + start, y * width + end);
      }
    }
  } else fail('核心仅解析all/rectangle/polygon/mask-runs/alpha-bounds/alpha-selection/connected-color；named与maskRef须由服务层解析。');
  return maskSummary(mask, width, height);
}

function color(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail('颜色须为#RRGGBB。');
  return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
}
function rgba(value) {
  if (!Array.isArray(value) || value.length !== 4) fail('rgba需要4个0–255整数。');
  value.forEach(channel => integer(channel, 0, 255, 'RGBA通道'));
  return value;
}

/** Local only, returns fresh pixels; protection covers all four RGBA channels. */
export function applyLocalOperation({ pixels, width, height, mask, operation, restorePixels }) {
  const count = dimensions(pixels, width, height);
  const selection = maskSummary(mask, width, height);
  if (!selection.count) fail('选区为空，不能执行修改。');
  if (!operation || !operations.has(operation.type)) fail('本地操作类型不支持；不会自动调用模型。');
  const output = new Uint8ClampedArray(pixels);
  const effectiveMask = new Uint8Array(mask);
  const type = operation.type;
  if (type === 'clean-alpha') {
    fields(operation, ['type', 'threshold']);
    const threshold = integer(operation.threshold ?? 1, 0, 16, 'threshold');
    for (let index = 0; index < count; index++) if (mask[index] && pixels[index * 4 + 3] > 0 && pixels[index * 4 + 3] <= threshold) output.fill(0, index * 4, index * 4 + 4);
  } else if (type === 'palette-map') {
    fields(operation, ['type', 'pairs']);
    if (!Array.isArray(operation.pairs) || !operation.pairs.length || operation.pairs.length > MAX_PALETTE_PAIRS)
      fail('调色板需要 1–64 对颜色。');
    const replacements = new Map();
    for (const pair of operation.pairs) {
      fields(pair, ['from', 'to']);
      const [r, g, b] = color(pair.from);
      const key = (r << 16) | (g << 8) | b;
      if (replacements.has(key)) fail('调色板原色重复。');
      replacements.set(key, color(pair.to));
    }
    for (let index = 0; index < count; index++) {
      if (!mask[index]) continue;
      const offset = index * 4;
      const rgb = replacements.get((pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2]);
      if (rgb) output.set(rgb, offset);
    }
  } else if (type === 'replace-color') {
    fields(operation, ['type', 'from', 'to', 'match']);
    if (operation.match !== undefined && operation.match !== 'exact-rgb') fail('替色仅支持exact-rgb。');
    const from = color(operation.from), to = color(operation.to);
    for (let index = 0; index < count; index++) {
      const offset = index * 4;
      if (mask[index] && pixels[offset] === from[0] && pixels[offset + 1] === from[1] && pixels[offset + 2] === from[2]) output.set(to, offset);
    }
  } else if (type === 'erase') {
    fields(operation, ['type']);
    for (let index = 0; index < count; index++) if (mask[index]) output.fill(0, index * 4, index * 4 + 4);
  } else if (type === 'restore-region') {
    fields(operation, ['type']); dimensions(restorePixels, width, height);
    for (let index = 0; index < count; index++) if (mask[index]) for (let channel = 0; channel < 4; channel++) output[index * 4 + channel] = restorePixels[index * 4 + channel];
  } else if (type === 'fill') {
    fields(operation, ['type', 'x', 'y', 'rgba']); point(operation, width, height);
    const replacement = rgba(operation.rgba), seed = operation.y * width + operation.x;
    if (!mask[seed]) fail('填充种子不在可编辑选区内。');
    if (!rgbaEqual(pixels, seed * 4, replacement)) {
      if (count <= LOCAL_EDIT_LIMITS.sharedChangeListPixels) {
        const target = pixels.subarray(seed * 4, seed * 4 + 4);
        // Protected pixels are traversal barriers, including matching colours.
        for (let index = 0; index < count; index++) if (!mask[index] && rgbaEqual(pixels, index * 4, target)) output[index * 4] = (target[0] + 1) % 256;
        floodFillRgba(output, width, height, operation, replacement);
        for (let index = 0; index < count; index++) if (!mask[index]) output.set(pixels.subarray(index * 4, index * 4 + 4), index * 4);
      } else {
        const component = connectedMask(pixels, width, height, seed, 0, mask);
        for (let index = 0; index < count; index++) if (component[index]) output.set(replacement, index * 4);
      }
    }
  } else if (type === 'pixel-patch') {
    fields(operation, ['type', 'spans']);
    if (!Array.isArray(operation.spans) || !operation.spans.length || operation.spans.length > LOCAL_EDIT_LIMITS.maxPatchBytes / 8) fail('像素补丁需要有界的非空spans。');
    let end = 0, bytes = 0;
    // The service checks the base RGBA SHA and decodes base64 before calling
    // this browser-safe core. Validate the whole patch before applying any span.
    for (const span of operation.spans) {
      fields(span, ['startPixel', 'before', 'after']);
      integer(span.startPixel, 0, count - 1, 'startPixel');
      if (!(span.before instanceof Uint8Array || span.before instanceof Uint8ClampedArray) || !(span.after instanceof Uint8Array || span.after instanceof Uint8ClampedArray) || !span.before.length || span.before.length % 4 || span.before.length !== span.after.length) fail('补丁before/after须为等长非空RGBA字节数组。');
      bytes += span.before.length + span.after.length;
      if (bytes > LOCAL_EDIT_LIMITS.maxPatchBytes) fail('像素补丁before+after合计超过512KiB。');
      if (span.startPixel < end || span.startPixel + span.before.length / 4 > count) fail('补丁spans须按像素排序、不重叠且不越界。');
      end = span.startPixel + span.before.length / 4;
      const start = span.startPixel * 4;
      for (let offset = 0; offset < span.before.length; offset += 4) {
        if (!rgbaEqual(pixels, start + offset, span.before, offset)) fail('像素补丁的before与当前RGBA基准不符。');
        if (!mask[span.startPixel + offset / 4] && !rgbaEqual(span.before, offset, span.after, offset)) fail('像素补丁试图修改保护区。');
      }
    }
    for (const span of operation.spans) output.set(span.after, span.startPixel * 4);
  } else if (type === 'translate') {
    fields(operation, ['type', 'dx', 'dy']);
    const dx = integer(operation.dx, -width, width, 'dx'), dy = integer(operation.dy, -height, height, 'dy');
    const rect = selection.bounds;
    if (selection.count !== rect.width * rect.height) fail('移动首版只支持填满的矩形选区。');
    const destination = rectangle({ ...rect, x: rect.x + dx, y: rect.y + dy }, width, height);
    fillRectangle(effectiveMask, width, destination);
    if (count <= LOCAL_EDIT_LIMITS.sharedChangeListPixels) translateSelectionRgba(output, width, height, rect, dx, dy);
    else if (dx || dy) {
      // Preserve overlapping source bytes before clearing; unlike the legacy
      // undo path, this allocates no per-pixel before/after object history.
      const region = new Uint8ClampedArray(rect.width * rect.height * 4);
      for (let y = 0; y < rect.height; y++) region.set(pixels.subarray(((rect.y + y) * width + rect.x) * 4, ((rect.y + y) * width + rect.x + rect.width) * 4), y * rect.width * 4);
      for (let y = rect.y; y < rect.y + rect.height; y++) output.fill(0, (y * width + rect.x) * 4, (y * width + rect.x + rect.width) * 4);
      for (let y = 0; y < rect.height; y++) output.set(region.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((destination.y + y) * width + destination.x) * 4);
    }
  }
  const summary = diffRgbaSummary(output, pixels, width, height);
  let alphaPreserved = true;
  for (let index = 0; index < count; index++) if (pixels[index * 4 + 3] !== output[index * 4 + 3]) { alphaPreserved = false; break; }
  return { pixels: output, effectiveMask, changedPixelCount: summary.count, bounds: summary.bbox, alphaPreserved,
    supportedConstraints: { preserveDimensions: true, preserveOutsideEffectiveMask: true, preserveAlpha: type === 'palette-map' || type === 'replace-color' || (type === 'clean-alpha' && (operation.threshold ?? 1) === 0) || (type === 'pixel-patch' && alphaPreserved), regionScope: type === 'translate' ? 'source-and-destination' : 'selected-region' } };
}
