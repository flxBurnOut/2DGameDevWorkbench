import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createScene } from '../../features/scene-composer/model.mjs';
import {
  createDocument,
  getDocument,
} from '../../lib/workbench/editor-documents.mjs';
import {
  loadManifest,
  repositoryRoot,
  readTask,
  persistTask,
} from '../../lib/workbench/runtime.mjs';
import {
  SceneWorkflowStore,
  hash,
} from '../../lib/workbench/scene-workflow-store.mjs';
import {
  executeGenerationStep,
  freezeWorkflowGeneration,
  generationStepSchema,
  getWorkflowGenerationSettings,
  runWorkflowImageJob,
  validateGenerationStep,
  verifyWorkflowGenerationEvidence,
} from '../../lib/workbench/scene-workflow-generation.mjs';

const root = repositoryRoot;
const manifest = await loadManifest();
const mapCapability = manifest.capabilities.find(
  (item) => item.id === 'map-stitcher',
);
const propCapability = manifest.capabilities.find(
  (item) => item.id === 'image-assets',
);
const provider = (id, model) => ({
  id,
  name: id,
  model,
  protocol: 'openai-images-edits',
  endpoint: `http://127.0.0.1:1/${id}/edits`,
  generationEndpoint: `http://127.0.0.1:1/${id}/generations`,
  apiKeyEnv: 'SCENE_WORKFLOW_FIXTURE_GENERATION_KEY',
});
mapCapability.connector = {
  type: 'local-adapter',
  adapter: 'map-stitcher',
  providers: [
    provider('gpt-image-2.6', 'fixture-object-model'),
    provider('fixture-map', 'fixture-map-model'),
  ],
  defaultProvider: 'fixture-map',
};
mapCapability.inputSchema.properties.provider.enum = [
  'gpt-image-2.6',
  'fixture-map',
];
propCapability.connector = {
  type: 'local-adapter',
  adapter: 'image-assets',
  providerSource: 'map-stitcher',
  providerIds: ['gpt-image-2.6'],
  defaultProvider: 'gpt-image-2.6',
};
propCapability.inputSchema.properties.provider.enum = ['gpt-image-2.6'];
const previousKey = process.env.SCENE_WORKFLOW_FIXTURE_GENERATION_KEY;
process.env.SCENE_WORKFLOW_FIXTURE_GENERATION_KEY =
  'fixture-scene-generation-secret';
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const calls = [];
let mode = 'success',
  blocked,
  entered,
  sequence = 0;
const png = async (width, height, transparent = false) => {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 50;
    data[offset + 1] = 110;
    data[offset + 2] = 140;
    data[offset + 3] =
      transparent && (offset / 4) % width < width / 4 ? 0 : 255;
  }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
};
const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
const tests = [],
  test = (name, run) => tests.push([name, run]);
const input = (suffix = '') => ({
  purpose: 'object',
  materialId: `lamp${suffix}`,
  definitionId: `lamp-definition${suffix}`,
  name: '灯',
  prompt: '透明背景上的一盏旧灯',
});
const step = (suffix = '') => ({
  id: `make-lamp${suffix}`,
  kind: 'generate',
  input: JSON.stringify(input(suffix)),
});
const propRequest = (purpose = 'fixture') => ({
  purpose,
  capability: 'image-assets',
  input: { operation: 'generate-prop', name: '灯', prompt: '一盏透明背景灯' },
});
async function fixture(budget = 4) {
  const number = ++sequence;
  const store = new SceneWorkflowStore(root, manifest);
  const scene = createScene('生成测试');
  scene.id = `generation-source-${number}`;
  const source = (
    await createDocument(root, manifest, {
      kind: 'scene',
      documentId: scene.id,
      commandId: `original-${number}`,
      content: scene,
    })
  ).document;
  const work = {
    schemaVersion: 1,
    id: `generation-${number}`,
    revision: 1,
    plans: [{ revision: 1 }],
    spec: { documentId: scene.id, budget: { generationCalls: budget } },
    generationCalls: [],
    generationConfiguration: freezeWorkflowGeneration(manifest, {
      prop: 'gpt-image-2.6',
      map: 'fixture-map',
    }),
    steps: [],
  };
  await createDocument(root, store.candidateManifest(work), {
    kind: 'scene',
    documentId: scene.id,
    commandId: `candidate-${number}`,
    content: scene,
  });
  const persist = async () => store.save(work);
  await persist();
  return { store, work, source, persist };
}
const candidate = ({ store, work }) =>
  getDocument(root, store.candidateManifest(work), {
    documentId: work.spec.documentId,
  }).then((result) => result.document);

test('typed object generation projects metadata and rejects paths, providers and invalid dimensions', () => {
  const parsed = generationStepSchema.parse(input());
  assert.equal(parsed.width, 1024);
  assert.equal(parsed.visualWidth, 64);
  for (const invalid of [
    { provider: 'gpt-image-2.6' },
    { references: ['secret.png'] },
    { purpose: 'background' },
    { width: 1000 },
    { visualWidth: 0 },
  ])
    assert.equal(
      generationStepSchema.safeParse({ ...input(), ...invalid }).success,
      false,
    );
  const scene = validateGenerationStep(createScene(), input());
  assert.equal(scene.materials[0].project.assets.length, 0);
  assert.equal(scene.materials[0].project.objects[0].visual.assetId, '');
  assert.throws(() => validateGenerationStep(scene, input()), /materialId/);
});

test('provider snapshots preserve distinct registered production models and expose no credentials', () => {
  const frozen = freezeWorkflowGeneration(manifest, {
    prop: 'gpt-image-2.6',
    map: 'fixture-map',
  });
  assert.equal(
    freezeWorkflowGeneration(manifest).prop.provider,
    'gpt-image-2.6',
  );
  assert.equal(frozen.prop.model, 'fixture-object-model');
  assert.equal(frozen.map.model, 'fixture-map-model');
  assert.equal(frozen.prop.configuredAtCreation, true);
  assert.equal(
    JSON.stringify(frozen).includes('fixture-scene-generation-secret'),
    false,
  );
  const metadata = getWorkflowGenerationSettings(manifest);
  assert.equal(metadata.prop.providers.length, 1);
  assert.equal(metadata.map.providers.length, 2);
  assert.equal(
    JSON.stringify(metadata).includes('fixture-scene-generation-secret'),
    false,
  );
  assert.throws(
    () => freezeWorkflowGeneration(manifest, { prop: 'unregistered' }),
    /未登记/,
  );
  assert.throws(
    () => freezeWorkflowGeneration(manifest, { apiKey: 'forbidden' }),
    /选择无效/,
  );
  const registered = mapCapability.connector.providers.find(
    (item) => item.id === 'fixture-map',
  );
  const endpoint = registered.endpoint;
  registered.endpoint += '?api_key=fixture-query-secret';
  try {
    assert.throws(() => freezeWorkflowGeneration(manifest), /内嵌认证/);
  } finally {
    registered.endpoint = endpoint;
  }
});

test('new artwork uses the frozen prop pipeline and saves CAS, usage, hashes and replayable material provenance', async () => {
  const f = await fixture();
  const receipt = { id: step().id };
  f.work.steps.push(receipt);
  const before = calls.length;
  const frozenEndpoint = f.work.generationConfiguration.prop.generationEndpoint;
  const registered = mapCapability.connector.providers.find(
    (item) => item.id === 'gpt-image-2.6',
  );
  const previous = {
    model: registered.model,
    endpoint: registered.generationEndpoint,
  };
  registered.model = 'later-model';
  registered.generationEndpoint = 'http://127.0.0.1:2/new-generations';
  let result;
  try {
    result = await executeGenerationStep(
      f.store,
      f.work,
      receipt,
      step(),
      f.persist,
    );
  } finally {
    registered.model = previous.model;
    registered.generationEndpoint = previous.endpoint;
  }
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).url, frozenEndpoint);
  assert.equal(calls.at(-1).fields.model, 'fixture-object-model');
  assert.equal(calls.at(-1).fields.background, 'transparent');
  assert.equal(result.document.revision, 2);
  assert.equal(
    (await getDocument(root, manifest, { documentId: f.source.id })).document
      .revision,
    1,
  );
  const asset = result.document.content.materials[0].project.assets[0];
  assert.equal(asset.generation.sourceTaskId, receipt.generationJob.taskId);
  assert.equal(
    asset.generation.sha256,
    hash(Buffer.from(asset.source.split(',')[1], 'base64')),
  );
  assert.equal(
    receipt.generationEvidence.image.sha256,
    asset.generation.sha256,
  );
  assert.equal(receipt.generationEvidence.usage.requestId, 'req_scene_fixture');
  assert.equal(receipt.generationEvidence.usage.usage.total_tokens, 42);
  assert.ok(
    receipt.generationEvidence.artifacts.some((item) =>
      item.artifactPath.endsWith('/provider-response.png'),
    ),
  );
  assert.equal(
    JSON.stringify(f.work).includes('fixture-scene-generation-secret'),
    false,
  );
  const replay = await executeGenerationStep(
    f.store,
    f.work,
    receipt,
    step(),
    f.persist,
  );
  assert.equal(replay.document.revision, 2);
  assert.equal(calls.length, before + 1);
  assert.equal(f.work.generationCalls.length, 1);
  assert.equal(f.work.generationCalls[0].submitted, true);
  assert.equal(
    (await verifyWorkflowGenerationEvidence(f.store, f.work)).calls.length,
    1,
  );
  assert.ok(
    await readFile(
      path.join(
        f.store.directory(f.work.id),
        `generation-request-${receipt.generationJob.requestId}.json`,
      ),
    ),
  );
  assert.ok(
    await readFile(
      path.join(
        f.store.directory(f.work.id),
        `generation-evidence-${receipt.generationJob.requestId}.json`,
      ),
    ),
  );
});

test('new art and native map origin share the same lifetime call budget', async () => {
  const f = await fixture(2);
  const propReceipt = { id: 'budget-object' },
    mapReceipt = { id: 'budget-map' };
  await runWorkflowImageJob(
    f.store,
    f.work,
    propReceipt,
    propRequest('budget-object'),
    f.persist,
  );
  const map = await runWorkflowImageJob(
    f.store,
    f.work,
    mapReceipt,
    {
      purpose: 'map-origin',
      capability: 'map-stitcher',
      input: {
        operation: 'generate-origin',
        prompt: '2D 工厂地图',
        aspectRatio: '3:2',
      },
    },
    f.persist,
  );
  assert.equal(map.image.kind, 'background');
  assert.equal(map.image.width, 1536);
  assert.equal(map.image.height, 1024);
  assert.equal(map.evidence.model, 'fixture-map-model');
  assert.equal(map.image.sha256, hash(map.image.bytes));
  assert.ok(map.image.artifactPath.endsWith('/generated-origin.png'));
  assert.equal(map.evidence.usage.requestId, 'req_scene_fixture');
  assert.equal(
    (await verifyWorkflowGenerationEvidence(f.store, f.work)).calls.length,
    2,
  );
  const count = calls.length;
  await assert.rejects(
    runWorkflowImageJob(
      f.store,
      f.work,
      { id: 'revision-extra' },
      propRequest('revision-extra'),
      f.persist,
    ),
    (error) => error.code === 'SCENE_GENERATION_BUDGET_EXHAUSTED',
  );
  assert.equal(calls.length, count);
  assert.equal(f.work.generationCalls.length, 2);
});

test('an unconfigured required production line stops before reserving a generation call', async () => {
  const f = await fixture();
  const saved = process.env.SCENE_WORKFLOW_FIXTURE_GENERATION_KEY;
  const count = calls.length;
  delete process.env.SCENE_WORKFLOW_FIXTURE_GENERATION_KEY;
  try {
    await assert.rejects(
      runWorkflowImageJob(
        f.store,
        f.work,
        { id: 'missing-map-key' },
        {
          purpose: 'missing-map-key',
          capability: 'map-stitcher',
          input: { operation: 'generate-origin', prompt: '2D 地图' },
        },
        f.persist,
      ),
      (error) => error.code === 'SCENE_GENERATION_CONFIGURATION',
    );
    assert.equal(f.work.generationCalls.length, 0);
    assert.equal(calls.length, count);
  } finally {
    process.env.SCENE_WORKFLOW_FIXTURE_GENERATION_KEY = saved;
  }
});

test('native map extension keeps exact template pixels and rejects arbitrary source paths', async () => {
  const f = await fixture();
  const bytes = await png(1024, 1024, true);
  const request = {
    purpose: 'extend:1,0',
    capability: 'map-stitcher',
    input: {
      operation: 'generate-layer',
      prompt: '向右扩展工厂地图',
      image: dataUrl(bytes),
      tile: { key: '1,0', x: 1, y: 0, w: 1, h: 1 },
      layer: 'overall',
      mask_mode: 'white',
    },
  };
  const result = await runWorkflowImageJob(
    f.store,
    f.work,
    { id: 'extend-right' },
    request,
    f.persist,
  );
  const source = await sharp(bytes).ensureAlpha().raw().toBuffer();
  const actual = await sharp(result.image.bytes).ensureAlpha().raw().toBuffer();
  for (let offset = 0; offset < source.length; offset += 4)
    if (source[offset + 3])
      assert.deepEqual(
        actual.subarray(offset, offset + 4),
        source.subarray(offset, offset + 4),
      );
  assert.ok(result.image.artifactPath.endsWith('/generated-layer.png'));
  const count = calls.length;
  await assert.rejects(
    runWorkflowImageJob(
      f.store,
      f.work,
      { id: 'path-injection' },
      {
        ...request,
        input: { ...request.input, image: '/outside/private.png' },
      },
      f.persist,
    ),
  );
  await assert.rejects(
    runWorkflowImageJob(
      f.store,
      f.work,
      { id: 'provider-injection' },
      { ...request, input: { ...request.input, provider: 'fixture-map' } },
      f.persist,
    ),
  );
  assert.equal(calls.length, count);
});

test('native Gemini and Hunyuan save reported IDs and numeric usage, with explicit unavailable counters', async () => {
  const registered = mapCapability.connector.providers.find(
    (item) => item.id === 'fixture-map',
  );
  const previous = { ...registered };
  try {
    for (const protocol of [
      'gemini-generate-content',
      'hunyuan-tokenhub-image',
    ]) {
      Object.assign(registered, { protocol, model: `fixture-${protocol}` });
      for (const metadata of [true, false]) {
        mode = metadata ? 'success' : 'no-metadata';
        const f = await fixture();
        const result = await runWorkflowImageJob(
          f.store,
          f.work,
          { id: 'protocol-map' },
          {
            purpose: 'protocol-map',
            capability: 'map-stitcher',
            input: { operation: 'generate-origin', prompt: '2D 工厂地图' },
          },
          f.persist,
        );
        const usage = result.evidence.usage;
        assert.equal(usage.protocol, protocol);
        assert.equal(usage.requestIdAvailable, metadata);
        assert.equal(usage.usageAvailable, metadata);
        assert.equal(usage.usage?.total_tokens ?? null, metadata ? 42 : null);
        assert.equal(usage.billingAmount, null);
        assert.equal(
          JSON.stringify(usage).includes('untrusted-upstream-field'),
          false,
        );
        assert.equal(
          (await verifyWorkflowGenerationEvidence(f.store, f.work)).calls
            .length,
          1,
        );
      }
    }
  } finally {
    Object.assign(registered, previous);
    mode = 'success';
  }
});

test('Gemini and Hunyuan refusals and unknown submissions preserve safe original receipts without echoing provider bodies or endpoints', async () => {
  const registered = mapCapability.connector.providers.find(
    (item) => item.id === 'fixture-map',
  );
  const previous = { ...registered };
  try {
    for (const protocol of [
      'gemini-generate-content',
      'hunyuan-tokenhub-image',
    ]) {
      Object.assign(registered, { protocol, model: `fixture-${protocol}` });
      for (const [failure, status, code, unresolved] of [
        ['http-refusal', 'failed', 'SCENE_GENERATION_ATTENTION', false],
        [
          'server-error',
          'attention_required',
          'SCENE_GENERATION_OUTCOME_UNKNOWN',
          true,
        ],
        [
          'request-timeout',
          'attention_required',
          'SCENE_GENERATION_OUTCOME_UNKNOWN',
          true,
        ],
        [
          'timeout',
          'attention_required',
          'SCENE_GENERATION_OUTCOME_UNKNOWN',
          true,
        ],
        [
          'network-error',
          'attention_required',
          'SCENE_GENERATION_OUTCOME_UNKNOWN',
          true,
        ],
      ]) {
        mode = failure;
        const f = await fixture(),
          receipt = { id: failure };
        const request = {
          purpose: failure,
          capability: 'map-stitcher',
          input: { operation: 'generate-origin', prompt: '2D 工厂地图' },
        };
        const count = calls.length;
        await assert.rejects(
          runWorkflowImageJob(f.store, f.work, receipt, request, f.persist),
          (error) => error.code === code,
        );
        const task = await readTask(manifest, receipt.generationJob.taskId);
        assert.equal(task.status, status);
        assert.equal(
          JSON.stringify(task).includes('fixture-scene-generation-secret'),
          false,
        );
        assert.equal(task.error.includes('untrusted-provider-body'), false);
        assert.equal(task.error.includes('http://'), false);
        assert.equal(task.error.includes('fixture-map/edits'), false);
        const audit = await verifyWorkflowGenerationEvidence(f.store, f.work);
        assert.equal(audit.pending[0].unresolved, unresolved);
        for (const filename of task.outputs) {
          const content = await readFile(path.resolve(root, filename), 'utf8');
          assert.equal(
            content.includes('fixture-scene-generation-secret'),
            false,
          );
          assert.equal(content.includes('untrusted-provider-body'), false);
        }
        mode = 'success';
        await assert.rejects(
          runWorkflowImageJob(f.store, f.work, receipt, request, f.persist),
          (error) => error.code === code,
        );
        assert.equal(
          calls.length,
          count + 1,
          'failure recovery observes the same task without another submission',
        );
      }
    }
  } finally {
    Object.assign(registered, previous);
    mode = 'success';
  }
});

test('unknown upstream outcomes retain the original task and never submit again', async () => {
  const f = await fixture();
  const receipt = { id: 'unknown' },
    request = propRequest('unknown');
  mode = 'network-error';
  const count = calls.length;
  await assert.rejects(
    runWorkflowImageJob(f.store, f.work, receipt, request, f.persist),
    (error) => error.code === 'SCENE_GENERATION_OUTCOME_UNKNOWN',
  );
  mode = 'success';
  const taskId = receipt.generationJob.taskId;
  assert.equal((await readTask(manifest, taskId)).status, 'attention_required');
  await assert.rejects(
    runWorkflowImageJob(f.store, f.work, receipt, request, f.persist),
    (error) => error.code === 'SCENE_GENERATION_OUTCOME_UNKNOWN',
  );
  assert.equal(calls.length, count + 1);
  assert.equal(receipt.generationJob.taskId, taskId);
  assert.equal(f.work.generationCalls.length, 1);
  const audited = await verifyWorkflowGenerationEvidence(f.store, f.work);
  assert.equal(audited.pending[0].unresolved, true);
});

test('lost receipt task identity recovers the original allocation; changed intents and missing identity never resubmit', async () => {
  const f = await fixture();
  const receipt = { id: 'recover' },
    request = propRequest('recover');
  const result = await runWorkflowImageJob(
    f.store,
    f.work,
    receipt,
    request,
    f.persist,
  );
  const count = calls.length,
    taskId = result.task.id;
  delete receipt.generationJob.taskId;
  delete f.work.generationCalls[0].taskId;
  const replay = await runWorkflowImageJob(
    f.store,
    f.work,
    receipt,
    request,
    f.persist,
  );
  assert.equal(replay.task.id, taskId);
  assert.equal(calls.length, count);
  await assert.rejects(
    runWorkflowImageJob(
      f.store,
      f.work,
      receipt,
      { ...request, input: { ...request.input, prompt: 'changed' } },
      f.persist,
    ),
    (error) => error.code === 'SCENE_GENERATION_INTENT_CHANGED',
  );
  delete receipt.generationJob.taskId;
  const originalTask = await readTask(manifest, taskId);
  delete originalTask.sceneWorkflowGeneration;
  await persistTask(manifest, originalTask);
  await assert.rejects(
    runWorkflowImageJob(f.store, f.work, receipt, request, f.persist),
    (error) => error.code === 'SCENE_GENERATION_OUTCOME_UNKNOWN',
  );
  assert.equal(calls.length, count);
});

test('a persistence failure after task allocation cannot turn recovery into a paid submission', async () => {
  const f = await fixture();
  const receipt = { id: 'prepare-write-failure' },
    request = propRequest('prepare-write-failure');
  const count = calls.length;
  let saves = 0;
  const persist = async () => {
    if (++saves === 2) throw new Error('fixture receipt write interrupted');
    await f.persist();
  };
  await assert.rejects(
    runWorkflowImageJob(f.store, f.work, receipt, request, persist),
    (error) => error.code === 'SCENE_GENERATION_ATTENTION',
  );
  assert.equal(calls.length, count);
  const original = receipt.generationJob.taskId;
  delete receipt.generationJob.taskId;
  await assert.rejects(
    runWorkflowImageJob(f.store, f.work, receipt, request, f.persist),
    (error) => error.code === 'SCENE_GENERATION_ATTENTION',
  );
  assert.equal(receipt.generationJob.taskId, original);
  assert.equal(calls.length, count);
});

test('pause observes a live original job and resumes it without another submission', async () => {
  const f = await fixture();
  const receipt = { id: 'pause-generation' },
    request = propRequest('pause-generation');
  let release;
  blocked = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const count = calls.length;
  const pending = runWorkflowImageJob(
    f.store,
    f.work,
    receipt,
    request,
    f.persist,
  );
  await started;
  await f.store.pause(f.work.id, 'pause-generation');
  assert.equal((await pending).paused, true);
  release();
  blocked = null;
  entered = null;
  await f.store.clearPause(f.work.id);
  const result = await runWorkflowImageJob(
    f.store,
    f.work,
    receipt,
    request,
    f.persist,
  );
  assert.equal(result.task.status, 'completed');
  assert.equal(calls.length, count + 1);
});

test('completed evidence tampering cannot be adopted or trigger a replacement generation', async () => {
  const f = await fixture();
  const receipt = { id: 'tamper' },
    request = propRequest('tamper');
  const result = await runWorkflowImageJob(
    f.store,
    f.work,
    receipt,
    request,
    f.persist,
  );
  const count = calls.length;
  const file = path.join(root, result.evidence.image.artifactPath);
  const bytes = await readFile(file);
  await writeFile(file, await png(1024, 1024, true));
  // Change a declared raw/diagnostic artifact as well as image bytes; a copied
  // image with the same dimensions must still fail its saved evidence hash.
  const diagnostic = result.evidence.artifacts.find((item) =>
    item.artifactPath.endsWith('/generation-diagnostics.json'),
  );
  await writeFile(
    path.join(root, diagnostic.artifactPath),
    JSON.stringify({ replaced: true }),
  );
  await assert.rejects(
    runWorkflowImageJob(f.store, f.work, receipt, request, f.persist),
    (error) => error.code === 'SCENE_GENERATION_EVIDENCE_CHANGED',
  );
  await assert.rejects(
    verifyWorkflowGenerationEvidence(f.store, f.work),
    (error) => error.code === 'SCENE_GENERATION_EVIDENCE_CHANGED',
  );
  await writeFile(file, bytes);
  assert.equal(calls.length, count);
  assert.equal((await candidate(f)).revision, 1);
});

try {
  globalThis.setTimeout = (callback, milliseconds, ...args) =>
    originalSetTimeout(
      callback,
      milliseconds === 1000 ? 10 : milliseconds,
      ...args,
    );
  globalThis.fetch = async (url, init) => {
    assert.ok(
      typeof url === 'string' && url.startsWith('http://127.0.0.1:1/'),
      'test must never reach a production endpoint',
    );
    if (url.endsWith('/asset')) return new Response(await png(1024, 1024));
    const fields =
      init.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : JSON.parse(init.body);
    calls.push({ url, fields });
    entered?.();
    if (blocked) await blocked;
    if (mode === 'timeout')
      throw new DOMException(
        'untrusted-provider-body fixture-scene-generation-secret',
        'AbortError',
      );
    if (mode === 'network-error')
      throw new Error('fixture secret must not leak');
    if (['http-refusal', 'server-error', 'request-timeout'].includes(mode))
      return Response.json(
        {
          error: {
            message:
              'untrusted-provider-body fixture-scene-generation-secret http://private-provider.example/secret',
          },
        },
        {
          status:
            mode === 'http-refusal' ? 401 : mode === 'server-error' ? 503 : 408,
        },
      );
    if (fields.contents)
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    data: (await png(1024, 1024)).toString('base64'),
                  },
                },
              ],
            },
          },
        ],
        ...(mode === 'no-metadata'
          ? {}
          : {
              responseId: 'req_gemini_fixture',
              usageMetadata: {
                promptTokenCount: 12,
                candidatesTokenCount: 30,
                totalTokenCount: 42,
                unknown: 'untrusted-upstream-field',
              },
            }),
      });
    if (fields.model === 'fixture-hunyuan-tokenhub-image')
      return Response.json({
        data: [{ url: 'http://127.0.0.1:1/fixture-map/asset' }],
        ...(mode === 'no-metadata'
          ? {}
          : {
              request_id: 'req_hunyuan_fixture',
              usage: {
                input_tokens: 12,
                output_tokens: 30,
                total_tokens: 42,
                unknown: 'untrusted-upstream-field',
              },
            }),
      });
    const [width, height] = fields.size.split('x').map(Number);
    const bytes = await png(width, height, fields.background === 'transparent');
    return Response.json(
      {
        data: [{ b64_json: bytes.toString('base64') }],
        usage: { input_tokens: 12, output_tokens: 30, total_tokens: 42 },
      },
      { headers: { 'x-request-id': 'req_scene_fixture' } },
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
    `Scene generation: ${tests.length} scenarios passed (isolated mock providers only).`,
  );
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  if (previousKey === undefined)
    delete process.env.SCENE_WORKFLOW_FIXTURE_GENERATION_KEY;
  else process.env.SCENE_WORKFLOW_FIXTURE_GENERATION_KEY = previousKey;
}
