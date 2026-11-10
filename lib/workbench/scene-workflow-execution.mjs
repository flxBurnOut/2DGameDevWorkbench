import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  applySceneCommands,
  applyInteractableCommands,
} from './editor-commands.mjs';
import {
  getDocument,
  createDocument,
  saveDocument,
  applyDocumentCommands,
  simulateDocument,
  validateDocument,
} from './editor-documents.mjs';
import { normalizeProject, referencedAssets } from '../../features/interactable-editor/contract.mjs';
import { objectRenderState } from '../../features/scene-composer/render-model.mjs';
import {
  createDocumentSimulation,
  replaySimulationEvents,
} from '../../features/scene-composer/simulation-replay.mjs';
import {
  validateScene,
  createScene,
  addMaterial,
  addInstance,
} from '../../features/scene-composer/model.mjs';
import { imageEditRequest } from './image-edits.mjs';
import { observeScene } from './scene-observation.mjs';
import { stepInputs, planSchema } from './scene-workflow-contract.mjs';
import { hash, workflowError } from './scene-workflow-store.mjs';
import {
  validateGenerationStep,
  executeGenerationStep,
  verifyWorkflowGenerationEvidence,
} from './scene-workflow-generation.mjs';
import {
  validateMapStep,
  projectMapStep,
  executeMapStep,
  assertMapPolicy,
} from './scene-workflow-map.mjs';

export const allowedSceneCommands = [
  'rename',
  'add-instance',
  'move-instances',
  'scale-instances',
  'flip-instances',
  'set-anchor',
  'reorder',
  'replace-instances',
  'remove-instances',
  'set-node-flags',
  'set-links',
  'add-link',
  'update-link',
  'remove-links',
];
export const allowedObjectCommands = [
  'rename-object',
  'bind-asset',
  'set-visual',
  'set-shape',
  'set-activation',
  'set-content',
  'set-behavior',
  'set-feedback',
  'set-completion',
];
const fail = (message) => {
  throw workflowError(message);
};
const unique = (values, label) => {
  if (new Set(values).size !== values.length) fail(`${label}身份重复。`);
};
const same = (a, b) => hash(a) === hash(b);
export function parseStep(step) {
  let input;
  try {
    input = stepInputs[step.kind].parse(JSON.parse(step.input));
  } catch (error) {
    fail(
      `步骤 ${step.id} 的参数无效：${error.issues?.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') || '请使用该步骤的 JSON 契约'}`,
    );
  }
  if (step.kind === 'scene')
    for (const c of input.commands) {
      if (!allowedSceneCommands.includes(c.type))
        fail(
          `场景协作不支持直接命令 ${c.type}。地图制作使用 map 步骤；导入与派生物件使用 object 步骤。`,
        );
      if (c.type === 'set-node-flags' && c.locked !== undefined)
        fail('专家不能更改节点锁。');
    }
  if (step.kind === 'object')
    for (const c of input.commands) {
      if (
        !allowedObjectCommands.includes(c.type) ||
        c.definitionId !== input.definitionId
      )
        fail('物件步骤只能配置本次派生定义，不能增删定义或添加未提供的素材。');
    }
  if (step.kind === 'image') {
    if (
      ['restore-region', 'pixel-patch'].includes(input.operation.type) ||
      input.region.type === 'named'
    )
      fail('场景协作使用明确区域和声明式图片操作，不接受外部会话或像素补丁。');
    if (
      input.operation.type === 'ai-edit' &&
      input.operation.references?.length
    )
      fail('协作图片编辑只发送已冻结的目标图片，不接受额外参考路径。');
    if (
      input.target.kind === 'scene-instance' &&
      (input.target.slot === 'visual') !== (input.target.index === undefined)
    )
      fail('默认外观不带 index；状态外观必须指定 index。');
  }
  return input;
}
export function orderedSteps(plan) {
  unique(
    plan.steps.map((step) => step.id),
    '步骤',
  );
  const available = new Set(plan.steps.map((step) => step.id));
  const done = new Set(),
    pending = [...plan.steps],
    result = [];
  for (const step of pending)
    if (step.dependsOn.some((id) => !available.has(id) || id === step.id))
      fail(`步骤 ${step.id} 依赖不存在或自身。`);
  while (pending.length) {
    const i = pending.findIndex((step) =>
      step.dependsOn.every((id) => done.has(id)),
    );
    if (i < 0) fail('制作依赖图存在循环。');
    const [step] = pending.splice(i, 1);
    result.push(step);
    done.add(step.id);
  }
  return result;
}
export function assertProtected(source, candidate, spec, allowMapProduction = false) {
  const base = source.content;
  const a = structuredClone(base.map),
    b = structuredClone(candidate.map);
  if (!allowMapProduction) {
  if (Boolean(a) !== Boolean(b)) fail('此任务不能创建或移除地图。');
  for (const layer of a?.layers || [])
    if (spec.editableMapLayerIds.includes(layer.id)) {
      const target = b.layers.find((item) => item.id === layer.id);
      if (!target || layer.locked) fail('地图层缺失或锁定。');
      layer.source = target.source = '<allowed-image-edit>';
    }
  if (a && b && spec.editableMapLayerIds.length)
    a.source = b.source = '<versioned-source-package>';
  if (!same(a, b))
    fail('此任务必须保留地图几何、碰撞、非目标图片层和显示设置。');
  }
  const protectedIds = new Set([
    ...spec.protectedInstanceIds,
    ...base.instances.filter((i) => i.locked).map((i) => i.id),
  ]);
  const checkOrder = (id) => {
    const preceding = (scene) => scene.order.slice(0, scene.order.indexOf(id))
      .filter(node => base.order.includes(node) && candidate.order.includes(node));
    if (!same(preceding(base), preceding(candidate))) fail(`受保护节点 ${id} 与已有节点的遮挡关系不能变化。`);
  };
  for (const element of base.mapSplit?.elements || []) {
    if (!element.locked) continue;
    const next = candidate.mapSplit?.elements.find(item => item.id === element.id);
    if (!next || !same(element, next)) fail(`任务不能修改已锁定的分层物件 ${element.id}。`);
    checkOrder(element.id);
  }
  for (const id of protectedIds) {
    const before = base.instances.find((i) => i.id === id),
      after = candidate.instances.find((i) => i.id === id);
    if (!before || !after || !same(before, after))
      fail(`受保护实例 ${id} 不能被移动、删除、替换或改写。`);
    if (
      !same(
        base.materials.find((m) => m.id === before.materialId),
        candidate.materials.find((m) => m.id === after.materialId),
      )
    )
      fail(`受保护实例 ${id} 的素材发生变化。`);
    const links = (scene) =>
      scene.links.filter(
        (link) => link.sourceInstanceId === id || link.targetInstanceId === id,
      );
    if (!same(links(base), links(candidate)))
      fail(`受保护实例 ${id} 的联动不能变化。`);
    checkOrder(id);
  }
  // Existing explicit locks are immutable, including map layers.
  for (const before of base.instances) {
    const after = candidate.instances.find((i) => i.id === before.id);
    if (after && after.locked !== before.locked) fail('任务不能更改实例锁。');
  }
}
export async function assertWorkflowProtection(store, work, source, candidate) {
  const mapProduction = ['create', 'extend'].includes(work.spec.mapMode);
  assertProtected(source, candidate, work.spec, mapProduction);
  if (mapProduction)
    await assertMapPolicy(store.root, source.content.map, candidate.map, work);
}
function objectContent(scene, input, sources) {
  if (scene.materials.some((m) => m.id === input.materialId))
    fail('派生素材必须使用新的 materialId。');
  let original, project;
  if (input.source.kind === 'scene') {
    const material = scene.materials.find(
      (m) => m.id === input.source.materialId,
    );
    if (!material) fail('物件来源素材不存在。');
    project = structuredClone(material.project);
    original = project.objects[0];
  } else {
    const doc = sources.find((d) => d.id === input.source.documentId);
    if (!doc || doc.kind !== 'interactable')
      fail('只能导入创建任务时明确选定并冻结的交互物工程。');
    project = structuredClone(doc.content);
    original = project.objects.find(
      (o) => o.definitionId === input.source.definitionId,
    );
    if (!original) fail('来源物件定义不存在。');
  }
  project.projectId = input.materialId;
  project.objects = [
    { ...original, definitionId: input.definitionId, displayName: input.name },
  ];
  const changed = applyInteractableCommands(
    normalizeProject(project),
    input.commands,
  ).content;
  changed.assets = referencedAssets(changed);
  const next = structuredClone(scene);
  next.materials.push({
    id: input.materialId,
    name: input.name,
    project: changed,
  });
  return validateScene(next);
}
export function applyLocalStep(scene, step, source) {
  const input = parseStep(step);
  if (step.kind === 'scene')
    return applySceneCommands(scene, input.commands).content;
  if (step.kind === 'object')
    return objectContent(scene, input, source.materials);
  return scene;
}
export function validateWorkflowPlan(raw, work, source, current) {
  const plan = planSchema.parse(raw),
    steps = orderedSteps(plan);
  unique(
    plan.requirements.map((r) => r.id),
    '需求',
  );
  unique(
    [...plan.visualCriteria, ...plan.acceptance].map((c) => c.id),
    '验收条件',
  );
  const text = [
    work.spec.description,
    ...work.clarifications.map((c) => c.text),
  ].join('\n');
  for (const r of plan.requirements)
    if (r.source === 'user' && (!r.evidence || !text.includes(r.evidence)))
      fail('用户需求的 evidence 必须是原始要求或补充要求中的原文。');
  const requirements = new Set(plan.requirements.map((r) => r.id));
  for (const c of [...plan.visualCriteria, ...plan.acceptance])
    if (c.requirementIds.some((id) => !requirements.has(id)))
      fail('验收条件引用了不存在的需求。');
  for (const { plan: original } of work.plans) {
    for (const r of original.requirements)
      if (!plan.requirements.some((next) => same(r, next)))
        fail('修订必须保留已确认需求；修改原目标需要基于当前工程建立新任务。');
    for (const c of original.visualCriteria)
      if (!plan.visualCriteria.some((next) => same(c, next)))
        fail('修订不能删除或放宽原视觉验收条件。');
    for (const c of original.acceptance)
      if (!plan.acceptance.some((next) => same(c, next)))
        fail('修订不能删除或放宽原行为断言。');
  }
  const needed = new Set(),
    completed = new Set(
      work.steps.filter((r) => r.status === 'completed').map((r) => r.id),
    );
  let simulated = structuredClone(current),
    images = 0,
    generations = 0,
    mapTiles = 0;
  const generated = new Set(), lineage = new Map();
  const producers = new Map(), dependencies = new Map();
  for (const step of steps) {
    if (completed.has(step.id))
      fail(`步骤 ${step.id} 已完成。修订只添加新的修正步骤，不重做已有工作。`);
    const input = parseStep(step);
    const ancestors = new Set(step.dependsOn);
    for (const dep of step.dependsOn)
      for (const ancestor of dependencies.get(dep) || []) ancestors.add(ancestor);
    dependencies.set(step.id, ancestors);
    const requireProducer = (materialId) => {
      const producer = producers.get(materialId);
      if (producer && !ancestors.has(producer))
        fail(`步骤 ${step.id} 必须依赖素材的制作步骤 ${producer}。`);
    };
    if (step.kind === 'object' && input.source.kind === 'scene') requireProducer(input.source.materialId);
    if (step.kind === 'scene') for (const command of input.commands) if (command.materialId) requireProducer(command.materialId);
    if (step.kind === 'image') {
      needed.add('appearance');
      if (input.target.kind === 'scene-layer' && ['create', 'extend'].includes(work.spec.mapMode))
        fail('地图制作任务不能同时改写已有地图层图片；可在采用地图后另建局部修改任务。');
      if (
        input.target.kind === 'scene-layer' &&
        !work.spec.editableMapLayerIds.includes(input.target.layerId)
      )
        fail('此地图层不在允许修改的范围内。');
      if (input.target.kind === 'scene-instance') {
        const instance = simulated.instances.find(
          (item) => item.id === input.target.instanceId,
        );
        if (!instance) fail('图片步骤引用的实例尚不存在，请检查依赖顺序。');
        if (
          instance.locked ||
          work.spec.protectedInstanceIds.includes(instance.id)
        )
          fail('此实例受保护或已锁定。');
      }
      if (input.operation.type === 'ai-edit') images++;
    } else if (step.kind === 'generate') {
      simulated = validateGenerationStep(simulated, input, { work });
      generated.add(input.materialId);
      lineage.set(input.materialId, new Set([input.materialId]));
      producers.set(input.materialId, step.id);
      needed.add('appearance');
      generations++;
    } else if (step.kind === 'map') {
      validateMapStep(work, simulated, step);
      simulated = projectMapStep(simulated, step);
      needed.add('appearance');
      needed.add('layout');
      generations++;
      mapTiles++;
    } else {
      simulated = applyLocalStep(simulated, step, source);
      assertProtected(source.document, simulated, work.spec, ['create', 'extend'].includes(work.spec.mapMode));
      if (step.kind === 'object') {
        producers.set(input.materialId, step.id);
        lineage.set(input.materialId, input.source.kind === 'scene' ? lineage.get(input.source.materialId) || new Set() : new Set());
        needed.add('appearance');
        needed.add('behavior');
      } else {
        needed.add('layout');
        if (input.commands.some((c) => c.type.includes('link')))
          needed.add('behavior');
      }
    }
  }
  if (!plan.questions.length && generated.size) {
    const visibleGenerated = new Set();
    const recordVisible = (simulation) => {
      for (const instance of simulated.instances) {
        const roots = lineage.get(instance.materialId);
        if (instance.hidden || !instance.included || !roots?.size) continue;
        const material = simulated.materials.find((item) => item.id === instance.materialId);
        const state = objectRenderState(instance, material, {
          time: simulation?.time || 0,
          simulated: simulation?.objects.find((item) => item.id === instance.id),
        });
        if (state.visible) for (const root of roots) visibleGenerated.add(root);
      }
    };
    recordVisible();
    for (const test of plan.acceptance) {
      if ([...generated].every((id) => visibleGenerated.has(id))) break;
      const replay = replaySimulationEvents(createDocumentSimulation('scene', simulated), test.events);
      if (!replay.truncated && !replay.linkDiagnostics.length) recordVisible(replay.simulation);
    }
    if ([...generated].some((id) => !visibleGenerated.has(id)))
      fail('生成素材必须在初始画面或实际声明的行为回放中可见，并参与导出，才能检查实际画面。');
  }
  if (generations + (work.generationCalls?.length || 0) > (work.spec.budget.generationCalls || 0))
    fail('新素材与地图生成超过已授权总次数。');
  if (mapTiles + work.steps.filter((step) => step.kind === 'map').length > (work.spec.budget.mapTiles || 0))
    fail('地图制作超过已授权新增图块数。');
  const seams = work.steps.filter((step) => step.mapOutput?.reviewRegion).length + steps.filter((step) => step.kind === 'map' && parseStep(step).operation === 'extend').length;
  if (4 + 2 * (plan.visualCriteria.filter((criterion) => criterion.region).length + plan.acceptance.length) + seams > 40)
    fail('复核所需图片超过单次可检查范围，请合并重复区域或缩小本次制作范围；地图接缝检查不能省略。');
  if (
    needed.has('behavior') &&
    !plan.acceptance.length &&
    !plan.questions.length
  )
    fail('涉及物件行为或联动的方案必须包含实际事件或状态断言。');
  if (images + work.imageCalls.length > work.spec.budget.imageCalls)
    fail('图片调用超过已授权总额度；不能增加预算或把 AI 请求伪装成本地修改。');
  if (
    work.calls.filter((c) => c.kind === 'review').length +
      1 +
      Number(plan.acceptance.length > 0) >
    work.spec.budget.reviewCalls
  )
    fail('剩余复核额度不足，不能省略最终检查。');
  if (!plan.questions.length && !steps.length)
    fail('可执行方案至少需要一个制作或修正步骤。');
  return { plan, steps, needed: [...needed] };
}

export async function ensureCandidate(store, work, source) {
  const manifest = store.candidateManifest(work);
  const result = await createDocument(store.root, manifest, {
    kind: 'scene',
    documentId: source.document.id,
    commandId: `candidate-${work.id}`,
    content: source.document.content,
  });
  return result.document;
}
export async function candidateDocument(store, work, revision) {
  return (
    await getDocument(store.root, store.candidateManifest(work), {
      documentId: work.spec.documentId,
      ...(revision ? { revision } : {}),
    })
  ).document;
}
export async function executeWorkflowStep(store, work, step, receipt, save) {
  const manifest = store.candidateManifest(work),
    input = parseStep(step);
  if (!receipt.beforeRevision) {
    const document = await candidateDocument(store, work);
    receipt.beforeRevision = document.revision;
    receipt.beforeHash = document.contentHash;
    receipt.commandId = `scene:${work.id}:${work.plans.length}:${step.id}`;
    await save();
  }
  const before = await candidateDocument(store, work, receipt.beforeRevision);
  const source = await store.source(work);
  if (step.kind === 'generate' || step.kind === 'map') {
    const result = step.kind === 'generate'
      ? await executeGenerationStep(store, work, receipt, step, save)
      : await executeMapStep(store, work, step, receipt, save);
    if (!result.paused) await assertWorkflowProtection(store, work, source.document, result.document.content);
    return result;
  }
  if (step.kind !== 'image') {
    const content = applyLocalStep(before.content, step, source);
    await assertWorkflowProtection(store, work, source.document, content);
    const result =
      step.kind === 'scene'
        ? await applyDocumentCommands(store.root, manifest, {
            documentId: before.id,
            expectedRevision: before.revision,
            commandId: receipt.commandId,
            commands: input.commands,
          })
        : await saveDocument(
            store.root,
            manifest,
            {
              documentId: before.id,
              expectedRevision: before.revision,
              commandId: receipt.commandId,
              content,
            },
            { respectLocks: true },
          );
    return { document: result.document };
  }
  const target = { ...input.target, documentId: before.id };
  if (!receipt.imageInput) {
    const inspected = await imageEditRequest(
      store.root,
      manifest,
      'image-inspect',
      { target },
    );
    const info = inspected.target;
    if (!info.editable || info.locked)
      fail(info.readOnlyReason || '所选图片不可编辑或已锁定。');
    if (info.revision !== before.revision) fail('候选图片版本已变化。');
    const guard = {
      expectedRevision: info.revision,
      expectedSha256: info.sha256,
    };
    const resolved = await imageEditRequest(
      store.root,
      manifest,
      'image-resolve',
      { target, ...guard, region: input.region },
    );
    receipt.imageInput = {
      target,
      ...guard,
      regionRef: resolved.regionRef,
      operation: input.operation,
      constraints: {
        preserveOutsideRegion: true,
        preserveDimensions: true,
        preserveAlpha: input.preserveAlpha,
      },
      commandId: `${receipt.commandId}:edit`,
      previewPolicy: 'host-unavailable',
    };
    if (input.operation.type === 'ai-edit') {
      if (work.imageCalls.length >= work.spec.budget.imageCalls)
        fail('图片调用额度已用完。');
      work.imageCalls.push({
        stepId: step.id,
        commandId: receipt.imageInput.commandId,
        status: 'recorded',
      });
    }
    await save();
  }
  if (!receipt.editId) {
    const result = await imageEditRequest(
      store.root,
      manifest,
      'image-edit',
      receipt.imageInput,
    );
    receipt.editId = result.edit.editId;
    receipt.candidateVersion = result.candidateVersion;
    receipt.taskId = result.taskId;
    const call = work.imageCalls.find(
      (c) => c.commandId === receipt.imageInput.commandId,
    );
    if (call)
      Object.assign(call, { taskId: result.taskId, status: result.status });
    await save();
  }
  let candidate;
  for (;;) {
    const result = await imageEditRequest(
      store.root,
      manifest,
      'image-session-get',
      { editId: receipt.editId },
    );
    candidate = result.edit.candidates.find(
      (c) => c.version === receipt.candidateVersion,
    );
    const call = work.imageCalls.find(
      (c) => c.commandId === receipt.imageInput.commandId,
    );
    if (call) call.status = candidate?.status || 'unknown';
    if (candidate?.status === 'completed') break;
    if (
      !candidate ||
      ['failed', 'attention_required', 'awaiting_configuration'].includes(
        candidate.status,
      )
    )
      throw workflowError(
        '图片候选未完成或需要检查，原请求身份已保留；不会重发。',
        'SCENE_IMAGE_ATTENTION',
        409,
      );
    if (await store.pauseRequested(work.id)) {
      await save();
      return { paused: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  receipt.imageEvidence = {
    taskId: receipt.taskId,
    sha256: candidate.sha256,
    diff: candidate.diffFromBase,
    evidence: candidate.evidence,
  };
  await save();
  const result = await imageEditRequest(store.root, manifest, 'image-apply', {
    editId: receipt.editId,
    candidateVersion: receipt.candidateVersion,
    expectedRevision: receipt.imageInput.expectedRevision,
    expectedSha256: receipt.imageInput.expectedSha256,
    commandId: `${receipt.commandId}:apply`,
  });
  const document = await candidateDocument(store, work, result.revision);
  await assertWorkflowProtection(store, work, source.document, document.content);
  return { document, imageEvidence: receipt.imageEvidence };
}

export async function observeWorkflow(
  store,
  work,
  options = {},
  label = 'candidate',
) {
  let document = await candidateDocument(store, work);
  const id = `${label}-${work.evidence.length + 1}`;
  const saved = await store.read(path.join(store.directory(work.id), `evidence-${id}.json`), true);
  const { sourceObject, ...renderOptions } = options;
  if (sourceObject) {
    const source = await store.source(work);
    const selected = source.materials.find(
      (item) => item.id === sourceObject.documentId,
    );
    if (
      !selected?.content.objects.some(
        (o) => o.definitionId === sourceObject.definitionId,
      )
    )
      fail('观察只允许任务开始时已选定的物件来源。');
    const scene = createScene(selected.name);
    scene.id = `source-${hash(sourceObject).slice(0, 24)}`;
    // Older orphan receipts contain the randomly assigned IDs of their one
    // rendered object. Rebuild that exact snapshot before checking its hash.
    const prior = saved?.documentId === scene.id ? saved.objects?.[0] : null;
    const material = addMaterial(
      scene,
      selected.content,
      sourceObject.definitionId,
      prior?.materialId ?? 'source_material',
    );
    if (prior && prior.materialId !== 'source_material')
      material.project.assets = normalizeProject(selected.content).assets;
    addInstance(scene, material.id, 0, 0, prior?.id ?? 'source_instance');
    document = {
      id: scene.id,
      kind: 'scene',
      revision: selected.revision,
      content: scene,
      contentHash: hash(scene),
    };
  }
  const requestHash = hash({ documentId: document.id, revision: document.revision, contentHash: document.contentHash, options: renderOptions, label });
  if (saved) {
    if (saved.requestHash !== requestHash) fail('已有观察记录与恢复请求不一致。');
    const images = await readEvidenceImages(store, saved);
    work.evidence.push(saved);
    return { metadata: saved, images };
  }
  const observation = await observeScene(
    store.root,
    store.candidateManifest(work),
    document,
    { ...renderOptions, maxWidth: 1280, maxHeight: 1280 },
  );
  const metadata = {
    id,
    requestHash,
    ...observation,
    images: observation.images.map(({ data: _data, ...image }) => image),
  };
  await store.freeze(work.id, `evidence-${id}`, metadata);
  work.evidence.push(metadata);
  return { metadata, images: observation.images };
}
export async function readEvidenceImages(store, evidence) {
  const root = await realpath(store.root),
    outputs = await realpath(
      path.resolve(root, store.manifest.workspace.outputDirectory),
    );
  const images = [];
  for (const image of evidence.images) {
    const file = await realpath(path.resolve(root, image.artifactPath));
    const relative = path.relative(outputs, file);
    if (
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`)
    )
      fail('观察图片路径越界。');
    const bytes = await readFile(file);
    if (hash(bytes) !== image.sha256) fail('观察图片已变化，旧报告不能沿用。');
    images.push({ ...image, data: bytes.toString('base64') });
  }
  return images;
}
export async function technicalReview(store, work) {
  const manifest = store.candidateManifest(work),
    document = await candidateDocument(store, work);
  const source = await store.source(work);
  await assertWorkflowProtection(store, work, source.document, document.content);
  const production = await verifyWorkflowGenerationEvidence(store, work);
  if (production.pending.some((call) => call.unresolved))
    throw workflowError('仍有提交结果未知或未完成的生成请求，请先核对原请求，不能采用或自动重新生成。', 'SCENE_GENERATION_OUTCOME_UNKNOWN', 409);
  const validation = await validateDocument(store.root, manifest, {
    documentId: document.id,
    revision: document.revision,
  });
  const checks = [];
  for (const test of work.plans.at(-1).plan.acceptance) {
    const result = await simulateDocument(store.root, manifest, {
      documentId: document.id,
      revision: document.revision,
      events: test.events,
      expectEvents: test.expectEvents,
      expectStates: test.expectStates,
    });
    checks.push({ id: test.id, description: test.description, ...result });
  }
  return {
    documentId: document.id,
    revision: document.revision,
    contentHash: document.contentHash,
    validation,
    production,
    checks,
    passed: validation.valid && checks.every((c) => c.passed),
    engineValidated: false,
  };
}
