import '../helpers/runtime-workspace.mjs';
import './raster.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  buildSplitElements,
  encodeMapMaskRle,
  freezeMapPixels,
  resolveMapSelection,
} from '../../lib/workbench/map-split-pixels.mjs';
import {
  classifyAutomaticMapMask,
  coarseMapSpecs,
  mapSplitSettings,
  mapSplitSamStatus,
} from '../../lib/workbench/map-split-vision.mjs';
import {
  automaticMapSegments,
  segmentMapSelection,
} from '../../lib/workbench/map-split-sam.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = path.join(
  root,
  'work',
  'test-runs',
  process.env.WORKBENCH_TEST_RUN,
  'map-split-pixels',
);
await mkdir(scratch, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const url = (png) => 'data:image/png;base64,' + png.toString('base64');
const png = (pixels, width, height) =>
  sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
const raw = async (source) =>
  sharp(
    typeof source === 'string'
      ? Buffer.from(source.split(',')[1], 'base64')
      : source,
  )
    .ensureAlpha()
    .raw()
    .toBuffer();
const rect = (x, y, width, height) => ({ type: 'rect', x, y, width, height });
const spec = (id, selection, rest = {}) => ({
  id,
  name: id,
  kind: 'object',
  parts: [{ id: 'art', plane: 'back', role: 'art', selection }],
  ...rest,
});
const create = async (width, height, pixels) => {
  const bytes = await png(pixels, width, height);
  return {
    png: bytes,
    sourceHash: sha(bytes),
    width,
    height,
    origin: { x: -22, y: 17 },
    layers: [],
  };
};

// Capture actual front-first scene order, participation and baked multi-card
// canvas coordinates; editor-only hidden does not remove export pixels.
const width = 8,
  height = 6,
  base = Buffer.alloc(width * height * 4),
  front = Buffer.alloc(base.length);
for (let i = 0; i < width * height; i++)
  base.set([20 + i, 80, 100, 255], 4 * i);
front.set([220, 10, 30, 255], 4 * (2 * width + 4));
const basePng = await png(base, width, height),
  frontPng = await png(front, width, height);
const scene = {
  order: ['map_top', 'already_placed', 'actor', 'map_surface', 'excluded'],
  instances: [{ id: 'already_placed' }],
  map: {
    origin: { x: -16, y: -4 },
    offset: { x: -6, y: 21 },
    layers: [
      {
        id: 'map_surface',
        source: url(basePng),
        width,
        height,
        included: true,
        hidden: true,
      },
      {
        id: 'excluded',
        source: url(basePng),
        width,
        height,
        included: false,
        hidden: false,
      },
      {
        id: 'map_top',
        source: url(frontPng),
        width,
        height,
        included: true,
        hidden: false,
      },
    ],
  },
};
const frozen = await freezeMapPixels(scene),
  frozenRaw = await raw(frozen.png);
assert.deepEqual(frozen.origin, { x: -22, y: 17 });
assert.equal(frozen.sourceHash, sha(frozen.png));
assert.deepEqual(
  frozen.layers.map((layer) => [layer.id, layer.plane]),
  [
    ['map_surface', 'back'],
    ['map_top', 'front'],
  ],
);
assert.deepEqual(
  [...frozenRaw.subarray(4 * (2 * width + 4), 4 * (2 * width + 4) + 4)],
  [220, 10, 30, 255],
);
assert.deepEqual([...frozenRaw.subarray(0, 4)], [20, 80, 100, 255]);
assert.deepEqual(
  (await buildSplitElements(frozen, []))[0].parts.map((part) => part.plane),
  ['back', 'front'],
);
await assert.rejects(
  freezeMapPixels({ ...scene, order: ['actor', 'map_surface'] }),
  { code: 'MAP_SPLIT_INVALID' },
);
await assert.rejects(
  freezeMapPixels({
    ...scene,
    map: {
      ...scene.map,
      layers: [
        { ...scene.map.layers[0], source: 'https://invalid.test/source.png' },
      ],
    },
  }),
  { code: 'MAP_SPLIT_INVALID' },
);

const first = new Uint8Array(width * height);
first[2 * width + 3] = 1;
first[2 * width + 4] = 1;
first[3 * width + 4] = 1;
const second = new Uint8Array(width * height);
second[3 * width + 5] = 1;
second[4 * width + 5] = 1;
const secondSelection = encodeMapMaskRle(second, width, height);
const specs = [
  spec('tree_across_seam', encodeMapMaskRle(first, width, height), {
    parts: [
      {
        id: 'canopy',
        role: 'art',
        plane: 'front',
        selection: encodeMapMaskRle(first, width, height),
      },
    ],
  }),
  spec('tree_across_seam', secondSelection, {
    parts: [
      { id: 'trunk', role: 'art', plane: 'back', selection: secondSelection },
    ],
  }),
  spec(
    'background',
    {
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 8, y: 1 },
        { x: 0, y: 1 },
      ],
    },
    { kind: 'background' },
  ),
];
const elements = await buildSplitElements(
  frozen,
  JSON.parse(JSON.stringify(specs)),
);
const tree = elements.find((item) => item.id === 'tree_across_seam');
assert.equal(elements.filter((item) => item.id === tree.id).length, 1);
assert.equal(tree.parts.length, 2);
assert.deepEqual([tree.x, tree.y], [3, 2]);
assert.deepEqual(
  tree.parts.map((part) => [part.id, part.x, part.y, part.plane]),
  [
    ['canopy', 0, 0, 'front'],
    ['trunk', 2, 1, 'back'],
  ],
);
assert.equal(tree.collision.enabled, false);
assert.deepEqual(tree.collision.mapIndices, []);
assert.deepEqual(
  tree.collision.polygons,
  [
    [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 3, y: 3 },
      { x: 2, y: 3 },
    ],
  ],
  'trunk support excludes the wider canopy',
);
const slab = {
  type: 'rle',
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  counts: [0, 2000],
};
assert.equal(classifyAutomaticMapMask(slab, 100, 100).kind, 'background');
assert.equal(
  classifyAutomaticMapMask({ ...slab, y: 80 }, 100, 100).kind,
  'surface',
);
assert.equal(
  classifyAutomaticMapMask(
    { ...slab, counts: Array.from({ length: 20 }, () => [99, 1]).flat() },
    100,
    100,
  ).kind,
  'object',
  'a bounding box spanning the canvas does not prove the actual pixels form a broad layer',
);
assert(elements.some((item) => item.kind === 'background'));
assert(elements.some((item) => item.kind === 'surface'));
// Disjoint ownership produces precisely the original source, with transparent
// holes at every moved object pixel and no repeated old-map sprite.
const composites = [];
const owners = new Uint8Array(width * height);
for (const element of elements)
  for (const part of element.parts) {
    const partPixels = await raw(part.source),
      ownership = await sharp(Buffer.from(part.mask.split(',')[1], 'base64'))
        .greyscale()
        .raw()
        .toBuffer();
    for (let y = 0; y < part.height; y++)
      for (let x = 0; x < part.width; x++) {
        const local = y * part.width + x,
          global = (element.y + part.y + y) * width + element.x + part.x + x;
        if (ownership[local]) {
          assert.equal(owners[global], 0);
          owners[global] = 1;
          assert.deepEqual(
            partPixels.subarray(local * 4, local * 4 + 4),
            frozenRaw.subarray(global * 4, global * 4 + 4),
          );
        }
      }
    composites.push({
      input: Buffer.from(part.source.split(',')[1], 'base64'),
      left: element.x + part.x,
      top: element.y + part.y,
    });
  }
assert(owners.every((value) => value === 1));
const reassembled = await sharp({
  create: {
    width,
    height,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(composites)
  .raw()
  .toBuffer();
assert.deepEqual(reassembled, frozenRaw);
const remaining = elements
  .filter((item) => item.kind !== 'object')
  .flatMap((element) =>
    element.parts.map((part) => ({
      input: Buffer.from(part.source.split(',')[1], 'base64'),
      left: element.x + part.x,
      top: element.y + part.y,
    })),
  );
const withHole = await sharp({
  create: {
    width,
    height,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(remaining)
  .raw()
  .toBuffer();
for (let i = 0; i < first.length; i++)
  if (first[i] || second[i]) assert.equal(withHole[4 * i + 3], 0);
assert.deepEqual(
  encodeMapMaskRle(
    (await resolveMapSelection(frozen, secondSelection)).mask,
    width,
    height,
  ),
  secondSelection,
);
await assert.rejects(
  resolveMapSelection(frozen, { ...secondSelection, counts: [999] }),
  { code: 'MAP_SPLIT_INVALID' },
);
const combined = await resolveMapSelection(frozen, {
  type: 'combine',
  operation: 'subtract',
  selections: [rect(0, 0, 3, 3), rect(1, 1, 1, 1)],
});
assert.equal(
  combined.mask.reduce((a, b) => a + b),
  8,
);
assert.equal(combined.mask[width + 1], 0);
await assert.rejects(
  buildSplitElements({ ...frozen, sourceHash: '0'.repeat(64) }, []),
  { code: 'MAP_SPLIT_SOURCE_CHANGED' },
);

// Pixel ownership and edge appearance are independent; core and other targets
// stay exact while a visible mixed edge may be attenuated/decontaminated.
const edged = Buffer.alloc(9 * 9 * 4);
for (let y = 2; y < 7; y++)
  for (let x = 2; x < 7; x++)
    edged.set(
      [180, 150, 90, x === 2 || y === 2 || x === 6 || y === 6 ? 128 : 255],
      4 * (9 * y + x),
    );
const edgeFrozen = await create(9, 9, edged);
const clean = (
  await buildSplitElements(edgeFrozen, [spec('art', rect(2, 2, 5, 5))])
)[0];
const repaired = (
  await buildSplitElements(edgeFrozen, [
    spec('art', rect(2, 2, 5, 5), {
      parts: [
        {
          id: 'art',
          selection: rect(2, 2, 5, 5),
          edge: {
            feather: 1,
            decontaminate: { background: [255, 255, 255], strength: 0.5 },
          },
        },
      ],
    }),
  ])
)[0];
assert.equal(clean.parts[0].mask, repaired.parts[0].mask);
const beforeEdge = await raw(clean.parts[0].source),
  afterEdge = await raw(repaired.parts[0].source);
assert.deepEqual(
  beforeEdge.subarray(4 * 12, 4 * 13),
  afterEdge.subarray(4 * 12, 4 * 13),
);
assert.equal(beforeEdge[3], 128);
assert.equal(afterEdge[3], 64);
const local = await coarseMapSpecs(frozen, { root: scratch, minArea: 1 });
assert.equal(local.verification, 'unverified');
assert.equal(local.usage.paidCalls, 0);
assert.equal(local.sam.available, false);
assert(local.specs.length > 0);
assert(
  local.specs.every((item) =>
    item.parts.every((part) => part.selection.type === 'rle'),
  ),
);
assert.deepEqual(JSON.parse(JSON.stringify(local.specs)), local.specs);
const flat = await create(
  8,
  8,
  Buffer.from(Array.from({ length: 64 }, () => [66, 77, 88, 255]).flat()),
);
const noCandidates = await coarseMapSpecs(flat, { root: scratch, minArea: 1 });
assert.equal(noCandidates.specs.length, 0);
assert(noCandidates.warnings.some((w) => w.includes('尚未拆出任何独立物件')));
assert.deepEqual(
  (await buildSplitElements(flat, noCandidates.specs)).map((item) => item.kind),
  ['surface'],
);
const automaticFallback = await coarseMapSpecs(flat, {
  root: scratch,
  mode: 'auto',
  minArea: 1,
});
assert.equal(automaticFallback.method, 'local-pixel-evidence');
assert.equal(automaticFallback.autoFallback.code, 'MAP_SPLIT_SAM_UNAVAILABLE');
assert.equal(automaticFallback.usage.localSamCalls, 0);
assert(automaticFallback.warnings[0].includes('明确退回纯像素'));
const colorPixels = Buffer.from(
  Array.from({ length: 64 }, () => [66, 77, 88, 255]).flat(),
);
for (const index of [18, 19, 26])
  colorPixels.set([255, 80, 10, 255], index * 4);
const colorFrozen = await create(8, 8, colorPixels),
  color = await coarseMapSpecs(colorFrozen, { root: scratch, minArea: 2 });
assert.equal(color.specs.length, 1);
assert.equal(color.evidence[0].method, 'quantized-color-component');
assert.equal(color.evidence[0].area, 3);
const flood = (
  await resolveMapSelection(colorFrozen, {
    type: 'auto',
    method: 'color',
    seed: { x: 2, y: 2 },
    tolerance: 0,
  })
).mask;
assert.equal(
  flood.reduce((a, b) => a + b),
  3,
);
await assert.rejects(
  resolveMapSelection(
    flat,
    { type: 'sam', box: { x: 0, y: 0, width: 3, height: 3 } },
    { root: scratch },
  ),
  { code: 'MAP_SPLIT_SAM_UNAVAILABLE' },
);

// Execute the actual bounded-window SAM transport against an isolated fixture
// worker, not an installed model or network service.
const tool = path.join(scratch, 'Tools', 'VisualStructure');
await mkdir(tool, { recursive: true });
await writeFile(
  path.join(scratch, 'package.json'),
  JSON.stringify({ type: 'commonjs' }),
);
const weights = path.join(scratch, 'fixture.weights');
await writeFile(weights, 'fixture-only');
await writeFile(
  path.join(tool, 'runtime-profile.json'),
  JSON.stringify({
    runtimeDirectory: 'runtime',
    weightsSha256: sha(Buffer.from('fixture-only')),
  }),
);
await writeFile(
  path.join(tool, 'worker.py'),
  `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{const job=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--job')+1]));
 const source=fs.readFileSync(job.source),meta=await sharp(source).metadata();
 if(sha(source)!==job.source_sha256||sha(fs.readFileSync(job.weights))!==job.weights_sha256)throw Error('identity');
 fs.mkdirSync(job.output);const mask=Buffer.alloc(meta.width*meta.height);mask[0]=255;
 const png=await sharp(mask,{raw:{width:meta.width,height:meta.height,channels:1}}).png().toBuffer();fs.writeFileSync(path.join(job.output,'map_part.png'),png);
 fs.writeFileSync(path.join(job.output,'receipt.json'),JSON.stringify({source_sha256:job.source_sha256,weights_sha256:job.weights_sha256,width:meta.width,height:meta.height,paid_calls:0,parts:[{id:'map_part',sha256:sha(png)}]}));})().catch(e=>{console.error(e);process.exitCode=1});`,
);
const previousPython = process.env.FORGE_STRUCTURE_PYTHON,
  previousWeights = process.env.FORGE_STRUCTURE_WEIGHTS;
try {
  process.env.FORGE_STRUCTURE_PYTHON = process.execPath;
  process.env.FORGE_STRUCTURE_WEIGHTS = weights;
  assert.equal((await mapSplitSamStatus(scratch)).available, true);
  const samResult = await segmentMapSelection(scratch, frozen, {
    type: 'sam',
    box: { x: 2, y: 1, width: 2, height: 2 },
    points: [{ x: 2, y: 1, include: true }],
    window: { x: 2, y: 1, width: 4, height: 4 },
  });
  assert.equal(samResult.mask[1 * width + 2], 1);
  assert.equal(
    samResult.mask.reduce((a, b) => a + b),
    1,
  );
  assert.equal(samResult.receipt.sourceMapHash, frozen.sourceHash);
  await assert.rejects(
    segmentMapSelection(scratch, frozen, {
      type: 'sam',
      box: { x: 2, y: 1, width: 2, height: 2 },
      window: { x: 3, y: 1, width: 4, height: 4 },
    }),
    { code: 'MAP_SPLIT_SAM_INVALID' },
  );
  assert.equal((await mapSplitSamStatus(scratch)).automaticAvailable, false);
  const automaticWorker = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{const job=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--job')+1]));const meta=await sharp(job.source).metadata();fs.mkdirSync(job.output);
const png=await sharp(Buffer.from([255,0,255,255]),{raw:{width:2,height:2,channels:1}}).png().toBuffer();fs.writeFileSync(path.join(job.output,'auto_001.png'),png);
fs.writeFileSync(path.join(job.output,'receipt.json'),JSON.stringify({operation:'map-automatic',source_sha256:sha(fs.readFileSync(job.source)),source_map_hash:job.source_map_hash,original_size:job.original_size,weights_sha256:job.weights_sha256,width:meta.width,height:meta.height,parameters:{...job.parameters,crop_n_layers:0},paid_calls:0,network_calls:0,seconds:0.01,native_pixel_accuracy:false,parts:[{id:'auto_001',file:'auto_001.png',sha256:sha(png),bbox:{x:1,y:1,width:2,height:2},area:3,predicted_iou:0.9,stability_score:0.99}]}));})().catch(e=>{console.error(e);process.exitCode=1});`;
  await writeFile(path.join(tool, 'map_auto.py'), automaticWorker);
  assert.equal((await mapSplitSamStatus(scratch)).automaticAvailable, true);
  const big = await create(
    64,
    48,
    Buffer.from(
      Array.from({ length: 64 * 48 }, () => [90, 80, 70, 255]).flat(),
    ),
  );
  const concurrency = await Promise.allSettled([
    automaticMapSegments(scratch, big),
    automaticMapSegments(scratch, big),
    segmentMapSelection(scratch, frozen, {
      type: 'sam',
      box: { x: 2, y: 1, width: 2, height: 2 },
    }),
    segmentMapSelection(scratch, frozen, {
      type: 'sam',
      box: { x: 2, y: 1, width: 2, height: 2 },
    }),
  ]);
  assert.equal(
    concurrency.filter((result) => result.status === 'fulfilled').length,
    1,
    'All SAM entry points share one atomic claim.',
  );
  assert.ok(
    concurrency
      .filter((result) => result.status === 'rejected')
      .every((result) => result.reason.code === 'MAP_SPLIT_SAM_BUSY'),
  );
  const predicted = await automaticMapSegments(scratch, big, {
    automatic: {
      maxEdge: 32,
      pointsPerSide: 8,
      pointsPerBatch: 4,
      maxCandidates: 10,
    },
  });
  assert.equal(predicted.receipt.overview.width, 32);
  assert.equal(predicted.receipt.overview.height, 24);
  assert.equal(predicted.receipt.nativePixelAccuracy, false);
  const exact = predicted.selections[0].selection;
  assert.deepEqual([exact.x, exact.y, exact.width, exact.height], [2, 2, 4, 4]);
  assert.equal(
    (await resolveMapSelection(big, exact)).mask.reduce((a, b) => a + b),
    12,
  );
  const automaticReceipts = [];
  const automatic = await coarseMapSpecs(big, {
    root: scratch,
    mode: 'auto',
    automatic: { maxEdge: 32, pointsPerSide: 8 },
    onReceipt: async (receipt) => automaticReceipts.push(receipt),
  });
  assert.equal(automatic.method, 'sam-automatic-overview');
  assert.equal(automatic.usage.localSamCalls, 1);
  assert.equal(automatic.usage.networkCalls, 0);
  assert.equal(automaticReceipts[0].kind, 'local-sam-automatic');
  assert.equal(automatic.specs.length, 1);
  assert(
    automatic.warnings.some((warning) =>
      warning.includes('不具有原生细节精度'),
    ),
  );
  const built = await buildSplitElements(big, automatic.specs);
  assert.equal(built.filter((element) => element.kind === 'object').length, 1);
  await assert.rejects(
    automaticMapSegments(scratch, big, { automatic: { pointsPerSide: 25 } }),
    { code: 'MAP_SPLIT_SAM_INVALID' },
  );
  await writeFile(
    path.join(tool, 'map_auto.py'),
    automaticWorker.replace(
      'weights_sha256:job.weights_sha256',
      "weights_sha256:'0'.repeat(64)",
    ),
  );
  await assert.rejects(automaticMapSegments(scratch, big), {
    code: 'MAP_SPLIT_SAM_INVALID',
  });
} finally {
  if (previousPython === undefined) delete process.env.FORGE_STRUCTURE_PYTHON;
  else process.env.FORGE_STRUCTURE_PYTHON = previousPython;
  if (previousWeights === undefined) delete process.env.FORGE_STRUCTURE_WEIGHTS;
  else process.env.FORGE_STRUCTURE_WEIGHTS = previousWeights;
}

// Fixed vision configuration and one-shot receipt transport. Every request is
// mocked before a fake credential is installed; no user data or real call.
const manifest = JSON.parse(
    await readFile(path.join(root, 'workbench', 'manifest.json'), 'utf8'),
  ),
  previousFetch = globalThis.fetch,
  previousKey = process.env.OPENAI_API_KEY,
  previousEndpoint = process.env.SCENE_EXPERT_OPENAI_URL;
let calls = 0,
  fail = false;
const receipts = [];
globalThis.fetch = async (endpoint, options) => {
  calls++;
  assert.equal(endpoint, 'http://127.0.0.1:9081/v1/responses');
  const body = JSON.parse(options.body);
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.equal(
    body.model,
    manifest.agentAssets.imageEditing.visualReviewer.model,
  );
  if (fail) throw Error('fixture disconnect');
  return Response.json({
    id: 'response_map_split_fixture',
    model: body.model,
    status: 'completed',
    usage: { input_tokens: 111, output_tokens: 50 },
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              objects: [
                {
                  id: 'red_fragment',
                  name: '红色目标',
                  kind: 'object',
                  reason: '图中可见红色片',
                  regions: [
                    {
                      box: { left: 125, top: 125, right: 625, bottom: 625 },
                      positivePoints: [{ x: 270, y: 270 }],
                      negativePoints: [],
                      role: 'art',
                      plane: 'back',
                    },
                  ],
                  collision: [],
                },
              ],
              warnings: [],
            }),
          },
        ],
      },
    ],
  });
};
try {
  process.env.OPENAI_API_KEY = 'fixture-only-map-split';
  process.env.SCENE_EXPERT_OPENAI_URL = 'http://127.0.0.1:9081/v1/responses';
  await assert.rejects(
    coarseMapSpecs(colorFrozen, { root: scratch, manifest, mode: 'vision' }),
    { code: 'MAP_SPLIT_INVALID' },
  );
  assert.equal(calls, 0);
  const options = {
    root: scratch,
    manifest,
    mode: 'vision',
    requestIdentity: 'fixture-request-1',
    onReceipt: async (value) => receipts.push(value),
    onLocated: async (plan) => {
      await writeFile(path.join(scratch, 'located.json'), JSON.stringify(plan));
    },
  };
  const service = mapSplitSettings(manifest);
  await assert.rejects(
    coarseMapSpecs(colorFrozen, {
      ...options,
      service: { ...service, endpoint: 'http://127.0.0.1:9082/' },
    }),
    { code: 'MAP_SPLIT_SERVICE_CHANGED' },
  );
  assert.equal(calls, 0);
  const vision = await coarseMapSpecs(colorFrozen, options);
  assert.equal(calls, 1);
  assert.equal(vision.usage.input_tokens, 111);
  assert.equal(receipts.length, 2);
  assert.equal(vision.receipt.responseId, 'response_map_split_fixture');
  assert.equal(vision.specs[0].parts[0].selection.type, 'rle');
  assert.equal(
    (
      await resolveMapSelection(colorFrozen, vision.specs[0].parts[0].selection)
    ).mask.reduce((a, b) => a + b),
    3,
  );
  await buildSplitElements(colorFrozen, vision.specs);
  await buildSplitElements(colorFrozen, vision.specs);
  assert.equal(calls, 1);
  const locatedPlan = JSON.parse(
    await readFile(path.join(scratch, 'located.json'), 'utf8'),
  );
  assert.ok(locatedPlan.specs[0].parts[0].selection.bounds);
  const recovered = await coarseMapSpecs(colorFrozen, {
    ...options,
    locatedPlan,
  });
  assert.deepEqual(recovered.specs, vision.specs);
  assert.equal(
    calls,
    1,
    'Recovery from durable localization never repeats the paid request.',
  );
  fail = true;
  await assert.rejects(
    coarseMapSpecs(colorFrozen, {
      ...options,
      requestIdentity: 'fixture-request-2',
    }),
    { code: 'SCENE_MODEL_OUTCOME_UNKNOWN' },
  );
  assert.equal(calls, 2);
} finally {
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousKey;
  if (previousEndpoint === undefined)
    delete process.env.SCENE_EXPERT_OPENAI_URL;
  else process.env.SCENE_EXPERT_OPENAI_URL = previousEndpoint;
}
console.log(
  'Map split pixels passed: real draw order/origin, exact ownership and holes, cross-card object parts, RLE/polygon/combine/auto, independent edge repair, honest local fallbacks, bounded local SAM wrapper, fixed vision snapshots and mocked one-shot receipts. No paid requests.',
);
