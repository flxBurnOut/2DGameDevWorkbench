// Read-only affordance prototype. Compares where the art suggests a player can
// stand with where collision geometry actually supports standing. Everything
// here is a pure function over world-aligned 1px grids: no I/O, no model calls.
// The rules are documented in docs/论文方法-画面与碰撞一致性.md (local draft).

export const DEFAULT_PLAYER = Object.freeze({
  width: 24,
  height: 48,
  runSpeed: 240,
  jumpVelocity: 560,
  gravity: 1500,
  maxFallSpeed: 900,
  airControl: 1,
});

export const DEFAULT_SURFACE_OPTIONS = Object.freeze({
  // Columns are sampled at world x multiples of sampleStep, so visual and
  // physical surfaces always share the same columns.
  sampleStep: 4,
  minAlpha: 128,
  // A visual top must be backed by this fraction of filled cells in a window
  // (robustWindow columns x robustDepth rows) so grass tufts and stray pixels
  // do not count as the walkable edge.
  robustDepth: 6,
  robustWindow: 5,
  robustDensity: 0.6,
  // Neighbouring samples join one segment when their heights differ by at most this.
  joinTolerance: 8,
  // A visual and a physical top in the same column match within this distance.
  matchTolerance: 6,
  minSegmentLength: 8,
});

const MAX_GRID_PIXELS = 64_000_000;

export function resolvePlayer(input = {}) {
  const player = { ...DEFAULT_PLAYER, ...input };
  for (const [key, value] of Object.entries(player))
    if (!Number.isFinite(value) || value < 0) throw new Error(`玩家参数 ${key} 无效。`);
  if (player.width < 1 || player.height < 1) throw new Error('玩家宽高必须至少为 1 像素。');
  player.width = Math.round(player.width);
  player.height = Math.round(player.height);
  player.airControl = Math.min(1, player.airControl);
  return player;
}

export function resolveSurfaceOptions(input = {}) {
  const options = { ...DEFAULT_SURFACE_OPTIONS, ...input };
  for (const [key, value] of Object.entries(options))
    if (!Number.isFinite(value) || value < 0) throw new Error(`表面参数 ${key} 无效。`);
  for (const key of ['sampleStep', 'robustDepth', 'robustWindow'])
    options[key] = Math.max(1, Math.round(options[key]));
  return options;
}

export function unionRect(rects) {
  const list = rects.filter((rect) => rect && rect.width > 0 && rect.height > 0);
  if (!list.length) return null;
  const x = Math.min(...list.map((r) => r.x));
  const y = Math.min(...list.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...list.map((r) => r.x + r.width)) - x,
    height: Math.max(...list.map((r) => r.y + r.height)) - y,
  };
}

export function polygonBounds(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function createGrid({ x, y, width, height }) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const w = Math.max(1, Math.ceil(x + width) - x0);
  const h = Math.max(1, Math.ceil(y + height) - y0);
  if (w > 30000 || h > 30000 || w * h > MAX_GRID_PIXELS)
    throw new Error(`分析范围 ${w}×${h} 超过 6400 万像素或 30000 像素边长。`);
  return { x0, y0, width: w, height: h, data: new Uint8Array(w * h) };
}

/** Even-odd fill sampled at pixel centres, matching how polygons cover cells. */
export function rasterizePolygon(grid, points) {
  if (points.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const top = Math.max(0, Math.floor(minY - grid.y0));
  const bottom = Math.min(grid.height - 1, Math.ceil(maxY - grid.y0));
  const crossings = [];
  for (let row = top; row <= bottom; row++) {
    const cy = grid.y0 + row + 0.5;
    crossings.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i];
      const b = points[j];
      if (a.y > cy !== b.y > cy)
        crossings.push(a.x + ((cy - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - grid.x0 - 0.5));
      const to = Math.min(grid.width - 1, Math.floor(crossings[k + 1] - grid.x0 - 0.5));
      if (from <= to) grid.data.fill(1, row * grid.width + from, row * grid.width + to + 1);
    }
  }
}

export function rasterizeRect(grid, rect) {
  rasterizePolygon(grid, [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ]);
}

/** mask: { x0, y0, width, height, alpha: Uint8Array } with integer world origin. */
export function stampMask(grid, mask, minAlpha = DEFAULT_SURFACE_OPTIONS.minAlpha) {
  for (let row = 0; row < mask.height; row++) {
    const gy = mask.y0 + row - grid.y0;
    if (gy < 0 || gy >= grid.height) continue;
    for (let col = 0; col < mask.width; col++) {
      const gx = mask.x0 + col - grid.x0;
      if (gx < 0 || gx >= grid.width) continue;
      if (mask.alpha[row * mask.width + col] >= minAlpha) grid.data[gy * grid.width + gx] = 1;
    }
  }
}

function sampledColumns(x0, width, step) {
  const columns = [];
  for (let x = Math.ceil(x0 / step) * step; x < x0 + width; x += step) columns.push(x);
  return columns;
}

/**
 * Join per-column samples into left-to-right segments. Samples only join
 * neighbours in the previous sampled column with the same key, so two
 * candidates never merge into one surface.
 */
export function linkSegments(samples, options, prefix) {
  const { sampleStep, joinTolerance, minSegmentLength } = options;
  const byColumn = new Map();
  for (const sample of samples) {
    if (!byColumn.has(sample.x)) byColumn.set(sample.x, []);
    byColumn.get(sample.x).push(sample);
  }
  const columns = [...byColumn.keys()].sort((a, b) => a - b);
  const segments = [];
  let open = [];
  for (const x of columns) {
    const next = [];
    const taken = new Set();
    for (const sample of byColumn.get(x).sort((a, b) => a.y - b.y)) {
      let best = null;
      for (const segment of open) {
        if (taken.has(segment) || segment.key !== sample.key) continue;
        const last = segment.points[segment.points.length - 1];
        if (last.x !== x - sampleStep) continue;
        const dy = Math.abs(last.y - sample.y);
        if (dy <= joinTolerance && (!best || dy < best.dy)) best = { segment, dy };
      }
      const segment = best?.segment || {
        id: `${prefix}${segments.length}`,
        key: sample.key,
        meta: sample.meta,
        points: [],
      };
      if (!best) segments.push(segment);
      taken.add(segment);
      segment.points.push({ x: sample.x, y: sample.y });
      next.push(segment);
    }
    open = next;
  }
  return segments
    .filter((segment) => segment.points.length * sampleStep >= minSegmentLength)
    .map((segment, index) => ({ ...segment, id: `${prefix}${index}` }));
}

/**
 * Standable tops of solid cells: an empty cell directly above a solid cell,
 * with at least player.height empty cells of headroom. Space outside the grid
 * counts as empty.
 */
export function physicalSurfaces(grid, player, options) {
  const { width: w, height: h, data } = grid;
  const samples = [];
  for (const x of sampledColumns(grid.x0, w, options.sampleStep)) {
    const col = x - grid.x0;
    let emptyRun = 0;
    let previous = 0;
    for (let row = 0; row < h; row++) {
      const solid = data[row * w + col];
      if (solid && !previous && (emptyRun >= player.height || emptyRun === row))
        samples.push({ x, y: grid.y0 + row, key: 'collision' });
      emptyRun = solid ? 0 : emptyRun + 1;
      previous = solid;
    }
  }
  return linkSegments(samples, options, 'p');
}

/** Column-window fill counts, so robust tops look at horizontal context too. */
function windowFiller(mask, minAlpha, half) {
  const { width, height, alpha } = mask;
  const filled = new Uint16Array(width * height);
  for (let row = 0; row < height; row++) {
    let running = 0;
    const base = row * width;
    for (let col = -half; col < width + half; col++) {
      const enter = col + half;
      if (enter < width && alpha[base + enter] >= minAlpha) running++;
      const leave = col - half - 1;
      if (leave >= 0 && alpha[base + leave] >= minAlpha) running--;
      if (col >= 0 && col < width) filled[base + col] = running;
    }
  }
  return filled;
}

/**
 * candidates: [{ key, label: 'ground'|'unlabeled', elementId?, mask }].
 * Each candidate yields its own robust top lines. Headroom is only blocked by
 * candidates labelled 'ground' (perceived solid); unlabeled art such as tree
 * canopies does not block perceived walking space.
 */
export function visualSurfaces(candidates, bounds, player, options) {
  const blocking = createGrid(bounds);
  for (const candidate of candidates)
    if (candidate.label === 'ground') stampMask(blocking, candidate.mask, options.minAlpha);
  const half = Math.floor(options.robustWindow / 2);
  const windowCells = options.robustWindow * options.robustDepth;
  const samples = [];
  for (const candidate of candidates) {
    const { mask } = candidate;
    const filled = windowFiller(mask, options.minAlpha, half);
    const density = (col, row) => {
      let sum = 0;
      const end = Math.min(mask.height, row + options.robustDepth);
      for (let r = row; r < end; r++) sum += filled[r * mask.width + col];
      return sum / windowCells;
    };
    for (const x of sampledColumns(mask.x0, mask.width, options.sampleStep)) {
      const col = x - mask.x0;
      let row = 0;
      while (row < mask.height) {
        if (mask.alpha[row * mask.width + col] < options.minAlpha || density(col, row) < options.robustDensity) {
          row++;
          continue;
        }
        const y = mask.y0 + row;
        if (hasHeadroom(blocking, x, y, player.height, candidate, options)) {
          samples.push({
            x,
            y,
            key: candidate.key,
            meta: { label: candidate.label, elementId: candidate.elementId ?? null, source: candidate.source ?? null },
          });
        }
        // Leave this solid run before looking for a lower top (arches, holes).
        while (row < mask.height && density(col, row) >= 0.2) row++;
      }
    }
  }
  return linkSegments(samples, options, 'v');
}

function hasHeadroom(grid, x, y, height, candidate, options) {
  const col = x - grid.x0;
  if (col < 0 || col >= grid.width) return true;
  // A ground candidate's own top rows are allowed; start above the robust band.
  const own = candidate.label === 'ground' ? options.robustDepth : 0;
  const from = Math.max(0, y - height - grid.y0);
  const to = Math.min(grid.height, y - grid.y0 - own);
  let solid = 0;
  for (let row = from; row < to; row++) solid += grid.data[row * grid.width + col];
  return solid <= Math.max(1, (to - from) * 0.1);
}

function columnIndex(segments) {
  const index = new Map();
  for (const segment of segments)
    for (const point of segment.points) {
      if (!index.has(point.x)) index.set(point.x, []);
      index.get(point.x).push(point.y);
    }
  return index;
}

function unmatchedSpans(segments, index, tolerance, step) {
  const spans = [];
  let matched = 0;
  let total = 0;
  for (const segment of segments) {
    let span = null;
    for (const point of segment.points) {
      total += step;
      const hit = (index.get(point.x) || []).some((y) => Math.abs(y - point.y) <= tolerance);
      if (hit) {
        matched += step;
        span = null;
        continue;
      }
      if (!span) {
        span = { segmentId: segment.id, key: segment.key, label: segment.meta?.label ?? null, x0: point.x, x1: point.x, ys: [] };
        spans.push(span);
      }
      span.x1 = point.x;
      span.ys.push(point.y);
    }
  }
  return {
    total,
    matched,
    spans: spans.map(({ ys, ...span }) => ({
      ...span,
      y: Math.round(ys.reduce((a, b) => a + b, 0) / ys.length),
      length: (span.x1 - span.x0) + step,
    })),
  };
}

const ratio = (part, whole) => (whole ? Number((part / whole).toFixed(4)) : null);

/**
 * Fake ground: visual surface with no physical support. Phantom ground:
 * physical surface with no visual cue. Lengths are in world pixels.
 */
export function compareSurfaces(visual, physical, options) {
  const physicalIndex = columnIndex(physical);
  const visualIndex = columnIndex(visual);
  const v = unmatchedSpans(visual, physicalIndex, options.matchTolerance, options.sampleStep);
  const p = unmatchedSpans(physical, visualIndex, options.matchTolerance, options.sampleStep);
  return {
    visualLength: v.total,
    physicalLength: p.total,
    fakeLength: v.total - v.matched,
    phantomLength: p.total - p.matched,
    // precision: share of collision tops that the art shows; recall: share of
    // art tops that collision supports.
    precision: ratio(p.matched, p.total),
    recall: ratio(v.matched, v.total),
    fake: v.spans,
    phantom: p.spans,
  };
}
