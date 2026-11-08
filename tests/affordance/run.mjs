import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createScene, replaceMap } from '../../features/scene-composer/model.mjs';
import { applyMapSplit } from '../../features/scene-composer/map-split.mjs';
import {
  compareSurfaces,
  createGrid,
  physicalSurfaces,
  rasterizePolygon,
  rasterizeRect,
  resolvePlayer,
  resolveSurfaceOptions,
  visualSurfaces,
} from '../../features/scene-composer/affordance.mjs';
import { analyzeReachability } from '../../features/scene-composer/reachability.mjs';
import { analyzeScene, writeAffordanceReport } from '../../lib/workbench/affordance-report.mjs';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { image, split } from '../scene-composer/map-split-fixture.mjs';

const player = resolvePlayer();
const options = resolveSurfaceOptions();
const rect = (x, y, width, height) => ({ x, y, width, height });
const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

function maskFrom(x0, y0, width, height, filled) {
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (filled(x, y)) alpha[y * width + x] = 255;
  return { x0, y0, width, height, alpha };
}

// Polygon rasterisation covers pixel centres, so a 10x10 square fills 100 cells.
{
  const grid = createGrid(rect(0, 0, 20, 20));
  rasterizePolygon(grid, [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }]);
  assert.equal(grid.data.reduce((a, b) => a + b, 0), 100);
}

// Physical tops need headroom: ground under a low ceiling is not standable.
{
  const grid = createGrid(rect(0, 0, 400, 260));
  rasterizeRect(grid, rect(0, 200, 400, 60));
  rasterizeRect(grid, rect(100, 120, 60, 20)); // platform, 60px above the ground
  rasterizeRect(grid, rect(260, 170, 80, 10)); // ceiling only 20px above the ground
  const segments = physicalSurfaces(grid, player, options);
  const at = (x, y) => segments.some((s) => s.points.some((p) => p.x === x && p.y === y));
  assert.ok(at(120, 120), 'platform top is standable');
  assert.ok(at(120, 200), 'ground under a tall platform keeps headroom');
  assert.ok(!at(300, 200), 'ground under a low ceiling is rejected');
  assert.ok(at(300, 170), 'the ceiling top itself is standable');
}

// Robust visual tops ignore thin grass blades above the solid body.
{
  const mask = maskFrom(0, 0, 60, 100, (x, y) => y >= 50 || (y >= 40 && x % 3 === 0));
  const candidates = [{ key: 'ground', label: 'ground', mask }];
  const [segment] = visualSurfaces(candidates, rect(0, 0, 60, 100), player, options);
  assert.ok(segment, 'a visual surface is found');
  for (const point of segment.points) {
    assert.ok(point.y > 42, `blade tips are not the top (${point.y})`);
    near(point.y, 50, options.matchTolerance, 'robust top stays near the real edge');
  }
}

// Unlabeled art does not block headroom; ground art does.
{
  const ground = { key: 'g', label: 'ground', mask: maskFrom(0, 100, 40, 20, () => true) };
  const canopy = { key: 'c', label: 'unlabeled', mask: maskFrom(0, 80, 40, 10, () => true) };
  const tops = visualSurfaces([ground, canopy], rect(0, 0, 40, 120), player, options);
  assert.ok(tops.some((s) => s.key === 'g'), 'ground under unlabeled canopy stays a visual surface');
  const slab = { key: 's', label: 'ground', mask: maskFrom(0, 80, 40, 10, () => true) };
  const blocked = visualSurfaces([ground, slab], rect(0, 0, 40, 120), player, options);
  assert.ok(!blocked.some((s) => s.key === 'g'), 'ground art 10px above blocks headroom');
}

// Consistency: matching tops count once; offsets produce fake and phantom spans.
{
  const line = (id, y, x0, x1, label = 'ground') => ({
    id, key: id, meta: { label },
    points: Array.from({ length: (x1 - x0) / 4 + 1 }, (_, i) => ({ x: x0 + i * 4, y })),
  });
  const same = compareSurfaces([line('v', 100, 0, 96)], [line('p', 103, 0, 96)], options);
  assert.equal(same.precision, 1);
  assert.equal(same.recall, 1);
  const off = compareSurfaces([line('v', 100, 0, 96), line('ledge', 60, 200, 240)], [line('p', 100, 0, 96), line('ghost', 40, 300, 320)], options);
  assert.equal(off.fake.length, 1);
  assert.equal(off.fake[0].segmentId, 'ledge');
  assert.equal(off.fakeLength, 44);
  assert.equal(off.phantom.length, 1);
  assert.equal(off.phantomLength, 24);
}

// Reachability: an 80px rise is within a 104px jump; a 150px rise is not.
{
  const build = (rise) => {
    const grid = createGrid(rect(0, 0, 600, 400));
    rasterizeRect(grid, rect(0, 300, 200, 100));
    rasterizeRect(grid, rect(260, 300 - rise, 120, 16));
    rasterizeRect(grid, rect(440, 300, 160, 100));
    return { grid, segments: physicalSurfaces(grid, player, options) };
  };
  const easy = build(80);
  const easyResult = analyzeReachability(easy.grid, easy.segments, player, { sampleStep: options.sampleStep });
  assert.equal(easyResult.goalReachable, true);
  assert.equal(easyResult.coverage, 1);
  const hard = build(150);
  const hardResult = analyzeReachability(hard.grid, hard.segments, player, { sampleStep: options.sampleStep });
  const platform = hardResult.segments.find((s) => s.y === 150);
  assert.ok(platform, 'high platform is a surface');
  assert.equal(platform.reachableLength, 0, 'high platform is unreachable');
  assert.equal(hardResult.goalReachable, false, 'without the platform the 240px ground gap is too wide (flat jump ~179px)');
  const wide = createGrid(rect(0, 0, 1200, 400));
  rasterizeRect(wide, rect(0, 300, 200, 100));
  rasterizeRect(wide, rect(800, 300, 400, 100));
  const wideResult = analyzeReachability(wide, physicalSurfaces(wide, player, options), player, { sampleStep: options.sampleStep });
  assert.equal(wideResult.goalReachable, false, 'a 600px gap is not jumpable');
}

// End to end on a split scene: front parts and background elements are excluded,
// a ledge without collision is fake ground, an invisible block is phantom ground.
async function partSource(width, height, filled) {
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (filled(x, y)) bytes.set([90, 70, 50, 255], (y * width + x) * 4);
  return `data:image/png;base64,${(await sharp(bytes, { raw: { width, height, channels: 4 } }).png().toBuffer()).toString('base64')}`;
}
function splitElement(id, kind, x, y, width, height, source, extra = {}) {
  return {
    id, name: id, kind, x, y, positionMode: 'relative', hidden: false, locked: false, included: true,
    parts: [{ id: 'art', role: 'art', plane: extra.plane || 'back', x: 0, y: 0, width, height, source, enabled: true }],
    collision: extra.collision || { enabled: false, polygons: [], mapIndices: [] },
  };
}
const scene = createScene('Affordance fixture');
scene.id = 'affordance_fixture';
replaceMap(scene, {
  name: 'fixture',
  origin: { x: 0, y: 0 },
  offset: { x: 0, y: 0 },
  layers: [{ id: 'map_overall', name: 'map', source: await image(400, 240, '#88aacc'), width: 400, height: 240, hidden: false, locked: true, included: true }],
  collisions: [
    [{ x: 0, y: 180 }, { x: 400, y: 180 }, { x: 400, y: 240 }, { x: 0, y: 240 }],
    [{ x: 60, y: 130 }, { x: 100, y: 130 }, { x: 100, y: 140 }, { x: 60, y: 140 }],
  ],
  source: 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
  warnings: [],
});
const elements = [
  splitElement('ground', 'surface', 0, 0, 400, 240, await partSource(400, 240, (x, y) => y >= 180 || (y >= 172 && x % 3 === 0))),
  splitElement('platform', 'object', 150, 100, 80, 16, await partSource(80, 16, () => true), {
    collision: { enabled: true, polygons: [[{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 16 }, { x: 0, y: 16 }]], mapIndices: [] },
  }),
  splitElement('ledge', 'object', 300, 120, 60, 12, await partSource(60, 12, () => true)),
  splitElement('sky', 'background', 0, 0, 400, 100, await partSource(400, 100, () => true)),
  splitElement('bush', 'object', 20, 150, 30, 30, await partSource(30, 30, () => true), { plane: 'front' }),
];
applyMapSplit(scene, split(elements, { origin: { x: 0, y: 0 }, candidateId: 'split_affordance' }));
const manifest = await loadManifest();
const analysis = await analyzeScene(repositoryRoot, manifest, scene);
const keys = analysis.inputs.candidates.map((c) => c.elementId);
assert.deepEqual(keys.sort((a, b) => a.localeCompare(b)), ['ground', 'ledge', 'platform'], 'background and front-plane art are excluded');
const all = analysis.consistency.all;
assert.ok(all.fake.some((s) => s.key === 'ledge:art' && s.x0 >= 296 && s.x1 <= 360), 'ledge without collision is fake ground');
assert.ok(all.phantom.some((s) => s.x0 >= 56 && s.x1 <= 100 && Math.abs(s.y - 130) <= 1), 'invisible block is phantom ground');
assert.ok(!all.phantom.some((s) => Math.abs(s.y - 100) <= 1), 'platform with art and collision is consistent');
assert.equal(analysis.consistency.ground.fake.filter((s) => s.y > 170).length, 1, 'ground art only fails under the invisible block');
assert.equal(analysis.reachability.goalReachable, true);
assert.ok(analysis.reachability.segments.find((s) => s.y === 100).reachableLength > 0, 'platform is reachable');

// The report writer stays read-only and saves an overlay under a test output root.
const testManifest = structuredClone(manifest);
testManifest.workspace.outputDirectory = `work/test-runs/${process.env.WORKBENCH_TEST_RUN}/outputs`;
const before = JSON.stringify(scene);
const written = await writeAffordanceReport(repositoryRoot, testManifest, scene, { documentId: scene.id, revision: 1 });
assert.equal(JSON.stringify(scene), before, 'analysis does not mutate the scene');
const report = JSON.parse(await readFile(path.join(repositoryRoot, written.directory, 'report.json'), 'utf8'));
assert.equal(report.readOnly, true);
assert.equal(report.summary.reachability.goalReachable, true);
const overlay = await sharp(path.join(repositoryRoot, written.directory, 'overlay.png')).metadata();
assert.ok(overlay.width > 0 && overlay.height > 0);
await rm(path.join(repositoryRoot, 'work/test-runs', process.env.WORKBENCH_TEST_RUN), { recursive: true, force: true });

console.log('affordance: all checks passed');
