import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  requestSceneSplit,
  parseSplitSpecDraft,
  splitPreviewUrl,
  splitCollisionTransfer,
  watchSceneSplit,
} from '../../components/scene-composer/scene-split-client.mjs';
import {
  splitCollisionTransfer as sharedCollisionTransfer,
  removeMapSplitElements,
} from '../../features/scene-composer/map-split.mjs';
import { activeMapCollisions } from '../../features/scene-composer/render-model.mjs';

const specs = [
  {
    id: 'tree',
    name: '跨缝树',
    kind: 'object',
    parts: [
      {
        id: 'front',
        role: 'art',
        plane: 'front',
        selection: {
          type: 'rle',
          x: 1020,
          y: 10,
          width: 8,
          height: 1,
          counts: [0, 3, 2, 3],
        },
      },
      {
        id: 'back',
        role: 'effect',
        plane: 'back',
        selection: {
          type: 'combine',
          operation: 'subtract',
          selections: [
            {
              type: 'polygon',
              points: [
                { x: 10, y: 10 },
                { x: 30, y: 10 },
                { x: 15, y: 30 },
              ],
            },
            { type: 'rect', x: 12, y: 12, width: 2, height: 3 },
          ],
        },
        edge: { feather: 1 },
      },
    ],
  },
];
assert.deepEqual(parseSplitSpecDraft(JSON.stringify(specs)), specs);
assert.deepEqual(parseSplitSpecDraft(JSON.stringify(specs[0])), specs);
assert.throws(() => parseSplitSpecDraft('{}'), /id/);
assert.throws(() => parseSplitSpecDraft('[]'), /非空/);
assert.equal(
  splitPreviewUrl({ mimeType: 'image/png', data: 'aGVsbG8=' }),
  'data:image/png;base64,aGVsbG8=',
);
assert.throws(
  () => splitPreviewUrl({ mimeType: 'text/html', data: 'AAAA' }),
  /PNG/,
);
const collisionScene = {
  map: {
    origin: { x: -50, y: 20 },
    offset: { x: 7, y: -4 },
    collisions: [
      [
        { x: -40, y: 30 },
        { x: -30, y: 30 },
        { x: -30, y: 40 },
      ],
    ],
  },
  order: ['tree', 'lamp'],
  mapSplit: {
    stale: false,
    tombstones: [],
    baseline: [],
    elements: [
      {
        id: 'tree',
        x: 5,
        y: 6,
        locked: false,
        collision: { mapIndices: [], polygons: [] },
      },
      { id: 'lamp', collision: { mapIndices: [] } },
    ],
  },
};
const transferred = splitCollisionTransfer(collisionScene, 'tree', [0]);
assert.equal(
  splitCollisionTransfer,
  sharedCollisionTransfer,
  'Browser and service use the exact same transfer function.',
);
assert.deepEqual(transferred, {
  enabled: true,
  mapIndices: [0],
  polygons: [
    [
      { x: 5, y: 4 },
      { x: 15, y: 4 },
      { x: 15, y: 14 },
    ],
  ],
});
assert.equal(
  collisionScene.map.origin.x +
    collisionScene.map.offset.x +
    collisionScene.mapSplit.elements[0].x +
    transferred.polygons[0][0].x,
  collisionScene.map.collisions[0][0].x + collisionScene.map.offset.x,
);
assert.deepEqual(splitCollisionTransfer(collisionScene, 'tree', []), {
  enabled: false,
  polygons: [],
  mapIndices: [],
});
{
  const timers = [],
    delays = [],
    failures = [];
  let reads = 0;
  const stop = watchSceneSplit(
    async () => {
      reads++;
      if (reads <= 2) throw Error('temporary read failure');
      return reads === 3 ? 'running' : 'ready';
    },
    (error, stopped) => failures.push([error.message, stopped]),
    {
      schedule: (tick, delay) => {
        timers.push(tick);
        delays.push(delay);
        return tick;
      },
      cancel: () => {},
    },
  );
  while (timers.length) {
    timers.shift()();
    await new Promise(setImmediate);
  }
  stop();
  assert.equal(reads, 4);
  assert.deepEqual(delays, [1800, 3600, 7200, 1800]);
  assert.equal(failures.length, 2);
  assert.ok(failures.every(([, stopped]) => !stopped));
}
collisionScene.mapSplit.elements[1].collision.mapIndices = [0];
assert.throws(
  () => splitCollisionTransfer(collisionScene, 'tree', [0]),
  /其他物件/,
);
assert.equal(
  collisionScene.map.collisions[0][0].x,
  -40,
  'transfer never edits or reindexes the source map polygons',
);
collisionScene.mapSplit.elements[1].collision.mapIndices = [];
collisionScene.mapSplit.elements[0].collision = transferred;
removeMapSplitElements(collisionScene, ['tree']);
assert.deepEqual(
  activeMapCollisions(collisionScene),
  [],
  'Late browser transfer stays disabled at the deleted owner’s original map position.',
);
assert.throws(
  () => splitCollisionTransfer(collisionScene, 'lamp', [0]),
  /删除物件/,
);
const intent = Object.freeze({
  documentId: 'fixture',
  expectedRevision: 7,
  commandId: 'fixture-original-command',
  mode: 'local',
});
const sent = [];
let lost = true;
const fetcher = async (url, request) => {
  sent.push({ url, input: JSON.parse(request.body) });
  if (lost) throw new Error('fixture response lost');
  return Response.json({
    candidate: {
      candidateId: 'same-candidate',
      revision: 1,
      sourceRevision: 7,
      status: 'ready',
      review: 'unverified',
    },
    replayed: true,
  });
};
await assert.rejects(requestSceneSplit('prepare', intent, fetcher), /lost/);
assert.equal(sent.length, 1, 'a lost response never starts a blind retry');
lost = false;
const resumed = await requestSceneSplit(
  'prepare',
  JSON.parse(JSON.stringify(intent)),
  fetcher,
);
assert.equal(resumed.candidate.review, 'unverified');
assert.equal(resumed.replayed, true);
assert.deepEqual(
  sent[0],
  sent[1],
  'explicit recovery sends the original immutable command and source revision',
);
const inspect = {
  documentId: 'fixture',
  candidateId: 'same-candidate',
  candidateRevision: 1,
  view: 'part',
  elementId: 'tree',
  partId: 'front',
  crop: { x: 1020, y: 10, width: 8, height: 1 },
  background: 'magenta',
};
await requestSceneSplit('inspect', inspect, fetcher);
assert.deepEqual(sent[2], {
  url: '/api/workbench/scene-split/inspect',
  input: inspect,
});
await assert.rejects(
  requestSceneSplit(
    'adopt',
    { ...intent, candidateId: 'same-candidate', candidateRevision: 1 },
    async () =>
      Response.json(
        { error: 'conflicting saved scene', code: 'REVISION_CONFLICT' },
        { status: 409 },
      ),
  ),
  { code: 'REVISION_CONFLICT', status: 409 },
);
// Protect the real UI entry points: shared saved-snapshot guards and the common
// front/back renderer must stay wired to these transport/evidence contracts.
const composer = await readFile(
  new URL(
    '../../components/scene-composer/scene-composer.tsx',
    import.meta.url,
  ),
  'utf8',
);
const canvas = await readFile(
  new URL('../../components/scene-composer/scene-canvas.tsx', import.meta.url),
  'utf8',
);
const panel = await readFile(
  new URL(
    '../../components/scene-composer/scene-split-panel.tsx',
    import.meta.url,
  ),
  'utf8',
);
assert.match(composer, /SceneSplitPanel document=\{splitWindow.document\}/);
assert.match(composer, /doc\.shared\.acceptAdopted\(document, guard\)/);
assert.match(composer, /kind: 'scene-split-part'/);
assert.match(composer, /removeMapSplitElements\(s, removed\)/);
assert.match(composer, /mapSplitCollisionOwner\(scene, index\)/);
assert.match(canvas, /sceneDisplayOrder\(scene/);
assert.match(canvas, /activeMapCollisions\(scene\)/);
assert.match(
  panel,
  /candidate\.adoption\.candidateRevision === candidate\.revision/,
);
assert.match(panel, /view: 'conflict',\s+conflictId: id,\s+side,/);
assert.match(panel, /await saveWorkspaceDraft\(pendingKey, intent, \[\]\)/);
console.log(
  'Map split frontend passed: exact mask draft preservation, safe PNG evidence, one-shot transport and original-command recovery, versioned crop/part previews, conflict feedback, saved-scene adoption and shared renderer wiring. Browser layout is verified separately.',
);
