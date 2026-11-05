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
import { activeMapCollisions } from '../../features/scene-composer/render-model.mjs';
import {
  createScenePackage,
  readScenePackage,
} from '../../features/scene-composer/package.mjs';
import { buildSceneGodotPackage } from '../../features/scene-composer/godot-builder.mjs';
import { updateSplitSourceState } from '../../features/scene-composer/map-split-source.mjs';

const manifest = await loadManifest();
const post = (operation, input) =>
  agentRequest(manifest, operation, input, { documentAuthority: true });
const png =
  'data:image/png;base64,' +
  (
    await sharp({
      create: { width: 32, height: 24, channels: 4, background: '#334466' },
    })
      .png()
      .toBuffer()
  ).toString('base64');
for (const initiallyTransferred of [false, true]) {
  const scene = createScene('删除后的碰撞归属');
  replaceMap(scene, {
    name: 'fixture',
    origin: { x: -20, y: -10 },
    offset: { x: 5, y: 7 },
    source: 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
    warnings: [],
    layers: [
      {
        id: 'map_overall',
        name: 'map',
        source: png,
        width: 32,
        height: 24,
        included: true,
        hidden: false,
        locked: false,
      },
    ],
    collisions: [
      [
        { x: -18, y: -8 },
        { x: -10, y: -8 },
        { x: -10, y: -2 },
      ],
    ],
  });
  const documentId = scene.id;
  await createDocument(repositoryRoot, manifest, {
    documentId,
    kind: 'scene',
    commandId: 'create',
    content: scene,
  });
  const read = async () =>
    (await getDocument(repositoryRoot, manifest, { documentId })).document;
  const candidate = (
    await post('scene-split-prepare', {
      documentId,
      expectedRevision: 1,
      commandId: 'prepare',
      mode: 'local',
      specs: [
        {
          id: 'fixture_owner',
          name: '物件',
          kind: 'object',
          parts: [
            {
              id: 'art',
              role: 'art',
              plane: 'back',
              selection: { type: 'rect', x: 2, y: 2, width: 10, height: 10 },
            },
          ],
          collision: {
            polygons: [],
            mapIndices: initiallyTransferred ? [0] : [],
          },
        },
      ],
    })
  ).candidate;
  await post('scene-split-adopt', {
    documentId,
    expectedRevision: 1,
    commandId: 'adopt',
    candidateId: candidate.candidateId,
    candidateRevision: candidate.revision,
  });
  let saved = await read();
  const binding = {
    documentId,
    candidateId: candidate.candidateId,
    elementId: 'fixture_owner',
  };
  const custom = [[{ x: 1, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 8 }]];
  await post('scene-split-patch', {
    ...binding,
    expectedRevision: saved.revision,
    commandId: initiallyTransferred ? 'release' : 'late-transfer',
    changes: {
      collision: { enabled: true, mapIndices: initiallyTransferred ? [] : [0], polygons: custom },
    },
  });
  saved = await read();
  assert.deepEqual(saved.content.mapSplit.elements.find(element => element.id === binding.elementId).collision.polygons, custom);
  assert.deepEqual(
    saved.content.mapSplit.baseline.find(
      (element) => element.id === 'fixture_owner',
    ).collision.mapIndices,
    initiallyTransferred ? [0] : [],
    'Ownership changes do not rewrite the three-way original.',
  );
  assert.deepEqual(
    activeMapCollisions(saved.content).map((entry) => entry.index),
    initiallyTransferred ? [0] : [],
  );
  await post('scene-split-patch', {
    ...binding,
    expectedRevision: saved.revision,
    commandId: 'delete-owner',
    changes: { remove: true },
  });
  saved = await read();
  assert.deepEqual(saved.content.mapSplit.deletedMapCollisions, [
    { elementId: 'fixture_owner', mapIndices: initiallyTransferred ? [] : [0] },
  ]);
  assert.deepEqual(
    activeMapCollisions(saved.content).map((entry) => entry.index),
    initiallyTransferred ? [0] : [],
  );
  const roundTrip = await readScenePackage(
    await createScenePackage(saved.content),
  );
  assert.deepEqual(
    activeMapCollisions(roundTrip).map((entry) => entry.index),
    initiallyTransferred ? [0] : [],
  );
  const built = await buildSceneGodotPackage(saved.content, { repositoryRoot });
  const zip = await JSZip.loadAsync(built.bytes),
    engineScene = await zip.file(built.scenePath.slice(6)).async('string');
  assert.equal(
    engineScene.includes('parent="MapCollisions"'),
    initiallyTransferred,
  );
  if (!initiallyTransferred) {
    const changed = structuredClone(saved.content);
    changed.map.collisions[0][0].x++;
    updateSplitSourceState(saved.content, changed);
    assert.equal(
      changed.mapSplit.stale,
      true,
      'Source changes also invalidate ownership recorded for a deleted element.',
    );
    const original = saved.content;
    await saveDocument(repositoryRoot, manifest, { documentId, expectedRevision: saved.revision, commandId: 'replace-collision', content: changed });
    const undone = await saveDocument(repositoryRoot, manifest, { documentId, expectedRevision: saved.revision + 1, commandId: 'undo-replacement', content: original });
    assert.deepEqual(undone.document.content.mapSplit, original.mapSplit);
    assert.deepEqual(activeMapCollisions(undone.document.content), []);
    // An unchanged candidate ID alone must never activate the old collision on the replacement map.
    const rejectedSource = structuredClone(changed);
    rejectedSource.mapSplit.stale = false;
    const retired = await saveDocument(repositoryRoot, manifest, {
      documentId, expectedRevision: undone.document.revision, commandId: 'retire-again', content: changed,
    });
    const checked = await saveDocument(repositoryRoot, manifest, {
      documentId, expectedRevision: retired.document.revision, commandId: 'wrong-source', content: rejectedSource,
    });
    assert.equal(checked.document.content.mapSplit.stale, true);
    const restored = await saveDocument(repositoryRoot, manifest, {
      documentId, expectedRevision: checked.document.revision, commandId: 'restore-active', content: original,
    });

    const parts = [2, 12].map((x, i) => ({
      id: 'replacement_bridge', name: '桥', kind: 'object', x: 0, y: 0,
      parts: [{ id: 'span_' + i, selection: { type: 'rect', x, y: 0, width: 8, height: 8 } }],
      collision: {
        polygons: [[{ x, y: 0 }, { x: x + 5, y: 0 }, { x, y: 5 }]],
        mapIndices: i === 1 ? [0] : [],
      },
    }));
    const revision = await post('scene-split-revise', {
      documentId, candidateId: candidate.candidateId, commandId: 'assign-deleted-blocker',
      candidateRevision: candidate.revision, expectedRevision: restored.document.revision, specs: parts,
    });
    const bridge = revision.candidate.elements.find(element => element.id === 'replacement_bridge');
    assert.equal(bridge.parts.length, 2);
    assert.deepEqual(bridge.collision.mapIndices, [0]);
    assert.deepEqual(bridge.collision.polygons, parts.flatMap(part => part.collision.polygons));
    await post('scene-split-adopt', {
      documentId, expectedRevision: restored.document.revision, commandId: 'adopt-new-owner',
      candidateId: candidate.candidateId, candidateRevision: revision.candidate.revision,
    });
    const reassigned = (await read()).content;
    assert.deepEqual(reassigned.mapSplit.deletedMapCollisions, [{ elementId: binding.elementId, mapIndices: [] }]);
    assert.deepEqual(activeMapCollisions(reassigned), []);
  }
}
console.log(
  'Scene split collision ownership passed: late transfer/delete suppresses old blocking; release/delete restores map blocking; source and engine packages preserve both intents.',
);
