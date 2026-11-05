import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { createProject } from '../../features/interactable-editor/contract.mjs';
import {
  createScene,
  validateScene,
  replaceMap,
  reorder,
  addMaterial,
  addInstance,
} from '../../features/scene-composer/model.mjs';
import {
  installMapSplit,
  mergeMapSplit,
  validateMapSplit,
  removeMapSplitElements,
  splitCollisionTransfer,
  mapSplitCollisionOwner,
} from '../../features/scene-composer/map-split.mjs';
import {
  activeMapCollisions,
  sceneDisplayOrder,
  mapSplitElementOrigin,
} from '../../features/scene-composer/render-model.mjs';
import {
  createScenePackage,
  readScenePackage,
} from '../../features/scene-composer/package.mjs';
import { buildSceneGodotPackage } from '../../features/scene-composer/godot-builder.mjs';
import { prepareGodotPackage } from '../../features/godot-export/package.mjs';
import { applySceneCommands } from '../../lib/workbench/editor-commands.mjs';
import { observeScene } from '../../lib/workbench/scene-observation.mjs';
import { image, element, split, splitFixture } from './map-split-fixture.mjs';

const tests = [];
const test = (name, run) => tests.push([name, run]);
const red = await image(12, 24, '#ff0000');
const blue = await image(12, 24, '#0000ff');
const green = await image(12, 24, '#00ff00');
const makeOld = () =>
  split([element('lamp', red, { sourceKey: 'lamp-source' })]);
const incoming = (options = {}) =>
  split(
    [
      element('new_lamp', red, {
        sourceKey: 'lamp-source',
        x: 160,
        ...options,
      }),
    ],
    { candidateId: 'new_split', sourceHash: '2'.repeat(64) },
  );

test('legacy scene remains byte-equivalent after validation and source round trip', async () => {
  const scene = createScene();
  assert.equal(Object.hasOwn(validateScene(scene), 'mapSplit'), false);
  assert.deepEqual(
    await readScenePackage(await createScenePackage(scene)),
    scene,
  );
});
test('scenery-only delivery needs no interaction runtime and keeps its entry scene', async () => {
  const scene = await splitFixture();
  const built = await buildSceneGodotPackage(scene, { repositoryRoot: process.cwd() });
  const { manifest } = await prepareGodotPackage(built.bytes);
  assert.equal(manifest.runtime, null);
  assert.equal(manifest.details.runtimeIncludedInScene, false);
  assert.deepEqual(manifest.entryScenes, [built.scenePath]);
});
test('editor and typed node ordering share locks and the player plane', async () => {
  const scene = await splitFixture();
  const tree = scene.mapSplit.elements.find(element => element.id === 'split_tree');
  const command = { type: 'reorder', ids: [tree.id], action: 'before', target: 'actor' };
  tree.locked = true;
  assert.throws(() => reorder(scene, command.ids, 'back'), /解锁/);
  assert.throws(() => applySceneCommands(scene, [command]), /locked/);
  tree.locked = false;
  const { content } = applySceneCommands(scene, [command]);
  reorder(scene, command.ids, command.action, command.target);
  assert.deepEqual(content.order, scene.order);
  assert.ok(tree.parts.every(part => part.plane === 'front'));
  assert.ok(content.mapSplit.elements.find(element => element.id === tree.id).parts.every(part => part.plane === 'front'));
  assert.throws(() => applySceneCommands(scene, [{ type: 'move-map', x: 100, y: 300 }]), /解锁/);
  scene.map.layers[0].locked = false;
  assert.deepEqual(applySceneCommands(scene, [{ type: 'move-map', x: 100, y: 300 }]).content.map.offset, { x: 100, y: 300 });
});
test('ordinary map-only exports preserve the established InteractionRuntime node and resources', async () => {
  const scene = await splitFixture();
  delete scene.mapSplit;
  scene.order = ['actor', 'map_overall'];
  const built = await buildSceneGodotPackage(scene, {
    repositoryRoot: process.cwd(),
  });
  const zip = await JSZip.loadAsync(built.bytes);
  assert.match(
    await zip.file(built.scenePath.slice(6)).async('string'),
    /\[node name="InteractionRuntime" parent="\." instance=ExtResource\("runtime"\)\]/,
  );
  assert.ok(
    zip.file(
      'addons/workbench_interaction/runtime/v1/interaction_runtime_2d.tscn',
    ),
  );
});
test('embedded PNG and mask dimensions, IDs, collision indices and JSON snapshots are guarded', () => {
  const initial = makeOld();
  assert.deepEqual(validateMapSplit(initial), initial);
  for (const source of [
    'https://example.com/lamp.png',
    '../private.png',
    'media/0.bin',
    'data:image/png;base64,YmFk',
  ]) {
    const bad = structuredClone(initial);
    bad.elements[0].parts[0].source = source;
    assert.throws(() => validateMapSplit(bad), /PNG/);
  }
  const badSize = structuredClone(initial);
  badSize.elements[0].parts[0].width = 13;
  assert.throws(() => validateMapSplit(badSize), /尺寸/);
  const badMask = structuredClone(initial);
  badMask.elements[0].parts[0].mask = blue;
  badMask.elements[0].parts[0].height = 25;
  assert.throws(() => validateMapSplit(badMask), /尺寸/);
  const duplicate = structuredClone(initial);
  duplicate.elements.push(duplicate.elements[0]);
  assert.throws(() => validateMapSplit(duplicate), /身份重复/);
  const ownership = structuredClone(initial);
  ownership.elements.push(element('other', blue));
  ownership.elements.forEach((entry) => {
    entry.collision.mapIndices = [0];
  });
  assert.throws(
    () => validateMapSplit(ownership, { mapCollisionCount: 1 }),
    /只能转移/,
  );
  ownership.elements.pop();
  ownership.elements[0].collision.mapIndices = [1];
  assert.throws(
    () => validateMapSplit(ownership, { mapCollisionCount: 1 }),
    /不存在/,
  );
  const snapshot = structuredClone(initial);
  snapshot.conflicts = [
    {
      id: 'conflict',
      elementId: 'lamp',
      field: 'element',
      reason: 'test',
      current: new Date(),
    },
  ];
  assert.throws(() => validateMapSplit(snapshot), /JSON/);
});
test('relative move replays 100 + 20 onto incoming 160 while stable element and part IDs survive', () => {
  const old = makeOld();
  old.elements[0].x = 120;
  const next = incoming();
  next.elements[0].parts[0].id = 'new_art';
  const merged = mergeMapSplit(old, next);
  assert.equal(merged.elements[0].id, 'lamp');
  assert.equal(merged.elements[0].x, 180);
  assert.equal(merged.elements[0].parts[0].id, 'art');
  assert.equal(merged.baseline[0].x, 160);
  assert.equal(merged.baseline[0].parts[0].id, 'art');
  assert.equal(merged.conflicts.length, 0);
  assert.equal(old.elements[0].x, 120);
});
test('world pin preserves absolute position across a changed map origin', () => {
  const old = makeOld();
  old.origin = { x: 10, y: 20 };
  Object.assign(old.elements[0], { positionMode: 'world', x: 120, y: 90 });
  const next = incoming();
  next.origin = { x: 50, y: -10 };
  const merged = mergeMapSplit(old, next);
  assert.deepEqual([merged.elements[0].x, merged.elements[0].y], [80, 120]);
  assert.equal(
    next.origin.x + merged.elements[0].x,
    old.origin.x + old.elements[0].x,
  );
});
test('incoming redraw merges with scene rename and independently disabled effect', () => {
  const old = makeOld();
  old.baseline[0].parts.push({
    ...old.baseline[0].parts[0],
    id: 'effect',
    role: 'effect',
  });
  old.elements = structuredClone(old.baseline);
  old.elements[0].name = '左灯';
  old.elements[0].parts[1].enabled = false;
  const next = incoming();
  next.elements[0].parts = structuredClone(old.baseline[0].parts);
  next.elements[0].parts[0].source = green;
  const merged = mergeMapSplit(old, next);
  assert.equal(merged.elements[0].name, '左灯');
  assert.equal(merged.elements[0].parts[0].source, green);
  assert.equal(merged.elements[0].parts[1].enabled, false);
  assert.deepEqual(merged.conflicts, []);
});
test('concurrent texture edits preserve three previews and allow field-specific incoming resolution', () => {
  const old = makeOld();
  old.elements[0].parts[0].source = blue;
  const next = incoming();
  next.elements[0].parts[0].source = green;
  const merged = mergeMapSplit(old, next);
  assert.equal(merged.conflicts.length, 1);
  const conflict = merged.conflicts[0];
  assert.equal(conflict.field, 'parts.art.source');
  assert.deepEqual(
    [conflict.baseline, conflict.current, conflict.incoming],
    [red, blue, green],
  );
  assert.equal(merged.elements[0].parts[0].source, blue);
  const resolved = mergeMapSplit(old, next, {
    resolutions: [{ conflictId: conflict.id, choice: 'incoming' }],
  });
  assert.equal(resolved.elements[0].parts[0].source, green);
  assert.equal(resolved.conflicts[0].resolution, 'incoming');
  assert.throws(
    () =>
      mergeMapSplit(old, next, {
        resolutions: [{ conflictId: 'outdated', choice: 'current' }],
      }),
    /冲突不存在/,
  );
});
test('redrawn image dimensions conflict as one texture/geometry unit instead of invalid mixed data', async () => {
  const old = makeOld();
  old.elements[0].parts[0].source = blue;
  const next = incoming();
  next.elements[0].parts[0].width = 20;
  next.elements[0].parts[0].source = await image(20, 24, '#00ff00');
  const merged = mergeMapSplit(old, next);
  assert.equal(merged.conflicts[0].reason, 'texture-geometry-changed');
  assert.equal(merged.elements[0].parts[0].width, 12);
  assert.equal(merged.elements[0].parts[0].source, blue);
});
test('same name supplies no matching evidence, and identical repeated lamps remain ambiguous', () => {
  const old = makeOld();
  delete old.baseline[0].sourceKey;
  delete old.elements[0].sourceKey;
  old.elements[0].name = '编辑灯';
  const different = incoming({ sourceKey: undefined });
  different.elements[0].parts[0].source = green;
  const noMatch = mergeMapSplit(old, different);
  assert.equal(noMatch.matches.length, 0);
  assert.ok(
    noMatch.conflicts.some(
      (entry) => entry.reason === 'missing-edited-element',
    ),
  );
  assert.equal(noMatch.elements.length, 2);
  const repeated = split([
    element('a', red, { x: 90 }),
    element('b', red, { x: 110 }),
  ]);
  const newRepeated = split([
    element('c', red, { x: 150 }),
    element('d', red, { x: 170 }),
  ]);
  const ambiguous = mergeMapSplit(repeated, newRepeated);
  assert.equal(ambiguous.matches.length, 0);
  assert.equal(
    ambiguous.conflicts.filter((entry) => entry.reason === 'ambiguous-match')
      .length,
    2,
  );
  assert.deepEqual(
    ambiguous.elements.map((entry) => entry.id),
    ['a', 'b'],
  );
  const explicit = mergeMapSplit(repeated, newRepeated, {
    matches: [
      { oldId: 'a', newId: 'c' },
      { oldId: 'b', newId: 'd' },
    ],
  });
  assert.deepEqual(
    explicit.elements.map((entry) => [entry.id, entry.x]),
    [
      ['a', 150],
      ['b', 170],
    ],
  );
  assert.throws(
    () =>
      mergeMapSplit(repeated, newRepeated, {
        matches: [
          { oldId: 'a', newId: 'c' },
          { oldId: 'b', newId: 'c' },
        ],
      }),
    /一对一/,
  );
});
test('ownership outline plus aligned position or a confirmed neighbor matches redrawn objects', () => {
  const old = makeOld();
  delete old.baseline[0].sourceKey;
  delete old.elements[0].sourceKey;
  old.baseline[0].parts[0].mask = red;
  old.elements[0].parts[0].mask = red;
  old.elements[0].name = '左灯';
  const next = incoming({ sourceKey: undefined, x: 100 });
  next.elements[0].parts[0].source = green;
  next.elements[0].parts[0].mask = red;
  const aligned = mergeMapSplit(old, next);
  assert.equal(aligned.elements.length, 1);
  assert.equal(aligned.elements[0].id, 'lamp');
  assert.equal(aligned.elements[0].name, '左灯');
  assert.match(aligned.matches[0].evidence, /ownership-outline/);
  const anchor = element('anchor', blue, {
    sourceKey: 'known-anchor',
    x: 20,
    y: 40,
  });
  old.baseline.push(structuredClone(anchor));
  old.elements.push(structuredClone(anchor));
  old.elements[0].x = 120;
  next.elements[0].x = 160;
  next.elements.push({ ...structuredClone(anchor), id: 'new_anchor', x: 80 });
  const neighbor = mergeMapSplit(old, next);
  assert.equal(neighbor.elements.find((entry) => entry.id === 'lamp').x, 180);
  assert.match(
    neighbor.matches.find((entry) => entry.oldId === 'lamp').evidence,
    /aligned-neighbor:anchor/,
  );
});
test('spatial one-to-many and many-to-one changes preserve even unedited objects as identity conflicts', async () => {
  const old = makeOld();
  delete old.baseline[0].sourceKey;
  delete old.elements[0].sourceKey;
  const half = await image(6, 24, '#00ff00');
  const fragments = [
    element('piece_a', half, { x: 100 }),
    element('piece_b', half, { x: 106 }),
  ];
  fragments.forEach((entry) => {
    entry.parts[0].width = 6;
  });
  const divided = mergeMapSplit(old, split(fragments));
  assert.deepEqual(
    divided.elements.map((entry) => entry.id),
    ['lamp'],
  );
  assert.deepEqual(divided.conflicts[0].candidates, ['piece_a', 'piece_b']);
  const two = split([
    element('lamp_a', red),
    element('lamp_b', blue, { x: 112 }),
  ]);
  const joined = element('joined', await image(24, 24, '#00ff00'));
  joined.parts[0].width = 24;
  const combined = mergeMapSplit(two, split([joined]));
  assert.deepEqual(
    combined.elements.map((entry) => entry.id),
    ['lamp_a', 'lamp_b'],
  );
  assert.equal(combined.conflicts.length, 2);
});
test('deletion, missing edited objects and scene-only additions preserve independent intent', () => {
  const old = makeOld();
  old.elements = [];
  old.tombstones = ['lamp'];
  const deleted = mergeMapSplit(old, incoming());
  assert.deepEqual(deleted.elements, []);
  assert.deepEqual(deleted.tombstones, ['lamp']);
  assert.deepEqual(mergeMapSplit(makeOld(), split([])).elements, []);
  const edited = makeOld();
  edited.elements[0].name = '改过的灯';
  edited.elements.push(element('scene_added', blue));
  const missing = mergeMapSplit(edited, split([]));
  assert.deepEqual(
    missing.elements.map((entry) => entry.id),
    ['lamp', 'scene_added'],
  );
  assert.equal(missing.conflicts[0].reason, 'missing-edited-element');
  const remove = mergeMapSplit(edited, split([]), {
    resolutions: [{ conflictId: missing.conflicts[0].id, choice: 'delete' }],
  });
  assert.deepEqual(
    remove.elements.map((entry) => entry.id),
    ['scene_added'],
  );
  assert.ok(remove.tombstones.includes('lamp'));
});
test('edited collision geometry checks new silhouette and incoming indices replace superseded indices', () => {
  const old = makeOld();
  old.elements[0].collision.enabled = true;
  old.elements[0].collision.polygons[0][0].x = 2;
  const next = incoming();
  next.elements[0].parts[0].source = green;
  next.elements[0].collision.mapIndices = [2];
  const merged = mergeMapSplit(old, next);
  assert.ok(
    merged.conflicts.some((entry) => entry.reason === 'shape-anchor-changed'),
  );
  assert.equal(merged.elements[0].collision.enabled, true);
  assert.deepEqual(merged.elements[0].collision.mapIndices, [2]);
});
test('install keeps a prepared baseline intact and rejects collisions before mutating the scene', async () => {
  const scene = await splitFixture();
  const prepared = structuredClone(scene.mapSplit);
  prepared.elements[1].name = '编辑名称';
  installMapSplit(scene, prepared);
  assert.equal(scene.mapSplit.baseline[1].name, '跨缝树');
  assert.equal(scene.mapSplit.elements[1].name, '编辑名称');
  const before = JSON.stringify(scene);
  prepared.elements[1].id = 'actor';
  assert.throws(() => installMapSplit(scene, prepared), /身份重复/);
  assert.equal(JSON.stringify(scene), before);
});
test('display keeps ordinary instances in order, straddles ActorSlot and never redraws original map', async () => {
  const scene = await splitFixture();
  const project = createProject();
  const material = addMaterial(scene, project, project.objects[0].definitionId);
  const a = addInstance(scene, material.id, 30, 40),
    b = addInstance(scene, material.id, 60, 40);
  const ordinary = scene.order.filter((id) =>
    [a.id, b.id, 'actor'].includes(id),
  );
  const order = sceneDisplayOrder(scene);
  assert.deepEqual(
    order
      .filter((entry) => ['instance', 'actor'].includes(entry.kind))
      .map((entry) => entry.id),
    ordinary,
  );
  assert.ok(!order.some((entry) => entry.kind === 'layer'));
  const actorZ = order.find((entry) => entry.kind === 'actor').zIndex;
  assert.ok(
    order.find((entry) => entry.key === 'split_tree:art').zIndex < actorZ,
  );
  assert.ok(
    order.find((entry) => entry.key === 'split_tree:canopy').zIndex > actorZ,
  );
  assert.ok(!order.some((entry) => entry.key === 'split_tree:glow'));
  assert.deepEqual(mapSplitElementOrigin(scene, scene.mapSplit.elements[1]), {
    x: 67,
    y: 46,
  });
  validateScene(scene);
});
test('map replacement retains old baseline stale, renders the new map and preserves ordinary positions', async () => {
  const scene = await splitFixture();
  const before = structuredClone(scene.mapSplit);
  const replacement = structuredClone(scene.map);
  replacement.origin.x += 40;
  replacement.collisions = [];
  replaceMap(scene, replacement);
  assert.equal(scene.mapSplit.stale, true);
  assert.deepEqual(scene.mapSplit.baseline, before.baseline);
  assert.deepEqual(
    sceneDisplayOrder(scene).map((entry) => entry.kind),
    ['actor', 'layer'],
  );
  validateScene(scene);
});
test('transferred collisions remain removed while the owner is disabled, excluded or deleted', async () => {
  const scene = await splitFixture();
  const tree = scene.mapSplit.elements[1];
  assert.deepEqual(activeMapCollisions(scene), []);
  tree.collision.enabled = false;
  tree.included = false;
  assert.deepEqual(activeMapCollisions(scene), []);
  scene.mapSplit.elements = scene.mapSplit.elements.filter(
    (entry) => entry.id !== tree.id,
  );
  scene.mapSplit.tombstones = [tree.id];
  scene.order = scene.order.filter((id) => id !== tree.id);
  assert.deepEqual(activeMapCollisions(scene), []);
  validateScene(scene);
});
test('late collision transfer survives owner deletion and source/Godot round trips without changing the merge baseline', async () => {
  const scene = await splitFixture();
  const tree = scene.mapSplit.elements[1];
  scene.mapSplit.baseline[1].collision.mapIndices = [];
  tree.collision.mapIndices = [];
  assert.deepEqual(
    activeMapCollisions(scene).map((entry) => entry.index),
    [0],
  );
  tree.collision = splitCollisionTransfer(scene, tree.id, [0]);
  assert.deepEqual(scene.mapSplit.baseline[1].collision.mapIndices, []);
  removeMapSplitElements(scene, [tree.id]);
  assert.deepEqual(scene.mapSplit.deletedMapCollisions, [
    { elementId: tree.id, mapIndices: [0] },
  ]);
  assert.deepEqual(activeMapCollisions(scene), []);
  assert.equal(mapSplitCollisionOwner(scene, 0).deleted, true);
  assert.throws(
    () => splitCollisionTransfer(scene, 'split_ground', [0]),
    /删除物件/,
  );
  validateScene(scene);
  const reopened = await readScenePackage(await createScenePackage(scene));
  assert.deepEqual(activeMapCollisions(reopened), []);
  const built = await buildSceneGodotPackage(scene, {
    repositoryRoot: process.cwd(),
  });
  const zip = await JSZip.loadAsync(built.bytes);
  assert.doesNotMatch(
    await zip.file(built.scenePath.slice(6)).async('string'),
    /parent="MapCollisions"/,
  );
  assert.deepEqual(
    activeMapCollisions(await readScenePackage(built.bytes)),
    [],
  );
});
test('explicit release returns collision to map before and after owner deletion, and permits a new owner', async () => {
  const scene = await splitFixture(),
    tree = scene.mapSplit.elements[1];
  tree.collision = splitCollisionTransfer(scene, tree.id, []);
  assert.deepEqual(
    activeMapCollisions(scene).map((entry) => entry.index),
    [0],
  );
  removeMapSplitElements(scene, [tree.id]);
  assert.deepEqual(scene.mapSplit.deletedMapCollisions, [
    { elementId: tree.id, mapIndices: [] },
  ]);
  assert.deepEqual(scene.mapSplit.baseline[1].collision.mapIndices, [0]);
  assert.deepEqual(
    activeMapCollisions(scene).map((entry) => entry.index),
    [0],
  );
  assert.equal(mapSplitCollisionOwner(scene, 0), undefined);
  scene.mapSplit.elements[0].collision = splitCollisionTransfer(
    scene,
    'split_ground',
    [0],
  );
  assert.equal(mapSplitCollisionOwner(scene, 0).elementId, 'split_ground');
  validateScene(scene);
});
test('partial release records only the remaining ownership and new-map migration never reuses old indices', async () => {
  const scene = await splitFixture();
  scene.map.collisions.push(
    scene.map.collisions[0].map((point) => ({ x: point.x + 40, y: point.y })),
  );
  scene.mapSplit.baseline[1].collision.mapIndices = [0, 1];
  scene.mapSplit.elements[1].collision = splitCollisionTransfer(
    scene,
    'split_tree',
    [1],
  );
  removeMapSplitElements(scene, ['split_tree']);
  assert.deepEqual(
    activeMapCollisions(scene).map((entry) => entry.index),
    [0],
  );
  const candidate = structuredClone(scene.mapSplit);
  candidate.sourceHash = '2'.repeat(64);
  candidate.elements = structuredClone(candidate.baseline);
  candidate.baseline[1].collision.mapIndices = [2];
  candidate.elements[1].collision.mapIndices = [2];
  candidate.tombstones = [];
  delete candidate.deletedMapCollisions;
  const merged = mergeMapSplit(scene.mapSplit, candidate);
  assert.deepEqual(merged.deletedMapCollisions, [
    { elementId: 'split_tree', mapIndices: [2] },
  ]);
  const released = structuredClone(scene.mapSplit);
  released.deletedMapCollisions[0].mapIndices = [];
  assert.deepEqual(mergeMapSplit(released, candidate).deletedMapCollisions, [
    { elementId: 'split_tree', mapIndices: [] },
  ]);
});
test('same-map revisions preserve late deletion ownership and explicit release', async () => {
  for (const release of [false, true]) {
    const scene = await splitFixture();
    scene.mapSplit.baseline[1].collision.mapIndices = [];
    if (release)
      scene.mapSplit.elements[1].collision = splitCollisionTransfer(
        scene,
        'split_tree',
        [],
      );
    removeMapSplitElements(scene, ['split_tree']);
    const next = structuredClone(scene.mapSplit);
    next.elements = structuredClone(next.baseline);
    next.elements[0].name = 'revised other object';
    next.tombstones = [];
    next.deletedMapCollisions = [];
    const merged = mergeMapSplit(scene.mapSplit, next);
    assert.deepEqual(merged.deletedMapCollisions, [
      { elementId: 'split_tree', mapIndices: release ? [] : [0] },
    ]);
    installMapSplit(scene, merged);
    assert.deepEqual(
      activeMapCollisions(scene).map((entry) => entry.index),
      release ? [0] : [],
    );
  }
});
test('adding and releasing ownership preserves moved and edited local polygons', async () => {
  const scene = await splitFixture(),
    tree = scene.mapSplit.elements[1];
  scene.map.collisions.push(
    scene.map.collisions[0].map((point) => ({ ...point, x: point.x + 80 })),
  );
  tree.x += 100;
  tree.collision.polygons[0][0].x += 3;
  const edited = structuredClone(tree.collision.polygons[0]);
  tree.collision = splitCollisionTransfer(scene, tree.id, [0, 1]);
  assert.deepEqual(tree.collision.polygons[0], edited);
  const added = structuredClone(tree.collision.polygons[1]);
  tree.collision = splitCollisionTransfer(scene, tree.id, [1]);
  assert.deepEqual(tree.collision.polygons, [added]);
});
test('keeping current ownership after map replacement never suppresses unrelated new map indices', () => {
  const old = makeOld();
  old.elements[0].collision.mapIndices = [0];
  old.elements[0].collision.polygons[0][0].x = 3;
  const next = incoming();
  next.elements[0].collision.mapIndices = [1];
  const preview = mergeMapSplit(old, next);
  const issue = preview.conflicts.find(
    (entry) => entry.field === 'collision.mapIndices',
  );
  const kept = mergeMapSplit(old, next, {
    resolutions: [{ conflictId: issue.id, choice: 'current' }],
  });
  assert.deepEqual(kept.elements[0].collision.mapIndices, []);
  assert.deepEqual(
    kept.elements[0].collision.polygons,
    old.elements[0].collision.polygons,
  );
});
test('repeated migrations reuse the exact part identity mapping in the baseline', () => {
  const old = makeOld();
  old.elements[0].parts.push({
    ...old.elements[0].parts[0],
    id: 'second',
    source: blue,
    x: 20,
  });
  old.baseline = structuredClone(old.elements);
  const next = incoming();
  next.elements[0].parts = old.elements[0].parts.map((part, index) => ({
    ...part,
    id: `new_${index}`,
  }));
  next.baseline = structuredClone(next.elements);
  const first = mergeMapSplit(old, next);
  assert.deepEqual(
    first.elements[0].parts.map((p) => p.id),
    first.baseline[0].parts.map((p) => p.id),
  );
  const third = structuredClone(first);
  third.sourceHash = '3'.repeat(64);
  third.elements[0].parts[1].source = green;
  third.baseline = structuredClone(third.elements);
  const second = mergeMapSplit(first, third);
  assert.equal(second.elements[0].parts[1].source, green);
  assert.equal(second.elements[0].parts[1].id, 'second');
});
test('source ZIP deduplicates baseline, texture, mask and conflict snapshots and rejects unsafe refs', async () => {
  const scene = await splitFixture();
  scene.mapSplit.elements[1].parts[0].mask = red;
  scene.mapSplit.conflicts.push({
    id: 'preview',
    elementId: 'split_tree',
    field: 'parts.art.source',
    reason: 'concurrent-edit',
    baseline: red,
    current: red,
    incoming: green,
  });
  const bytes = await createScenePackage(scene);
  const zip = await JSZip.loadAsync(bytes);
  const stored = JSON.parse(await zip.file('scene.json').async('string'));
  assert.equal(
    stored.mapSplit.elements[1].parts[0].source,
    stored.mapSplit.baseline[1].parts[0].source,
  );
  assert.equal(
    stored.mapSplit.elements[1].parts[0].mask,
    stored.mapSplit.conflicts[0].current,
  );
  assert.deepEqual(await readScenePackage(bytes), scene);
  stored.mapSplit.elements[1].parts[0].source = '../private.png';
  zip.file('scene.json', JSON.stringify(stored));
  await assert.rejects(
    readScenePackage(await zip.generateAsync({ type: 'uint8array' })),
    /PNG/,
  );
});
test('Godot export has one script-free movable parent with global-Z parts and transferred collision once', async () => {
  const scene = await splitFixture();
  scene.mapSplit.elements[1].hidden = true;
  const built = await buildSceneGodotPackage(scene, {
    repositoryRoot: process.cwd(),
  });
  const zip = await JSZip.loadAsync(built.bytes);
  const text = await zip.file(built.scenePath.slice(6)).async('string');
  assert.match(text, /\[node name="split_tree" type="Node2D" parent="\."\]/);
  assert.match(text, /position = Vector2\(67, 46\)/);
  assert.equal((text.match(/z_as_relative = false/g) || []).length, 4);
  assert.match(text, /\[node name="Part_glow"[\s\S]*?visible = false/);
  assert.match(text, /parent="split_tree\/CollisionBody"/);
  assert.doesNotMatch(text, /parent="MapCollisions"/);
  assert.doesNotMatch(text, /InteractionRuntime|interaction_actor|script =/);
  assert.equal(
    Object.keys(zip.files).filter((name) => /\/split\/\d+\.png$/.test(name))
      .length,
    3,
  );
  assert.deepEqual(await readScenePackage(built.bytes), scene);
});
test('saved observation uses split pixels, transparent hole, parent coordinates and enabled effects', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'forge-split-observation-'),
  );
  try {
    const scene = await splitFixture();
    scene.mapSplit.elements[1].x += 40;
    const evidence = await observeScene(
      root,
      { workspace: { outputDirectory: 'outputs' } },
      { id: scene.id, kind: 'scene', revision: 1, content: scene },
      { overlay: false, region: { x: -33, y: -34, width: 240, height: 160 } },
    );
    const pixels = await sharp(Buffer.from(evidence.images[0].data, 'base64'))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const pixel = (x, y) => [
      ...pixels.subarray((y * 240 + x) * 4, (y * 240 + x) * 4 + 4),
    ];
    assert.deepEqual(pixel(0, 0), [0, 0, 255, 255]);
    assert.equal(
      pixel(105, 90)[3],
      0,
      'Moved object leaves its owned pixels transparent.',
    );
    assert.deepEqual(pixel(145, 90), [255, 0, 0, 255]);
    assert.equal(
      evidence.objects.find((entry) => entry.id === 'split_tree').parts.length,
      2,
    );
    assert.ok(!evidence.resources.some((entry) => entry.id === 'map_overall'));
  } finally {
    assert.ok(
      path.dirname(root) === path.resolve(os.tmpdir()) &&
        path.basename(root).startsWith('forge-split-observation-'),
    );
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, run] of tests) {
  await run();
  console.log(`PASS ${name}`);
}
console.log(`Scene map split: ${tests.length} tests passed.`);
