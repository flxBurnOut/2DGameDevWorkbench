import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import sharp from 'sharp';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import {
  createScene,
  replaceMap,
} from '../../features/scene-composer/model.mjs';
import {
  createDocument,
  getDocument,
  saveDocument,
} from '../../lib/workbench/editor-documents.mjs';
import { agentRequest } from '../../lib/workbench/agent-api.mjs';
import { mergeSplitRevision } from '../../lib/workbench/scene-split-merge.mjs';

const manifest = await loadManifest();
const scene = createScene('分层回归');
const documentId = scene.id;
const post = (op, input) =>
  agentRequest(manifest, op, input, { documentAuthority: true });
const read = async () =>
  (await getDocument(repositoryRoot, manifest, { documentId })).document;
const png = await sharp({
  create: { width: 32, height: 16, channels: 4, background: '#ac7038' },
})
  .png()
  .toBuffer();
replaceMap(scene, {
  name: 'test',
  origin: { x: -14, y: 0 },
  offset: { x: 9, y: -6 },
  layers: [
    {
      id: 'map_overall',
      name: '地图',
      source: 'data:image/png;base64,' + png.toString('base64'),
      width: 32,
      height: 16,
      hidden: false,
      locked: true,
      included: true,
    },
  ],
  source:
    'data:application/zip;base64,' +
    (await new JSZip().generateAsync({ type: 'base64' })),
  warnings: [],
  collisions: [
    [
      { x: -12, y: 2 },
      { x: -6, y: 2 },
      { x: -6, y: 8 },
    ],
  ],
});
await createDocument(repositoryRoot, manifest, {
  documentId,
  kind: 'scene',
  commandId: 'create',
  content: scene,
});
const selection = { type: 'rect', x: 2, y: 1, width: 8, height: 9 };
const specs = [
  {
    id: 'lamp',
    sourceKey: 'lamp-a',
    name: '灯',
    kind: 'object',
    parts: [{ id: 'art', role: 'art', plane: 'back', selection }],
    collision: { polygons: [], mapIndices: [0] },
  },
];
const initial = {
  documentId,
  expectedRevision: 1,
  commandId: 'prepare',
  specs,
};
const prepared = (await post('scene-split-prepare', initial)).candidate;
assert.equal(prepared.status, 'ready', JSON.stringify(prepared.error));
assert.equal(prepared.review, 'unverified');
assert.equal(
  prepared.elements.find((e) => e.id === 'lamp').collision.enabled,
  true,
);
assert.equal(prepared.origin.x, -5);
assert.equal((await post('scene-split-prepare', initial)).replayed, true);
await assert.rejects(post('scene-split-prepare', { ...initial, specs: [] }), {
  code: 'COMMAND_ID_REUSED',
});
const { candidateId } = prepared;
const version = { documentId, candidateId, candidateRevision: 1 };
const checked = (
  await post('scene-split-revise', {
    ...version,
    expectedRevision: 1,
    commandId: 'review-1',
    review: { elementIds: ['lamp'], note: '检查左灯' },
  })
).candidate;
assert.equal(checked.review, 'unverified');
assert.deepEqual(
  (await post('scene-split-get', { ...version, includeSpecs: true })).candidate
    .specs[0].parts[0].selection,
  selection,
);
const corrected = (
  await post('scene-split-revise', {
    ...version,
    candidateRevision: 2,
    expectedRevision: 1,
    commandId: 'review-2',
    review: { elementIds: ['split_surface'], note: '核对余图' },
  })
).candidate;
assert.equal(corrected.review, 'reviewed');
assert.equal(
  (await post('scene-split-get', { documentId })).candidates[0].candidateId,
  candidateId,
);
const view = await post('scene-split-inspect', {
  ...version,
  view: 'candidate',
});
const decoded = (buffer) => sharp(buffer).ensureAlpha().raw().toBuffer();
assert.deepEqual(
  await decoded(Buffer.from(view.images[0].data, 'base64')),
  await decoded(png),
);
const adopt = {
  ...version,
  candidateRevision: 3,
  expectedRevision: 1,
  commandId: 'adopt',
};
const saved = await post('scene-split-adopt', adopt);
assert.equal(saved.revision, 2);
assert.equal((await post('scene-split-adopt', adopt)).replayed, true);
const patch = {
  documentId,
  candidateId,
  elementId: 'lamp',
  expectedRevision: 2,
  changes: { x: 22 },
  commandId: 'move-lamp',
};
assert.equal((await post('scene-split-patch', patch)).revision, 3);
await assert.rejects(
  post('scene-split-patch', { ...patch, commandId: 'stale' }),
  { code: 'REVISION_CONFLICT' },
);
const target = {
  kind: 'scene-split-part',
  documentId,
  elementId: 'lamp',
  partId: 'art',
  window: { x: 2, y: 3, width: 3, height: 2 },
};
const listed = await post('image-inspect', {
  scope: { kind: 'scene-split-part', documentId },
  query: '灯',
});
assert.equal(listed.targets.length, 1);
const inspected = (await post('image-inspect', { target })).target;
const guard = {
  target,
  expectedRevision: inspected.revision,
  expectedSha256: inspected.sha256,
};
const region = await post('image-resolve', {
  ...guard,
  region: { type: 'all' },
});
const edit = await post('image-edit', {
  ...guard,
  regionRef: region.regionRef,
  operation: { type: 'erase' },
  commandId: 'erase-window',
});
assert.equal(edit.status, 'completed');
const apply = {
  editId: edit.edit.editId,
  candidateVersion: edit.candidateVersion,
  expectedRevision: guard.expectedRevision,
  expectedSha256: guard.expectedSha256,
  commandId: 'adopt-window',
};
await post('image-apply', apply);
const edited = await read();
assert.equal(edited.revision, 4);
const element = edited.content.mapSplit.elements.find((e) => e.id === 'lamp');
const baseline = edited.content.mapSplit.baseline.find((e) => e.id === 'lamp');
assert.equal(element.x, 22);
assert.equal(baseline.x, 2);
const bytes = await decoded(
  Buffer.from(element.parts[0].source.split(',')[1], 'base64'),
);
for (let y = 0; y < 9; y++)
  for (let x = 0; x < 8; x++)
    assert.equal(
      bytes[(y * 8 + x) * 4 + 3],
      x >= 2 && x < 5 && y >= 3 && y < 5 ? 0 : 255,
    );
assert.equal(
  edited.content.mapSplit.elements.find((e) => e.kind === 'surface').parts[0]
    .source,
  edited.content.mapSplit.baseline.find((e) => e.kind === 'surface').parts[0]
    .source,
);
// Old candidates must not supersede a newer saved scene or silently transfer to a different object.
await assert.rejects(
  post('scene-split-adopt', {
    ...adopt,
    expectedRevision: 4,
    commandId: 'old-candidate',
  }),
  { code: 'REVISION_CONFLICT' },
);
const newer = structuredClone(edited.content.map);
replaceMap(edited.content, newer);
await saveDocument(repositoryRoot, manifest, {
  documentId,
  expectedRevision: 4,
  commandId: 'replace-map',
  content: edited.content,
});
const stale = await post('image-inspect', { target });
assert.equal(stale.target.editable, false);
const threeWay = structuredClone(edited.content.mapSplit);
const incoming = {
  ...threeWay,
  elements: structuredClone(threeWay.baseline),
  baseline: structuredClone(threeWay.baseline),
};
const image = incoming.elements.find((el) => el.id === 'lamp').parts[0],
  original = await decoded(Buffer.from(image.source.split(',')[1], 'base64'));
const asUrl = async (raw) =>
  'data:image/png;base64,' +
  (
    await sharp(raw, {
      raw: { width: image.width, height: image.height, channels: 4 },
    })
      .png()
      .toBuffer()
  ).toString('base64');
original.set([30, 40, 50, 255], 0);
image.source = await asUrl(original);
const separate = await mergeSplitRevision(threeWay, incoming);
assert.equal(separate.conflicts.length, 0);
const separatePixels = await decoded(
  Buffer.from(
    separate.elements
      .find((el) => el.id === 'lamp')
      .parts[0].source.split(',')[1],
    'base64',
  ),
);
assert.deepEqual([...separatePixels.subarray(0, 4)], [30, 40, 50, 255]);
assert.equal(separatePixels[(3 * 8 + 2) * 4 + 3], 0);
original.set([150, 100, 50, 255], (3 * 8 + 2) * 4);
image.source = await asUrl(original);
const disputed = await mergeSplitRevision(threeWay, incoming);
assert.equal(disputed.conflicts.length, 1);
const decisions = [
  { conflictId: disputed.conflicts[0].id, choice: 'incoming' },
];
const resolved = await mergeSplitRevision(threeWay, incoming, {
  resolutions: decisions,
  priorConflicts: disputed.conflicts,
});
assert.equal(resolved.conflicts[0].resolution, 'incoming');
const resolvedPixels = await decoded(
  Buffer.from(
    resolved.elements
      .find((el) => el.id === 'lamp')
      .parts[0].source.split(',')[1],
    'base64',
  ),
);
assert.deepEqual(
  [...resolvedPixels.subarray((3 * 8 + 2) * 4, (3 * 8 + 3) * 4)],
  [150, 100, 50, 255],
);
assert.equal(resolvedPixels[(3 * 8 + 3) * 4 + 3], 0); // neighbouring local retouch still migrated
original.set([11, 22, 33, 255], (3 * 8 + 2) * 4);
image.source = await asUrl(original);
const changedEvidence = await mergeSplitRevision(threeWay, incoming, {
  resolutions: decisions,
  priorConflicts: disputed.conflicts,
});
assert.equal(changedEvidence.conflicts[0].resolution, undefined);
// The command identity exists before a visual provider receives the request.
// Polling, a second client and an unknown response all keep that same intent.
const originalFetch = globalThis.fetch,
  originalKey = process.env.OPENAI_API_KEY,
  originalUrl = process.env.SCENE_EXPERT_OPENAI_URL;
let providerCalls = 0,
  disconnect;
globalThis.fetch = (url) => {
  assert.equal(url, 'http://127.0.0.1:9085/v1/responses');
  providerCalls++;
  return new Promise((_resolve, reject) => {
    disconnect = () => reject(new Error('simulated lost response'));
  });
};
try {
  process.env.OPENAI_API_KEY = 'scene-split-fixture';
  process.env.SCENE_EXPERT_OPENAI_URL = 'http://127.0.0.1:9085/v1/responses';
  const job = {
    documentId,
    expectedRevision: (await read()).revision,
    commandId: 'once-only-vision',
    mode: 'vision',
  };
  const started = await post('scene-split-prepare', job);
  assert.equal(started.candidate.status, 'running');
  for (let i = 0; i < 100 && !disconnect; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(providerCalls, 1);
  assert.equal(
    (await post('scene-split-prepare', job)).candidate.candidateId,
    started.candidate.candidateId,
  );
  disconnect();
  let last;
  for (let i = 0; i < 100; i++) {
    last = (
      await post('scene-split-get', {
        documentId,
        candidateId: started.candidate.candidateId,
      })
    ).candidate;
    if (last.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(last.status, 'attention_required');
  assert.equal(
    (await post('scene-split-prepare', job)).candidate.status,
    'attention_required',
  );
  assert.equal(providerCalls, 1);
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalUrl === undefined) delete process.env.SCENE_EXPERT_OPENAI_URL;
  else process.env.SCENE_EXPERT_OPENAI_URL = originalUrl;
}
// Recovering an older successful adoption must not relabel the candidate as
// adopted at its old version after a newer revision was accepted.
const rebased = (
  await post('scene-split-revise', {
    documentId,
    candidateId,
    candidateRevision: 3,
    expectedRevision: 5,
    commandId: 'rebase-same-map',
  })
).candidate;
const latest = await post('scene-split-adopt', {
  documentId,
  candidateId,
  candidateRevision: rebased.revision,
  expectedRevision: 5,
  commandId: 'adopt-rebased',
});
assert.equal(
  (await post('scene-split-adopt', adopt)).currentRevision,
  latest.revision,
);
assert.equal(
  (await post('scene-split-get', { documentId, candidateId })).candidate
    .adoption.revision,
  latest.revision,
);
// The flattened map still has the same pixels, but index 0 now denotes a
// different old-map blocker. Reusing the old ownership proof would move it.
const changedMap = await read();
changedMap.content.map.collisions[0][0].x += 1;
await saveDocument(repositoryRoot, manifest, {
  documentId,
  expectedRevision: changedMap.revision,
  content: changedMap.content,
  commandId: 'change-confirmed-polygon',
});
await assert.rejects(
  post('scene-split-revise', {
    documentId,
    candidateId,
    candidateRevision: rebased.revision,
    expectedRevision: latest.revision + 1,
    commandId: 'repoint-transfer',
  }),
  { code: 'SPLIT_SOURCE_CHANGED' },
);
await import('./collision-ownership.mjs');
console.log(
  'Scene split service passed: shared candidate recovery, exact previews, review versions, adoption, collision transfer, stable instance edit, scoped texture windows and stale-map guards.',
);
