import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createScene, addMaterial, addInstance, replaceMap } from '../../features/scene-composer/model.mjs';
import { createProject, createObject } from '../../features/interactable-editor/contract.mjs';
import { createScenePackage, readScenePackage } from '../../features/scene-composer/package.mjs';
import { mapProjectFixture } from '../helpers/map-project.mjs';
import { splitFixture } from '../scene-composer/map-split-fixture.mjs';
import { createMapProjectPackage } from '../../features/map-stitcher/project-package.mjs';
import { createDocument, getDocument, saveDocument, applyDocumentCommands, documentRequest } from '../../lib/workbench/editor-documents.mjs';
import { inspectSceneImageSource, replaceSceneImageSource } from '../../lib/workbench/image-edit-scene-sources.mjs';
import { inspectMapSource } from '../../lib/workbench/scene-workflow-map.mjs';
import { loadManifest, repositoryRoot as root } from '../../lib/workbench/runtime.mjs';
import { createHash } from 'node:crypto';

const manifest = await loadManifest();
assert.ok(manifest.workspace.documentDirectory.includes(process.env.WORKBENCH_TEST_RUN));
const data = (bytes, mime) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#5d8d5d' } }).png().toBuffer();
const { draft } = await mapProjectFixture(png, 'map:scene-boundaries');
draft.pending = [];
draft.snapshot.shapes = [];
Object.assign(draft.snapshot.tiles[0], { x: 0, y: 0, w: 1, h: 1, feather: { top: 0, right: 0, bottom: 0, left: 0 } });
draft.snapshot.imageLocks = Object.fromEntries(Object.keys(draft.snapshot.tiles[0].images).map(key => [key, false]));
const source = data(await createMapProjectPackage(draft), 'application/zip');
const scene = createScene('Collision overrides');
scene.id = 'scene-collision-boundaries';
replaceMap(scene, { name: 'Map', origin: { x: 0, y: 0 }, offset: { x: 7, y: 9 }, source, warnings: [], collisions: [],
  layers: [{ id: 'map_overall', name: 'Map', source: data(png, 'image/png'), width: 16, height: 16, locked: false, hidden: false, included: true }] });
const initial = await createDocument(root, manifest, { kind: 'scene', content: scene, commandId: 'collision-create' });
const collisions = [[{ x: 0, y: 12 }, { x: 16, y: 12 }, { x: 16, y: 16 }, { x: 0, y: 16 }]];
const request = { documentId: scene.id, expectedRevision: 1, commandId: 'collision-edit', commands: [{ type: 'set-map-collisions', collisions }] };
const edited = await applyDocumentCommands(root, manifest, request);
assert.deepEqual(edited.document.content.map.collisionOverride, { sourceCollisions: [] });
assert.deepEqual(edited.document.content.map.collisions, collisions);
assert.equal(edited.document.content.map.source, source);
assert.equal((await inspectSceneImageSource(root, edited.document.content, 'map_overall')).editable, true);
assert.equal((await inspectMapSource(root, edited.document.content.map)).canExtend, true);
assert.deepEqual((await getDocument(root, manifest, { documentId: scene.id, revision: 1 })).document, initial.document);
assert.equal((await applyDocumentCommands(root, manifest, request)).replayed, true);
await assert.rejects(() => applyDocumentCommands(root, manifest, { ...request, commandId: 'collision-stale' }), { code: 'REVISION_CONFLICT' });
await assert.rejects(() => applyDocumentCommands(root, manifest, { ...request, commands: [{ type: 'set-map-collisions', collisions: [] }] }), { code: 'COMMAND_ID_REUSED' });

const candidateBytes = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#a8987b' } }).png().toBuffer();
const candidate = { bytes: candidateBytes, taskId: 'collision-image-candidate', sha256: createHash('sha256').update(candidateBytes).digest('hex'), width: 16, height: 16, mimeType: 'image/png' };
const imageEdited = await replaceSceneImageSource(root, edited.document.content, 'map_overall', candidate);
assert.deepEqual(imageEdited.map.collisions, collisions);
assert.deepEqual(imageEdited.map.collisionOverride, edited.document.content.map.collisionOverride);
assert.deepEqual((await readScenePackage(await createScenePackage(imageEdited))).map, imageEdited.map);
const wrongBaseline = structuredClone(imageEdited);
wrongBaseline.map.collisionOverride.sourceCollisions = collisions;
assert.equal((await inspectSceneImageSource(root, wrongBaseline, 'map_overall')).editable, false);
assert.equal((await inspectMapSource(root, wrongBaseline.map)).canExtend, false);
const wrongPixels = structuredClone(edited.document.content);
wrongPixels.map.layers[0].source = data(candidateBytes, 'image/png');
assert.equal((await inspectSceneImageSource(root, wrongPixels, 'map_overall')).editable, false);

// Full browser/Agent snapshots use the same collision baseline, including undo.
const snapshot = structuredClone(edited.document.content);
snapshot.map.collisions[0][0].y = 10;
const saved = await saveDocument(root, manifest, { documentId: scene.id, expectedRevision: 2, commandId: 'collision-snapshot', content: snapshot });
assert.deepEqual(saved.document.content.map.collisionOverride, { sourceCollisions: [] });
assert.equal((await inspectMapSource(root, saved.document.content.map)).canExtend, true);
const restored = await saveDocument(root, manifest, { documentId: scene.id, expectedRevision: 3, commandId: 'collision-undo', content: initial.document.content });
assert.equal(restored.document.content.map.collisionOverride, undefined);

// A transaction that replaces the map then edits collisions uses the NEW map's baseline.
const newMap = structuredClone(scene.map);
newMap.name = 'Replacement';
const replacementSourceCollisions = [[{ x: 1, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 7 }]];
const replacementDraft = structuredClone(draft);
replacementDraft.id = 'replacement-map';
replacementDraft.snapshot.shapes = [{ id: 'replacement-region', tileKey: '0,0', mapLayer: 'overall', layer: 'collision', mode: 'polygon', points: replacementSourceCollisions[0] }];
newMap.source = data(await createMapProjectPackage(replacementDraft), 'application/zip');
newMap.collisions = replacementSourceCollisions;
const replaced = await applyDocumentCommands(root, manifest, { documentId: scene.id, expectedRevision: 4, commandId: 'collision-replace', commands: [
  { type: 'replace-map', map: newMap }, { type: 'set-map-collisions', collisions },
] });
assert.deepEqual(replaced.document.content.map.collisionOverride, { sourceCollisions: replacementSourceCollisions });
assert.equal((await inspectMapSource(root, replaced.document.content.map)).canExtend, true);
assert.equal((await inspectSceneImageSource(root, replaced.document.content, 'map_overall')).editable, true);

const lockedScene = createScene('Locked edits');
lockedScene.id = 'scene-lock-boundaries';
const project = createProject(); project.objects = [createObject('inspect')];
const material = addMaterial(lockedScene, project, project.objects[0].definitionId, 'material');
const instance = addInstance(lockedScene, material.id, 0, 0, 'locked'); instance.locked = true;
await createDocument(root, manifest, { kind: 'scene', content: lockedScene, commandId: 'lock-create' });
const agentSave = (content, commandId) => documentRequest(root, manifest, 'document-save', { documentId: lockedScene.id, expectedRevision: 1, commandId, content }, { agent: true });
await assert.rejects(() => applyDocumentCommands(root, manifest, { documentId: lockedScene.id, expectedRevision: 1, commandId: 'lock-order-command', commands: [{ type: 'reorder', ids: ['locked'], action: 'front' }] }), { code: 'INVALID_COMMAND' });
const reordered = structuredClone(lockedScene); reordered.order.reverse();
await assert.rejects(() => agentSave(reordered, 'lock-order-snapshot'), { code: 'LOCKED_NODE' });
const unlockedAndMoved = structuredClone(lockedScene); unlockedAndMoved.instances[0].locked = false; unlockedAndMoved.instances[0].x++;
await assert.rejects(() => agentSave(unlockedAndMoved, 'lock-unlock-and-move'), { code: 'LOCKED_NODE' });
const replacement = structuredClone(project); replacement.objects[0].content.prompt = 'Changed artwork behavior';
await assert.rejects(() => applyDocumentCommands(root, manifest, { documentId: lockedScene.id, expectedRevision: 1, commandId: 'lock-material-command', commands: [{ type: 'replace-material', materialId: 'material', project: replacement, definitionId: replacement.objects[0].definitionId }] }), { code: 'LOCKED_NODE' });
const replacedMaterial = structuredClone(lockedScene); replacedMaterial.materials[0].project = replacement;
await assert.rejects(() => agentSave(replacedMaterial, 'lock-material-snapshot'), { code: 'LOCKED_NODE' });
assert.equal((await getDocument(root, manifest, { documentId: lockedScene.id })).document.revision, 1);
const unlock = { documentId: lockedScene.id, expectedRevision: 1, commandId: 'lock-unlock', commands: [{ type: 'set-node-flags', ids: ['locked'], locked: false }] };
await applyDocumentCommands(root, manifest, unlock);
assert.equal((await applyDocumentCommands(root, manifest, unlock)).replayed, true);
const order = { documentId: lockedScene.id, expectedRevision: 2, commandId: 'lock-now-order', commands: [{ type: 'reorder', ids: ['locked'], action: 'front' }] };
assert.deepEqual((await applyDocumentCommands(root, manifest, order)).document.content.order, ['locked', 'actor']);
assert.equal((await applyDocumentCommands(root, manifest, order)).replayed, true);
await assert.rejects(() => applyDocumentCommands(root, manifest, { ...order, commandId: 'lock-stale' }), { code: 'REVISION_CONFLICT' });

// Locked map layers share the same ordering rule; explicit edits to other nodes
// and replacing a map keep their existing command semantics.
const layerScene = structuredClone(scene); layerScene.id = 'scene-layer-lock-boundaries';
layerScene.map.layers[0].locked = true;
await createDocument(root, manifest, { kind: 'scene', content: layerScene, commandId: 'layer-lock-create' });
const layerReordered = structuredClone(layerScene); layerReordered.order.reverse();
await assert.rejects(() => documentRequest(root, manifest, 'document-save', {
  documentId: layerScene.id, expectedRevision: 1, commandId: 'layer-order-snapshot', content: layerReordered,
}, { agent: true }), { code: 'LOCKED_NODE' });
await assert.rejects(() => applyDocumentCommands(root, manifest, {
  documentId: layerScene.id, expectedRevision: 1, commandId: 'layer-order-command', commands: [{ type: 'reorder', ids: ['map_overall'], action: 'front' }],
}), { code: 'INVALID_COMMAND' });
const actorMoved = await applyDocumentCommands(root, manifest, {
  documentId: layerScene.id, expectedRevision: 1, commandId: 'actor-order-command', commands: [{ type: 'reorder', ids: ['actor'], action: 'back' }],
});
assert.deepEqual(actorMoved.document.content.order, layerReordered.order);
const mapReplaced = await applyDocumentCommands(root, manifest, {
  documentId: layerScene.id, expectedRevision: 2, commandId: 'replace-locked-map', commands: [{ type: 'replace-map', map: newMap }],
});
assert.equal(mapReplaced.document.content.map.name, 'Replacement');

const splitScene = await splitFixture(); splitScene.id = 'scene-split-lock-boundaries';
const lockedElement = splitScene.mapSplit.elements.find(element => element.id === 'split_tree');
lockedElement.locked = true;
await createDocument(root, manifest, { kind: 'scene', content: splitScene, commandId: 'split-lock-create' });
const splitReordered = structuredClone(splitScene); splitReordered.order.reverse();
await assert.rejects(() => documentRequest(root, manifest, 'document-save', {
  documentId: splitScene.id, expectedRevision: 1, commandId: 'split-order-snapshot', content: splitReordered,
}, { agent: true }), { code: 'LOCKED_NODE' });
await assert.rejects(() => applyDocumentCommands(root, manifest, {
  documentId: splitScene.id, expectedRevision: 1, commandId: 'split-order-command', commands: [{ type: 'reorder', ids: [lockedElement.id], action: 'front' }],
}), { code: 'INVALID_COMMAND' });
const hidden = await applyDocumentCommands(root, manifest, {
  documentId: splitScene.id, expectedRevision: 1, commandId: 'split-flags-command', commands: [{ type: 'set-node-flags', ids: [lockedElement.id], hidden: true }],
});
const shown = structuredClone(hidden.document.content);
shown.mapSplit.elements.find(element => element.id === lockedElement.id).hidden = false;
const flagsSaved = await documentRequest(root, manifest, 'document-save', {
  documentId: splitScene.id, expectedRevision: 2, commandId: 'split-flags-snapshot', content: shown,
}, { agent: true });
assert.equal(flagsSaved.document.content.mapSplit.elements.find(element => element.id === lockedElement.id).locked, true);

// Removing a source collision must retire existing split indices BEFORE final
// validation, just as the typed collision command does.
const emptied = structuredClone(flagsSaved.document.content); emptied.map.collisions = [];
const retired = await documentRequest(root, manifest, 'document-save', {
  documentId: splitScene.id, expectedRevision: 3, commandId: 'split-collision-snapshot', content: emptied,
}, { agent: true });
assert.equal(retired.document.content.mapSplit.stale, true);
assert.deepEqual(retired.document.content.map.collisionOverride, { sourceCollisions: splitScene.map.collisions });
const typedSplit = structuredClone(flagsSaved.document.content); typedSplit.id = 'scene-split-collision-command';
await createDocument(root, manifest, { kind: 'scene', content: typedSplit, commandId: 'split-collision-create' });
const retiredByCommand = await applyDocumentCommands(root, manifest, {
  documentId: typedSplit.id, expectedRevision: 1, commandId: 'split-collision-command', commands: [{ type: 'set-map-collisions', collisions: [] }],
});
assert.deepEqual(retired.document.content.map, retiredByCommand.document.content.map);
assert.deepEqual(retired.document.content.mapSplit, retiredByCommand.document.content.mapSplit);
console.log('Scene boundaries passed: collision overrides, image/source checks, portable round-trip, immutable versions, lock parity, CAS and command replay.');
