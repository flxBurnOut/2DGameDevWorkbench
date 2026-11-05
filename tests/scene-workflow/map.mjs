import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
  createScene,
  addMaterial,
  addInstance,
} from '../../features/scene-composer/model.mjs';
import {
  createProject,
  createObject,
} from '../../features/interactable-editor/contract.mjs';
import {
  createScenePackage,
  readScenePackage,
} from '../../features/scene-composer/package.mjs';
import {
  createDocument,
  getDocument,
} from '../../lib/workbench/editor-documents.mjs';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { SceneWorkflowStore } from '../../lib/workbench/scene-workflow-store.mjs';
import { freezeWorkflowGeneration } from '../../lib/workbench/scene-workflow-generation.mjs';
import {
  assertMapPolicy,
  executeMapStep,
  inspectMapSource,
  mapGenerationTemplate,
  mapStepSchema,
  projectMapStep,
  projectedMapSource,
  stitchMapExtension,
  validateMapStep,
  workflowMapHash,
  workflowMapLayerId,
  workflowMapTileKey,
} from '../../lib/workbench/scene-workflow-map.mjs';
import { mapPixels, sceneMapFixture } from './map-fixtures.mjs';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const root = repositoryRoot,
  manifest = await loadManifest();
const capability = manifest.capabilities.find(
  (item) => item.id === 'map-stitcher',
);
capability.connector = {
  type: 'local-adapter',
  adapter: 'map-stitcher',
  defaultProvider: 'fixture-map',
  providers: [
    {
      id: 'fixture-map',
      name: 'fixture-map',
      model: 'fixture-map-model',
      protocol: 'openai-images-edits',
      endpoint: 'http://127.0.0.1:1/map/edits',
      generationEndpoint: 'http://127.0.0.1:1/map/generations',
      apiKeyEnv: 'SCENE_WORKFLOW_MAP_FIXTURE_KEY',
    },
  ],
};
capability.inputSchema.properties.provider.enum = ['fixture-map'];
manifest.capabilities.find(
  (item) => item.id === 'image-assets',
).connector.providerIds = ['fixture-map'];
manifest.capabilities.find(
  (item) => item.id === 'image-assets',
).connector.defaultProvider = 'fixture-map';
const priorKey = process.env.SCENE_WORKFLOW_MAP_FIXTURE_KEY;
process.env.SCENE_WORKFLOW_MAP_FIXTURE_KEY = 'fixture-map-secret';
const originalFetch = globalThis.fetch,
  originalSetTimeout = globalThis.setTimeout;
const tests = [],
  test = (name, run) => tests.push([name, run]),
  calls = [];
const packagesToImport = [];
let sequence = 0,
  responseMode = 'success';
const origin = (id = 'new-map') => ({
  id,
  kind: 'map',
  title: '新地图',
  dependsOn: [],
  input: JSON.stringify({
    operation: 'create',
    name: '工厂背景',
    prompt: '正交侧视工厂',
    aspectRatio: '3:2',
    origin: { x: 10, y: -8 },
  }),
});
const extension = (
  id = 'extend-right',
  direction = 'right',
  neighborTileKey = '0,0',
  dependsOn = [],
) => ({
  id,
  kind: 'map',
  title: '扩展地图',
  dependsOn,
  input: JSON.stringify({
    operation: 'extend',
    name: '扩展片区',
    prompt: '连续扩展工厂走廊',
    direction,
    neighborTileKey,
    overlapPercent: 25,
  }),
});
async function fixture({
  scene,
  mode = 'extend',
  budget = 4,
  steps = [extension()],
} = {}) {
  const number = ++sequence,
    store = new SceneWorkflowStore(root, manifest);
  scene ||= (await sceneMapFixture()).scene;
  scene.id = `map-source-${number}`;
  const source = (
    await createDocument(root, manifest, {
      kind: 'scene',
      documentId: scene.id,
      commandId: `map-original-${number}`,
      content: scene,
    })
  ).document;
  const frozen = {
    document: source,
    materials: [],
    mapSource: await inspectMapSource(root, source.content.map),
  };
  const work = {
    schemaVersion: 1,
    id: `map-workflow-${number}`,
    revision: 1,
    plans: [{ revision: 1, plan: { steps } }],
    spec: {
      documentId: scene.id,
      mapMode: mode,
      editableMapLayerIds: [],
      budget: { generationCalls: budget, mapTiles: budget },
    },
    steps: [],
    mapSource: frozen.mapSource,
    generationCalls: [],
    generationConfiguration: freezeWorkflowGeneration(manifest, {
      map: 'fixture-map',
    }),
  };
  work.sourceHash = await store.freeze(work.id, 'source', frozen);
  await createDocument(root, store.candidateManifest(work), {
    kind: 'scene',
    documentId: scene.id,
    commandId: `map-candidate-${number}`,
    content: source.content,
  });
  const persist = () => store.save(work);
  await persist();
  return { store, work, source, persist };
}
const candidate = (f) =>
  getDocument(root, f.store.candidateManifest(f.work), {
    documentId: f.work.spec.documentId,
  }).then((result) => result.document);
async function execute(f, step) {
  const receipt = { id: step.id, kind: 'map', status: 'started' };
  f.work.steps.push(receipt);
  const result = await executeMapStep(
    f.store,
    f.work,
    step,
    receipt,
    f.persist,
  );
  return { result, receipt };
}
const raw = (bytes) =>
  sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const embedded = (source) => Buffer.from(source.split(',')[1], 'base64');
async function worldPixel(layer, map, x, y) {
  const data = await raw(embedded(layer.source));
  const start = ((y - map.origin.y) * layer.width + x - map.origin.x) * 4;
  return [...data.subarray(start, start + 4)];
}
test('typed map input forbids providers, files, custom positions and map replacement', async () => {
  assert.equal(
    mapStepSchema.parse(JSON.parse(origin().input)).aspectRatio,
    '3:2',
  );
  for (const invalid of [
    { provider: 'fixture-map' },
    { image: '/private/image.png' },
    { model: 'invented' },
    { width: 100000 },
  ])
    assert.equal(
      mapStepSchema.safeParse({ ...JSON.parse(origin().input), ...invalid })
        .success,
      false,
    );
  assert.equal(
    mapStepSchema.safeParse({
      ...JSON.parse(extension().input),
      overlapPercent: 0,
    }).success,
    false,
  );
  const f = await fixture();
  assert.throws(
    () =>
      validateMapStep(
        { ...f.work, spec: { ...f.work.spec, mapMode: 'preserve' } },
        f.source.content,
        extension(),
      ),
    /未授权/,
  );
  assert.throws(
    () => validateMapStep(f.work, f.source.content, origin()),
    /空场景/,
  );
  assert.throws(
    () =>
      validateMapStep(
        {
          ...f.work,
          spec: { ...f.work.spec, budget: { generationCalls: 0, mapTiles: 2 } },
        },
        f.source.content,
        extension(),
      ),
    /额度/,
  );
  assert.equal(calls.length, 0);
});
test('node and tile identity conflicts fail during planning and execution before a paid request', async () => {
  const addConflict = (scene, id) => {
    const project = createProject();
    project.objects = [createObject('inspect')];
    const material = addMaterial(
        scene,
        project,
        project.objects[0].definitionId,
      ),
      instance = addInstance(scene, material.id, 5, 5),
      oldId = instance.id;
    instance.id = id;
    scene.order = scene.order.map((key) => (key === oldId ? id : key));
    return scene;
  };
  const count = calls.length,
    create = origin(),
    createFixture = await fixture({
      scene: addConflict(createScene(), 'map_overall'),
      mode: 'create',
      steps: [create],
    });
  assert.throws(
    () =>
      validateMapStep(createFixture.work, createFixture.source.content, create),
    /身份.*冲突/,
  );
  assert.throws(
    () => projectMapStep(createFixture.source.content, create),
    /身份重复/,
  );
  await assert.rejects(execute(createFixture, create), /身份.*冲突/);
  const extend = extension('conflict-extension'),
    local = await sceneMapFixture(),
    extendFixture = await fixture({
      scene: addConflict(local.scene, workflowMapLayerId(extend)),
      steps: [extend],
    });
  assert.throws(
    () =>
      validateMapStep(extendFixture.work, extendFixture.source.content, extend),
    /身份.*冲突/,
  );
  await assert.rejects(execute(extendFixture, extend), /身份.*冲突/);
  const summary = structuredClone(extendFixture.work.mapSource);
  summary.tiles.push({
    ...summary.tiles[0],
    key: workflowMapTileKey(extension('tile-conflict')),
  });
  assert.throws(
    () =>
      validateMapStep(
        extendFixture.work,
        local.scene,
        extension('tile-conflict'),
        summary,
      ),
    /块身份已存在/,
  );
  assert.equal(calls.length, count);
});
test('real saved Pixelwork and Forge source packages prove tile IDs, pixels, geometry and collision', async () => {
  for (const format of ['pixelwork-v2', 'forge-map-project']) {
    const f = await sceneMapFixture({ format }),
      info = await inspectMapSource(root, f.scene.map);
    assert.equal(info.canExtend, true, info.readOnlyReason);
    assert.equal(info.format, format);
    assert.deepEqual(info.tiles[0].bounds, {
      x: 0,
      y: 0,
      width: 24,
      height: 16,
    });
    const wrong = structuredClone(f.scene.map);
    wrong.collisions[0][0].x++;
    assert.equal((await inspectMapSource(root, wrong)).canExtend, false);
    const changed = structuredClone(f.scene.map);
    changed.layers[0].source = `data:image/png;base64,${(await mapPixels(24, 16, [145, 20, 5, 255])).toString('base64')}`;
    assert.equal((await inspectMapSource(root, changed)).canExtend, false);
  }
  const noSource = (await sceneMapFixture()).scene.map;
  noSource.source = 'data:application/zip;base64,AAAA';
  assert.equal((await inspectMapSource(root, noSource)).canExtend, false);
});
test('fractional editor geometry uses the existing round-placement and floor-frame contract', async () => {
  for (const position of [0.85, -0.85]) {
    const local = await sceneMapFixture({ collision: false }),
      zip = await JSZip.loadAsync(local.source),
      data = JSON.parse(
        await zip.file('map_stitch_state.json').async('string'),
      ),
      key = `${position},0`,
      canvasX = position < 0 ? -21 : 0;
    data.tiles[key] = { x: position, y: 0, w: 1, h: 1 };
    data.tileUploads[key] = data.source;
    data.tileFeathers[key] = { top: 0, right: 0, bottom: 0, left: 0 };
    data.hiddenPreviewTiles[key] = false;
    zip.file('map_stitch_state.json', JSON.stringify(data));
    local.scene.map.source = `data:application/zip;base64,${await zip.generateAsync({ type: 'base64' })}`;
    const rendered = await sharp({
      create: {
        width: 45,
        height: 16,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: local.bytes, left: -canvasX, top: 0 },
        {
          input: local.bytes,
          left: Math.round(position * 24) - canvasX,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    local.scene.map.origin.x = canvasX;
    local.scene.map.layers[0].width = 45;
    local.scene.map.layers[0].source = `data:image/png;base64,${rendered.toString('base64')}`;
    const info = await inspectMapSource(root, local.scene.map);
    assert.equal(info.canExtend, true, info.readOnlyReason);
    assert.equal(info.canvas.width, 45);
    assert.equal(info.tiles[1].bounds.x, Math.round(position * 24));
    const step = extension(
        `fractional-${position > 0 ? 'right' : 'left'}`,
        position > 0 ? 'right' : 'left',
        key,
      ),
      f = await fixture({ scene: local.scene, steps: [step] });
    const { result } = await execute(f, step);
    assert.equal(
      (await inspectMapSource(root, result.document.content.map)).canExtend,
      true,
    );
    await assertMapPolicy(
      root,
      f.source.content.map,
      result.document.content.map,
      f.work,
    );
  }
});
test('planning projects create plus two dependent extensions and never supplies usable image art', async () => {
  const first = origin(),
    second = extension('second', 'right', '0,0', [first.id]),
    third = extension('third', 'right', workflowMapTileKey(second), [
      second.id,
    ]);
  const work = {
    spec: { mapMode: 'create', budget: { generationCalls: 3, mapTiles: 3 } },
    mapSource: null,
  };
  let scene = createScene();
  for (const step of [first, second, third]) {
    validateMapStep(work, scene, step);
    scene = projectMapStep(scene, step);
  }
  assert.equal(projectedMapSource(scene).tiles.length, 3);
  assert.equal(scene.map.layers.length, 3);
  assert.ok(scene.map.source.includes('projection'));
  assert.equal((await inspectMapSource(root, scene.map)).canExtend, false);
  assert.throws(
    () =>
      validateMapStep(work, projectMapStep(createScene(), first), {
        ...second,
        dependsOn: [],
      }),
    /直接依赖/,
  );
  const f = await fixture();
  validateMapStep(f.work, f.source.content, extension());
  assert.equal(
    projectMapStep(f.source.content, extension()).map.layers.length,
    2,
  );
  const many = {
    ...work,
    spec: { ...work.spec, budget: { generationCalls: 16, mapTiles: 16 } },
  };
  let bounded = projectMapStep(createScene(), first),
    previous = first;
  for (let index = 0; index < 7; index++) {
    const step = extension(
      `many-${index}`,
      'right',
      index ? workflowMapTileKey(previous) : '0,0',
      [previous.id],
    );
    validateMapStep(many, bounded, step);
    bounded = projectMapStep(bounded, step);
    previous = step;
  }
  assert.equal(bounded.map.layers.length, 8);
  assert.throws(
    () =>
      validateMapStep(
        many,
        bounded,
        extension('too-many', 'right', workflowMapTileKey(previous), [
          previous.id,
        ]),
      ),
    /上限/,
  );
});
test('explicit source-image locks and exhausted tile intents stop before any provider submission', async () => {
  const local = await sceneMapFixture(),
    zip = await JSZip.loadAsync(local.source),
    data = JSON.parse(await zip.file('map_stitch_state.json').async('string'));
  data.workbench.layerLocks.overall = true;
  zip.file('map_stitch_state.json', JSON.stringify(data));
  local.scene.map.source = `data:application/zip;base64,${await zip.generateAsync({ type: 'base64' })}`;
  const locked = await fixture({ scene: local.scene }),
    count = calls.length;
  assert.equal(locked.work.mapSource.canExtend, false);
  assert.match(locked.work.mapSource.readOnlyReason, /已锁定/);
  await assert.rejects(execute(locked, extension()), /已锁定/);
  const first = extension(),
    second = extension('extra'),
    f = await fixture({ budget: 1, steps: [first, second] });
  f.work.steps.push({ id: first.id, kind: 'map', status: 'failed' });
  await assert.rejects(execute(f, second), /意图.*额度/);
  assert.equal(calls.length, count);
});
test('deterministic overlap restoration and clipping keep holes and context exact', async () => {
  const { scene } = await sceneMapFixture({ collision: false }),
    target = { x: 18, y: 0, width: 24, height: 16 },
    before = { x: 0, y: 0, width: 24, height: 16 };
  const template = await mapGenerationTemplate(scene, target),
    templateData = await raw(template);
  scene.map.layers[0].hidden = true;
  assert.deepEqual(await mapGenerationTemplate(scene, target), template, 'Editor visibility cannot change the generator reference');
  assert.deepEqual(
    [...templateData.subarray(0, 4)],
    await worldPixel(scene.map.layers[0], scene.map, 18, 0),
  );
  const generated = await mapPixels(24, 16, [140, 30, 10, 255]);
  const stitched = await stitchMapExtension(
      template,
      generated,
      target,
      before,
    ),
    data = await raw(stitched),
    generatedData = await raw(generated);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 24; x++) {
      const offset = (y * 24 + x) * 4;
      assert.deepEqual(
        data.subarray(offset, offset + 4),
        x < 6 ? Buffer.alloc(4) : generatedData.subarray(offset, offset + 4),
      );
    }
});
test('native extension preserves locked old pixels, collisions, offsets, source bytes and world positions', async () => {
  for (const format of ['pixelwork-v2', 'forge-map-project']) {
    const local = await sceneMapFixture({ format }),
      f = await fixture({ scene: local.scene }),
      count = calls.length;
    const { result, receipt } = await execute(f, extension());
    assert.equal(calls.length, count + 1);
    assert.equal(result.document.revision, 2);
    const map = result.document.content.map;
    assert.deepEqual(map.collisions, f.source.content.map.collisions);
    assert.deepEqual(map.offset, f.source.content.map.offset);
    assert.deepEqual(map.origin, { x: 0, y: 0 });
    assert.equal(map.layers[0].locked, true);
    assert.equal(map.layers[0].width, 42);
    assert.equal(map.layers.length, 2);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 24; x++)
        assert.deepEqual(
          await worldPixel(map.layers[0], map, x, y),
          await worldPixel(
            f.source.content.map.layers[0],
            f.source.content.map,
            x,
            y,
          ),
        );
    const afterZip = await JSZip.loadAsync(embedded(map.source)),
      beforeZip = await JSZip.loadAsync(local.source);
    for (const filename of Object.keys(beforeZip.files).filter(
      (filename) =>
        filename.startsWith('images/') && !beforeZip.files[filename].dir,
    ))
      assert.deepEqual(
        await afterZip.file(filename).async('nodebuffer'),
        await beforeZip.file(filename).async('nodebuffer'),
      );
    assert.equal((await inspectMapSource(root, map)).canExtend, true);
    const toggled = structuredClone(map);
    toggled.layers[0].locked = !toggled.layers[0].locked;
    toggled.layers[0].hidden = !toggled.layers[0].hidden;
    assert.equal((await inspectMapSource(root, toggled)).canExtend, true);
    await assertMapPolicy(root, f.source.content.map, map, f.work);
    assert.equal(
      receipt.mapOutput.sourceTaskId,
      receipt.mapJob.generationJob.taskId,
    );
    assert.equal(receipt.mapOutput.afterMapHash, workflowMapHash(map));
    assert.equal(
      (await getDocument(root, manifest, { documentId: f.source.id })).document
        .revision,
      1,
    );
    const packaged = await createScenePackage(result.document.content),
      reread = await readScenePackage(packaged);
    assert.deepEqual(reread.map, map);
    packagesToImport.push({ format, scene: result.document.content });
  }
});
test('left and upward extension pads old images while preserving their exact world coordinates', async () => {
  for (const direction of ['left', 'up']) {
    const step = extension(`extend-${direction}`, direction),
      f = await fixture({ steps: [step] });
    const { result } = await execute(f, step),
      map = result.document.content.map;
    assert.deepEqual(
      map.origin,
      direction === 'left' ? { x: -18, y: 0 } : { x: 0, y: -12 },
    );
    assert.deepEqual(
      await worldPixel(map.layers[0], map, 4, 3),
      await worldPixel(
        f.source.content.map.layers[0],
        f.source.content.map,
        4,
        3,
      ),
    );
    assert.deepEqual(map.collisions, f.source.content.map.collisions);
    await assertMapPolicy(root, f.source.content.map, map, f.work);
  }
});
test('empty-scene creation and two extensions share the same native generation ledger and source package', async () => {
  const first = origin(),
    second = extension('create-east', 'right', '0,0', [first.id]),
    third = extension('create-far-east', 'right', workflowMapTileKey(second), [
      second.id,
    ]);
  const f = await fixture({
      scene: createScene(),
      mode: 'create',
      budget: 3,
      steps: [first, second, third],
    }),
    count = calls.length;
  for (const step of [first, second, third]) await execute(f, step);
  const document = await candidate(f),
    info = await inspectMapSource(root, document.content.map);
  assert.equal(document.revision, 4);
  assert.equal(info.tiles.length, 3);
  assert.equal(info.canExtend, true, info.readOnlyReason);
  assert.equal(f.work.generationCalls.length, 3);
  assert.equal(calls.length, count + 3);
  assert.deepEqual(document.content.map.offset, { x: 10, y: -8 });
  assert.equal(document.content.map.collisions.length, 0);
  assert.match(document.content.map.warnings.join(''), /碰撞/);
  await assertMapPolicy(root, null, document.content.map, f.work);
  assert.equal(f.work.mapSource.createdByWorkflow, true);
  assert.equal(f.work.mapSource.tiles.length, 3);
  validateMapStep(
    f.work,
    document.content,
    extension('later-repair', 'right', workflowMapTileKey(third)),
  );
  packagesToImport.push({ format: 'pixelwork-v2', scene: document.content });
});
test('generated map sources reopen through the real importer, editable-state exporter and scene package reader', async () => {
  const server = await createTestViteServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });
  const priorImage = globalThis.Image,
    priorReader = globalThis.FileReader,
    urls = [];
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(
        (result) => this.onload({ target: { result } }),
        (error) => this.onerror({ target: { error } }),
      );
    }
  };
  globalThis.Image = class {
    set src(url) {
      assert.ok(
        url.startsWith('blob:'),
        'only local importer blobs may be decoded',
      );
      originalFetch(url)
        .then((response) => response.arrayBuffer())
        .then((bytes) => sharp(Buffer.from(bytes)).metadata())
        .then(({ width, height }) => {
          this.naturalWidth = width;
          this.naturalHeight = height;
          this.onload();
        })
        .catch(() => this.onerror());
    }
  };
  try {
    const importer = await server.ssrLoadModule(
        '/features/map-stitcher/godot-import.ts',
      ),
      storage = await server.ssrLoadModule(
        '/features/map-stitcher/state-package.ts',
      );
    for (const entry of packagesToImport) {
      const scene = await readScenePackage(
        await createScenePackage(entry.scene),
      );
      const loaded = await importer.loadMapProject(
        new File([embedded(scene.map.source)], 'workflow-map.zip'),
      );
      assert.equal(loaded.sourceFormat, entry.format);
      const sourceInfo = await inspectMapSource(root, scene.map);
      assert.deepEqual(
        loaded.tiles.map((tile) => tile.key),
        sourceInfo.tiles.map((tile) => tile.key),
      );
      for (const tile of loaded.tiles)
        for (const asset of Object.values(tile.images)) urls.push(asset.url);
      const exported = await storage.createPixelworkStatePackage(loaded),
        reopened = await storage.loadFrameRoninState(
          new File([exported.blob], 'workflow-editable.zip'),
        );
      assert.deepEqual(reopened.shapes, loaded.shapes);
      assert.equal(reopened.tiles.length, loaded.tiles.length);
      for (const tile of reopened.tiles)
        for (const asset of Object.values(tile.images)) urls.push(asset.url);
      for (const tile of loaded.tiles)
        assert.deepEqual(
          Buffer.from(await tile.images.overall.file.arrayBuffer()),
          Buffer.from(
            await reopened.tiles
              .find((other) => other.key === tile.key)
              .images.overall.file.arrayBuffer(),
          ),
        );
    }
  } finally {
    urls.forEach((url) => URL.revokeObjectURL(url));
    if (priorImage === undefined) delete globalThis.Image;
    else globalThis.Image = priorImage;
    if (priorReader === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = priorReader;
    await server.close();
  }
});
test('unknown provider outcome retains original identity and replay never submits another request', async () => {
  const f = await fixture(),
    step = extension(),
    receipt = { id: step.id, kind: 'map', status: 'started' };
  f.work.steps.push(receipt);
  responseMode = 'network-error';
  const count = calls.length;
  await assert.rejects(
    executeMapStep(f.store, f.work, step, receipt, f.persist),
    (error) => error.code === 'SCENE_GENERATION_OUTCOME_UNKNOWN',
  );
  const taskId = receipt.mapJob.generationJob.taskId;
  responseMode = 'success';
  await assert.rejects(
    executeMapStep(f.store, f.work, step, receipt, f.persist),
    (error) => error.code === 'SCENE_GENERATION_OUTCOME_UNKNOWN',
  );
  assert.equal(receipt.mapJob.generationJob.taskId, taskId);
  assert.equal(calls.length, count + 1);
  assert.equal((await candidate(f)).revision, 1);
});
test('lost candidate-save response reuses exact derived package and CAS command without generation', async () => {
  const f = await fixture(),
    { receipt, result } = await execute(f, extension()),
    count = calls.length;
  const replay = await executeMapStep(
    f.store,
    f.work,
    extension(),
    receipt,
    f.persist,
  );
  assert.equal(replay.document.revision, result.document.revision);
  assert.equal(replay.document.contentHash, result.document.contentHash);
  assert.equal(calls.length, count);
  const sourceFile = path.join(
    f.store.directory(f.work.id),
    `${receipt.mapOutput.resultName}.json`,
  );
  assert.equal(
    workflowMapHash(JSON.parse(await readFile(sourceFile, 'utf8')).content.map),
    receipt.mapOutput.afterMapHash,
  );
});
test('map policies reject changed original pixels, locks, collisions, source bytes and unauthorized append operations', async () => {
  const f = await fixture(),
    { result } = await execute(f, extension()),
    map = result.document.content.map;
  for (const change of [
    (m) => {
      m.layers[0].locked = false;
    },
    (m) => {
      m.collisions[0][0].x++;
    },
    (m) => {
      m.offset.x++;
    },
    (m) => {
      m.layers[0].source = m.layers[1].source;
    },
    (m) => {
      m.source = f.source.content.map.source;
    },
  ]) {
    const tampered = structuredClone(map);
    change(tampered);
    await assert.rejects(
      assertMapPolicy(root, f.source.content.map, tampered, f.work),
    );
  }
  const unauthorized = structuredClone(f.work);
  unauthorized.steps = [];
  await assert.rejects(
    assertMapPolicy(root, f.source.content.map, map, unauthorized),
    /缺少.*回执/,
  );
  const changedIntent = structuredClone(f.work);
  changedIntent.plans[0].plan.steps[0].input = extension('other').input.replace(
    '连续扩展工厂走廊',
    '完全重画',
  );
  await assert.rejects(
    assertMapPolicy(root, f.source.content.map, map, changedIntent),
    /冻结方案/,
  );
  const noBudget = structuredClone(f.work);
  noBudget.spec.budget.mapTiles = 0;
  await assert.rejects(
    assertMapPolicy(root, f.source.content.map, map, noBudget),
    /额度/,
  );
  assert.equal(workflowMapLayerId(extension()), map.layers[1].id);
});

try {
  globalThis.setTimeout = (fn, milliseconds, ...args) =>
    originalSetTimeout(fn, milliseconds === 1000 ? 1 : milliseconds, ...args);
  globalThis.fetch = async (url, init) => {
    assert.ok(
      typeof url === 'string' && url.startsWith('http://127.0.0.1:1/map/'),
      'production providers are forbidden',
    );
    const fields =
      init.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : JSON.parse(init.body);
    calls.push({ url, fields });
    if (responseMode === 'network-error')
      throw new Error('fixture provider connection lost');
    const [width, height] = url.endsWith('/generations')
      ? [24, 16]
      : fields.size.split('x').map(Number);
    const bytes = await mapPixels(width, height, [120, 35, 10, 255]);
    return Response.json(
      {
        data: [{ b64_json: bytes.toString('base64') }],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      },
      { headers: { 'x-request-id': 'map-fixture-request' } },
    );
  };
  await mkdir(path.resolve(root, manifest.workspace.outputDirectory), {
    recursive: true,
  });
  for (const [name, run] of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(
    `Scene maps: ${tests.length} scenarios passed (local fixtures and mocked providers only).`,
  );
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  if (priorKey === undefined) delete process.env.SCENE_WORKFLOW_MAP_FIXTURE_KEY;
  else process.env.SCENE_WORKFLOW_MAP_FIXTURE_KEY = priorKey;
}
