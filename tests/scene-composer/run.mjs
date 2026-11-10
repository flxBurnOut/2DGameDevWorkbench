import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
  createObject,
  createProject,
} from '../../features/interactable-editor/contract.mjs';
import {
  createScene,
  validateScene,
  addMaterial,
  addInstance,
  reorder,
  replaceInstances,
  replaceMap,
  instanceOrigin,
  changeAnchor,
  sceneWarnings,
} from '../../features/scene-composer/model.mjs';
import {
  createScenePackage,
  readScenePackage,
} from '../../features/scene-composer/package.mjs';
import { buildSceneGodotPackage } from '../../features/scene-composer/godot-builder.mjs';
import { createSceneSimulation } from '../../features/scene-composer/simulation.mjs';
import { exportSceneRequest } from '../../lib/workbench/scene-export.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
test('scene editor is registered once without adding an Agent execution capability', async () => {
  const manifest = JSON.parse(
    await readFile('workbench/manifest.json', 'utf8'),
  );
  assert.equal(
    manifest.editorModules.filter((m) => m.id === 'scene-composer').length,
    1,
  );
  assert.ok(!manifest.capabilities.some((c) => c.id === 'scene-composer'));
  const editor = manifest.editorModules.find((m) => m.id === 'scene-composer');
  assert.ok(
    (
      await readFile(`app/(workbench)${editor.ui.route}/page.tsx`, 'utf8')
    ).includes('SceneComposer'),
  );
});
const png = await sharp({
  create: {
    width: 32,
    height: 24,
    channels: 4,
    background: { r: 40, g: 130, b: 80, alpha: 0.7 },
  },
})
  .png()
  .toBuffer();
const image = `data:image/png;base64,${png.toString('base64')}`;
const mapSource = `data:application/zip;base64,${Buffer.from(await new JSZip().file('map-test.json', '{}').generateAsync({ type: 'uint8array' })).toString('base64')}`;
const makeMap = () => ({
  name: '测试地图',
  origin: { x: -100, y: -80 },
  offset: { x: 20, y: 30 },
  layers: [
    {
      id: 'map_overall',
      name: '地图底图',
      source: image,
      width: 32,
      height: 24,
      locked: true,
      hidden: false,
      included: true,
    },
    {
      id: 'map_top',
      name: '地图前景',
      source: image,
      width: 32,
      height: 24,
      locked: true,
      hidden: false,
      included: true,
    },
  ],
  collisions: [
    [
      { x: -100, y: -56 },
      { x: -68, y: -56 },
      { x: -68, y: -52 },
    ],
  ],
  source: mapSource,
  warnings: [],
});
function fixture(kind = 'toggle') {
  const scene = createScene('小屋场景');
  replaceMap(scene, makeMap());
  const project = createProject();
  project.objects = [createObject(kind)];
  project.objects[0].visual.assetId = 'image';
  project.objects[0].visual.width = 32;
  project.objects[0].visual.height = 24;
  project.assets = [
    { id: 'image', name: 'test.png', mime: 'image/png', source: image },
  ];
  const material = addMaterial(scene, project, project.objects[0].definitionId);
  const a = addInstance(scene, material.id, -70, -40),
    b = addInstance(scene, material.id, -55, -40);
  return { scene, project, material, a, b };
}
test('front/back and relative placement preserve selected group order', () => {
  const { scene, a, b } = fixture();
  const original = scene.order.filter((id) => [a.id, b.id].includes(id));
  reorder(scene, [a.id, b.id], 'front');
  assert.deepEqual(scene.order.slice(0, 2), original);
  reorder(scene, [a.id, b.id], 'back');
  assert.deepEqual(scene.order.slice(-2), original);
  reorder(scene, [a.id, b.id], 'before', 'actor');
  assert.deepEqual(
    scene.order.slice(
      scene.order.indexOf('actor') - 2,
      scene.order.indexOf('actor'),
    ),
    original,
  );
  reorder(scene, [a.id], 'index', 1);
  assert.equal(scene.order[0], a.id);
  validateScene(scene);
});
test('material import keeps only media used by the chosen definition', () => {
  const { project, scene } = fixture();
  const other = createObject('inspect');
  other.visual.assetId = 'other';
  project.objects.push(other);
  project.assets.push({ ...project.assets[0], id: 'other' });
  const imported = addMaterial(scene, project, other.definitionId);
  assert.deepEqual(imported.project.assets.map(asset => asset.id), ['other']);
  assert.equal(project.assets.length, 2);
});
test('one long tick completes the same feedback and cooldown as separate ticks', () => {
  const { scene, a, material } = fixture('inspect');
  const object = material.project.objects[0];
  object.content.pages = [];
  object.feedback = [{ type: 'wait', seconds: 1 }, { type: 'wait', seconds: 1 }];
  object.cooldownSeconds = 2;
  const run = times => {
    const sim = createSceneSimulation(scene);
    const instance = sim.objects.find(item => item.id === a.id);
    sim.request(instance);
    for (const seconds of times) sim.tick(seconds);
    return [instance.state.successCount, instance.cooldown, sim.waiting];
  };
  assert.deepEqual(run([3]), [1, 1, null]);
  assert.deepEqual(run([3]), run([1, 1, 1]));
});
test('node sort never drops nodes when targeting the selected group or edges', () => {
  const { scene, a, b } = fixture();
  for (const action of ['front', 'forward', 'backward', 'back']) {
    for (let n = 0; n < 12; n++) {
      reorder(scene, [a.id, b.id], action);
      validateScene(scene);
    }
  }
  const before = [...scene.order];
  reorder(scene, [a.id], 'before', a.id);
  assert.deepEqual(scene.order, before);
});
test('single replacement preserves identity and placement without mutating siblings or source', () => {
  const { scene, project, a, b } = fixture();
  const old = structuredClone(a);
  const originProject = JSON.stringify(project);
  const changed = structuredClone(project);
  changed.objects[0].visual.height = 96;
  const next = addMaterial(scene, changed, changed.objects[0].definitionId);
  replaceInstances(scene, [a.id], next.id);
  for (const key of ['id', 'name', 'x', 'y', 'scale', 'flipH'])
    assert.deepEqual(a[key], old[key]);
  assert.equal(a.anchor.y, 48);
  assert.equal(b.materialId, old.materialId);
  assert.equal(JSON.stringify(project), originProject);
});
test('anchor changes preserve object origin under scale and mirror', () => {
  const { a } = fixture();
  a.scale = 3;
  a.flipH = true;
  const origin = instanceOrigin(a);
  changeAnchor(a, { x: 17, y: -20 });
  assert.deepEqual(instanceOrigin(a), origin);
});
test('map expansion keeps object coordinates and original relative order', () => {
  const { scene, a, b } = fixture();
  const before = structuredClone(scene.instances);
  const map = makeMap();
  map.origin.x -= 500;
  map.layers[0].width += 500;
  replaceMap(scene, map);
  assert.deepEqual(scene.instances, before);
  assert.ok(scene.order.indexOf(b.id) < scene.order.indexOf(a.id));
  map.layers = [map.layers[0]];
  replaceMap(scene, map);
  assert.ok(!scene.order.includes('map_top'));
  validateScene(scene);
});
test('missing definitions, duplicate IDs and damaged order reject atomically', () => {
  const { scene } = fixture();
  const before = JSON.stringify(scene);
  const bad = structuredClone(scene);
  bad.instances[0].materialId = 'missing';
  assert.throws(() => validateScene(bad), /缺少素材/);
  bad.instances[0].materialId = scene.materials[0].id;
  bad.order.push('actor');
  assert.throws(() => validateScene(bad), /顺序/);
  assert.equal(JSON.stringify(scene), before);
});
test('source ZIP deduplicates binaries and restores all materials and editor flags', async () => {
  const { scene, project, a } = fixture();
  addMaterial(scene, project, project.objects[0].definitionId);
  a.hidden = true;
  a.included = false;
  const bytes = await createScenePackage(scene);
  const zip = await JSZip.loadAsync(bytes);
  assert.equal(
    Object.keys(zip.files).filter((p) => /^media\/\d+\.bin$/.test(p)).length,
    2,
  );
  assert.deepEqual(await readScenePackage(bytes), scene);
});
test('broken or traversal source references are rejected without fetching external data', async () => {
  const { scene } = fixture();
  const zip = await JSZip.loadAsync(await createScenePackage(scene));
  const manifest = JSON.parse(await zip.file('scene.json').async('string'));
  manifest.map.layers[0].source = '../../secret';
  zip.file('scene.json', JSON.stringify(manifest));
  await assert.rejects(
    readScenePackage(await zip.generateAsync({ type: 'uint8array' })),
    /路径无效/,
  );
  scene.materials[0].project.assets[0].source = 'https://example.com/asset.png';
  await assert.rejects(createScenePackage(scene), /全部素材/);
});
test('preview uses transformed ranges and independent state per instance', () => {
  const { scene, a, b } = fixture('pickup');
  a.scale = 2;
  a.flipH = true;
  const o = scene.materials[0].project.objects[0];
  o.detection.shape.offset.x = 10;
  const sim = createSceneSimulation(scene);
  const first = sim.objects.find((i) => i.id === a.id);
  const second = sim.objects.find((i) => i.id === b.id);
  assert.equal(first.definition.detection.shape.offset.x, -20);
  sim.request(first);
  while (sim.waiting?.type === 'show_text') sim.advanceText();
  assert.equal(first.state.completed, true);
  assert.equal(second.state.completed, false);
  assert.equal(createSceneSimulation(scene).objects[0].state.completed, false);
});
test('pointer selection uses the same scene order as exported visuals', () => {
  const { scene, a, b } = fixture('inspect');
  a.x = b.x;
  a.y = b.y;
  scene.materials[0].project.objects[0].activation.mode = 'pointer_click';
  reorder(scene, [a.id], 'front');
  const sim = createSceneSimulation(scene);
  const origin = instanceOrigin(a);
  sim.click(origin.x, origin.y);
  assert.equal(
    sim.events.find((e) => e.name === 'interaction_started').instanceId,
    a.id,
  );
});
test('hidden editing nodes export, excluded instances do not, and all resource references resolve', async () => {
  const { scene, a, b } = fixture();
  a.hidden = true;
  a.scale = 2;
  a.flipH = true;
  b.included = false;
  reorder(scene, [a.id], 'front');
  const built = await buildSceneGodotPackage(scene, {
    repositoryRoot: process.cwd(),
  });
  const zip = await JSZip.loadAsync(built.bytes);
  const scenePath = built.scenePath.slice(6);
  const text = await zip.file(scenePath).async('string');
  assert.ok(text.includes(`instance_id = "${a.id}"`));
  assert.ok(!text.includes(`instance_id = "${b.id}"`));
  assert.ok(text.includes('scale = Vector2(-2, 2)'));
  const origin = instanceOrigin(a);
  assert.ok(text.includes(`position = Vector2(${origin.x}, ${origin.y})`));
  assert.ok(text.includes('position = Vector2(-80, -50)'));
  assert.ok(text.includes('position = Vector2(20, 30)'));
  assert.equal(zip.file('project.godot'), null);
  for (const [name, file] of Object.entries(zip.files))
    if (/\.(tscn|tres)$/.test(name)) {
      const content = await file.async('string');
      for (const match of content.matchAll(/path="res:\/\/([^"\n]+)"/g))
        assert.ok(zip.file(match[1]), `${name}: missing ${match[1]}`);
    }
  assert.deepEqual(await readScenePackage(built.bytes), scene);
});
test('different scene exports isolate object resource paths and keep one shared runtime', async () => {
  const { scene } = fixture();
  const second = structuredClone(scene);
  second.id = 'other_scene';
  const firstZip = await JSZip.loadAsync(
    (await buildSceneGodotPackage(scene, { repositoryRoot: process.cwd() }))
      .bytes,
  );
  const secondZip = await JSZip.loadAsync(
    (await buildSceneGodotPackage(second, { repositoryRoot: process.cwd() }))
      .bytes,
  );
  const overlap = Object.keys(firstZip.files).filter(
    (p) => !firstZip.files[p].dir && secondZip.file(p),
  );
  assert.ok(overlap.length > 0);
  assert.ok(
    overlap.every((p) =>
      p.startsWith('addons/workbench_interaction/runtime/v1/'),
    ),
  );
});
test('map-only export produces a usable scene and malformed image dimensions fail', async () => {
  const scene = createScene();
  replaceMap(scene, makeMap());
  const output = await buildSceneGodotPackage(scene, {
    repositoryRoot: process.cwd(),
  });
  assert.ok(output.bytes.length);
  scene.map.layers[0].width = 99;
  await assert.rejects(
    buildSceneGodotPackage(scene, { repositoryRoot: process.cwd() }),
    /尺寸/,
  );
});
test('local web export stores verified outputs and a separate non-Agent export record', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-export-test-'));
  try {
    const { scene } = fixture();
    const bytes = await createScenePackage(scene);
    const request = Readable.from([Buffer.from(bytes)]);
    request.headers = { 'content-type': 'application/zip' };
    const result = await exportSceneRequest(request, root);
    assert.equal(result.status, 'completed');
    for (const file of result.outputs)
      assert.ok((await readFile(path.join(root, file))).length);
    const record = JSON.parse(
      await readFile(
        path.join(root, 'work/scene-exports', `${result.exportId}.json`),
        'utf8',
      ),
    );
    assert.equal(record.sceneId, scene.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('map-outside and behind-base warnings keep the scene editable', () => {
  const { scene, a } = fixture();
  a.x = 10000;
  reorder(scene, [a.id], 'back');
  assert.equal(sceneWarnings(scene).length, 2);
  validateScene(scene);
});

let passed = 0;
for (const [name, run] of tests) {
  await run();
  passed++;
  console.log(`PASS ${name}`);
}
console.log(`Scene composer: ${passed} tests passed.`);

await import('./map-split.mjs');

if (process.argv.includes('--write-engine-fixture')) {
  const { scene } = fixture();
  const result = await buildSceneGodotPackage(scene, {
    repositoryRoot: process.cwd(),
  });
  const root = path.resolve('outputs/scene-composer-engine-check');
  await mkdir(root, { recursive: true });
  const zip = await JSZip.loadAsync(result.bytes);
  for (const [name, entry] of Object.entries(zip.files))
    if (!entry.dir) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await entry.async('nodebuffer'));
    }
  await writeFile(
    path.join(root, 'project.godot'),
    `[application]\nconfig/name="Scene composer export check"\nrun/main_scene="${result.scenePath}"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n`,
  );
  console.log(root);
}
