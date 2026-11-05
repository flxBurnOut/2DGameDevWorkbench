import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  root,
  manifest,
  snapshot,
  fixture,
  turn,
  step,
  plan,
  planner,
  opinion,
} from './fixtures.mjs';
import { SceneWorkflowService } from '../../lib/workbench/scene-workflows.mjs';
import {
  candidateDocument,
  validateWorkflowPlan,
  assertProtected,
  observeWorkflow,
} from '../../lib/workbench/scene-workflow-execution.mjs';
import {
  applyDocumentCommands,
  getDocument,
} from '../../lib/workbench/editor-documents.mjs';
import { hash } from '../../lib/workbench/scene-workflow-store.mjs';
import { acceptanceSchema } from '../../lib/workbench/scene-workflow-contract.mjs';
import { sceneSummary } from '../../lib/workbench/scene-workflow-prompts.mjs';
import { splitFixture } from '../scene-composer/map-split-fixture.mjs';
import { createScene, addMaterial, addInstance } from '../../features/scene-composer/model.mjs';
import { observeScene } from '../../lib/workbench/scene-observation.mjs';

const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('Real provider requests are forbidden in this suite');
};
const tests = [],
  test = (name, fn) => tests.push([name, fn]);
const make = (requestModel) =>
  new SceneWorkflowService(root, manifest, { snapshot, requestModel });
async function launch(service, name, spec = {}) {
  const f = await fixture(name);
  const input = { commandId: `workflow-${name}`, spec: { ...f.spec, ...spec } };
  const { work } = await service.request('scene-workflow-create', input);
  return { ...f, input, work: await service.drain(work.id) };
}
const readSource = (id) =>
  getDocument(root, manifest, { documentId: id }).then((r) => r.document);
const adoption = (work) => ({
  workId: work.id,
  commandId: `adopt-${work.id}`,
  expectedRevision: work.revision,
  candidateRevision: work.candidateRevision,
  candidateHash: work.candidateHash,
});
const movePlan = plan([
  step('place', 'scene', {
    commands: [{ type: 'move-instances', ids: ['gate'], dx: 4 }],
  }),
]);
test('split protection, mask summaries and cumulative revisions survive collaboration', async () => {
  const scene = await splitFixture();
  const tree = scene.mapSplit.elements[1];
  tree.locked = true;
  tree.parts[0].mask = tree.parts[0].source;
  const current = structuredClone(scene);
  current.mapSplit.elements[1].included = false;
  const spec = { description: '拉杆开门', protectedInstanceIds: [], editableMapLayerIds: [] };
  assert.throws(() => assertProtected({ content: scene }, current, spec), /锁定的分层/);
  const summary = JSON.stringify(sceneSummary({ content: scene }));
  assert.ok(!summary.includes('base64,'));
  const revised = structuredClone(movePlan);
  revised.requirements.push({ id: 'lamp', text: '保留灯', source: 'user', evidence: '保留灯' });
  revised.visualCriteria.push({ id: 'lamp-visible', description: '灯可见', requirementIds: ['lamp'], region: null });
  const work = { spec, steps: [], plans: [{ plan: movePlan }, { plan: revised }], clarifications: [{ text: '保留灯' }] };
  assert.throws(() => validateWorkflowPlan(movePlan, work, { document: { content: scene } }, scene), /已确认需求/);
  const removedCriterion = { ...revised, visualCriteria: movePlan.visualCriteria };
  assert.throws(() => validateWorkflowPlan(removedCriterion, work, { document: { content: scene } }, scene), /原视觉验收/);
});
test('an interrupted source-object observation reuses the exact recorded evidence', async () => {
  const service = make(planner(movePlan));
  const { work } = await launch(service, 'source-observation');
  const before = await service.store.load(work.id);
  const source = (await service.store.source(before)).materials[0];
  const options = { sourceObject: { documentId: source.id, definitionId: source.content.objects[0].definitionId } };
  const saved = await observeWorkflow(service.store, before, options, 'source-check');
  const restored = await observeWorkflow(service.store, await service.store.load(work.id), options, 'source-check');
  assert.deepEqual(restored.metadata, saved.metadata);

  // Reproduce the orphan written by the previous exporter with random IDs.
  const originalWork = await service.store.load(work.id);
  const scene = createScene(source.name);
  scene.id = saved.metadata.documentId;
  const material = addMaterial(scene, source.content, options.sourceObject.definitionId);
  material.project.assets = source.content.assets;
  addInstance(scene, material.id, 0, 0);
  const contentHash = hash(scene), label = 'older-source';
  const raw = await observeScene(root, service.store.candidateManifest(work), {
    id: scene.id, kind: 'scene', revision: source.revision, content: scene, contentHash,
  }, {});
  const old = {
    id: `${label}-${originalWork.evidence.length + 1}`,
    requestHash: hash({ documentId: scene.id, revision: source.revision, contentHash, options: {}, label }),
    ...raw, images: raw.images.map(({ data: _data, ...info }) => info),
  };
  await service.store.freeze(work.id, `evidence-${old.id}`, old);
  assert.deepEqual((await observeWorkflow(service.store, originalWork, options, label)).metadata, old);
});

test('behavior acceptance cannot pass by listing an instance without a state assertion', () => {
  assert.equal(
    acceptanceSchema.safeParse({
      id: 'weak',
      description: '没有状态的检查',
      requirementIds: ['goal'],
      events: [],
      expectEvents: [],
      expectStates: [{ instanceId: 'gate' }],
    }).success,
    false,
  );
});

test('dynamic consultation, extra observation, isolated object/image execution, replay and adoption', async () => {
  const gatePlan = plan(
    [
      step('derive-lever', 'object', {
        materialId: 'lever-material',
        definitionId: 'lever-definition',
        name: '拉杆',
        source: { kind: 'scene', materialId: 'gate-material' },
        commands: [
          {
            type: 'set-behavior',
            definitionId: 'lever-definition',
            behavior: {
              kind: 'toggle',
              initialToggle: false,
              states: [
                {
                  name: '关',
                  appearance: {
                    visible: true,
                    solidEnabled: true,
                    tint: '#ffffff',
                    assetId: '',
                  },
                },
                {
                  name: '开',
                  appearance: {
                    visible: true,
                    solidEnabled: true,
                    tint: '#ffffff',
                    assetId: '',
                  },
                },
              ],
            },
          },
        ],
      }),
      step(
        'place-lever',
        'scene',
        {
          commands: [
            {
              type: 'add-instance',
              materialId: 'lever-material',
              instanceId: 'lever',
              x: 40,
              y: 100,
            },
            {
              type: 'add-link',
              link: {
                id: 'lever-gate',
                sourceInstanceId: 'lever',
                event: 'toggled',
                targetInstanceId: 'gate',
                action: 'set_toggle',
                value: 'source_toggle',
                enabled: true,
              },
            },
          ],
        },
        ['derive-lever'],
      ),
      step(
        'weather-gate',
        'image',
        {
          target: {
            kind: 'scene-instance',
            instanceId: 'gate',
            slot: 'visual',
          },
          region: { type: 'rectangle', x: 2, y: 2, width: 8, height: 8 },
          operation: { type: 'palette-map', pairs: [{ from: '#996633', to: '#665544' }, { from: '#665544', to: '#996633' }] },
          preserveAlpha: true,
        },
        ['place-lever'],
      ),
    ],
    [
      {
        id: 'open',
        description: '拉杆打开门并关闭碰撞',
        requirementIds: ['goal'],
        events: [{ type: 'request', instanceId: 'lever' }],
        expectEvents: [{ name: 'link_applied', count: 1 }],
        expectStates: [
          {
            instanceId: 'gate',
            toggleState: true,
            visible: false,
            solidEnabled: false,
          },
        ],
      },
    ],
  );
  const script = [
    [
      'coordinator',
      turn('consult', { target: 'layout', question: '门和拉杆应该如何放置？' }),
    ],
    [
      'layout',
      turn('consult', {
        target: 'behavior',
        question: '门缩小后交互和碰撞是否要调整？',
      }),
    ],
    ['behavior', turn('propose')],
    ['layout', turn('propose')],
    [
      'coordinator',
      turn('consult', {
        target: 'appearance',
        question: '检查已有素材与门边做旧区域。',
      }),
    ],
    [
      'appearance',
      turn('observe', {
        observation: {
          region: { x: 100, y: 40, width: 48, height: 72 },
          events: null,
          sourceObject: null,
        },
      }),
    ],
    ['appearance', turn('propose')],
    ['coordinator', turn('finalize', { plan: gatePlan })],
  ];
  let calls = 0;
  const service = make(async (args) => {
    calls++;
    assert.ok(args.images.length >= 2);
    if (args.role.endsWith('reviewer')) {
      assert.equal(
        args.data.peerMessages,
        undefined,
        'independent review cannot see planner self-evaluation',
      );
      assert.ok(args.data.technical.passed);
      return opinion(args.data);
    }
    const [role, response] = script.shift();
    assert.equal(args.role, role);
    if (role === 'behavior') assert.equal(args.data.peerMessages.length, 0);
    return response;
  });
  const { work, document, input } = await launch(service, 'full');
  assert.equal(
    work.status,
    'ready_to_adopt',
    `${work.message}\n${JSON.stringify(work.messages.filter((m) => m.role === 'validator'))}`,
  );
  assert.equal(
    work.imageCalls.length,
    0,
    'local pixel edit does not spend generation budget',
  );
  assert.equal(work.steps.length, 3);
  assert.equal(work.calls.length, 10);
  assert.equal(
    (await readSource(document.id)).revision,
    1,
    'candidate production leaves original untouched',
  );
  const candidate = await candidateDocument(service.store, work);
  assert.equal(candidate.content.instances.length, 2);
  assert.notEqual(
    candidate.content.instances[0].materialId,
    'gate-material',
    'image adoption derives only the selected instance',
  );
  assert.equal(candidate.content.instances[1].materialId, 'lever-material');
  assert.equal(work.steps[2].imageEvidence.diff.changedOutsideRegion, 0);
  const placed = await service.request('scene-workflow-observe', { workId: work.id, imageStepId: work.steps[2].id });
  assert.equal(placed.evidence.candidateSha256, work.steps[2].imageEvidence.sha256);
  assert.deepEqual(placed.images.map(i => i.role), ['base', 'candidate']);
  const replay = work.evidence.find((e) => e.id.startsWith('replay-'));
  assert.equal(replay.objects.find((o) => o.id === 'gate').solidEnabled, false);
  assert.equal(replay.objects.find((o) => o.id === 'gate').visible, false);
  const observed = await service.request('scene-workflow-observe', {
    workId: work.id,
    evidenceId: replay.id,
  });
  assert.ok(
    observed.images.every(
      (i) => hash(Buffer.from(i.data, 'base64')) === i.sha256,
    ),
  );
  assert.equal(
    (await service.request('scene-workflow-create', input)).replayed,
    true,
  );
  const adopt = adoption(work);
  const adopted = await service.request('scene-workflow-adopt', adopt);
  assert.equal(adopted.work.status, 'completed');
  assert.equal(adopted.adoption.revision, 2);
  assert.equal(
    (await service.request('scene-workflow-adopt', adopt)).replayed,
    true,
  );
  assert.equal(
    calls,
    10,
    'reads, duplicate create and adoption never dispatch models',
  );
  await assert.rejects(
    service.request('scene-workflow-create', {
      ...input,
      spec: { ...input.spec, description: 'different intent' },
    }),
    (e) => e.code === 'COMMAND_ID_REUSED',
  );
});

test('manual execution checks plan identity and source CAS without overwriting later edits', async () => {
  const service = make(planner(movePlan));
  const { work } = await launch(service, 'manual', { autoExecute: false });
  assert.equal(work.status, 'ready', work.message);
  assert.equal((await candidateDocument(service.store, work)).revision, 1);
  await assert.rejects(
    service.request('scene-workflow-execute', {
      workId: work.id,
      expectedRevision: work.revision,
      commandId: 'wrong-plan',
      planHash: '0'.repeat(64),
    }),
    (e) => e.code === 'SCENE_PLAN_CHANGED',
  );
  await service.request('scene-workflow-execute', {
    workId: work.id,
    expectedRevision: work.revision,
    commandId: 'correct-plan',
    planHash: work.plans[0].hash,
  });
  const done = await service.drain(work.id);
  assert.equal(done.status, 'ready_to_adopt', done.message);
  await applyDocumentCommands(root, manifest, {
    documentId: done.spec.documentId,
    expectedRevision: 1,
    commandId: 'human-edit',
    commands: [{ type: 'rename', name: 'Human change' }],
  });
  await assert.rejects(
    service.request('scene-workflow-adopt', adoption(done)),
    (e) => e.code === 'REVISION_CONFLICT',
  );
  assert.equal((await readSource(done.spec.documentId)).name, 'Human change');
  const changed = await service.store.load(work.id);
  await assert.rejects(
    service.request('scene-workflow-adopt', adoption(changed)),
    (e) => e.code === 'SCENE_ADOPTION_PENDING',
  );
});

test('explicit visual defect triggers delta repair; preferences never trigger paid rework', async () => {
  let coordinations = 0,
    reviews = 0;
  const service = make(async ({ role, data }) => {
    if (role.endsWith('reviewer'))
      return opinion(data, ++reviews === 1 ? 'defect' : 'preference');
    if (role !== 'coordinator') return turn('propose');
    coordinations++;
    if (coordinations % 2)
      return turn('consult', {
        target: 'layout',
        question: '检查并修正门的位置。',
      });
    return turn('finalize', {
      plan:
        coordinations === 2
          ? movePlan
          : plan([
              step('repair-position', 'scene', {
                commands: [{ type: 'move-instances', ids: ['gate'], dx: 2 }],
              }),
            ]),
    });
  });
  const { work } = await launch(service, 'repair');
  assert.equal(work.status, 'ready_to_adopt', work.message);
  assert.equal(work.repairs, 1);
  assert.deepEqual(
    work.steps.map((s) => s.id),
    ['place', 'repair-position'],
  );
  assert.equal(
    (await candidateDocument(service.store, work)).content.instances[0].x,
    126,
    'completed move applies only once',
  );
  assert.equal(work.reviews[0].status, 'failed');
  assert.equal(work.reviews[1].status, 'passed');
});

test('dispute reversal stays visible and requires actual user adjudication', async () => {
  let reviews = 0;
  const service = make(
    planner(movePlan, ['layout'], ({ data }) =>
      opinion(data, ++reviews === 1 ? 'insufficient' : 'met'),
    ),
  );
  const { work } = await launch(service, 'dispute');
  assert.equal(work.status, 'attention_required', work.message);
  assert.equal(work.reviews[0].status, 'needs_human');
  assert.deepEqual(work.reviews[0].requiresHuman, ['appearance']);
  await assert.rejects(
    service.request('scene-workflow-adopt', adoption(work)),
    /确认/,
  );
  assert.equal(
    (
      await service.request('scene-workflow-adopt', {
        ...adoption(work),
        acknowledgedCriteria: ['appearance'],
        reviewNote: '已查看对比，门的位置符合要求。',
      })
    ).work.status,
    'completed',
  );
});

test('failed behavior assertions force a repair before independent approval', async () => {
  let coordinations = 0,
    reviews = 0;
  const assertions = [
    {
      id: 'moved-state',
      description: '门应隐藏且无碰撞',
      requirementIds: ['goal'],
      events: [{ type: 'request', instanceId: 'gate' }],
      expectEvents: [],
      expectStates: [
        { instanceId: 'gate', visible: false, solidEnabled: false },
      ],
    },
  ];
  const initial = plan(
    [
      step('disable-gate', 'object', {
        materialId: 'disabled',
        definitionId: 'disabled-gate',
        name: '门',
        source: { kind: 'scene', materialId: 'gate-material' },
        commands: [
          {
            type: 'set-activation',
            definitionId: 'disabled-gate',
            activation: { enabled: false },
          },
        ],
      }),
      step(
        'replace',
        'scene',
        {
          commands: [
            {
              type: 'replace-instances',
              ids: ['gate'],
              materialId: 'disabled',
            },
          ],
        },
        ['disable-gate'],
      ),
    ],
    assertions,
  );
  const repaired = plan(
    [
      step('enable-gate', 'scene', {
        commands: [
          {
            type: 'replace-instances',
            ids: ['gate'],
            materialId: 'gate-material',
          },
        ],
      }),
    ],
    assertions,
  );
  const service = make(async ({ role, data }) => {
    if (role.endsWith('reviewer')) {
      reviews++;
      return opinion(data);
    }
    if (role !== 'coordinator') return turn('propose');
    const roles = ['appearance', 'layout', 'behavior'];
    if (coordinations < roles.length)
      return turn('consult', {
        target: roles[coordinations++],
        question: '请检查门的激活与状态。',
      });
    if (coordinations++ === 3) return turn('finalize', { plan: initial });
    if (coordinations === 5) {
      assert.ok(
        data.repairIssues.length > 0,
        'coordinator receives concrete failed assertions',
      );
      return turn('consult', {
        target: 'layout',
        question: '替回原素材恢复激活。',
      });
    }
    return turn('finalize', { plan: repaired });
  });
  const { work } = await launch(service, 'behavior-repair');
  assert.equal(work.status, 'ready_to_adopt', work.message);
  assert.equal(work.reviews[0].technical.passed, false);
  assert.deepEqual(work.reviews[0].opinions, {});
  assert.equal(work.reviews[1].technical.passed, true);
  assert.equal(
    reviews,
    2,
    'models cannot waive the initial failing deterministic check',
  );
  const weakening = structuredClone(repaired);
  weakening.acceptance = [];
  const source = await service.store.source(work);
  const candidate = await candidateDocument(service.store, work);
  assert.throws(
    () => validateWorkflowPlan(weakening, work, source, candidate.content),
    /原行为断言/,
  );
});

test('protected geometry, image scope, event links and user criteria are programmatic constraints', async () => {
  const service = make(planner(movePlan));
  const f = await fixture('protected');
  const { work: created } = await service.request('scene-workflow-create', {
    commandId: 'protected',
    spec: { ...f.spec, protectedInstanceIds: ['gate'] },
  });
  const work = await service.drain(created.id);
  assert.equal(work.status, 'attention_required');
  assert.equal(work.steps.length, 0);
  assert.match(work.message, /受保护/);
  const source = await service.store.source(work);
  const changed = structuredClone(source.document.content);
  changed.map.collisions.push([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]);
  assert.throws(
    () => assertProtected(source.document, changed, work.spec),
    /地图几何/,
  );
  const reordered = structuredClone(source.document.content);
  reordered.order = ['gate', 'background', 'actor'];
  assert.throws(
    () => assertProtected(source.document, reordered, work.spec),
    /遮挡/,
  );
  const unprotected = {
    ...work,
    spec: { ...work.spec, protectedInstanceIds: [] },
  };
  const forged = plan([
    step('move-map', 'scene', { commands: [{ type: 'move-map', x: 2, y: 3 }] }),
  ]);
  assert.throws(
    () =>
      validateWorkflowPlan(
        forged,
        unprotected,
        source,
        source.document.content,
      ),
    /不支持直接命令/,
  );
  const weakening = structuredClone(movePlan);
  weakening.requirements[0].evidence = '不是用户原文';
  assert.throws(
    () =>
      validateWorkflowPlan(
        weakening,
        unprotected,
        source,
        source.document.content,
      ),
    /原文/,
  );
  const charged = plan([
    step('ai', 'image', {
      target: { kind: 'scene-instance', instanceId: 'gate', slot: 'visual' },
      region: { type: 'rectangle', x: 0, y: 0, width: 8, height: 8 },
      operation: { type: 'ai-edit', prompt: '增加一点锈迹' },
    }),
  ]);
  assert.throws(
    () =>
      validateWorkflowPlan(
        charged,
        unprotected,
        source,
        source.document.content,
      ),
    /额度/,
  );
});

test('pause, safe resume and interrupted completed calls never repeat a request', async () => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const script = planner(movePlan);
  const service = make(async (args) => {
    calls++;
    if (calls === 1) {
      entered();
      await gate;
    }
    return script(args);
  });
  const f = await fixture('paused');
  const { work } = await service.request('scene-workflow-create', {
    commandId: 'paused',
    spec: f.spec,
  });
  await started;
  await service.request('scene-workflow-pause', {
    workId: work.id,
    commandId: 'pause',
  });
  release();
  const paused = await service.drain(work.id);
  assert.equal(paused.status, 'paused');
  assert.equal(calls, 1);
  const restored = make(script);
  await restored.request('scene-workflow-resume', {
    workId: paused.id,
    commandId: 'resume',
    expectedRevision: paused.revision,
  });
  assert.equal((await restored.drain(paused.id)).status, 'ready_to_adopt');

  const recovered = make(planner(movePlan));
  const pending = await launch(recovered, 'completed-call', {
    autoExecute: false,
  });
  const saved = pending.work;
  saved.status = saved.phase = 'planning';
  saved.plans = [];
  saved.messages = saved.messages.slice(0, -1);
  saved.queue = [
    { key: saved.calls.at(-1).key, role: 'coordinator', question: 'resume' },
  ];
  await recovered.store.save(saved);
  let reissued = 0;
  const resume = make(() => {
    reissued++;
    throw new Error('must reuse persisted result');
  });
  await resume.request('scene-workflow-resume', {
    workId: saved.id,
    expectedRevision: saved.revision,
    commandId: 'resume-completed',
  });
  const finished = await resume.drain(saved.id);
  assert.equal(finished.status, 'ready', finished.message);
  assert.equal(reissued, 0);
});

test('unknown model outcomes and exhausted budgets stop; reads remain side effect free', async () => {
  let calls = 0;
  const unknown = make(() => {
    calls++;
    throw Object.assign(new Error('outcome unknown'), {
      code: 'SCENE_MODEL_OUTCOME_UNKNOWN',
    });
  });
  const { work, input } = await launch(unknown, 'unknown');
  assert.equal(work.status, 'attention_required');
  assert.equal(work.calls[0].status, 'outcome_unknown');
  await unknown.request('scene-workflow-get', { workId: work.id });
  await unknown.request('scene-workflow-create', input);
  await assert.rejects(
    unknown.request('scene-workflow-resume', {
      workId: work.id,
      expectedRevision: work.revision,
      commandId: 'retry',
    }),
    (e) => e.code === 'SCENE_MODEL_OUTCOME_UNKNOWN',
  );
  assert.equal(calls, 1);
  const bounded = make(() => turn('propose'));
  const budget = await launch(bounded, 'budget', {
    budget: { planningCalls: 4, reviewCalls: 2, imageCalls: 0, revisions: 0 },
  });
  assert.equal(budget.work.status, 'budget_exhausted');
  assert.equal(budget.work.calls.length, 4);
});

test('adoption recovers a committed document after a lost receipt, with exact identity', async () => {
  const service = make(planner(movePlan));
  const { work } = await launch(service, 'adopt-recovery');
  const input = adoption(work),
    originalSave = service.store.save.bind(service.store);
  let failed = false;
  service.store.save = async (value) => {
    if (value.status === 'completed' && !failed) {
      failed = true;
      throw new Error('disk write interrupted');
    }
    await originalSave(value);
  };
  await assert.rejects(
    service.request('scene-workflow-adopt', input),
    /interrupted/,
  );
  assert.equal((await readSource(work.spec.documentId)).revision, 2);
  const restored = make(() => {
    throw new Error('no model call');
  });
  const result = await restored.request('scene-workflow-adopt', input);
  assert.equal(result.work.status, 'completed');
  assert.equal(result.adoption.revision, 2);
});

test('tampered plans and rendered evidence cannot be adopted', async () => {
  const service = make(planner(movePlan));
  const { work } = await launch(service, 'integrity');
  const imagePath = path.join(
    root,
    work.evidence.find((e) => e.id.startsWith('candidate-')).images[0]
      .artifactPath,
  );
  const bytes = await readFile(imagePath);
  await writeFile(imagePath, Buffer.from('changed'));
  await assert.rejects(
    service.request('scene-workflow-adopt', adoption(work)),
    /观察图片已变化/,
  );
  await writeFile(imagePath, bytes);
  const file = path.join(service.store.directory(work.id), 'plan-1.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.plan.summary = 'changed';
  await writeFile(file, JSON.stringify(record));
  await assert.rejects(
    service.request('scene-workflow-adopt', adoption(work)),
    (e) => e.code === 'SCENE_PLAN_CHANGED',
  );
});

test('all saved scene tasks are discoverable across stable history pages', async () => {
  const service = make(planner(movePlan));
  const { work } = await launch(service, 'history-seed');
  const documentId = 'history-only-fixtures';
  for (let i = 0; i < 55; i++) {
    const row = { ...work, id: `history-${String(i).padStart(2, '0')}`, spec: { ...work.spec, documentId }, updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() };
    await service.store.write(path.join(service.store.directory(row.id), 'task.json'), row);
  }
  const first = await service.request('scene-workflow-list', { documentId });
  assert.equal(first.works.length, 20);
  assert.equal(first.total, 55);
  assert.equal(first.nextOffset, 20);
  const second = await service.request('scene-workflow-list', { documentId, offset: first.nextOffset, snapshot: first.snapshot });
  const third = await service.request('scene-workflow-list', { documentId, offset: second.nextOffset, snapshot: second.snapshot });
  assert.equal(third.nextOffset, null);
  assert.equal(new Set([...first.works, ...second.works, ...third.works].map((row) => row.id)).size, 55);
  assert.equal(third.works.at(-1).id, 'history-00');
  const beyond = await service.request('scene-workflow-list', { documentId, offset: 55, snapshot: first.snapshot });
  assert.deepEqual(beyond.works, []);
  const changed = await service.store.load('history-00');
  await service.store.save(changed);
  await assert.rejects(service.request('scene-workflow-list', { documentId, offset: 20, snapshot: first.snapshot }), (e) => e.code === 'SCENE_HISTORY_CHANGED');
  const refreshed = await service.request('scene-workflow-list', { documentId });
  assert.equal(refreshed.works[0].id, 'history-00');
  assert.equal(refreshed.total, 55, 'a refresh never deletes the older records');
});

try {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(
    `Scene workflow: ${tests.length} integration scenarios passed (no provider calls).`,
  );
} finally {
  globalThis.fetch = originalFetch;
}
