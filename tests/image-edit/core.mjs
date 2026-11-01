import { planImageIntent } from '../../features/image-edit/edit-intent.mjs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as character from '../../Tools/SpritePipeline/sprite_pipeline/static/pixel_editor_core.js';

const oldFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = () => { requests++; throw new Error('Local image core must never use a network provider.'); };
const { resolveRegion, applyLocalOperation, LOCAL_EDIT_LIMITS, ...shared } = await import('../../features/image-edit/core.mjs');
const rgba = values => new Uint8ClampedArray(values.flat());
const pixel = (pixels, index) => [...pixels.subarray(index * 4, index * 4 + 4)];
const all = (pixels, width, height) => resolveRegion(pixels, width, height, { type: 'all' }).mask;
const run = (pixels, width, height, mask, operation, restorePixels) => applyLocalOperation({ pixels, width, height, mask, operation, restorePixels });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('character primitives are the same imported functions, with no DOM or Python requirement', () => {
  const descriptors = Object.getOwnPropertyDescriptors(character);
  for (const name of Object.keys(shared)) assert.equal(shared[name], descriptors[name].value, name);
  assert.equal(typeof document, 'undefined');
  assert.ok(Object.isFrozen(LOCAL_EDIT_LIMITS));
});
test('regions use explicit original-pixel bounds and do not mutate hidden RGB', () => {
  const pixels = rgba([[30, 20, 10, 0], [1, 2, 3, 1], [1, 2, 3, 128], [1, 2, 3, 255]]);
  const before = pixels.slice();
  assert.deepEqual(resolveRegion(pixels, 2, 2, { type: 'rectangle', x: 1, y: 0, width: 1, height: 2 }), { mask: new Uint8Array([0, 1, 0, 1]), count: 2, bounds: { x: 1, y: 0, width: 1, height: 2 } });
  assert.equal(resolveRegion(pixels, 2, 2, { type: 'all' }).count, 4);
  assert.equal(resolveRegion(pixels, 2, 2, { type: 'alpha-bounds', threshold: 128 }).count, 2);
  assert.equal(resolveRegion(pixels, 2, 2, { type: 'alpha-bounds', threshold: 0 }).count, 4);
  assert.deepEqual([...resolveRegion(pixels, 2, 2, { type: 'alpha-selection', minAlpha: 0, maxAlpha: 1 }).mask], [1, 1, 0, 0]);
  assert.deepEqual(resolveRegion(new Uint8Array(16), 2, 2, { type: 'alpha-bounds' }).bounds, null);
  const corners = rgba([[1, 2, 3, 255], [8, 9, 10, 0], [11, 12, 13, 0], [4, 5, 6, 255]]);
  assert.equal(resolveRegion(corners, 2, 2, { type: 'alpha-bounds' }).count, 4, 'Alpha bounds select the bounding rectangle, not a subject silhouette');
  assert.equal(resolveRegion(corners, 2, 2, { type: 'alpha-selection', minAlpha: 1 }).count, 2);
  assert.deepEqual(pixels, before);
});
test('polygon even-odd pixels agree with rectangles and are bounded at image edges', () => {
  const pixels = new Uint8Array(5 * 4 * 4);
  const rectangle = resolveRegion(pixels, 5, 4, { type: 'rectangle', x: 1, y: 1, width: 3, height: 2 });
  const polygon = resolveRegion(pixels, 5, 4, { type: 'polygon', points: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 3 }, { x: 1, y: 3 }] });
  assert.deepEqual(polygon, rectangle);
  assert.deepEqual(resolveRegion(pixels, 5, 4, { type: 'polygon', points: [{ x: 1, y: 3 }, { x: 4, y: 3 }, { x: 4, y: 1 }, { x: 1, y: 1 }] }), rectangle);
  assert.equal(resolveRegion(pixels, 5, 4, { type: 'polygon', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 4 }] }).count, 10);
});

test('mask runs round trip hard brush masks with strict ordering and no RGBA changes', () => {
  const pixels = new Uint8Array(4 * 3 * 4).fill(137), original = pixels.slice();
  const spec = { type: 'mask-runs', spans: [{ startPixel: 1, length: 2 }, { startPixel: 5, length: 3 }, { startPixel: 11, length: 1 }] };
  const region = resolveRegion(pixels, 4, 3, spec);
  assert.deepEqual(region, { mask: new Uint8Array([0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1]), count: 6, bounds: { x: 1, y: 0, width: 3, height: 3 } });
  assert.deepEqual(resolveRegion(pixels, 4, 3, { type: 'mask-runs', spans: [] }), { mask: new Uint8Array(12), count: 0, bounds: null });
  assert.equal(resolveRegion(pixels, 4, 3, { type: 'mask-runs', spans: [{ startPixel: 0, length: 4 }, { startPixel: 4, length: 8 }] }).count, 12, 'Adjacent runs are valid and may cross rows.');
  for (const spans of [
    [{ startPixel: -1, length: 1 }], [{ startPixel: 1.5, length: 1 }], [{ startPixel: 1, length: 0 }], [{ startPixel: 1, length: 1.5 }],
    [{ startPixel: 11, length: 2 }], [{ startPixel: 12, length: 1 }], [{ startPixel: 3, length: 2 }, { startPixel: 4, length: 1 }],
    [{ startPixel: 5, length: 1 }, { startPixel: 1, length: 1 }], [{ startPixel: 1, length: 1, alpha: 128 }],
  ]) assert.throws(() => resolveRegion(pixels, 4, 3, { type: 'mask-runs', spans }));
  assert.throws(() => resolveRegion(new Uint8Array(512 * 512 * 4), 512, 512, { type: 'mask-runs', spans: Array.from({ length: 65537 }, (_, index) => ({ startPixel: index * 2, length: 1 })) }), /65536/);
  assert.deepEqual(pixels, original, 'Mask editing never mutates source RGBA, including after invalid input.');
  assert.deepEqual(resolveRegion(pixels, 4, 3, spec), region, 'Resolving the same immutable runs is deterministic.');
});
test('connected colour is four-way seed-relative RGBA, including alpha and hidden RGB', () => {
  const pixels = rgba([[10, 10, 10, 100], [12, 10, 10, 100], [14, 10, 10, 100], [10, 10, 10, 100], [10, 10, 10, 103], [10, 10, 10, 110]]);
  assert.equal(resolveRegion(pixels, 3, 2, { type: 'connected-color', x: 0, y: 0 }).count, 2);
  assert.deepEqual([...resolveRegion(pixels, 3, 2, { type: 'connected-color', x: 0, y: 0, tolerance: 3 }).mask], [1, 1, 0, 1, 1, 0]);
  const diagonal = rgba([[5, 5, 5, 0], [7, 7, 7, 0], [7, 7, 7, 0], [5, 5, 5, 0]]);
  assert.equal(resolveRegion(diagonal, 2, 2, { type: 'connected-color', x: 1, y: 0 }).count, 1, 'No row wrap or diagonal connection');
});
test('alpha cleanup clears only selected alpha 1..threshold; threshold0 and alpha0 hidden RGB stay intact', () => {
  const pixels = rgba([[21, 22, 23, 0], [31, 32, 33, 1], [41, 42, 43, 2], [51, 52, 53, 16], [61, 62, 63, 255]]);
  const mask = new Uint8Array([1, 1, 0, 1, 1]);
  const result = run(pixels, 5, 1, mask, { type: 'clean-alpha', threshold: 16 });
  assert.deepEqual(pixel(result.pixels, 0), [21, 22, 23, 0]);
  assert.deepEqual(pixel(result.pixels, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixel(result.pixels, 2), [41, 42, 43, 2]);
  assert.equal(result.changedPixelCount, 2);
  assert.deepEqual(result.bounds, { x: 1, y: 0, width: 3, height: 1 });
  assert.equal(run(result.pixels, 5, 1, mask, { type: 'clean-alpha', threshold: 16 }).changedPixelCount, 0);
  assert.equal(run(pixels, 5, 1, mask, { type: 'clean-alpha', threshold: 0 }).changedPixelCount, 0);
});
test('exact RGB replacement preserves all alpha values and every protected channel', () => {
  const pixels = rgba([[10, 20, 30, 0], [10, 20, 30, 1], [10, 20, 30, 128], [10, 20, 31, 255]]);
  const before = pixels.slice();
  const result = run(pixels, 4, 1, new Uint8Array([1, 0, 1, 1]), { type: 'replace-color', from: '#0a141e', to: '#abcdef' });
  assert.deepEqual([...result.pixels], [171, 205, 239, 0, 10, 20, 30, 1, 171, 205, 239, 128, 10, 20, 31, 255]);
  assert.equal(result.alphaPreserved, true);
  assert.equal(result.supportedConstraints.preserveAlpha, true);
  assert.equal(result.changedPixelCount, 2);
  assert.deepEqual(pixels, before);
  assert.notEqual(result.pixels, pixels);
});
test('intent routing only converts whole explicit pixel instructions', () => {
  assert.equal(planImageIntent('将 #112233 替换为 #445566').operation.type, 'replace-color');
  assert.equal(planImageIntent('#112233 → #445566，保留反光').route, 'ai');
  assert.equal(planImageIntent('#112233 → #445566', true).route, 'ai');
  assert.equal(planImageIntent('#abcdef → #112233，#ABCDEF → #998877').route, 'invalid');
  assert.equal(planImageIntent('擦除选区像素').operation.type, 'erase');
  assert.deepEqual(planImageIntent('移动选区(-3, 1)').operation, { type: 'translate', dx: -3, dy: 1 });
});
test('simultaneous palette swaps do not cascade or touch protected RGBA', () => {
  const input = rgba([[255,0,0,0],[0,255,0,128],[255,0,0,255],[1,2,3,255]]);
  const mask = new Uint8Array([1,1,0,1]);
  const pairs = [{from:'#FF0000',to:'#00ff00'}, {from:'#00FF00',to:'#ff0000'}];
  const result = run(input, 4, 1, mask, {type:'palette-map', pairs});
  assert.deepEqual([...result.pixels], [0,255,0,0,255,0,0,128,255,0,0,255,1,2,3,255]);
  assert.equal(result.changedPixelCount, 2);
  assert.throws(() => run(input, 4, 1, mask, {type:'palette-map', pairs:[...pairs,{from:'#ff0000',to:'#112233'}]}));
});
test('fill is connected, respects protected barriers and matches the original character algorithm', () => {
  const pixels = rgba(Array(5).fill([1, 2, 3, 255]));
  const result = run(pixels, 5, 1, new Uint8Array([1, 1, 0, 1, 1]), { type: 'fill', x: 0, y: 0, rgba: [9, 8, 7, 128] });
  assert.equal(result.changedPixelCount, 2);
  assert.deepEqual(pixel(result.pixels, 3), [1, 2, 3, 255]);
  const expected = pixels.slice();
  character.floodFillRgba(expected, 5, 1, { x: 0, y: 0 }, [9, 8, 7, 128]);
  assert.deepEqual(run(pixels, 5, 1, all(pixels, 5, 1), { type: 'fill', x: 0, y: 0, rgba: [9, 8, 7, 128] }).pixels, expected);
  assert.equal(run(expected, 5, 1, all(pixels, 5, 1), { type: 'fill', x: 0, y: 0, rgba: [9, 8, 7, 128] }).changedPixelCount, 0);
  assert.throws(() => run(pixels, 5, 1, new Uint8Array([0, 1, 0, 1, 1]), { type: 'fill', x: 0, y: 0, rgba: [1, 2, 3, 4] }), /种子/);
});
test('erase and restore change exactly selected four-channel pixels', () => {
  const pixels = rgba([[2, 3, 4, 0], [5, 6, 7, 128], [8, 9, 10, 255]]), mask = new Uint8Array([1, 0, 1]);
  const erased = run(pixels, 3, 1, mask, { type: 'erase' });
  assert.deepEqual([...erased.pixels], [0, 0, 0, 0, 5, 6, 7, 128, 0, 0, 0, 0]);
  const restored = run(erased.pixels, 3, 1, mask, { type: 'restore-region' }, pixels);
  assert.deepEqual(restored.pixels, pixels);
  assert.equal(run(restored.pixels, 3, 1, mask, { type: 'restore-region' }, pixels).changedPixelCount, 0);
});
test('translation preserves overlap/hidden RGB and declares source plus destination as the effective region', () => {
  const pixels = rgba([[1, 2, 3, 255], [4, 5, 6, 0], [7, 8, 9, 128], [10, 11, 12, 255], [13, 14, 15, 1]]);
  const mask = new Uint8Array([0, 1, 1, 0, 0]);
  const result = run(pixels, 5, 1, mask, { type: 'translate', dx: 1, dy: 0 });
  assert.deepEqual([...result.effectiveMask], [0, 1, 1, 1, 0]);
  assert.deepEqual([...result.pixels], [1, 2, 3, 255, 0, 0, 0, 0, 4, 5, 6, 0, 7, 8, 9, 128, 13, 14, 15, 1]);
  assert.equal(result.supportedConstraints.regionScope, 'source-and-destination');
  assert.deepEqual(mask, new Uint8Array([0, 1, 1, 0, 0]));
  const expected = pixels.slice();
  character.translateSelectionRgba(expected, 5, 1, { x: 1, y: 0, width: 2, height: 1 }, 1, 0);
  assert.deepEqual(result.pixels, expected);
  assert.equal(run(pixels, 5, 1, mask, { type: 'translate', dx: 0, dy: 0 }).bounds, null);
  assert.throws(() => run(pixels, 5, 1, mask, { type: 'translate', dx: -2, dy: 0 }), /x须/);
  assert.throws(() => run(pixels, 5, 1, new Uint8Array([1, 0, 1, 0, 0]), { type: 'translate', dx: 1, dy: 0 }), /矩形/);
});
test('pixel patches validate the full transaction before writing, including protected/hidden RGB bytes', () => {
  const pixels = rgba([[1, 2, 3, 0], [4, 5, 6, 255], [7, 8, 9, 128]]), before = pixels.slice();
  const mask = new Uint8Array([1, 0, 1]);
  const span = (start, original, after) => ({ startPixel: start, before: new Uint8Array(original), after: new Uint8Array(after) });
  const good = { type: 'pixel-patch', spans: [span(0, [1, 2, 3, 0], [10, 20, 30, 0]), span(2, [7, 8, 9, 128], [8, 9, 10, 128])] };
  const result = run(pixels, 3, 1, mask, good);
  assert.equal(result.changedPixelCount, 2);
  assert.equal(result.alphaPreserved, true);
  assert.deepEqual(pixel(result.pixels, 1), [4, 5, 6, 255]);
  for (const spans of [
    [good.spans[0], span(2, [0, 0, 0, 128], [8, 9, 10, 128])],
    [good.spans[0], span(1, [4, 5, 6, 255], [4, 5, 7, 255])],
    [good.spans[1], good.spans[0]], [good.spans[0], good.spans[0]],
    [span(2, [7, 8, 9, 128, 1, 2, 3, 4], [0, 0, 0, 0, 0, 0, 0, 0])],
  ]) assert.throws(() => run(pixels, 3, 1, mask, { type: 'pixel-patch', spans }));
  assert.deepEqual(pixels, before, 'A late invalid span must not partially modify the original');
  assert.throws(() => run(result.pixels, 3, 1, mask, good), /基准不符/, 'Replaying a stale before-patch is rejected');
  assert.throws(() => run(pixels, 3, 1, mask, { type: 'pixel-patch', spans: [{ startPixel: 0, before: new Uint8Array(262148), after: new Uint8Array(262148) }] }), /512KiB/);
});
test('large bounded fill/translation agree with shared character results without huge history lists', () => {
  const width = 300, height = 300, pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) pixels.set([1, 2, 3, 255], index * 4);
  const mask = all(pixels, width, height);
  for (let y = 0; y < height; y++) { mask[y * width + 150] = 0; pixels.set([8, 8, 8, 255], (y * width + 150) * 4); }
  const expectedFill = pixels.slice(); character.floodFillRgba(expectedFill, width, height, { x: 0, y: 0 }, [9, 8, 7, 255]);
  const fill = run(pixels, width, height, mask, { type: 'fill', x: 0, y: 0, rgba: [9, 8, 7, 255] });
  assert.deepEqual(fill.pixels, expectedFill);
  assert.equal(fill.changedPixelCount, 150 * height);
  const rect = { x: 3, y: 4, width: 6, height: 7 };
  const selection = resolveRegion(pixels, width, height, { type: 'rectangle', ...rect });
  const expectedMove = pixels.slice(); character.translateSelectionRgba(expectedMove, width, height, rect, 2, -3);
  assert.deepEqual(run(pixels, width, height, selection.mask, { type: 'translate', dx: 2, dy: -3 }).pixels, expectedMove);
});
test('invalid dimensions, nonbinary masks, empty regions, malformed parameters and unsupported reads fail closed', () => {
  const pixels = rgba([[1, 2, 3, 255]]);
  for (const [width, height] of [[0, 1], [1.5, 1], [Infinity, 1], [3841, 1], [3840, 3840]]) assert.throws(() => resolveRegion(new Uint8Array(), width, height, { type: 'all' }));
  assert.throws(() => resolveRegion(new Float32Array(4), 1, 1, { type: 'all' }));
  for (const spec of [{ type: 'rectangle', x: 0, y: 0, width: 2, height: 1 }, { type: 'rectangle', x: 0.5, y: 0, width: 1, height: 1 }, { type: 'alpha-selection', minAlpha: 2, maxAlpha: 1 }, { type: 'connected-color', x: 0, y: 0, tolerance: -1 }, { type: 'polygon', points: Array(1025).fill({ x: 0, y: 0 }) }, { type: 'named', regionId: 'secret' }, { type: 'maskRef', path: '/private/file' }]) assert.throws(() => resolveRegion(pixels, 1, 1, spec));
  for (const mask of [new Uint8Array([255]), new Uint8Array([0]), new Uint8Array()]) assert.throws(() => run(pixels, 1, 1, mask, { type: 'erase' }));
  for (const operation of [{ type: 'clean-alpha', threshold: 17 }, { type: 'replace-color', from: '#fff', to: '#000000' }, { type: 'fill', x: 0, y: 0, rgba: [1, 2, 3, 256] }, { type: 'translate', dx: 0.5, dy: 0 }, { type: 'restore-region' }, { type: 'erase', apiKey: 'never-accepted' }, { type: 'ai-edit' }]) assert.throws(() => run(pixels, 1, 1, new Uint8Array([1]), operation));
});

try {
  for (const [name, fn] of tests) { fn(); console.log(`ok - ${name}`); }
  const benchmark = [];
  for (const size of [1024, 1536, 2880]) {
    const pixels = new Uint8ClampedArray(size * size * 4), mask = new Uint8Array(size * size).fill(1);
    const started = performance.now();
    const result = run(pixels, size, size, mask, { type: 'fill', x: 0, y: 0, rgba: [4, 5, 6, 128] });
    assert.equal(result.changedPixelCount, size * size);
    assert.deepEqual(pixel(result.pixels, size * size - 1), [4, 5, 6, 128]);
    benchmark.push({ width: size, height: size, operation: 'full-canvas-fill', elapsedMs: Math.round(performance.now() - started), rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
  }
  assert.equal(requests, 0);
  console.log(JSON.stringify({ tests: tests.length, networkRequests: requests, benchmark, note: 'RSS is a process sample, not an allocation profiler or a browser frame-rate claim.' }, null, 2));
} finally { globalThis.fetch = oldFetch; }
