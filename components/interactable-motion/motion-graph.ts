import { motionUrl, type MotionCandidate, type MotionWork } from '../sprite-generator/open-motion-model';

/**
 * The interactable panel shows one open-motion work as a state graph. Nodes
 * are the named states (the reference image first); edges are plan stages.
 * Everything here is derived from the saved work, never stored separately.
 */
export type StateDraft = { name: string; appearance: string; targetPng?: string };
export type InteractableDraft = {
  states: StateDraft[];
  /** Transition into the last state ends with this hold description. */
  hold: string;
  loop: boolean;
  returnToStart: boolean;
};

export type NodeSource = 'reference' | 'confirmed' | 'target' | 'derived' | 'text';
export type GraphNode = {
  index: number;
  name: string;
  source: NodeSource;
  /** open-motion relative path plus cache key for its exact image. */
  image?: { path: string; v: string };
  /** Plan stage that ends in this node; null for the reference state. */
  stage: number | null;
  /** Index in the candidate's state chain (asset id suffix), when confirmed. */
  chainIndex?: number;
};
export type EdgeStatus = 'draft' | 'planned' | 'generating' | 'reviewing' | 'awaiting_review' | 'accepted' | 'state_only'
  | 'rejected' | 'attention';
export type GraphEdge = {
  stage: number;
  from: number;
  to: number;
  name: string;
  frames: number;
  status: EdgeStatus;
  /** Frames of this stage inside the finished candidate, when it has one. */
  timeline?: { start: number; count: number; hold: number };
};

export const edgeStatusLabels: Record<EdgeStatus, string> = {
  draft: '草稿',
  planned: '规划中',
  generating: '生成中',
  reviewing: '复核中',
  awaiting_review: '待检查',
  accepted: '已接受',
  state_only: '状态帧已确认',
  rejected: '已拒绝',
  attention: '需要处理',
};
export const nodeSourceLabels: Record<NodeSource, string> = {
  reference: '原图',
  confirmed: '已确认',
  target: '目标图',
  derived: '派生图',
  text: '仅文字',
};

const MAX_TRANSITIONS = 4;
export const draftLimits = { states: MAX_TRANSITIONS + 1, name: 40, appearance: 200 };

/** The first draft state uses the bound object's actual initial appearance. */
export function defaultDraft(kind?: 'toggle' | 'sequence' | null, entries: string[] = [], initialToggle = false): InteractableDraft {
  const names = kind === 'sequence' && entries.length >= 2
    ? entries.slice(0, draftLimits.states)
    : kind === 'toggle' && entries.length === 2 ? (initialToggle ? [entries[1], entries[0]] : entries) : ['关闭', '打开'];
  return {
    states: names.map((name, index) => ({ name: name.slice(0, draftLimits.name) || `状态 ${index + 1}`, appearance: '' })),
    hold: '',
    loop: false,
    returnToStart: false,
  };
}

export function draftFromWork(work: MotionWork): InteractableDraft | null {
  const skeleton = work.spec.interactable_skeleton;
  if (!skeleton) return null;
  const returnToStart = work.spec.return_to_reference;
  const hasClosingState = returnToStart && skeleton.states.length > 2 && skeleton.states.at(-1)?.name === skeleton.states[0].name;
  return {
    states: (hasClosingState ? skeleton.states.slice(0, -1) : skeleton.states).map(state => ({ ...state })),
    hold: skeleton.hold ?? '',
    loop: work.spec.loop,
    returnToStart,
  };
}

export function draftProblems(draft: InteractableDraft): string[] {
  const problems: string[] = [];
  if (draft.states.length < 2) problems.push('至少需要两个状态');
  if (draft.states.length > draftLimits.states) problems.push(`最多 ${draftLimits.states} 个状态（${MAX_TRANSITIONS} 段过渡）`);
  const names = draft.states.map(s => s.name.trim());
  if (names.some(n => !n)) problems.push('每个状态都需要名称');
  if (new Set(names).size !== names.length) problems.push('状态名称不能重复');
  if (draft.states.slice(1).some(s => s.appearance.trim().length < 2)) problems.push('描述原图之后每个状态的外观');
  if (draft.returnToStart && draft.states.length >= draftLimits.states) problems.push(`回到初始状态也算一段过渡，最多 ${draftLimits.states - 1} 个状态`);
  return problems;
}

/**
 * Before structured skeletons (B1) were accepted by the planner, the graph was
 * serialized into the user's own description. The text keeps every state name
 * so the frozen plan and checkpoints can be matched back to the graph.
 */
export function draftDescription(draft: InteractableDraft): { description: string; ending: string } {
  const [first, ...rest] = draft.states;
  const chain = draft.states.map(s => `「${s.name.trim()}」`).join(' → ');
  const lines = [
    `交互物状态动画，按顺序经过 ${draft.states.length} 个状态：${chain}。`,
    `初始状态「${first.name.trim()}」就是对象原图${first.appearance.trim() ? `：${first.appearance.trim()}` : ''}。`,
    ...rest.map((s, i) => `过渡 ${i + 1}：从「${draft.states[i].name.trim()}」变为「${s.name.trim()}」${s.appearance.trim() ? `，${s.appearance.trim()}` : ''}。`),
    '固定部件保持不动，只有运动部件改变。',
  ];
  if (draft.hold.trim()) lines.push(`结束后：${draft.hold.trim()}。`);
  if (draft.returnToStart) lines.push(`最后回到初始状态「${first.name.trim()}」。`);
  const last = draft.returnToStart ? first : draft.states.at(-1)!;
  return { description: lines.join('\n').slice(0, 2000), ending: `停在「${last.name.trim()}」`.slice(0, 300) };
}

/** Structured skeleton sent with the spec once the planner accepts it (B1). */
export function draftSkeleton(draft: InteractableDraft) {
  const states = draft.states.map(s => ({ name: s.name.trim(), appearance: s.appearance.trim() || s.name.trim() }));
  // Returning to the start is one more transition, back to the reference state.
  if (draft.returnToStart && states.length < draftLimits.states) states.push({
    ...states[0], appearance: `回到初始状态：${states[0].appearance}`.slice(0, draftLimits.appearance),
  });
  return { states, hold: draft.hold.trim() };
}

export function draftTransitionCount(draft: InteractableDraft): number {
  return draft.states.length - 1 + Number(draft.returnToStart);
}

export function pendingDraftTargets(work: MotionWork, draft: InteractableDraft) {
  return draft.states.slice(1).flatMap((state, stage) => state.targetPng && !work.end_targets?.some(t => t.stage === stage)
    ? [{ name: state.name, png: state.targetPng, stage }]
    : []);
}

function stageStatus(work: MotionWork, candidate: MotionCandidate | undefined, stage: number): EdgeStatus {
  if (!work.plan) return 'draft';
  if (!work.job || !candidate) return 'planned';
  const run = candidate.plan_execution.stages[stage];
  if (!run) return 'planned';
  if (run.state === 'accepted') return 'accepted';
  if (run.state === 'reviewing') return 'reviewing';
  if (run.state === 'awaiting_review') {
    return candidate.state_chain?.some(s => s.stage === stage) ? 'state_only' : 'awaiting_review';
  }
  if (run.state === 'rejected') return 'rejected';
  if (['submitting', 'pending', 'complete'].includes(run.state)) return 'generating';
  if (['failed', 'unknown'].includes(run.state)) return 'attention';
  return 'planned';
}

/** State names come from the same boundary rule as `state_chain.transition`. */
export function stateNames(work: MotionWork): string[] {
  const prop = work.plan?.quality?.interactable;
  if (!work.plan || !prop) return [];
  return [prop.initial_state, ...work.plan.stages.slice(0, -1).map(s => s.checkpoint?.endpoint || s.goal), prop.target_state];
}

export function workGraph(work: MotionWork | null, candidateIndex = 1, draft?: InteractableDraft): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!work?.plan?.quality?.interactable) {
    const states = draft?.states || [];
    return {
      nodes: states.map((s, index) => ({ index, name: s.name || `状态 ${index + 1}`, stage: index ? index - 1 : null,
        source: index === 0 ? 'reference' : s.targetPng ? 'target' : 'text' })),
      edges: states.slice(1).map((s, i) => ({ stage: i, from: i, to: i + 1, name: `${states[i].name} → ${s.name}`, frames: 0,
        status: work?.status === 'planning' ? 'planned' : 'draft' })),
    };
  }
  const candidate = work.job?.candidates.find(c => c.candidate_index === candidateIndex);
  const names = stateNames(work);
  const revision = String(work.revision);
  const nodes: GraphNode[] = names.map((name, index) => {
    if (index === 0) return { index, name, stage: null, source: 'reference', image: { path: 'reference', v: revision }, chainIndex: 0 };
    const stage = index - 1;
    const chain = candidate?.state_chain?.findIndex(s => s.stage === stage) ?? -1;
    if (candidate && chain >= 0) {
      const state = candidate.state_chain![chain];
      return { index, name, stage, source: 'confirmed', chainIndex: chain,
        image: { path: `candidates/${candidate.candidate_index}/stages/${stage}/state-image`, v: state.sha256 } };
    }
    const target = work.end_targets?.find(t => t.stage === stage);
    if (target) return { index, name, stage, source: 'target', image: { path: `targets/${stage}`, v: target.sha256 } };
    return { index, name, stage, source: 'text' };
  });
  const edges: GraphEdge[] = work.plan.stages.map((s, stage) => {
    const row = candidate?.plan_execution.timeline[stage];
    return {
      stage, from: stage, to: stage + 1, name: s.name,
      // The assembled timeline is what plays and what tools edit. Before assembly the stage review shows exactly
      // the planned count: raw provider counts may include a removed context frame.
      frames: (row && candidate?.frames.length ? row.count : 0) || s.frame_count,
      status: stageStatus(work, candidate, stage),
      ...(row && candidate?.frames.length ? { timeline: { start: row.start, count: row.count, hold: row.hold_frames ?? 0 } } : {}),
    };
  });
  return { nodes, edges };
}

export type Selection = { kind: 'node'; index: number } | { kind: 'edge'; stage: number };

export function nodeImageUrl(node: GraphNode, work: Pick<MotionWork, 'id' | 'revision'> | null, referenceUrl: string) {
  if (node.index === 0 && referenceUrl) return referenceUrl;
  return node.image && work
    ? motionUrl(`open-motion/${work.id}/${node.image.path}`, { revision: String(work.revision), v: node.image.v })
    : '';
}

/** What still blocks the panel, phrased for the status bar, plus its one primary action. */
export type PanelAction = 'plan' | 'replan' | 'generate' | 'resume' | 'review-stage' | 'review-candidate' | 'writeback' | 'wait' | 'none';
export function panelStatus(work: MotionWork | null, candidateIndex: number, draft: InteractableDraft, objectId: string): { missing: string[]; action: PanelAction; message: string } {
  if (!work) {
    const missing = [!objectId ? '选择交互物对象' : '', ...draftProblems(draft)].filter(Boolean);
    return { missing, action: 'plan', message: missing.length ? '' : '状态图保存在当前浏览器；制定方案时才提交。' };
  }
  if (work.revision !== work.latest_revision) return { missing: ['进入最新版本'], action: 'none', message: '正在查看历史版本。' };
  if (work.status === 'planning') return { missing: [], action: 'wait', message: '正在形成制作方案…' };
  if (!work.plan) return { missing: [], action: 'replan', message: work.message || '本轮规划已停止，未提交绘图。' };
  if (work.plan.questions.length) return { missing: ['补充方案提出的问题'], action: 'replan', message: '返回状态图补充后重新制定方案。' };
  // Unmet reference premises (for example a hinge without a checked structure) block production.
  if (work.status === 'needs_input' && !work.job) return { missing: ['处理方案提出的前提问题'], action: 'replan', message: work.message };
  if (!work.job) return { missing: [], action: 'generate', message: '核对状态与过渡后开始制作。' };
  const candidate = work.job.candidates.find(c => c.candidate_index === candidateIndex);
  if (!candidate) return { missing: ['选择候选'], action: 'none', message: '' };
  const awaiting = candidate.plan_execution.stages.findIndex(s => s.state === 'awaiting_review');
  if (awaiting >= 0) return { missing: [`确认第 ${awaiting + 1} 段过渡`], action: 'review-stage', message: '在中间播放本段，填写结论后确认状态帧或整段过渡；后续制作在确认后继续。' };
  if (candidate.status === 'approved') return { missing: [], action: 'writeback', message: '已采用。可以写回交互物或导出。' };
  // Accepted transitions are usable on their own; a blocked whole clip only prevents adoption and export.
  if (candidate.frames.length && candidate.hard_failures.length)
    return { missing: [], action: 'writeback', message: '完整候选有技术阻断（见“检查”页签），不能采用或导出；已确认的状态图与已接受的过渡仍可写回。' };
  if (candidate.frames.length) return { missing: ['播放并采用完整候选'], action: 'review-candidate', message: '在“检查”页签播放并填写结论后采用；也可以先写回已接受的过渡。' };
  if (work.job.plan_control.enabled) return { missing: [], action: 'wait', message: work.job.plan_control.message };
  return { missing: [], action: 'resume', message: work.job.plan_control.message };
}

/** Keep the editor context (document and object) on every in-panel navigation. */
export function panelHref(values: Record<string, string | number | undefined>, context: { documentId: string; definitionId: string }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...values, document: context.documentId, definition: context.definitionId }))
    if (value !== undefined && value !== '') query.set(key, String(value));
  return `/tools/interactable-motion${query.size ? `?${query}` : ''}`;
}

/** Where the work is in its life cycle; drives the step indicator and the centre view. */
export const panelPhases = ['定义状态', '制定方案', '制作与检查', '写回'] as const;
export function panelPhase(work: MotionWork | null, editing: boolean): number {
  if (!work || editing) return 0;
  if (!work.plan || !work.job) return 1;
  const done = work.job.candidates.some(c => c.status === 'approved' ||
    (c.frames.length > 0 && c.plan_execution.stages.every(s => s.state === 'accepted')));
  return done ? 3 : 2;
}
