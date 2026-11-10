export type Role =
  | 'coordinator'
  | 'appearance'
  | 'layout'
  | 'behavior'
  | 'visual_reviewer'
  | 'behavior_reviewer';
export const roleNames: Record<Role, string> = {
  coordinator: '总协调者',
  appearance: '美术与素材',
  layout: '布局与空间',
  behavior: '交互与行为',
  visual_reviewer: '独立视觉复核',
  behavior_reviewer: '独立行为复核',
};
export const statusNames: Record<string, string> = {
  planning: '专家规划中',
  executing: '制作候选中',
  reviewing: '独立复核中',
  revising: '局部修订中',
  ready: '方案待执行',
  ready_to_adopt: '候选待采用',
  paused: '已暂停',
  needs_input: '需要补充要求',
  attention_required: '需要检查',
  budget_exhausted: '额度已用完',
  completed: '已采用',
};
export interface ModelProfile {
  provider: 'openai' | 'tokenhub';
  model: string;
  maxOutputTokens: number;
  timeoutSeconds: number;
  tokenParameter: 'max_tokens' | 'max_completion_tokens';
  reasoningEffort: 'auto' | 'low' | 'medium' | 'high';
}
export interface ModelConfiguration {
  default: ModelProfile;
  roles: Partial<Record<Role, ModelProfile>>;
}
export interface ModelSettings {
  configured: boolean;
  configuration: ModelConfiguration | null;
  services: Array<{
    id: string;
    name: string;
    endpoint: string;
    configured: boolean;
  }>;
  production?: Partial<Record<'prop' | 'map', ProductionProviderSettings>>;
}
export interface ProductionProviderSettings {
  provider: string | null;
  providers: Array<{
    id: string;
    name: string;
    model: string;
    configured: boolean;
  }>;
}
export interface WorkflowBudget {
  planningCalls: number;
  reviewCalls: number;
  imageCalls: number;
  generationCalls: number;
  mapTiles: number;
  revisions: number;
}
export type WorkflowMapMode = 'preserve' | 'create' | 'extend';
export const mapModeNames: Record<WorkflowMapMode, string> = {
  preserve: '保持地图几何',
  create: '创建新地图',
  extend: '扩建现有地图',
};
export interface WorkflowSpec {
  documentId: string;
  expectedRevision: number;
  description: string;
  sourceDocumentIds: string[];
  protectedInstanceIds: string[];
  editableMapLayerIds: string[];
  mapMode: WorkflowMapMode;
  generationProviders: Partial<Record<'prop' | 'map', string>>;
  budget: WorkflowBudget;
  autoExecute: boolean;
}
export interface WorkflowPlan {
  title: string;
  summary: string;
  questions: string[];
  requirements: Array<{
    id: string;
    text: string;
    source: 'user' | 'expert';
    evidence: string;
  }>;
  steps: Array<{
    id: string;
    title: string;
    kind: string;
    dependsOn: string[];
    input: string;
  }>;
  visualCriteria: Array<{ id: string; description: string; requirementIds?: string[]; region?: { x: number; y: number; width: number; height: number } | null }>;
  acceptance: Array<{ id: string; description: string; requirementIds?: string[]; events?: unknown[]; expectEvents?: unknown[]; expectStates?: unknown[] }>;
}
export interface Evidence {
  id: string;
  revision: number;
  contentHash: string;
  images: Array<{
    role: string;
    sha256: string;
    artifactPath: string;
    width: number;
    height: number;
  }>;
}
export interface Finding {
  criterionId: string;
  classification: string;
  evidenceIds: string[];
  explanation: string;
  suggestion: string;
}
export interface WorkflowReview {
  id: string;
  candidateRevision: number;
  candidateHash: string;
  status: string;
  requiresHuman: string[];
  findings?: Finding[];
  opinions: Record<string, { summary: string; findings: Finding[] }>;
  dispute?: { summary: string; findings: Finding[] };
  technical: {
    passed: boolean;
    engineValidated: false;
    checks: Array<{
      id: string;
      description: string;
      passed: boolean;
      checks: unknown;
    }>;
  };
}
export interface WorkflowAdoption {
  documentId: string;
  revision: number;
  contentHash: string;
  candidateRevision: number;
  candidateHash: string;
}
export interface WorkflowStepReceipt {
  id: string;
  title: string;
  kind: string;
  planHash: string;
  status: string;
  beforeRevision?: number;
  beforeHash?: string;
  afterRevision?: number;
  afterHash?: string;
  commandId?: string;
  generationJob?: {
    requestId: string;
    requestHash: string;
    status: string;
    taskId?: string;
    profileHash: string;
    submissionState?: string;
    submitted?: boolean;
  };
  generationEvidence?: {
    image: {
      artifactPath: string;
      sha256: string;
      width: number;
      height: number;
    };
    provider: string;
    model: string;
    usage?: Record<string, unknown>;
  };
  mapJob?: {
    id: string;
    commandId: string;
    generationJob?: WorkflowStepReceipt['generationJob'];
    generationEvidence?: WorkflowStepReceipt['generationEvidence'];
  };
  mapOutput?: {
    operation: 'create' | 'extend';
    stepId: string;
    tileKey: string;
    layerId: string;
    tileBounds: { x: number; y: number; width: number; height: number };
    beforeMapHash: string;
    afterMapHash: string;
    sourceTaskId: string;
    generatedSha256: string;
    stitchedSha256: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface GenerationProfile {
  provider: string;
  model: string;
  configuredAtCreation: boolean;
  [key: string]: unknown;
}
export interface SceneWorkflow {
  id: string;
  revision: number;
  status: string;
  phase: string;
  running: boolean;
  recoverableProduction?: boolean;
  configurationRequired?: boolean;
  message: string;
  createdAt: string;
  updatedAt: string;
  spec: WorkflowSpec;
  sourceRevision: number;
  sourceContentHash: string;
  candidateRevision?: number;
  candidateHash?: string;
  usage: WorkflowBudget;
  generationConfiguration?: {
    schemaVersion: 1;
    prop: GenerationProfile | null;
    map: GenerationProfile | null;
  } | null;
  generationCalls?: Array<Record<string, unknown>>;
  questions?: string[];
  adoption?: WorkflowAdoption;
  plans: Array<{ revision: number; hash: string; plan: WorkflowPlan }>;
  messages: Array<{
    key?: string;
    role: Role | 'validator';
    round: number;
    question?: string;
    response: { action: string; summary: string; question?: string };
  }>;
  calls: Array<{
    id: string;
    role: Role;
    kind: string;
    status: string;
    profile: ModelProfile;
    evidenceIds: string[];
    receipt?: {
      responseId?: string;
      requestId?: string;
      usage?: Record<string, number>;
    };
  }>;
  steps: WorkflowStepReceipt[];
  evidence: Evidence[];
  reviews: WorkflowReview[];
}
export interface WorkflowResult {
  work: SceneWorkflow;
  adoption?: WorkflowAdoption;
  replayed?: boolean;
}
export interface WorkflowHistoryPage {
  works: SceneWorkflow[];
  total: number;
  offset: number;
  limit: number;
  snapshot: string;
  nextOffset: number | null;
}
export function mergeWorkflowHistory(current: SceneWorkflow[], incoming: SceneWorkflow[]) {
  const rows = new Map(current.map((work) => [work.id, work]));
  for (const work of incoming) rows.set(work.id, newerWorkflow(rows.get(work.id) || null, work));
  return [...rows.values()];
}
export function sceneWorkflowNavigation(value: string) {
  const url = new URL(value, 'http://workbench.local');
  const documentId = url.searchParams.get('document');
  const workId = url.searchParams.get('sceneWorkflow');
  const valid = (id: string | null) => !!id && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id);
  return valid(documentId) && valid(workId) ? { documentId: documentId!, workId: workId! } : null;
}
export function writeSceneWorkflowNavigation(documentId: string, workId: string | null) {
  const url = new URL(window.location.href);
  if (workId) {
    url.searchParams.set('document', documentId);
    url.searchParams.set('scene', documentId);
    url.searchParams.set('sceneWorkflow', workId);
  } else url.searchParams.delete('sceneWorkflow');
  window.history.replaceState(null, '', url);
}
export function newerWorkflow(
  current: SceneWorkflow | null,
  incoming: SceneWorkflow,
): SceneWorkflow {
  return current?.id === incoming.id && current.revision > incoming.revision
    ? current
    : incoming;
}
export class WorkflowClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'WorkflowClientError';
  }
}
export async function workflowRequest<T>(
  operation: string,
  input: unknown = {},
): Promise<T> {
  const response = await fetch(
    `/api/workbench/scene-workflow/${encodeURIComponent(operation)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      cache: 'no-store',
      signal: AbortSignal.timeout(90000),
    },
  );
  const value = (await response.json()) as { error?: string; code?: string };
  if (!response.ok)
    throw new WorkflowClientError(
      value.error || '场景协作请求未完成。',
      response.status,
      value.code,
    );
  return value as T;
}
export function canAdoptWorkflow(work: SceneWorkflow): boolean {
  const review = work.reviews.at(-1);
  return (
    !work.running &&
    !work.recoverableProduction &&
    ['ready_to_adopt', 'attention_required'].includes(work.status) &&
    !!review?.technical.passed &&
    ['passed', 'needs_human'].includes(review.status) &&
    review.candidateRevision === work.candidateRevision &&
    review.candidateHash === work.candidateHash
  );
}
export function canReviseWorkflow(work: SceneWorkflow): boolean {
  return (
    !work.running &&
    !work.recoverableProduction &&
    work.status !== 'completed' &&
    work.usage.revisions < work.spec.budget.revisions &&
    work.usage.planningCalls < work.spec.budget.planningCalls
  );
}
export function adoptionInput(
  work: SceneWorkflow,
  acknowledgedCriteria: string[],
  reviewNote: string,
  commandId = crypto.randomUUID(),
) {
  const review = work.reviews.at(-1);
  if (!canAdoptWorkflow(work) || !review)
    throw new Error('候选尚未完成当前版本的检查。');
  if (
    review.requiresHuman.some((id) => !acknowledgedCriteria.includes(id)) ||
    (review.requiresHuman.length && reviewNote.trim().length < 4)
  )
    throw new Error('请查看证据并确认待裁决事项。');
  return {
    workId: work.id,
    expectedRevision: work.revision,
    commandId,
    candidateRevision: work.candidateRevision,
    candidateHash: work.candidateHash,
    acknowledgedCriteria,
    reviewNote,
  };
}
export function validateAdoption(
  work: SceneWorkflow,
  adoption: WorkflowAdoption,
) {
  if (
    work.status !== 'completed' ||
    adoption.documentId !== work.spec.documentId ||
    adoption.candidateRevision !== work.candidateRevision ||
    adoption.candidateHash !== work.candidateHash ||
    !Number.isInteger(adoption.revision) ||
    adoption.revision <= work.sourceRevision
  )
    throw new Error('采用回执与所选候选不匹配。');
}
export function validateMutationResult(
  result: WorkflowResult,
  operation: string,
  input: Record<string, unknown>,
  documentId: string,
) {
  if (
    result.work.spec.documentId !== documentId ||
    (input.workId !== undefined && result.work.id !== input.workId)
  )
    throw new Error('协作回执与原请求的场景或任务不匹配。');
  if (operation === 'adopt') {
    if (!result.adoption) throw new Error('采用请求未返回有效回执。');
    validateAdoption(result.work, result.adoption);
    if (
      result.adoption.candidateRevision !== input.candidateRevision ||
      result.adoption.candidateHash !== input.candidateHash
    )
      throw new Error('采用回执与原请求的候选不匹配。');
  }
}
