import assert from 'node:assert/strict';
import sharp from 'sharp';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
  root,
  manifest as baseManifest,
  snapshot,
  planner,
  opinion,
  step,
  turn,
} from './fixtures.mjs';
import { createScene } from '../../features/scene-composer/model.mjs';
import {
  createDocument,
  getDocument,
  applyDocumentCommands,
} from '../../lib/workbench/editor-documents.mjs';
import { SceneWorkflowService } from '../../lib/workbench/scene-workflows.mjs';
import {
  candidateDocument,
  validateWorkflowPlan,
  observeWorkflow,
} from '../../lib/workbench/scene-workflow-execution.mjs';
import { inspectMapSource } from '../../lib/workbench/scene-workflow-map.mjs';
import { sceneMapFixture } from './map-fixtures.mjs';

const manifest = structuredClone(baseManifest);
const provider = (id, model) => ({
  id,
  name: id,
  model,
  protocol: 'openai-images-edits',
  endpoint: `http://127.0.0.1:1/${id}/edits`,
  generationEndpoint: `http://127.0.0.1:1/${id}/generations`,
  apiKeyEnv: 'SCENE_PRODUCTION_TEST_KEY',
});
const maps = manifest.capabilities.find((c) => c.id === 'map-stitcher');
const art = manifest.capabilities.find((c) => c.id === 'image-assets');
maps.connector = {
  type: 'local-adapter',
  adapter: 'map-stitcher',
  providers: [
    provider('gpt-image-2.6', 'fixture-object'),
    provider('production-map', 'fixture-map'),
  ],
  defaultProvider: 'production-map',
};
maps.inputSchema.properties.provider.enum = ['gpt-image-2.6', 'production-map'];
art.connector = {
  type: 'local-adapter',
  adapter: 'image-assets',
  providerSource: 'map-stitcher',
  providerIds: ['gpt-image-2.6'],
  defaultProvider: 'gpt-image-2.6',
};
art.inputSchema.properties.provider.enum = ['gpt-image-2.6'];
const previousKey = process.env.SCENE_PRODUCTION_TEST_KEY;
process.env.SCENE_PRODUCTION_TEST_KEY = 'isolated-test-secret';
const originalFetch = globalThis.fetch;
let productionRequests = 0;
let failNextRequest = false;
const providerBytes = async (width, height, transparent) => {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 60;
      pixels[i + 1] = 105;
      pixels[i + 2] = 140;
      pixels[i + 3] =
        transparent && (x < width / 4 || x > (width * 3) / 4) ? 0 : 255;
    }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
};
const description =
  '创建工厂地图，向右扩展，生成铁门和拉杆，拉杆开门时关闭碰撞。';
const makePlan = (steps, acceptance = []) => ({
  title: '工厂制作',
  summary: description,
  requirements: [
    { id: 'goal', text: description, source: 'user', evidence: description },
  ],
  steps,
  visualCriteria: [
    {
      id: 'scene-art',
      description: '铁门和拉杆可见，地图接缝连续，已有内容保持原位',
      requirementIds: ['goal'],
      region: null,
    },
  ],
  acceptance,
  questions: [],
});
const toggle = (definitionId, door = false) => ({
  type: 'set-behavior',
  definitionId,
  behavior: {
    kind: 'toggle',
    initialToggle: false,
    states: [
      {
        name: '关闭',
        appearance: {
          visible: true,
          solidEnabled: true,
          tint: '#ffffff',
          assetId: '',
        },
      },
      {
        name: '打开',
        appearance: {
          visible: !door,
          solidEnabled: !door,
          tint: '#ffffff',
          assetId: '',
        },
      },
    ],
  },
});
const generate = (name) =>
  step(`art-${name}`, 'generate', {
    purpose: 'object',
    materialId: `${name}-art`,
    definitionId: `${name}-art-def`,
    name,
    prompt: `透明背景上的工厂${name}`,
    visualWidth: 48,
    visualHeight: 72,
  });
const derive = (name, door) =>
  step(
    `configure-${name}`,
    'object',
    {
      materialId: `${name}-material`,
      definitionId: `${name}-definition`,
      name,
      source: { kind: 'scene', materialId: `${name}-art` },
      commands: [toggle(`${name}-definition`, door)],
    },
    [`art-${name}`],
  );
const factoryPlan = makePlan(
  [
    step('factory-origin', 'map', {
      operation: 'create',
      name: '工厂',
      prompt: '侧视工厂内部',
      aspectRatio: '1:1',
    }),
    step(
      'factory-right',
      'map',
      {
        operation: 'extend',
        name: '工厂右侧',
        prompt: '延续工厂走廊',
        neighborTileKey: '0,0',
        direction: 'right',
        overlapPercent: 20,
      },
      ['factory-origin'],
    ),
    generate('door'),
    derive('door', true),
    generate('lever'),
    derive('lever', false),
    step(
      'place-controls',
      'scene',
      {
        commands: [
          {
            type: 'add-instance',
            materialId: 'door-material',
            instanceId: 'door',
            x: 500,
            y: 600,
          },
          {
            type: 'add-instance',
            materialId: 'lever-material',
            instanceId: 'lever',
            x: 400,
            y: 600,
          },
          {
            type: 'add-link',
            link: {
              id: 'open-door',
              sourceInstanceId: 'lever',
              event: 'toggled',
              targetInstanceId: 'door',
              action: 'set_toggle',
              value: 'source_toggle',
              enabled: true,
            },
          },
        ],
      },
      ['configure-door', 'configure-lever', 'factory-right'],
    ),
    step(
      'weather-door',
      'image',
      {
        target: { kind: 'scene-instance', instanceId: 'door', slot: 'visual' },
        region: { type: 'rectangle', x: 350, y: 100, width: 20, height: 20 },
        operation: { type: 'replace-color', from: '#3c698c', to: '#556677' },
        preserveAlpha: true,
      },
      ['place-controls'],
    ),
  ],
  [
    {
      id: 'open-door',
      description: '拉杆打开门并停用碰撞',
      requirementIds: ['goal'],
      events: [{ type: 'request', instanceId: 'lever' }],
      expectEvents: [{ name: 'link_applied', count: 1 }],
      expectStates: [
        {
          instanceId: 'door',
          toggleState: true,
          visible: false,
          solidEnabled: false,
        },
      ],
    },
  ],
);
const specFor = (document, extra = {}) => ({
  documentId: document.id,
  expectedRevision: document.revision,
  description,
  mapMode: 'create',
  budget: {
    planningCalls: 16,
    reviewCalls: 9,
    imageCalls: 0,
    generationCalls: 4,
    mapTiles: 2,
    revisions: 1,
  },
  generationProviders: { prop: 'gpt-image-2.6', map: 'production-map' },
  ...extra,
});
async function empty(name) {
  const scene = createScene(name);
  scene.id = name;
  return (
    await createDocument(root, manifest, {
      kind: 'scene',
      documentId: name,
      content: scene,
      commandId: `create-${name}`,
    })
  ).document;
}
const makeService = (
  plan,
  roles = ['appearance', 'layout', 'behavior'],
  review,
) =>
  new SceneWorkflowService(root, manifest, {
    snapshot,
    requestModel: planner(plan, roles, review),
  });
async function run(service, document, extra = {}) {
  const request = {
    commandId: `task-${document.id}`,
    spec: specFor(document, extra),
  };
  const { work } = await service.request('scene-workflow-create', request);
  return { work: await service.drain(work.id), request };
}
const adopt = (work) => ({
  workId: work.id,
  commandId: `adopt-${work.id}`,
  expectedRevision: work.revision,
  candidateRevision: work.candidateRevision,
  candidateHash: work.candidateHash,
});
const checkReady = (work) =>
  assert.equal(
    work.status,
    'ready_to_adopt',
    `${work.message}\n${JSON.stringify(work.messages.filter((m) => m.role === 'validator'))}`,
  );

try {
  globalThis.fetch = async (url, init) => {
    assert.ok(
      typeof url === 'string' && url.startsWith('http://127.0.0.1:1/'),
      'production providers are never contacted',
    );
    productionRequests++;
    if (failNextRequest) {
      failNextRequest = false;
      throw new Error('mock lost provider reply');
    }
    const fields =
      init.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : JSON.parse(init.body);
    const [width, height] = fields.size.split('x').map(Number);
    const bytes = await providerBytes(
      width,
      height,
      fields.background === 'transparent',
    );
    return Response.json(
      {
        data: [{ b64_json: bytes.toString('base64') }],
        usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
      },
      {
        headers: { 'x-request-id': `production-fixture-${productionRequests}` },
      },
    );
  };

  const original = await empty('production-full');
  const service = makeService(
    factoryPlan,
    ['appearance', 'layout', 'behavior'],
    ({ data }) => {
      assert.ok(data.technical.passed);
      assert.ok(data.steps.some((s) => s.generationEvidence?.image?.sha256));
      assert.ok(data.steps.some((s) => s.mapEvidence?.stitchedSha256));
      return opinion(data);
    },
  );
  const { work, request } = await run(service, original);
  checkReady(work);
  assert.equal(productionRequests, 4);
  assert.equal(work.generationCalls.length, 4);
  assert.equal(work.steps.length, 8);
  assert.equal(work.imageCalls.length, 0);
  const candidate = await candidateDocument(service.store, work);
  assert.equal(candidate.content.map.layers.length, 2);
  assert.equal(candidate.content.instances.length, 2);
  assert.equal(
    (await inspectMapSource(root, candidate.content.map)).canExtend,
    true,
  );
  assert.ok(work.reviews.at(-1).technical.checks.every((c) => c.passed));
  assert.equal(
    (await getDocument(root, manifest, { documentId: original.id })).document
      .content.map,
    null,
    'original stays empty before adoption',
  );
  const publicWork = (
    await service.request('scene-workflow-get', { workId: work.id })
  ).work;
  assert.equal(publicWork.usage.generationCalls, 4);
  assert.equal(publicWork.usage.mapTiles, 2);
  assert.equal(
    JSON.stringify(publicWork).includes('isolated-test-secret'),
    false,
  );
  assert.equal(
    (await service.request('scene-workflow-create', request)).replayed,
    true,
  );
  assert.equal(
    productionRequests,
    4,
    'create replay cannot restart production',
  );
  const adopted = await service.request('scene-workflow-adopt', adopt(work));
  assert.equal(adopted.adoption.revision, 2);
  assert.equal(
    (await getDocument(root, manifest, { documentId: original.id })).document
      .content.map.layers.length,
    2,
  );
  console.log(
    'PASS complete workflow: new map, extension, two generated objects, behavior, local edit, independent review and CAS adoption',
  );

  const base = await sceneMapFixture();
  const existingScene = structuredClone(base.scene);
  existingScene.id = 'production-extend';
  const existing = (
    await createDocument(root, manifest, {
      kind: 'scene',
      documentId: existingScene.id,
      commandId: 'existing-map',
      content: existingScene,
    })
  ).document;
  const extensionPlan = makePlan([
    step('west', 'map', {
      operation: 'extend',
      name: '西侧',
      prompt: '向西延续工厂',
      neighborTileKey: '0,0',
      direction: 'left',
      overlapPercent: 25,
    }),
    step(
      'west-up',
      'map',
      {
        operation: 'extend',
        name: '西北',
        prompt: '向上延续工厂',
        neighborTileKey: 'wf_west',
        direction: 'up',
        overlapPercent: 25,
      },
      ['west'],
    ),
  ]);
  const extension = makeService(extensionPlan, ['appearance', 'layout']);
  const extended = (
    await run(extension, existing, {
      mapMode: 'extend',
      budget: { generationCalls: 2, mapTiles: 2 },
    })
  ).work;
  checkReady(extended);
  const final = await candidateDocument(extension.store, extended);
  assert.deepEqual(
    final.content.map.collisions,
    existing.content.map.collisions,
  );
  assert.deepEqual(final.content.map.offset, existing.content.map.offset);
  const beforePixels = await sharp(
    Buffer.from(existing.content.map.layers[0].source.split(',')[1], 'base64'),
  ).metadata();
  const afterPixels = await sharp(
    Buffer.from(final.content.map.layers[0].source.split(',')[1], 'base64'),
  ).metadata();
  assert.ok(afterPixels.width > beforePixels.width);
  assert.ok(afterPixels.height > beforePixels.height);
  await applyDocumentCommands(root, manifest, {
    documentId: existing.id,
    expectedRevision: 1,
    commandId: 'user-change',
    commands: [{ type: 'rename', name: '用户的新版本' }],
  });
  await assert.rejects(
    extension.request('scene-workflow-adopt', adopt(extended)),
    (error) => error.code === 'REVISION_CONFLICT',
  );
  assert.equal(
    (await getDocument(root, manifest, { documentId: existing.id })).document
      .name,
    '用户的新版本',
  );
  console.log(
    'PASS chained extension uses declared tile dependencies, preserves old geometry and rejects original-scene conflicts',
  );

  const constraints = await empty('production-constraints');
  const manual = makeService(factoryPlan);
  const { work: planned } = await run(manual, constraints, {
    autoExecute: false,
  });
  assert.equal(planned.status, 'ready');
  const source = await manual.store.source(planned);
  const state = (await candidateDocument(manual.store, planned)).content;
  const lostDependency = structuredClone(factoryPlan);
  lostDependency.steps.find((s) => s.id === 'configure-door').dependsOn = [];
  assert.throws(
    () => validateWorkflowPlan(lostDependency, planned, source, state),
    /必须依赖/,
  );
  const tooSmall = structuredClone(planned);
  tooSmall.spec.budget.generationCalls = 3;
  assert.throws(
    () => validateWorkflowPlan(factoryPlan, tooSmall, source, state),
    /总次数/,
  );
  const preserve = structuredClone(planned);
  preserve.spec.mapMode = 'preserve';
  assert.throws(
    () => validateWorkflowPlan(factoryPlan, preserve, source, state),
    /未授权/,
  );
  const noPlacement = makePlan([generate('door')]);
  assert.throws(
    () => validateWorkflowPlan(noPlacement, { ...planned, plans: [] }, source, state),
    /可见/,
  );
  await assert.rejects(
    manual.request('scene-workflow-create', {
      commandId: 'bad-extend',
      spec: specFor(constraints, { mapMode: 'extend' }),
    }),
    /已有地图/,
  );
  console.log(
    'PASS explicit production budgets, map policy, visible generated art and resource dependencies are enforced before execution',
  );

  const mapGoal = '创建工厂地图，并向东、向北扩展，原区域保持不变。';
  const firstMap = makePlan([
    step('origin', 'map', {
      operation: 'create',
      name: '工厂',
      prompt: '工厂内部',
      aspectRatio: '1:1',
    }),
    step(
      'east',
      'map',
      {
        operation: 'extend',
        name: '东侧',
        prompt: '向东延续',
        neighborTileKey: '0,0',
        direction: 'right',
      },
      ['origin'],
    ),
  ]);
  firstMap.requirements = [
    { id: 'goal', text: mapGoal, source: 'user', evidence: mapGoal },
  ];
  firstMap.visualCriteria[0].description =
    '工厂地图包含东侧和北侧延伸，原区域保持不变';
  const repairedMap = {
    ...firstMap,
    steps: [
      step('north', 'map', {
        operation: 'extend',
        name: '北侧',
        prompt: '向北延续',
        neighborTileKey: 'wf_east',
        direction: 'up',
      }),
    ],
  };
  const consults = [0, 0];
  let reviews = 0;
  const repairService = new SceneWorkflowService(root, manifest, {
    snapshot,
    requestModel: async (args) => {
      if (args.role.endsWith('reviewer'))
        return opinion(args.data, reviews++ === 0 ? 'defect' : 'met');
      const repairing = Boolean(args.data.repairIssues?.length),
        round = Number(repairing);
      if (args.role !== 'coordinator') return turn('propose');
      if (consults[round] < 2)
        return turn('consult', {
          target: ['appearance', 'layout'][consults[round]++],
          question: '请核对地图制作与本次问题。',
        });
      if (repairing)
        assert.ok(
          args.data.mapSource.tiles.some((tile) => tile.key === 'wf_east'),
          'repair sees actual newly produced tile',
        );
      return turn('finalize', { plan: repairing ? repairedMap : firstMap });
    },
  });
  const repairSource = await empty('production-repair');
  const startCalls = productionRequests;
  const repaired = (
    await run(repairService, repairSource, {
      description: mapGoal,
      budget: {
        planningCalls: 16,
        reviewCalls: 6,
        generationCalls: 3,
        mapTiles: 3,
        revisions: 1,
      },
    })
  ).work;
  checkReady(repaired);
  assert.equal(repaired.repairs, 1);
  assert.equal(repaired.generationCalls.length, 3);
  assert.equal(
    productionRequests - startCalls,
    3,
    'repair adds only the missing tile',
  );
  assert.equal(
    repaired.evidence.filter((e) => e.id.startsWith('seam-')).length,
    3,
    'every review sees actual saved seams, including retained tiles after repair',
  );
  assert.equal(repaired.steps.filter((s) => s.id === 'east').length, 1);
  const generatedFile = path.resolve(
    root,
    repaired.steps[0].mapJob.generationEvidence.image.artifactPath,
  );
  const savedBytes = await readFile(generatedFile);
  await writeFile(generatedFile, Buffer.from('changed evidence'));
  try {
    await assert.rejects(
      repairService.request('scene-workflow-adopt', adopt(repaired)),
    );
  } finally {
    await writeFile(generatedFile, savedBytes);
  }
  assert.equal(
    (await getDocument(root, manifest, { documentId: repairSource.id }))
      .document.revision,
    1,
    'changed generation evidence cannot be adopted',
  );
  await repairService.request('scene-workflow-adopt', adopt(repaired));
  console.log(
    'PASS visual defect repairs only a new map tile from current context; adoption rechecks original production artifacts',
  );

  const lostSource = await empty('production-lost-reply');
  const objectPlan = makePlan([
    generate('door'),
    step(
      'show-door',
      'scene',
      {
        commands: [
          {
            type: 'add-instance',
            materialId: 'door-art',
            instanceId: 'new-door',
            x: 10,
            y: 10,
          },
        ],
      },
      ['art-door'],
    ),
  ]);
  const lostService = makeService(objectPlan, ['appearance', 'layout']);
  failNextRequest = true;
  const lost = (
    await run(lostService, lostSource, {
      mapMode: 'preserve',
      budget: { generationCalls: 2, mapTiles: 0 },
    })
  ).work;
  assert.equal(lost.status, 'attention_required');
  assert.equal(
    (await lostService.request('scene-workflow-get', { workId: lost.id })).work
      .recoverableProduction,
    true,
  );
  const afterLost = productionRequests;
  await assert.rejects(
    lostService.request('scene-workflow-revise', {
      workId: lost.id,
      expectedRevision: lost.revision,
      commandId: 'do-not-repeat',
      clarification: '请继续检查原生成结果。',
    }),
    (error) => error.code === 'SCENE_GENERATION_OUTCOME_UNKNOWN',
  );
  await lostService.request('scene-workflow-resume', {
    workId: lost.id,
    expectedRevision: lost.revision,
    commandId: 'recover-original-production',
  });
  const recovered = await lostService.drain(lost.id);
  assert.equal(recovered.status, 'attention_required');
  assert.equal(
    productionRequests,
    afterLost,
    'recovery checks original job and never issues another generation',
  );
  assert.equal(recovered.generationCalls.length, 1);
  console.log(
    'PASS lost provider reply can be inspected using original task identity and cannot be bypassed by revision',
  );
  delete process.env.SCENE_PRODUCTION_TEST_KEY;
  const keylessSource = await empty('production-needs-key');
  const originOnly = makePlan([
    step('create-with-key', 'map', {
      operation: 'create',
      name: '工厂',
      prompt: '工厂地图',
      aspectRatio: '1:1',
    }),
  ]);
  const keylessService = makeService(originOnly, ['appearance', 'layout']);
  const beforeKeyless = productionRequests;
  const keyless = (
    await run(keylessService, keylessSource, {
      budget: { generationCalls: 1, mapTiles: 1 },
    })
  ).work;
  assert.equal(keyless.errorCode, 'SCENE_GENERATION_CONFIGURATION');
  assert.equal(keyless.generationCalls.length, 0);
  const keylessPublic = (
    await keylessService.request('scene-workflow-get', { workId: keyless.id })
  ).work;
  assert.equal(keylessPublic.configurationRequired, true);
  assert.equal(keylessPublic.recoverableProduction, true);
  assert.equal(productionRequests, beforeKeyless);
  process.env.SCENE_PRODUCTION_TEST_KEY = 'isolated-test-secret';
  await keylessService.request('scene-workflow-resume', {
    workId: keyless.id,
    expectedRevision: keyless.revision,
    commandId: 'configured-continue',
  });
  const configured = await keylessService.drain(keyless.id);
  checkReady(configured);
  assert.equal(configured.steps.length, 1);
  assert.equal(productionRequests - beforeKeyless, 1);
  console.log(
    'PASS missing credentials spend no generation calls and the original map step continues after configuration',
  );
  const unsaved = await service.store.load(work.id);
  const beforeObservation = await observeWorkflow(
    service.store,
    unsaved,
    {},
    'crash-observation',
  );
  const resumed = await service.store.load(work.id);
  const afterObservation = await observeWorkflow(
    service.store,
    resumed,
    {},
    'crash-observation',
  );
  assert.equal(
    JSON.stringify(afterObservation.metadata),
    JSON.stringify(beforeObservation.metadata),
    'orphan immutable evidence is recovered exactly instead of rendered into conflicting paths',
  );
  console.log(
    'PASS rendered evidence recovers from a crash between immutable evidence and task persistence',
  );
  console.log(
    'Scene production integration: 7 scenarios passed with isolated model and image providers.',
  );
} finally {
  globalThis.fetch = originalFetch;
  if (previousKey === undefined) delete process.env.SCENE_PRODUCTION_TEST_KEY;
  else process.env.SCENE_PRODUCTION_TEST_KEY = previousKey;
}
