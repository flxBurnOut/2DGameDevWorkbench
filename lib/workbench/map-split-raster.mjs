import { setImmediate } from 'node:timers/promises';

/** Even-odd fill at pixel centres, including concave/self-intersecting paths.
 * Active edges avoid testing every vertex at every pixel. Yield between row
 * batches so large valid paths cannot monopolize the Runtime Bridge. */
export async function rasterizeMapPolygon(mask, width, points) {
  const starts = new Map();
  let first = Infinity,
    last = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    if (a.y === b.y) continue;
    const low = a.y < b.y ? a : b,
      high = a.y < b.y ? b : a;
    const edge = {
      x: low.x,
      y: low.y,
      end: high.y,
      slope: (high.x - low.x) / (high.y - low.y),
    };
    if (!starts.has(low.y)) starts.set(low.y, []);
    starts.get(low.y).push(edge);
    first = Math.min(first, low.y);
    last = Math.max(last, high.y);
  }
  let active = [];
  for (let y = first; y < last; y++) {
    active = active.filter((edge) => edge.end > y);
    if (starts.has(y)) active.push(...starts.get(y));
    const crossings = active
      .map((edge) => edge.x + (y + 0.5 - edge.y) * edge.slope)
      .sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const left = Math.max(0, Math.ceil(crossings[i] - 0.5));
      const right = Math.min(width, Math.ceil(crossings[i + 1] - 0.5));
      if (left < right) mask.fill(1, y * width + left, y * width + right);
    }
    if ((y - first + 1) % 16 === 0) await setImmediate();
  }
}
