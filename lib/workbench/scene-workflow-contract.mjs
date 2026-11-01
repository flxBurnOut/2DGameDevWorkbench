import * as z from 'zod/v4';
import {
  sceneCommandSchema,
  interactableCommandSchema,
  documentInputs,
} from './document-contract.mjs';
import {
  imageRegionSpecSchema,
  imageEditOperationSchema,
} from './image-edit-contract.mjs';
import {
  generationStepSchema,
  mapStepSchema,
} from './scene-workflow-production-contract.mjs';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const providerId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const commandId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const revision = z.number().int().positive();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const short = z.string().min(1).max(1200);
export const SCENE_ROLES = {
  coordinator: '总协调者',
  appearance: '美术与素材专家',
  layout: '布局与空间专家',
  behavior: '交互与行为专家',
  visual_reviewer: '独立视觉复核',
  behavior_reviewer: '独立行为复核',
};
export const planningRoles = [
  'coordinator',
  'appearance',
  'layout',
  'behavior',
];
export const busyStates = ['planning', 'executing', 'reviewing', 'revising'];
const role = z.enum(planningRoles);
export const regionSchema = z
  .object({
    x: z.number().min(-1e7).max(1e7),
    y: z.number().min(-1e7).max(1e7),
    width: z.number().positive().max(30000),
    height: z.number().positive().max(30000),
  })
  .strict();
export const modelProfileSchema = z
  .object({
    provider: z.enum(['openai', 'tokenhub']),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/),
    maxOutputTokens: z.number().int().min(1024).max(32768).default(12000),
    timeoutSeconds: z.number().int().min(30).max(600).default(180),
    tokenParameter: z
      .enum(['max_tokens', 'max_completion_tokens'])
      .default('max_tokens'),
    reasoningEffort: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  })
  .strict();
export const modelSettingsSchema = z
  .object({
    default: modelProfileSchema,
    roles: z
      .object(
        Object.fromEntries(
          Object.keys(SCENE_ROLES).map((key) => [
            key,
            modelProfileSchema.optional(),
          ]),
        ),
      )
      .strict()
      .default({}),
  })
  .strict();
export const budgetSchema = z
  .object({
    planningCalls: z.number().int().min(4).max(48).default(16),
    reviewCalls: z.number().int().min(2).max(30).default(9),
    imageCalls: z.number().int().min(0).max(8).default(0),
    generationCalls: z.number().int().min(0).max(16).default(0),
    mapTiles: z.number().int().min(0).max(16).default(0),
    revisions: z.number().int().min(0).max(3).default(2),
  })
  .strict();
export const taskSpecSchema = z
  .object({
    documentId: id,
    expectedRevision: revision,
    description: z.string().trim().min(4).max(12000),
    sourceDocumentIds: z.array(id).max(12).default([]),
    protectedInstanceIds: z.array(id).max(2000).default([]),
    editableMapLayerIds: z.array(id).max(8).default([]),
    mapMode: z.enum(['preserve', 'create', 'extend']).default('preserve'),
    generationProviders: z
      .object({ prop: providerId.optional(), map: providerId.optional() })
      .strict()
      .default({}),
    budget: budgetSchema.default({
      planningCalls: 16,
      reviewCalls: 9,
      imageCalls: 0,
      generationCalls: 0,
      mapTiles: 0,
      revisions: 2,
    }),
    autoExecute: z.boolean().default(true),
  })
  .strict();

// The model emits a small envelope; input JSON is then parsed against the same
// typed command contracts as the editors. It is data, never executable code.
export const stepSchema = z
  .object({
    id,
    title: short,
    kind: z.enum(['scene', 'object', 'image', 'generate', 'map']),
    dependsOn: z.array(id).max(24),
    input: z.string().min(2).max(100000),
  })
  .strict();
const simulate = documentInputs['document-simulate'].shape;
export const acceptanceSchema = z
  .object({
    id,
    description: short,
    requirementIds: z.array(id).min(1).max(40),
    events: simulate.events,
    expectEvents: simulate.expectEvents.unwrap(),
    expectStates: simulate.expectStates.unwrap(),
  })
  .strict()
  .refine(
    (value) => value.expectEvents.length + value.expectStates.length > 0,
    '行为检查必须包含事件或状态断言。',
  )
  .refine(
    (value) =>
      value.expectStates.every((state) =>
        Object.keys(state).some(
          (key) => key !== 'instanceId' && state[key] !== undefined,
        ),
      ),
    '每项状态断言必须指定至少一个预期状态，不能只列实例身份。',
  );
export const planSchema = z
  .object({
    title: z.string().min(1).max(160),
    summary: short,
    requirements: z
      .array(
        z
          .object({
            id,
            text: short,
            source: z.enum(['user', 'expert']),
            evidence: z.string().max(1200),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    steps: z.array(stepSchema).max(24),
    visualCriteria: z
      .array(
        z
          .object({
            id,
            description: short,
            requirementIds: z.array(id).min(1).max(40),
            region: regionSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    acceptance: z.array(acceptanceSchema).max(4),
    questions: z.array(short).max(6),
  })
  .strict();
export const expertTurnSchema = z
  .object({
    action: z.enum(['propose', 'consult', 'observe', 'finalize', 'ask_user']),
    summary: short,
    target: role.nullable(),
    question: z.string().max(1200),
    observation: z
      .object({
        region: regionSchema.nullable(),
        events: simulate.events.nullable(),
        sourceObject: z
          .object({ documentId: id, definitionId: id })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    plan: planSchema.nullable(),
  })
  .strict();
export const reviewSchema = z
  .object({
    summary: short,
    findings: z
      .array(
        z
          .object({
            criterionId: id,
            classification: z.enum([
              'met',
              'defect',
              'preference',
              'insufficient',
            ]),
            evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(12),
            affectedStepIds: z.array(id).max(24),
            explanation: short,
            suggestion: z.string().max(1200),
          })
          .strict(),
      )
      .min(1)
      .max(24),
  })
  .strict();
export const stepInputs = {
  generate: generationStepSchema,
  map: mapStepSchema,
  scene: z
    .object({ commands: z.array(sceneCommandSchema).min(1).max(100) })
    .strict(),
  object: z
    .object({
      materialId: id,
      definitionId: id,
      name: z.string().min(1).max(200),
      source: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('scene'), materialId: id }).strict(),
        z
          .object({
            kind: z.literal('document'),
            documentId: id,
            definitionId: id,
          })
          .strict(),
      ]),
      commands: z.array(interactableCommandSchema).max(60),
    })
    .strict(),
  image: z
    .object({
      target: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('scene-layer'), layerId: id }).strict(),
        z
          .object({
            kind: z.literal('scene-instance'),
            instanceId: id,
            slot: z.enum(['visual', 'toggle-state', 'sequence-entry']),
            index: z.number().int().min(0).max(99).optional(),
          })
          .strict(),
      ]),
      region: imageRegionSpecSchema,
      operation: imageEditOperationSchema,
      preserveAlpha: z.boolean().default(true),
    })
    .strict(),
};
const work = { workId: id };
const mutate = { ...work, expectedRevision: revision, commandId };
export const sceneWorkflowInputs = {
  'scene-workflow-settings': z
    .object({
      configuration: modelSettingsSchema.optional(),
      keys: z
        .object({
          openai: z.string().max(4096).optional(),
          tokenhub: z.string().max(4096).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  'scene-workflow-list': z
    .object({
      documentId: id.optional(),
      limit: z.number().int().min(1).max(50).default(20),
      offset: z.number().int().min(0).default(0),
      snapshot: sha.optional(),
    })
    .strict(),
  'scene-workflow-create': z
    .object({ commandId, spec: taskSpecSchema })
    .strict(),
  'scene-workflow-get': z.object(work).strict(),
  'scene-workflow-execute': z.object({ ...mutate, planHash: sha }).strict(),
  'scene-workflow-revise': z
    .object({ ...mutate, clarification: z.string().trim().min(4).max(4000) })
    .strict(),
  'scene-workflow-pause': z.object({ ...work, commandId }).strict(),
  'scene-workflow-resume': z.object(mutate).strict(),
  'scene-workflow-observe': z
    .object({ ...work, evidenceId: z.string().min(1).max(200).optional(), imageStepId: id.optional() })
    .strict().refine(v => !(v.imageStepId && v.evidenceId), 'Specify either imageStepId or evidenceId.'),
  'scene-workflow-adopt': z
    .object({
      ...mutate,
      candidateRevision: revision,
      candidateHash: sha,
      acknowledgedCriteria: z.array(id).max(24).default([]),
      reviewNote: z.string().max(1200).default(''),
    })
    .strict(),
};
export const sceneWorkflowTools = [
  [
    'workbench_list_scene_workflows',
    'scene-workflow-list',
    'List saved scene collaboration tasks; no model call. Follow nextOffset with the returned snapshot until null to read all history. If the list changes, restart from offset 0.',
  ],
  [
    'workbench_create_scene_workflow',
    'scene-workflow-create',
    'Plan and optionally execute an authorized scene task using bounded experts. Freezes a saved scene, selected sources, protection, generation providers and budgets. Can generate object art and create or extend maps only within the explicit policy and quotas. Uses an isolated candidate; never changes the original automatically. Model and image calls may incur costs.',
  ],
  [
    'workbench_get_scene_workflow',
    'scene-workflow-get',
    'Read the exact saved scene task, expert exchanges, plans, receipts and checks. Does not restart interrupted requests.',
  ],
  [
    'workbench_execute_scene_workflow',
    'scene-workflow-execute',
    'Execute the exact reviewed plan into an isolated candidate within its frozen budget, then run independent visual and behavior checks.',
  ],
  [
    'workbench_revise_scene_workflow',
    'scene-workflow-revise',
    'Add an explicit clarification and request a bounded revision. Preserves completed candidate work and lifetime usage; cannot increase budgets or change protected targets.',
  ],
  [
    'workbench_pause_scene_workflow',
    'scene-workflow-pause',
    'Pause at the next safe boundary; an already submitted request may complete and is not submitted again.',
  ],
  [
    'workbench_resume_scene_workflow',
    'scene-workflow-resume',
    'Continue saved safe work within existing authorization. Unknown or failed model submissions are never retried automatically.',
  ],
  [
    'workbench_observe_scene_workflow',
    'scene-workflow-observe',
    'Read saved candidate/reference evidence and PNGs at their exact revision, or specify imageStepId for a completed image step to compare its base and candidate at placement scale; no model call or browser-draft access.',
  ],
  [
    'workbench_adopt_scene_workflow',
    'scene-workflow-adopt',
    'Adopt the exact checked candidate into the original scene with source-revision checks and an idempotent command. Preserves upstream maps and object projects; reports conflicts instead of overwriting newer edits.',
  ],
];
