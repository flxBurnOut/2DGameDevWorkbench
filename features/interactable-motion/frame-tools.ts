import type { RgbaImage } from './png-rgba';

/**
 * Deterministic interactable frame tools. Every function returns new RGBA
 * bytes; none decides acceptance. Results become playback alternatives and
 * are submitted with an explicit region so the server can verify that all
 * other pixels stayed identical.
 */
export type Mask = Uint8Array;
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Span = { start: number; length: number };
export type Point = { x: number; y: number };

export function emptyMask(width: number, height: number): Mask { return new Uint8Array(width * height); }

/** Boxes are right/bottom exclusive, as in the interactable contract's opaque regions. */
export function boxMask(width: number, height: number, boxes: Box[]): Mask {
  const mask = emptyMask(width, height);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.min(width, Math.floor(b.x0))), x1 = Math.max(0, Math.min(width, Math.floor(b.x1)));
    const y0 = Math.max(0, Math.min(height, Math.floor(b.y0))), y1 = Math.max(0, Math.min(height, Math.floor(b.y1)));
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  }
  return mask;
}

export function subtractMask(a: Mask, b: Mask): Mask { return a.map((v, i) => (v && !b[i] ? 1 : 0)); }
export function maskCount(mask: Mask) { let n = 0; for (const v of mask) n += v ? 1 : 0; return n; }

const same = (a: Uint8Array, b: Uint8Array, i: number) =>
  a[i * 4] === b[i * 4] && a[i * 4 + 1] === b[i * 4 + 1] && a[i * 4 + 2] === b[i * 4 + 2] && a[i * 4 + 3] === b[i * 4 + 3];

export function changedMask(before: Uint8Array, after: Uint8Array): Mask {
  const out = new Uint8Array(before.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = same(before, after, i) ? 0 : 1;
  return out;
}

/** Ordered, non-overlapping spans; small gaps are merged to keep the region compact. */
export function maskSpans(mask: Mask, mergeGap = 0): Span[] {
  const spans: Span[] = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const last = spans.at(-1);
      if (last && start - (last.start + last.length) <= mergeGap) last.length = i - last.start;
      else spans.push({ start, length: i - start });
      start = -1;
    }
  }
  return spans;
}

/** T1: copy reference pixels into fixed regions, skipping pixels a moving part may cover. */
export function backfillFixed(reference: Uint8Array, frame: Uint8Array, fixed: Mask, occluded?: Mask): Uint8Array {
  const out = frame.slice();
  for (let i = 0; i < fixed.length; i++) {
    if (!fixed[i] || occluded?.[i]) continue;
    out.set(reference.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return out;
}

export function translate(pixels: Uint8Array, width: number, height: number, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = x - dx, sy = y - dy;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    out.set(pixels.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * width + x) * 4);
  }
  return out;
}

/** Pixels whose RGBA differ inside the mask; transparent-vs-transparent counts as equal. */
export function maskedDifference(a: Uint8Array, b: Uint8Array, mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (a[i * 4 + 3] === 0 && b[i * 4 + 3] === 0) continue;
    if (!same(a, b, i)) n++;
  }
  return n;
}

/** T3: integer shift that best realigns the fixed parts of a frame with the reference. */
export function detectOffset(reference: Uint8Array, frame: Uint8Array, width: number, height: number, mask: Mask, radius = 3): Point & { before: number; after: number } {
  const before = maskedDifference(reference, frame, mask);
  let best = { x: 0, y: 0, after: before };
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (!dx && !dy) continue;
    const score = maskedDifference(reference, translate(frame, width, height, dx, dy), mask);
    if (score < best.after || (score === best.after && Math.abs(dx) + Math.abs(dy) < Math.abs(best.x) + Math.abs(best.y))) best = { x: dx, y: dy, after: score };
  }
  return { ...best, before };
}

/** T4: clear faint alpha and isolated single pixels (no opaque 4-neighbour). */
export function cleanup(pixels: Uint8Array, width: number, height: number, { alphaBelow = 32, isolated = true } = {}): Uint8Array {
  const out = pixels.slice();
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && pixels[(y * width + x) * 4 + 3] >= alphaBelow;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, a = pixels[i + 3];
    if (!a) continue;
    const faint = a < alphaBelow;
    const alone = isolated && !opaque(x - 1, y) && !opaque(x + 1, y) && !opaque(x, y - 1) && !opaque(x, y + 1);
    if (faint || alone) out.fill(0, i, i + 4);
  }
  return out;
}

const hex = (value: string) => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
/** T5: exact RGB mapping inside a mask; alpha is kept. */
export function paletteMap(pixels: Uint8Array, mask: Mask | null, pairs: { source: string; target: string }[]): Uint8Array {
  const out = pixels.slice();
  const map = new Map(pairs.map(p => [hex(p.source).join(','), hex(p.target)]));
  for (let i = 0; i < pixels.length / 4; i++) {
    if ((mask && !mask[i]) || !pixels[i * 4 + 3]) continue;
    const target = map.get(`${pixels[i * 4]},${pixels[i * 4 + 1]},${pixels[i * 4 + 2]}`);
    if (target) out.set(target, i * 4);
  }
  return out;
}

/** T7: difference between the last and the first frame of a loop. */
export function seamDifference(last: Uint8Array, first: Uint8Array) {
  const mask = changedMask(last, first);
  return { mask, changed: maskCount(mask), total: mask.length };
}

/** T8: nearest-neighbour rotation of the moving part about a pivot; the vacated area becomes transparent. */
export function rotatePart(base: Uint8Array, width: number, height: number, moving: Mask, pivot: Point, degrees: number): Uint8Array {
  const out = base.slice();
  for (let i = 0; i < moving.length; i++) if (moving[i]) out.fill(0, i * 4, i * 4 + 4);
  const r = (degrees * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Inverse mapping keeps every destination pixel a copy of exactly one source pixel.
    const dx = x + 0.5 - pivot.x, dy = y + 0.5 - pivot.y;
    const sx = Math.floor(pivot.x + dx * cos + dy * sin), sy = Math.floor(pivot.y - dx * sin + dy * cos);
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const s = sy * width + sx;
    if (!moving[s] || !base[s * 4 + 3]) continue;
    out.set(base.subarray(s * 4, s * 4 + 4), (y * width + x) * 4);
  }
  return out;
}

/** Evenly spaced angles from the first to the last frame, both ends included. */
export function rotationAngles(count: number, from: number, to: number): number[] {
  if (count < 2) return [to];
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
}

/** A deterministic patch for one frame, or null when the tool changed nothing there. */
export function framePatch(frame: number, sourceSha256: string, before: Uint8Array, after: Uint8Array, mergeGap = 3) {
  const changed = changedMask(before, after);
  if (!maskCount(changed)) return null;
  return { region: { frame, source_sha256: sourceSha256, spans: maskSpans(changed, mergeGap) }, changed: maskCount(changed) };
}

export function rgba(width: number, height: number, pixels: Uint8Array): RgbaImage { return { width, height, pixels }; }
