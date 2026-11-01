import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { imageEditRequest } from './image-edits.mjs';
import { getDocument, saveDocument } from './editor-documents.mjs';
import {
  sceneWorkflowInputs,
  expertTurnSchema,
  reviewSchema,
  busyStates,
  SCENE_ROLES,
  taskSpecSchema,
} from './scene-workflow-contract.mjs';
import {
  SceneWorkflowStore,
  hash,
  workflowError,
} from './scene-workflow-store.mjs';
import {
  sceneModelSettings,
  sceneModelSnapshot,
  sendSceneExpert,
} from './scene-workflow-models.mjs';
import {
  ensureCandidate,
  candidateDocument,
  validateWorkflowPlan,
  orderedSteps,
  executeWorkflowStep,
  observeWorkflow,
  readEvidenceImages,
  technicalReview,
  assertWorkflowProtection,
} from './scene-workflow-execution.mjs';
import {
  planningInstructions,
  sceneRoleInstructions,
  reviewerInstructions,
  sceneSummary,
  commandGuide,
} from './scene-workflow-prompts.mjs';
import {
  freezeWorkflowGeneration,
  getWorkflowGenerationSettings,
  verifyWorkflowGenerationEvidence,
} from './scene-workflow-generation.mjs';
import { inspectMapSource } from './scene-workflow-map.mjs';

const clone = (value) => structuredClone(value);
const countCalls = (work, kind) =>
  work.calls.filter((call) => call.kind === kind).length;
const unknownCall = (work) =>
  work.calls.some((call) =>
    ['submitting', 'outcome_unknown'].includes(call.status),
  );
const unresolvedProduction = (work) =>
  (work.generationCalls || []).some(
    (call) =>
      !['completed', 'failed', 'awaiting_configuration'].includes(call.status),
  );
const productionConfigurationRequired = (work) =>
  work.status === 'attention_required' &&
  work.phase === 'executing' &&
  work.errorCode === 'SCENE_GENERATION_CONFIGURATION';
const displayError = (error) =>
  error.code === 'ENOENT'
    ? '任务所需文件缺失。'
    : error.issues
      ? error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
          .slice(0, 1500)
      : String(error.message || '场景协作未完成。').slice(0, 1500);

/** Only the canonical Bridge owns this service. Tests inject a transport, never a
 * production fixture provider. Reads do not dispatch or recover paid work. */
export class SceneWorkflowService {
  constructor(root, manifest, options = {}) {
    this.store = new SceneWorkflowStore(root, manifest);
    this.manifest = manifest;
    this.requestModel = options.requestModel || sendSceneExpert;
    this.snapshot = options.snapshot || (() => sceneModelSnapshot(manifest));
    this.generationSnapshot =
      options.generationSnapshot ||
      ((requested) => freezeWorkflowGeneration(manifest, requested));
    this.active = new Map();
    this.locks = new Map();
  }
  async exclusive(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve();
    let release;
    const lock = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => lock);
    this.locks.set(id, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }
  public(work) {
    const value = clone(work);
    delete value.queue;
    value.calls = value.calls.map(({ result: _result, ...call }) => call);
    value.steps = value.steps.map(({ imageInput: _input, ...step }) => step);
    value.evidence = value.evidence.map(
      ({ id, revision, contentHash, images, viewport, time }) => ({
        id,
        revision,
        contentHash,
        images,
        viewport,
        time,
      }),
    );
    value.usage = {
      planningCalls: countCalls(work, 'planning'),
      reviewCalls: countCalls(work, 'review'),
      imageCalls: work.imageCalls.length,
      generationCalls: work.generationCalls?.length || 0,
      mapTiles: work.steps.filter((step) => step.kind === 'map').length,
      revisions: work.repairs,
    };
    value.running = this.active.has(work.id);
    value.configurationRequired = productionConfigurationRequired(work);
    value.recoverableProduction =
      work.phase === 'executing' &&
      (unresolvedProduction(work) || value.configurationRequired) &&
      work.status !== 'completed';
    if (busyStates.includes(work.status) && !value.running) {
      value.status = unknownCall(work) ? 'attention_required' : 'paused';
      value.message = unknownCall(work)
        ? '服务曾在模型请求期间中断。原调用已保留，不会自动重发。'
        : '服务已停止。已完成步骤保留，可显式继续安全的后续步骤。';
    }
    return value;
  }
  async request(operation, raw = {}) {
    const schema = sceneWorkflowInputs[operation];
    if (!schema) throw workflowError('未知场景协作操作。');
    const input = schema.parse(raw);
    if (operation === 'scene-workflow-settings')
      return {
        ...sceneModelSettings(this.manifest, input),
        production: getWorkflowGenerationSettings(this.manifest),
      };
    if (operation === 'scene-workflow-list') {
      const page = await this.store.list(input.documentId, input.limit, input.offset, input.snapshot);
      return {
        ...page, works: page.works.map((work) => this.public(work)),
      };
    }
    if (operation === 'scene-workflow-create') return this.create(input);
    if (operation === 'scene-workflow-get')
      return { work: this.public(await this.store.load(input.workId)) };
    if (operation === 'scene-workflow-observe') {
      const work = await this.store.load(input.workId);
      if (input.imageStepId) {
        const step = work.steps.find(item => item.id === input.imageStepId && item.kind === 'image');
        if (!step?.imageEvidence?.sha256 || !step.editId || !step.candidateVersion)
          throw workflowError('该图片步骤尚无已完成的候选。', 'SCENE_EVIDENCE_NOT_FOUND', 404);
        const { edit } = await imageEditRequest(this.store.root, this.store.candidateManifest(work), 'image-session-get', {
          editId: step.editId, candidateVersion: step.candidateVersion, comparison: {},
        });
        const { beforePng, afterPng, ...comparison } = edit.comparison;
        if (comparison.candidateSha256 !== step.imageEvidence.sha256)
          throw workflowError('候选图片与步骤回执不符。');
        return { evidence: { workId: work.id, stepId: step.id, ...comparison }, images: [
          { role: 'base', mimeType: 'image/png', data: beforePng },
          { role: 'candidate', mimeType: 'image/png', data: afterPng },
        ] };
      }
      const evidence = input.evidenceId
        ? work.evidence.find((e) => e.id === input.evidenceId)
        : [...work.evidence]
            .reverse()
            .find((e) => e.id.startsWith('candidate-')) || work.evidence.at(-1);
      if (!evidence)
        throw workflowError(
          '此任务尚无保存的观察图片。',
          'SCENE_EVIDENCE_NOT_FOUND',
          404,
        );
      return {
        evidence,
        images: await readEvidenceImages(this.store, evidence),
      };
    }
    if (operation === 'scene-workflow-pause') {
      const work = await this.store.load(input.workId);
      if (this.active.has(work.id))
        await this.store.pause(work.id, input.commandId);
      return {
        work: this.public(work),
        pauseRequested: this.active.has(work.id),
      };
    }
    return this.exclusive(input.workId, async () => {
      const work = await this.store.load(input.workId);
      const fingerprint = hash({ operation, input });
      const prior = work.commands.find((item) => item.id === input.commandId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw workflowError(
            'commandId 已用于不同请求。',
            'COMMAND_ID_REUSED',
            409,
          );
        return {
          work: this.public(work),
          ...(work.adoption ? { adoption: work.adoption } : {}),
          replayed: true,
        };
      }
      if (this.active.has(work.id))
        throw workflowError(
          '场景任务正在运行，请先暂停或等待当前步骤完成。',
          'SCENE_WORKFLOW_BUSY',
          409,
        );
      const recoveringAdoption =
        operation === 'scene-workflow-adopt' &&
        work.adoptIntent?.fingerprint === fingerprint;
      if (work.revision !== input.expectedRevision && !recoveringAdoption)
        throw Object.assign(
          workflowError(
            '场景任务已有更新，请读取当前版本。',
            'REVISION_CONFLICT',
            409,
          ),
          { currentRevision: work.revision },
        );
      if (operation === 'scene-workflow-adopt')
        return this.adopt(work, input, fingerprint);
      if (unknownCall(work))
        throw workflowError(
          '此任务有结果未知的模型请求，不能重新提交；原候选和回执保留。',
          'SCENE_MODEL_OUTCOME_UNKNOWN',
          409,
        );
      if (operation === 'scene-workflow-execute') {
        if (
          work.status !== 'ready' ||
          work.plans.at(-1)?.hash !== input.planHash
        )
          throw workflowError(
            '只能执行当前已就绪的确切方案。',
            'SCENE_PLAN_CHANGED',
            409,
          );
        work.executionAuthorized = true;
        work.phase = 'executing';
        work.status = 'executing';
      } else if (operation === 'scene-workflow-revise') {
        if (work.status === 'completed')
          throw workflowError(
            '已采用任务保留原证据，请基于当前场景建立新任务。',
          );
        const production = await verifyWorkflowGenerationEvidence(
          this.store,
          work,
        );
        if (production.pending.some((call) => call.unresolved))
          throw workflowError(
            '请先核对已有生成请求的结果，不能通过修订创建另一个请求。',
            'SCENE_GENERATION_OUTCOME_UNKNOWN',
            409,
          );
        this.requirePlanningBudget(work);
        if (work.repairs >= work.spec.budget.revisions)
          throw workflowError(
            '修订额度已用完，不能增加预算。',
            'SCENE_BUDGET_EXHAUSTED',
            409,
          );
        work.clarifications.push({
          text: input.clarification,
          at: new Date().toISOString(),
        });
        this.beginRevision(work, [{ summary: input.clarification }]);
      } else if (operation === 'scene-workflow-resume') {
        if (
          !['paused', ...busyStates].includes(work.status) &&
          !(
            work.status === 'attention_required' &&
            work.phase === 'executing' &&
            (unresolvedProduction(work) ||
              productionConfigurationRequired(work))
          )
        )
          throw workflowError('此任务不能直接继续，请处理当前问题。');
        if (
          work.calls.some(
            (call) =>
              call.status === 'failed' &&
              work.queue.some((entry) => entry.key === call.key),
          )
        )
          throw workflowError(
            '失败请求不会自动重试；请明确补充要求后制定新版本。',
          );
        work.status = work.phase;
      }
      delete work.errorCode;
      work.commands.push({ id: input.commandId, fingerprint, operation });
      await this.store.clearPause(work.id);
      await this.store.save(work);
      this.start(work.id);
      return { work: this.public(work) };
    });
  }
  async create(input) {
    const id = `scene-${hash(input.commandId).slice(0, 24)}`,
      fingerprint = hash(input);
    return this.exclusive(id, async () => {
      const existing = await this.store.read(
        path.join(this.store.directory(id), 'task.json'),
        true,
      );
      if (existing) {
        if (
          existing.requestHash !== fingerprint &&
          hash({
            commandId: input.commandId,
            spec: taskSpecSchema.parse(existing.spec),
          }) !== fingerprint
        )
          throw workflowError(
            'commandId 已用于不同的场景任务。',
            'COMMAND_ID_REUSED',
            409,
          );
        return { work: this.public(existing), replayed: true };
      }
      const { document } = await getDocument(this.store.root, this.manifest, {
        documentId: input.spec.documentId,
      });
      if (document.kind !== 'scene') throw workflowError('请先保存共享场景。');
      if (input.spec.mapMode === 'create' && document.content.map)
        throw workflowError(
          '创建地图需要空地图场景；已有地图请选择扩展或保持。',
        );
      if (input.spec.mapMode === 'extend' && !document.content.map)
        throw workflowError('扩展地图需要已有地图；空场景请选择创建。');
      if (
        input.spec.mapMode !== 'preserve' &&
        (!input.spec.budget.generationCalls || !input.spec.budget.mapTiles)
      )
        throw workflowError('创建或扩展地图需要授权生成次数和新增图块数。');
      if (document.revision !== input.spec.expectedRevision)
        throw Object.assign(
          workflowError(
            '场景已有更新，请先保存并读取最新版本。',
            'REVISION_CONFLICT',
            409,
          ),
          { currentRevision: document.revision },
        );
      for (const id of input.spec.protectedInstanceIds)
        if (!document.content.instances.some((instance) => instance.id === id))
          throw workflowError('受保护实例不存在。');
      for (const id of input.spec.editableMapLayerIds)
        if (
          !document.content.map?.layers.some(
            (layer) => layer.id === id && !layer.locked,
          )
        )
          throw workflowError(
            '可编辑地图层不存在或已锁定；请先在编辑器明确解锁。',
          );
      if (
        new Set(input.spec.sourceDocumentIds).size !==
        input.spec.sourceDocumentIds.length
      )
        throw workflowError('来源工程重复。');
      const materials = [];
      for (const documentId of input.spec.sourceDocumentIds) {
        const source = (
          await getDocument(this.store.root, this.manifest, { documentId })
        ).document;
        if (source.kind !== 'interactable')
          throw workflowError('附加素材必须来自已保存的交互物工程。');
        materials.push(source);
      }
      const mapSource =
        input.spec.mapMode === 'extend'
          ? await inspectMapSource(this.store.root, document.content.map)
          : null;
      if (mapSource && !mapSource.canExtend)
        throw workflowError(
          mapSource.readOnlyReason || '地图来源无法验证，不能自动扩展。',
        );
      const source = { document, materials, mapSource };
      // Freeze all planning context before starting any model call.
      const modelSnapshot = await this.snapshot();
      const generationConfiguration =
        input.spec.budget.generationCalls > 0
          ? await this.generationSnapshot(input.spec.generationProviders)
          : null;
      const sourceHash = await this.store.freeze(id, 'source', source);
      const now = new Date().toISOString();
      const work = {
        schemaVersion: 1,
        id,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        requestHash: fingerprint,
        spec: input.spec,
        sourceHash,
        sourceRevision: document.revision,
        sourceContentHash: document.contentHash,
        modelSnapshot,
        generationConfiguration,
        mapSource,
        status: 'planning',
        phase: 'planning',
        message: '正在读取已有场景并安排专家。',
        executionAuthorized: input.spec.autoExecute,
        nextTurn: 1,
        round: 0,
        repairs: 0,
        queue: [
          {
            key: 'turn-0',
            role: 'coordinator',
            question:
              '根据原始需求选择必要专家，先观察已有资源，再制定小而完整的方案。',
          },
        ],
        messages: [],
        calls: [],
        plans: [],
        steps: [],
        evidence: [],
        reviews: [],
        imageCalls: [],
        generationCalls: [],
        clarifications: [],
        consultations: {},
        commands: [],
      };
      await this.store.save(work);
      this.start(id);
      return { work: this.public(work) };
    });
  }
  start(id) {
    if (this.active.has(id)) return;
    const promise = Promise.resolve()
      .then(() => this.drive(id))
      .finally(() => this.active.delete(id));
    // drive records every terminal error. Keep an observer attached for shutdown
    // failures without reporting an unhandled rejection or repeating a request.
    promise.catch(() => {});
    this.active.set(id, promise);
  }
  async drain(id) {
    await this.active.get(id);
    return this.store.load(id);
  }
  requirePlanningBudget(work) {
    if (countCalls(work, 'planning') >= work.spec.budget.planningCalls)
      throw workflowError(
        '规划调用已到上限，原方案与候选保留。',
        'SCENE_BUDGET_EXHAUSTED',
        409,
      );
  }
  enqueue(work, role, question, extra = {}) {
    return { key: `turn-${work.nextTurn++}`, role, question, ...extra };
  }
  async invoke(
    work,
    { key, role, kind, instructions, data, evidence, schema },
  ) {
    const previous = work.calls.find((call) => call.key === key);
    if (previous) {
      if (previous.role !== role || previous.kind !== kind)
        throw workflowError('模型调用身份冲突。');
      if (previous.status === 'completed') return schema.parse(previous.result);
      throw workflowError(
        '已有请求失败或结果未知，不能自动重发。',
        'SCENE_MODEL_OUTCOME_UNKNOWN',
        409,
      );
    }
    const cap =
      kind === 'planning'
        ? work.spec.budget.planningCalls
        : work.spec.budget.reviewCalls;
    if (countCalls(work, kind) >= cap)
      throw workflowError(
        `${kind === 'planning' ? '规划' : '复核'}调用已到上限。`,
        'SCENE_BUDGET_EXHAUSTED',
        409,
      );
    if (Buffer.byteLength(JSON.stringify(data)) > 750000)
      throw workflowError('此任务的上下文过大，请缩小场景或选择更少素材。');
    const images = [];
    for (const item of evidence)
      images.push(
        ...(await readEvidenceImages(this.store, item)).map((image) => ({
          ...image,
          evidenceId: item.id,
          revision: item.revision,
        })),
      );
    if (images.length > 40)
      throw workflowError('本次观察图片过多，请缩小检查范围。');
    const profile =
      work.modelSnapshot.configuration.roles[role] ||
      work.modelSnapshot.configuration.default;
    const call = {
      key,
      role,
      kind,
      id: randomUUID(),
      status: 'submitting',
      startedAt: new Date().toISOString(),
      profile,
      inputHash: hash({
        instructions,
        data,
        images: images.map((image) => image.sha256),
      }),
      evidenceIds: evidence.map((e) => e.id),
    };
    work.calls.push(call);
    await this.store.save(work);
    try {
      const result = await this.requestModel({
        manifest: this.manifest,
        snapshot: work.modelSnapshot,
        role,
        instructions,
        data,
        images,
        schema,
        onReceipt: async (receipt) => {
          call.receipt = { ...call.receipt, ...receipt };
          await this.store.save(work);
        },
      });
      call.result = schema.parse(result);
      call.status = 'completed';
      call.finishedAt = new Date().toISOString();
      await this.store.save(work);
      return call.result;
    } catch (error) {
      call.status =
        error.code === 'SCENE_MODEL_OUTCOME_UNKNOWN'
          ? 'outcome_unknown'
          : 'failed';
      call.error = displayError(error);
      call.finishedAt = new Date().toISOString();
      await this.store.save(work);
      throw error;
    }
  }
  async drive(id) {
    const work = await this.store.load(id);
    try {
      const source = await this.store.source(work);
      await ensureCandidate(this.store, work, source);
      if (!work.evidence.length) {
        await observeWorkflow(this.store, work, {}, 'baseline');
        await this.store.save(work);
      }
      while (busyStates.includes(work.status)) {
        if (await this.store.pauseRequested(id)) {
          work.status = 'paused';
          work.message = '已在安全步骤之间暂停，未完成的原请求身份保留。';
          await this.store.save(work);
          return;
        }
        if (work.phase === 'planning' || work.phase === 'revising')
          await this.planningTurn(work, source);
        else if (work.phase === 'executing') await this.executeNext(work);
        else if (work.phase === 'reviewing') await this.reviewNext(work);
        else throw workflowError('任务执行阶段无效。');
      }
    } catch (error) {
      work.status =
        error.code === 'SCENE_BUDGET_EXHAUSTED'
          ? 'budget_exhausted'
          : 'attention_required';
      work.message = displayError(error);
      work.errorCode = error.code || 'SCENE_WORKFLOW_FAILED';
      await this.store.save(work);
    }
  }
  async planningTurn(work, source) {
    const entry = work.queue[0];
    if (!entry) throw workflowError('专家没有形成可执行方案。');
    if (
      !work.calls.some(
        (call) => call.key === entry.key && call.status === 'completed',
      )
    )
      this.requirePlanningBudget(work);
    const document = await candidateDocument(this.store, work);
    if (
      ['create', 'extend'].includes(work.spec.mapMode) &&
      document.content.map
    ) {
      work.mapSource = await inspectMapSource(
        this.store.root,
        document.content.map,
      );
      work.mapSource.createdByWorkflow = work.steps.some(
        (step) => step.mapOutput?.operation === 'create',
      );
    }
    const first = !work.messages.some(
      (message) => message.round === work.round && message.role === entry.role,
    );
    const peerMessages =
      entry.role !== 'coordinator' && first ? [] : work.messages.slice(-24);
    const relevant = [work.evidence[0], work.evidence.at(-1)].filter(
      (item, index, all) =>
        item && all.findIndex((e) => e.id === item.id) === index,
    );
    work.message = `${SCENE_ROLES[entry.role]}正在${entry.question ? '处理问题' : '分析场景'}。`;
    const turn = await this.invoke(work, {
      key: entry.key,
      role: entry.role,
      kind: 'planning',
      schema: expertTurnSchema,
      instructions: `${planningInstructions}\nROLE: ${sceneRoleInstructions[entry.role]}`,
      data: {
        originalRequest: work.spec,
        clarifications: work.clarifications,
        question: entry.question,
        currentCandidate: sceneSummary(document),
        selectedSources: source.materials.map(sceneSummary),
        mapSource: work.mapSource || source.mapSource || null,
        generationConfiguration: work.generationConfiguration || null,
        productionRemaining: {
          generationCalls:
            (work.spec.budget.generationCalls || 0) -
            (work.generationCalls?.length || 0),
          mapTiles:
            (work.spec.budget.mapTiles || 0) -
            work.steps.filter((step) => step.kind === 'map').length,
        },
        peerMessages,
        evidence: relevant.map(({ images: _images, ...metadata }) => metadata),
        currentPlan: work.plans.at(-1)?.plan || null,
        completedSteps: work.steps
          .filter((s) => s.status === 'completed')
          .map((s) => ({ id: s.id, title: s.title, result: s.afterHash })),
        repairIssues: work.repairIssues || [],
        callsRemaining:
          work.spec.budget.planningCalls - countCalls(work, 'planning'),
        commandContracts: commandGuide(),
      },
      evidence: relevant,
    });
    work.messages.push({
      key: entry.key,
      round: work.round,
      role: entry.role,
      question: entry.question,
      response: turn,
    });
    work.queue.shift();
    if (turn.action === 'consult') {
      if (!turn.target || turn.target === entry.role || !turn.question.trim())
        throw workflowError('咨询必须包含另一个专家和具体问题。');
      const key = `${work.round}:${entry.role}:${turn.target}`;
      work.consultations[key] = (work.consultations[key] || 0) + 1;
      if (work.consultations[key] > 2)
        throw workflowError('同一轮专家咨询已到两次上限，请查看保留的分歧。');
      work.queue.unshift(
        this.enqueue(work, turn.target, turn.question),
        this.enqueue(
          work,
          entry.role,
          '咨询已回答。结合新的证据解决该问题，修改提案或结束讨论。',
        ),
      );
    } else if (turn.action === 'observe') {
      if (
        !turn.observation ||
        work.evidence.filter((e) => e.id.startsWith('inspection-')).length >= 12
      )
        throw workflowError('观察请求无效或已到本任务的观察上限。');
      const options = Object.fromEntries(
        Object.entries(turn.observation).filter(([, value]) => value !== null),
      );
      if (options.sourceObject && (options.region || options.events))
        throw workflowError('来源物件观察不能同时指定场景区域或回放。');
      await observeWorkflow(this.store, work, options, 'inspection');
      work.queue.unshift(
        this.enqueue(work, entry.role, '新的真实观察证据已提供，请据此继续。'),
      );
    } else if (turn.action === 'ask_user') {
      work.status = 'needs_input';
      work.questions = [turn.question.trim() || turn.summary];
      work.message = '专家需要补充关键目标或选择，请查看问题。';
    } else if (turn.action === 'finalize') {
      if (entry.role !== 'coordinator' || !turn.plan)
        throw workflowError('只有协调者可以提交完整最终方案。');
      try {
        const { plan, needed } = validateWorkflowPlan(
          turn.plan,
          work,
          source,
          document.content,
        );
        const contributed = new Set(
          work.messages
            .filter(
              (m) => m.round === work.round && m.response.action === 'propose',
            )
            .map((m) => m.role),
        );
        if (
          !plan.questions.length &&
          needed.some((role) => !contributed.has(role))
        )
          throw workflowError(
            `请先咨询并取得这些专家的提案：${needed.filter((role) => !contributed.has(role)).join(', ')}。`,
          );
        const record = {
          revision: work.plans.length + 1,
          hash: hash(plan),
          candidateRevision: document.revision,
          candidateHash: document.contentHash,
          plan,
        };
        await this.store.freeze(work.id, `plan-${record.revision}`, record);
        work.plans.push(record);
        work.questions = plan.questions;
        work.status = plan.questions.length
          ? 'needs_input'
          : work.executionAuthorized
            ? 'executing'
            : 'ready';
        work.phase = 'executing';
        work.message = plan.questions.length
          ? '请补充方案中的关键问题。'
          : work.executionAuthorized
            ? '方案校验完成，开始制作候选。'
            : '方案已就绪，等待制作授权。';
        work.queue = [];
      } catch (error) {
        const invalid = hash(turn.plan);
        if (work.lastInvalidPlan === invalid)
          throw workflowError(
            `协调者重复了相同无效方案，已停止调用。${displayError(error)}`,
          );
        work.lastInvalidPlan = invalid;
        work.messages.push({
          round: work.round,
          role: 'validator',
          response: {
            action: 'validation_feedback',
            summary: displayError(error),
          },
        });
        work.queue.unshift(
          this.enqueue(
            work,
            'coordinator',
            `本地校验拒绝该方案。保持原目标，仅修正问题并 finalize：${displayError(error)}`,
          ),
        );
      }
    } else if (entry.role === 'coordinator' && !work.queue.length) {
      work.queue.push(
        this.enqueue(
          work,
          'coordinator',
          '请完成必要咨询并 finalize，或者只提出缺失的关键问题。',
        ),
      );
    }
    await this.store.save(work);
  }
  async executeNext(work) {
    const record = await this.store.plan(work),
      steps = orderedSteps(record.plan);
    const step = steps.find(
      (s) =>
        !work.steps.some(
          (receipt) =>
            receipt.planHash === record.hash &&
            receipt.id === s.id &&
            receipt.status === 'completed',
        ),
    );
    if (!step) {
      work.status = work.phase = 'reviewing';
      work.message = '候选制作完成，正在检查实际画面与行为。';
      await this.store.save(work);
      return;
    }
    let receipt = work.steps.find(
      (r) => r.planHash === record.hash && r.id === step.id,
    );
    if (!receipt) {
      receipt = {
        id: step.id,
        title: step.title,
        kind: step.kind,
        planHash: record.hash,
        status: 'started',
      };
      work.steps.push(receipt);
      await this.store.save(work);
    }
    work.message = `正在执行：${step.title}`;
    const result = await executeWorkflowStep(
      this.store,
      work,
      step,
      receipt,
      () => this.store.save(work),
    );
    if (result.paused) {
      work.status = 'paused';
      work.message = '制作请求已保存，在原任务完成前暂停后续采用。';
      await this.store.save(work);
      return;
    }
    receipt.status = 'completed';
    receipt.afterRevision = result.document.revision;
    receipt.afterHash = result.document.contentHash;
    work.candidateRevision = result.document.revision;
    work.candidateHash = result.document.contentHash;
    await this.store.save(work);
  }
  beginRevision(work, issues) {
    work.repairs++;
    work.round++;
    work.phase = 'revising';
    work.status = 'revising';
    work.repairIssues = issues;
    work.lastInvalidPlan = null;
    work.queue = [
      this.enqueue(
        work,
        'coordinator',
        '根据当前候选与明确问题提出局部修订。保留已完成工作，保持原验收条件，修正步骤使用新 ID。',
      ),
    ];
    work.message = '正在根据检查结果调整受影响的步骤。';
  }
  async repairOrStop(work, issues) {
    if (
      work.executionAuthorized &&
      work.repairs < work.spec.budget.revisions &&
      countCalls(work, 'planning') < work.spec.budget.planningCalls
    )
      this.beginRevision(work, issues);
    else {
      work.status = 'attention_required';
      work.message =
        '候选仍有明确问题；本次修订额度已结束，已有结果和检查证据保留。';
    }
    await this.store.save(work);
  }
  validateOpinion(report, assigned, all, evidence, steps) {
    const ids = report.findings.map((f) => f.criterionId);
    if (
      new Set(ids).size !== ids.length ||
      assigned.some((id) => !ids.includes(id)) ||
      ids.some((id) => !all.includes(id))
    )
      throw workflowError(
        '复核缺少指定验收条件或引用了不存在的条件。',
        'SCENE_REVIEW_INVALID',
      );
    for (const finding of report.findings) {
      if (
        finding.evidenceIds.some((id) => !evidence.includes(id)) ||
        finding.affectedStepIds.some((id) => !steps.includes(id))
      )
        throw workflowError(
          '复核引用了不存在或不属于当前候选的证据。',
          'SCENE_REVIEW_INVALID',
        );
    }
    return report;
  }
  async reviewNext(work) {
    const planRecord = await this.store.plan(work),
      plan = planRecord.plan,
      document = await candidateDocument(this.store, work);
    let review = work.reviews.find(
      (r) =>
        r.planHash === planRecord.hash &&
        r.candidateHash === document.contentHash,
    );
    if (!review) {
      const technical = await technicalReview(this.store, work);
      review = {
        id: `review-${work.reviews.length + 1}`,
        planHash: planRecord.hash,
        candidateRevision: document.revision,
        candidateHash: document.contentHash,
        technical,
        evidenceIds: [],
        opinions: {},
        requiresHuman: [],
        status: 'running',
      };
      work.reviews.push(review);
      await this.store.save(work);
      if (!technical.passed) {
        review.status = 'failed';
        await this.repairOrStop(
          work,
          technical.checks
            .filter((check) => !check.passed)
            .map((check) => ({
              id: check.id,
              summary: check.description,
              evidence: check.checks,
            })),
        );
        return;
      }
    }
    if (!review.technical.passed) {
      review.status = 'failed';
      await this.repairOrStop(
        work,
        review.technical.checks
          .filter((check) => !check.passed)
          .map((check) => ({
            id: check.id,
            summary: check.description,
            evidence: check.checks,
          })),
      );
      return;
    }
    if (!review.evidenceIds.length) {
      const main = await observeWorkflow(this.store, work, {}, 'candidate');
      review.evidenceIds.push(main.metadata.id);
      for (const criterion of plan.visualCriteria.filter((c) => c.region)) {
        const result = await observeWorkflow(
          this.store,
          work,
          { region: criterion.region },
          `detail-${criterion.id}`,
        );
        review.evidenceIds.push(result.metadata.id);
      }
      for (const step of work.steps.filter(
        (item) => item.mapOutput?.reviewRegion,
      )) {
        const result = await observeWorkflow(
          this.store,
          work,
          { region: step.mapOutput.reviewRegion, overlay: false },
          `seam-${step.id}`,
        );
        review.evidenceIds.push(result.metadata.id);
      }
      for (const test of plan.acceptance) {
        const result = await observeWorkflow(
          this.store,
          work,
          { events: test.events },
          `replay-${test.id}`,
        );
        review.evidenceIds.push(result.metadata.id);
      }
      await this.store.save(work);
    }
    const evidence = work.evidence.filter((e) =>
      review.evidenceIds.includes(e.id),
    );
    if (
      evidence.some(
        (e) =>
          e.revision !== document.revision ||
          e.contentHash !== document.contentHash,
      )
    )
      throw workflowError('复核证据不属于当前候选版本。');
    const all = [...plan.visualCriteria, ...plan.acceptance].map((c) => c.id),
      stepIds = work.steps.map((step) => step.id);
    const evidenceIds = evidence.map((e) => e.id);
    const roles = [
      {
        role: 'visual_reviewer',
        assigned: plan.visualCriteria.map((c) => c.id),
      },
      ...(plan.acceptance.length
        ? [
            {
              role: 'behavior_reviewer',
              assigned: plan.acceptance.map((c) => c.id),
            },
          ]
        : []),
    ];
    for (const { role, assigned } of roles) {
      if (review.opinions[role]) continue;
      work.message = `${SCENE_ROLES[role]}正在检查候选。`;
      const report = await this.invoke(work, {
        key: `${review.id}:${role}`,
        role,
        kind: 'review',
        schema: reviewSchema,
        instructions: reviewerInstructions,
        data: {
          originalRequest: work.spec.description,
          clarifications: work.clarifications,
          requirements: plan.requirements,
          assignedCriteria: assigned,
          visualCriteria: plan.visualCriteria,
          acceptance: plan.acceptance,
          candidate: sceneSummary(document),
          technical: review.technical,
          evidence,
          steps: work.steps.map((s) => ({
            id: s.id,
            title: s.title,
            kind: s.kind,
            imageEvidence: s.imageEvidence,
            generationEvidence: s.generationEvidence,
            mapEvidence: s.mapOutput,
            mapGenerationEvidence: s.mapJob?.generationEvidence,
          })),
        },
        evidence: [work.evidence[0], ...evidence],
      });
      review.opinions[role] = this.validateOpinion(
        report,
        assigned,
        all,
        evidenceIds,
        stepIds,
      );
      await this.store.save(work);
      return;
    }
    const findings = Object.values(review.opinions).flatMap(
      (opinion) => opinion.findings,
    );
    const disputes = all.filter((id) => {
      const classifications = new Set(
        findings
          .filter((f) => f.criterionId === id)
          .map((f) => f.classification),
      );
      return (
        classifications.has('insufficient') ||
        (classifications.has('met') && classifications.has('defect'))
      );
    });
    if (
      disputes.length &&
      !review.dispute &&
      countCalls(work, 'review') < work.spec.budget.reviewCalls
    ) {
      const report = await this.invoke(work, {
        key: `${review.id}:dispute`,
        role: 'visual_reviewer',
        kind: 'review',
        schema: reviewSchema,
        instructions: `${reviewerInstructions}\nThis is the single bounded dispute review.`,
        data: {
          originalRequest: work.spec.description,
          requirements: plan.requirements,
          assignedCriteria: disputes,
          visualCriteria: plan.visualCriteria,
          acceptance: plan.acceptance,
          candidate: sceneSummary(document),
          technical: review.technical,
          opinions: review.opinions,
          evidence,
          stepIds,
        },
        evidence: [work.evidence[0], ...evidence],
      });
      review.dispute = this.validateOpinion(
        report,
        disputes,
        disputes,
        evidenceIds,
        stepIds,
      );
      await this.store.save(work);
    }
    const selected = [];
    for (const id of all) {
      const original = findings.filter((f) => f.criterionId === id);
      const resolved = review.dispute?.findings.find(
        (f) => f.criterionId === id,
      );
      if (resolved) {
        selected.push(resolved);
        if (
          ['met', 'preference'].includes(resolved.classification) &&
          original.some((f) =>
            ['defect', 'insufficient'].includes(f.classification),
          )
        )
          review.requiresHuman.push(id);
      } else
        selected.push(
          original.find((f) => f.classification === 'defect') ||
            original.find((f) => f.classification === 'insufficient') ||
            original[0],
        );
    }
    review.findings = selected;
    review.requiresHuman = [
      ...new Set([
        ...review.requiresHuman,
        ...selected
          .filter((f) => f.classification === 'insufficient')
          .map((f) => f.criterionId),
      ]),
    ];
    if (selected.some((f) => f.classification === 'defect')) {
      review.status = 'failed';
      await this.repairOrStop(
        work,
        selected.filter((f) => f.classification === 'defect'),
      );
      return;
    }
    review.status = review.requiresHuman.length ? 'needs_human' : 'passed';
    work.candidateRevision = document.revision;
    work.candidateHash = document.contentHash;
    work.status = review.requiresHuman.length
      ? 'attention_required'
      : 'ready_to_adopt';
    work.message = review.requiresHuman.length
      ? '复核仍有待实际画面确认的事项，原意见和复核建议均已保存。'
      : '候选检查完成，可以对比后采用到原场景。';
    await this.store.save(work);
  }
  async adopt(work, input, fingerprint) {
    await this.store.plan(work);
    const document = await candidateDocument(this.store, work),
      source = await this.store.source(work);
    const review = work.reviews.at(-1);
    if (
      !['ready_to_adopt', 'attention_required'].includes(work.status) ||
      !review?.technical.passed ||
      !['passed', 'needs_human'].includes(review.status)
    )
      throw workflowError('候选尚未完成有效检查，不能采用。');
    if (
      document.revision !== input.candidateRevision ||
      document.contentHash !== input.candidateHash ||
      review.candidateHash !== document.contentHash ||
      review.candidateRevision !== document.revision
    )
      throw workflowError(
        '候选版本或检查依据已变化，请重新检查。',
        'SCENE_CANDIDATE_CHANGED',
        409,
      );
    for (const id of review.requiresHuman)
      if (
        !input.acknowledgedCriteria.includes(id) ||
        input.reviewNote.trim().length < 4
      )
        throw workflowError(
          '请实际查看并明确确认所有待裁决事项，填写简短结论。',
        );
    for (const e of work.evidence.filter((e) =>
      review.evidenceIds.includes(e.id),
    ))
      await readEvidenceImages(this.store, e);
    await assertWorkflowProtection(
      this.store,
      work,
      source.document,
      document.content,
    );
    const checked = await technicalReview(this.store, work);
    if (!checked.passed) throw workflowError('采用前的行为或结构检查未通过。');
    const commandId = `scene-adopt:${work.id}:${hash(input.commandId).slice(0, 24)}`;
    // This intent precedes the document commit. A lost response repeats the same
    // exact command against the original revision; it cannot adopt a newer scene.
    if (work.adoptIntent && work.adoptIntent.fingerprint !== fingerprint)
      throw workflowError(
        '已有采用请求需要使用原 commandId 恢复。',
        'SCENE_ADOPTION_PENDING',
        409,
      );
    work.adoptIntent = { fingerprint, input, commandId };
    await this.store.save(work);
    const result = await saveDocument(
      this.store.root,
      this.manifest,
      {
        documentId: source.document.id,
        expectedRevision: source.document.revision,
        commandId,
        content: { ...document.content, id: source.document.id },
      },
      { respectLocks: true },
    );
    work.adoption = {
      documentId: result.document.id,
      revision: result.document.revision,
      contentHash: result.document.contentHash,
      candidateRevision: document.revision,
      candidateHash: document.contentHash,
      acknowledgedCriteria: input.acknowledgedCriteria,
      reviewNote: input.reviewNote,
      commandId: input.commandId,
    };
    work.commands.push({
      id: input.commandId,
      fingerprint,
      operation: 'scene-workflow-adopt',
    });
    work.status = 'completed';
    work.message = '已采用到原场景；源地图和交互物工程保持原版本。';
    await this.store.save(work);
    return { work: this.public(work), adoption: work.adoption };
  }
}

const services = new Map();
export function sceneWorkflowService(root, manifest) {
  const key = path.resolve(
    root,
    manifest.workspace.sceneWorkflowDirectory || 'work/scene-workflows',
  );
  if (!services.has(key))
    services.set(key, new SceneWorkflowService(root, manifest));
  return services.get(key);
}
export const sceneWorkflowRequest = (root, manifest, operation, input) =>
  sceneWorkflowService(root, manifest).request(operation, input);
