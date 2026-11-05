import assert from 'node:assert/strict';
import { rasterizeMapPolygon } from '../../lib/workbench/map-split-raster.mjs';

const inside = (x, y, points) => {
  let value = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    )
      value = !value;
  }
  return Number(value);
};
for (const coords of [
  [
    [0, 0],
    [12, 0],
    [12, 12],
    [0, 12],
  ],
  [
    [1, 1],
    [11, 11],
    [11, 1],
    [1, 11],
  ],
  [
    [1, 1],
    [11, 2],
    [5, 5],
    [10, 11],
    [2, 9],
  ],
  [
    [0, 0],
    [6, 6],
    [12, 0],
    [6, 12],
  ],
  [
    [1, 1],
    [5, 1],
    [5, 1],
    [5, 8],
    [1, 1],
  ],
]) {
  const points = coords.map(([x, y]) => ({ x, y }));
  for (const polygon of [points, [...points].reverse()]) {
    const mask = new Uint8Array(144);
    await rasterizeMapPolygon(mask, 12, polygon);
    assert.deepEqual(
      mask,
      Uint8Array.from({ length: 144 }, (_, i) =>
        inside((i % 12) + 0.5, Math.floor(i / 12) + 0.5, polygon),
      ),
    );
  }
}
const mask = new Uint8Array(4096 * 4096);
const points = Array.from({ length: 2000 }, (_, i) => ({
  x: Math.round(2048 + 2048 * Math.cos((i * Math.PI) / 1000)),
  y: Math.round(2048 + 2048 * Math.sin((i * Math.PI) / 1000)),
}));
let ticks = 0,
  running = true;
const heartbeat = () => {
  if (running) {
    ticks++;
    setImmediate(heartbeat);
  }
};
setImmediate(heartbeat);
const started = performance.now();
try {
  await rasterizeMapPolygon(mask, 4096, points);
} finally {
  running = false;
}
assert.ok(
  ticks > 2,
  'Large polygons yield repeatedly so other Bridge work can progress.',
);
assert.equal(mask[2048 * 4096 + 2048], 1);
assert.equal(mask[0], 0);
console.log(
  `Polygon raster regression passed: even-odd pixel parity; 4096² / 2000 vertices in ${Math.round(performance.now() - started)} ms, ${ticks} event-loop turns.`,
);
