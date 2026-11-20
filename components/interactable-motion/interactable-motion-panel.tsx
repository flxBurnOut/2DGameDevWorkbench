'use client';
/* oxlint-disable next/no-img-element -- Exact pixel frames and state images. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowRight, Check, History, LoaderCircle, Settings2, Sparkles, Pencil, ChevronRight } from 'lucide-react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useWorkbenchActions } from '@/components/workbench/workbench-provider';
import { SourceAssetLink } from '@/components/workbench/shared-navigation';
import { publishEditorSession, removeEditorSession, markEditorSaved } from '@/lib/workbench/editor-session';
import { readDocument } from '@/features/editor-documents/client';
import type { InteractableProject } from '@/features/interactable-editor/contract.mjs';
import type { ImageTargetRef } from '@/features/image-edit/client';
import type { Box, Point } from '@/features/interactable-motion/frame-tools';
import { ImageEditWorkspace } from '../image-edit/lazy-image-edit-workspace';
import {
  blankSpec, MotionRequestError, motionObjectId, motionPlanningRequestKey, motionReferenceObjects, motionSpecsEqual, motionRequest, motionUrl, motionWorkspace, submitMotionPlan,
  type MotionReferenceObject, type MotionReview, type MotionSpec, type MotionWork,
} from '../sprite-generator/open-motion-model';
import type { MotionConfiguration } from '../sprite-generator/motion-model-settings';
import { useMotionWork } from '../sprite-generator/use-motion-work';
import { MotionStageReview } from '../sprite-generator/motion-stage-review';
import { MotionVisualReview } from '../sprite-generator/motion-visual-review';
import { MotionTargets } from '../sprite-generator/motion-targets';
import { MotionAdjustment } from '../sprite-generator/motion-adjustment';
import { ExpertRecord, motionPlanningRoles } from '../sprite-generator/motion-expert-record';
import { motionPlanningProgress } from '../sprite-generator/open-motion-model';
import '../sprite-generator/open-motion.css';
import './interactable-motion.css';
import {
  defaultDraft, panelHref, draftDescription, draftFromWork, draftProblems, draftSkeleton, draftTransitionCount, edgeStatusLabels,
  nodeImageUrl, nodeSourceLabels, panelStatus, pendingDraftTargets, workGraph,
  panelPhase, panelPhases, type InteractableDraft, type Selection,
} from './motion-graph';
import { StateEditor } from './state-editor';
import { StateGraphView } from './state-graph-view';
import { TransitionCanvas, type DrawMode, type Overlays, type ToolMarks } from './transition-canvas';
import { ToolsTab } from './tools-tab';
import { WritebackTab, type Rhythm } from './writeback-tab';
import { PropReferenceGenerator } from './prop-reference-generator';
import { propProvenanceLabel } from '@/components/interactable-editor/prop-reference-tools';
import { DerivedAssets } from './derived-assets';
import { MotionStructure } from '../sprite-generator/motion-structure';

const MotionModelSettings = lazy(() => import('../sprite-generator/motion-model-settings').then(m => ({ default: m.MotionModelSettings })));
const subscribe = (fn: () => void) => { window.addEventListener('popstate', fn); return () => window.removeEventListener('popstate', fn); };
type Tab = 'requirements' | 'check' | 'tools' | 'writeback';
const tabs: [Tab, string][] = [['requirements', '要求'], ['check', '检查'], ['tools', '工具'], ['writeback', '写回']];
type StageEvidence = { token: string; review: MotionReview & { motion_evidence?: { tracked_parts?: { pivot_xy?: [number, number] | null } } } };
type Recent = { id: string; title: string; updated_at: string; diagnostic_only: boolean; object_type?: string };
type PlanningAttempt = { requestKey: string; spec: MotionSpec; expectedRevision?: number; workspaceId?: string };
type DraftSession = {
  draft: InteractableDraft;
  objectId: string;
  structure?: MotionSpec['visual_structure'];
  revision?: number;
  planned?: InteractableDraft;
  pending?: PlanningAttempt;
  requestKey?: string;
};
const browserDraftKey = (scope: string) => `forge.interactable-motion.draft.${scope}`;

function saveBrowserDraft(key: string, value: DraftSession) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { throw new Error('浏览器草稿未能保存。请检查浏览器存储后再试。'); }
}

function committedDraft(value: DraftSession, work: MotionWork): DraftSession {
  return { draft: value.draft, planned: value.draft, objectId: motionObjectId(work.spec),
    structure: work.spec.visual_structure ?? null, revision: work.revision };
}

export function InteractableMotionEntry() {
  const search = useSyncExternalStore(subscribe, () => location.search, () => '');
  const params = new URLSearchParams(search);
  const work = params.get('work') || '';
  const version = Number(params.get('version')) || undefined;
  const object = params.get('object') || '';
  const documentId = params.get('document') || '';
  const definitionId = params.get('definition') || '';
  return <InteractableMotionPanel key={JSON.stringify([work, version, object, documentId, definitionId])} workId={work} version={version}
    objectId={object} initialCandidate={Number(params.get('candidate')) || 1} documentId={documentId} definitionId={definitionId} />;
}

function InteractableMotionPanel({ workId, version, objectId: initialObject, initialCandidate, documentId, definitionId }: {
  workId: string; version?: number; objectId: string; initialCandidate: number; documentId: string; definitionId: string;
}) {
  const wb = useWorkbenchActions();
  const { work, apply, refresh, error, setError, busy, run, mutate, readOnly, loaded } = useMotionWork(workId, version);
  const context = useMemo(() => ({ documentId, definitionId }), [documentId, definitionId]);
  const [objects, setObjects] = useState<MotionReferenceObject[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [configuration, setConfiguration] = useState<MotionConfiguration | null>(null);
  const [project, setProject] = useState<InteractableProject | null>(null);
  const draftKey = browserDraftKey(workId || (documentId ? JSON.stringify([documentId, definitionId, initialObject]) : initialObject || 'new'));
  const [draftSession, setDraftSession] = useState<DraftSession | null>(null);
  const [editing, setEditing] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tab, setTab] = useState<Tab>('requirements');
  const [candidateIndex, setCandidateIndex] = useState(initialCandidate);
  const [frame, setFrame] = useState(0);
  const [overlays, setOverlays] = useState<Overlays>({ onion: false, fixed: true, heat: false, pivot: true, seam: false });
  const [marks, setMarks] = useState<ToolMarks>({ fixed: [], exclude: [], moving: [], pivot: null });
  const [drawMode, setDrawMode] = useState<DrawMode>(null);
  const [note, setNote] = useState(''), [watched, setWatched] = useState(false), [acknowledge, setAcknowledge] = useState(false);
  const [reviewSeconds, setReviewSeconds] = useState('');
  const [rhythms, setRhythms] = useState<Record<number, Rhythm>>({});
  const [adjustmentVersion, setAdjustmentVersion] = useState(0);
  const [pixelTarget, setPixelTarget] = useState<ImageTargetRef | null>(null);
  const [evidence, setEvidence] = useState<StageEvidence | null>(null);
  const [settingsShown, setSettingsShown] = useState(false);
  // Hinge and deformation plans need a checked structure, chosen explicitly like on the character page.
  const structureSaver = useRef<(() => void) | null>(null);
  const registerStructureSaver = useCallback((save: (() => void) | null) => { structureSaver.current = save; }, []);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const transferred = useRef(false);

  // References, settings and recent interactable works; GET only.
  const refreshLists = useCallback(async () => {
    const [refs, config, history] = await Promise.all([
      motionRequest<{ objects?: MotionReferenceObject[]; characters?: MotionReferenceObject[] }>('open-motion/references'),
      motionRequest<MotionConfiguration>('open-motion/settings'),
      motionRequest<{ works: Recent[] }>('open-motion'),
    ]);
    setObjects(motionReferenceObjects(refs).filter(o => o.valid && o.object_type === 'interactable'));
    setConfiguration(config);
    setRecent(history.works.filter(w => !w.diagnostic_only && w.object_type === 'interactable'));
  }, []);
  useEffect(() => { queueMicrotask(() => void refreshLists().catch(e => setError((e as Error).message))); }, [refreshLists, setError]);
  useEffect(() => {
    if (!documentId) return;
    let live = true;
    void readDocument<InteractableProject>(documentId, undefined, { media: 'references' })
      .then(r => { if (live) setProject(r.document.content); })
      .catch(e => { if (live) setError(`未能读取绑定的交互物工程：${(e as Error).message}`); });
    return () => { live = false; };
  }, [documentId, setError]);
  const object = project?.objects.find(o => o.definitionId === definitionId);
  const initialDraft = useMemo(() => {
    const behavior = object?.behavior;
    if (behavior?.kind === 'toggle') return defaultDraft('toggle', behavior.states.map(s => s.name), behavior.initialToggle);
    if (behavior?.kind === 'sequence') return defaultDraft('sequence', behavior.entries.map(e => e.name));
    return defaultDraft();
  }, [object]);
  const frozenDraft = useMemo(() => work && draftFromWork(work), [work]);
  const draftReady = draftSession !== null && draftSession.revision === work?.revision;
  const activeDraft = draftReady ? draftSession : null;
  const draft = activeDraft?.draft ?? frozenDraft ?? initialDraft;
  const plannedDraft = activeDraft?.planned ?? frozenDraft ?? draft;
  const pendingPlan = activeDraft?.pending;
  const objectId = work ? motionObjectId(work.spec) : activeDraft?.objectId ?? initialObject;
  const structure = activeDraft?.structure ?? null;
  const setDraft = (value: InteractableDraft) => setDraftSession(current => current && { ...current, draft: value });
  const setObjectId = (value: string) => setDraftSession(current => current && { ...current, objectId: value, structure: null });
  const setStructure = (value: MotionSpec['visual_structure']) => setDraftSession(current => current && { ...current, structure: value });

  // Match local edits and target PNGs to their own work revision.
  useEffect(() => {
    if (draftReady || !loaded || (workId && !work)) return;
    let live = true;
    queueMicrotask(async () => {
      let saved: DraftSession | null = null;
      try {
        if (!readOnly) saved = JSON.parse(localStorage.getItem(draftKey) || 'null') as DraftSession | null;
      } catch { setError('浏览器草稿未能读取；服务器中的作品不受影响。'); }
      if (!saved && documentId && !project && !work) return;
      if (saved?.pending?.workspaceId && work) {
        try {
          if (await motionWorkspace() !== saved.pending.workspaceId)
            throw new Error('这份规划草稿属于另一动画工作区。请切回原工作区后刷新。');
        } catch (error) { if (live) setError((error as Error).message); return; }
        if (!live) return;
      }
      if (saved?.pending && work && saved.pending.requestKey === work.request_key &&
          work.revision === (saved.pending.expectedRevision ?? 0) + 1 && motionSpecsEqual(work.spec, saved.pending.spec)) {
        setDraftSession(committedDraft(saved, work));
        setEditing(false);
        setSelection(null);
      } else if (saved?.pending && saved.revision !== work?.revision) {
        setError('原规划草稿与当前作品版本不一致。请在原动画工作区核对回执。');
        return;
      } else if (saved && saved.revision === work?.revision) {
        setDraftSession({ ...saved, objectId: saved.objectId ?? initialObject });
      } else {
        const legacyDraft = saved?.revision === undefined ? saved?.draft : undefined;
        const restored = legacyDraft && frozenDraft &&
          JSON.stringify(draftSkeleton(legacyDraft)) === JSON.stringify(draftSkeleton(frozenDraft)) ? legacyDraft : null;
        setDraftSession({
          draft: restored ?? frozenDraft ?? initialDraft,
          ...(restored ? { planned: restored } : {}),
          objectId: work ? motionObjectId(work.spec) : initialObject,
          structure: work?.spec.visual_structure ?? null,
          revision: work?.revision,
        });
      }
    });
    return () => { live = false; };
  }, [draftReady, loaded, workId, work, documentId, project, draftKey, readOnly, frozenDraft, initialDraft, initialObject, setError]);
  useEffect(() => {
    if (!activeDraft || transferred.current || readOnly) return;
    try { saveBrowserDraft(draftKey, activeDraft); } catch { /* The footer verifies saving before a planning POST. */ }
  }, [activeDraft, draftKey, readOnly]);
  const { setPageTitle } = wb;
  useEffect(() => { setPageTitle(work?.plan?.title || '交互物动画'); return () => setPageTitle(''); }, [work?.plan?.title, setPageTitle]);

  const candidate = work?.job?.candidates.find(c => c.candidate_index === candidateIndex);
  const graph = useMemo(() => workGraph(editing ? null : work, candidateIndex, draft), [work, candidateIndex, draft, editing]);
  const status = panelStatus(editing ? null : work, candidateIndex, draft, objectId);
  const referenceUrl = work ? motionUrl(`open-motion/${work.id}/reference`, { revision: String(work.revision) })
    : objectId ? motionUrl(`open-motion/references/${objectId}`) : '';
  const edge = selection?.kind === 'edge' ? graph.edges.find(e => e.stage === selection.stage) : undefined;
  const node = selection?.kind === 'node' ? graph.nodes.find(n => n.index === selection.index) : undefined;
  const stateImageUrl = node ? nodeImageUrl(node, work, referenceUrl) : '';
  const awaiting = candidate?.plan_execution.stages.findIndex(s => s.state === 'awaiting_review') ?? -1;
  // Select the transition that needs attention, otherwise the first one.
  useEffect(() => {
    if (selection || !graph.nodes.length) return;
    queueMicrotask(() => setSelection(awaiting >= 0 ? { kind: 'edge', stage: awaiting } : graph.edges[0] ? { kind: 'edge', stage: 0 } : { kind: 'node', index: 0 }));
  }, [selection, graph, awaiting]);
  // Stage evidence holds the per-stage measurements used by overlays and the check tab.
  const evidenceStage = edge && work?.job && edge.status !== 'planned' && edge.status !== 'draft' ? edge.stage : null;
  useEffect(() => {
    if (evidenceStage === null || !work) return;
    const abort = new AbortController();
    void motionRequest<StageEvidence>(`open-motion/${work.id}/candidates/${candidateIndex}/stages/${evidenceStage}`, undefined,
      { revision: String(work.revision) }, abort.signal).then(value => { if (!abort.signal.aborted) setEvidence(value); }).catch(() => setEvidence(null));
    return () => abort.abort();
  }, [evidenceStage, work, candidateIndex, work?.job?.revision]);
  const selectedStage = selection?.kind === 'edge' ? selection.stage : -1;
  const stageFrames = useMemo(() => {
    const timeline = graph.edges.find(e => e.stage === selectedStage)?.timeline;
    const job = work?.job;
    const current = job?.candidates.find(c => c.candidate_index === candidateIndex);
    if (!timeline || !current || !job) return [];
    const { start, count, hold } = timeline;
    return current.frames.slice(start, start + count).map((f, i) => ({
      url: motionUrl(`jobs/${job.job_id}/candidates/${current.candidate_index}/frames/${f.index}/image`, { revision: String(job.revision), expected_sha256: f.sha256 }),
      sha256: f.sha256, locked: i === 0 || i >= count - 1 - hold, label: `候选第 ${f.index + 1} 帧`,
    }));
  }, [graph, selectedStage, work, candidateIndex]);
  const measuredBoxes: Box[] = (work?.plan?.quality?.interactable as { opaque_regions?: { box: number[] }[] } | undefined)?.opaque_regions
    ?.map(r => ({ x0: r.box[0], y0: r.box[1], x1: r.box[2], y1: r.box[3] })) || [];
  const pivotXy = evidence?.review.motion_evidence?.tracked_parts?.pivot_xy;
  const measuredPivot: Point | null = pivotXy ? { x: pivotXy[0], y: pivotXy[1] } : null;
  const radius = evidence?.review.motion_evidence?.tracked_parts?.reference_radius_px ?? null;
  const onDraw = useCallback((mode: Exclude<DrawMode, null>, value: Box | Point) => {
    setMarks(m => mode === 'pivot' ? { ...m, pivot: value as Point } : { ...m, [mode]: [...m[mode], value as Box] });
  }, []);
  const rhythmKey = `forge.interactable-motion.rhythm.${work?.id}.${work?.revision}.${candidateIndex}`;
  useEffect(() => {
    if (!work) return;
    queueMicrotask(() => { try { setRhythms(JSON.parse(localStorage.getItem(rhythmKey) || '{}')); } catch { setRhythms({}); } });
  }, [rhythmKey, work]);
  const changeRhythm = useCallback((stage: number, value: Rhythm) => setRhythms(current => {
    const next = { ...current, [stage]: value };
    try { localStorage.setItem(rhythmKey, JSON.stringify(next)); } catch { /* playback setting only */ }
    return next;
  }), [rhythmKey]);
  const rhythm = edge ? rhythms[edge.stage] : undefined;

  useEffect(() => {
    publishEditorSession({
      capabilityId: 'interactable-motion', dirty: !work, busy,
      items: work ? [{ id: `motion:${work.id}`, capabilityId: 'sprite-generator', title: work.plan?.title || work.spec.description.slice(0, 60),
        detail: work.job?.plan_control.message || work.message,
        state: work.job?.status === 'not_submitted' ? 'not_submitted'
          : work.status === 'planning' || work.job?.status === 'queued' ? 'running'
          : candidate?.status === 'approved' ? 'completed' : 'attention',
        href: panelHref({ work: work.id }, context), updatedAt: work.job?.updated_at || work.updated_at, stage: 1 }] : [],
      save: async () => {
        if (activeDraft && !transferred.current && !readOnly) saveBrowserDraft(draftKey, activeDraft);
        structureSaver.current?.();
        markEditorSaved('interactable-motion');
      },
    });
    return () => removeEditorSession('interactable-motion');
  }, [work, busy, candidate?.status, context, activeDraft, draftKey, readOnly]);

  const plan = () => run(async () => {
    if (!activeDraft || readOnly) return;
    let attempt = pendingPlan;
    if (!attempt) {
      if (!work && !configuration?.planning_configured) { settingsRef.current?.setAttribute('open', ''); throw new Error('先配置规划模型，再制定方案。'); }
      const problems = draftProblems(draft);
      if (!objectId || problems.length) throw new Error(problems[0] || '请选择交互物对象');
      const { description, ending } = draftDescription(draft);
      const spec: MotionSpec = { ...(work?.spec ?? blankSpec), object_id: objectId, object_type: 'interactable', description, ending,
        loop: draft.loop, return_to_reference: draft.returnToStart, interactable_skeleton: draftSkeleton(draft), visual_structure: structure };
      const key = motionPlanningRequestKey(work, activeDraft.requestKey || '');
      attempt = { spec, requestKey: key, expectedRevision: work?.revision,
        workspaceId: key === activeDraft.requestKey ? undefined : await motionWorkspace() };
    }
    const pending = { ...activeDraft, pending: attempt };
    // The POST may succeed even when the response never reaches the browser.
    saveBrowserDraft(draftKey, pending);
    setDraftSession(pending);
    let value: MotionWork;
    try {
      value = await submitMotionPlan(work?.id, attempt);
    } catch (e) {
      // These responses reject the submitted values before starting a plan.
      if (e instanceof MotionRequestError && ['validation_error', 'conflict', 'request_validation_error'].includes(e.code || '') && [400, 409, 413, 422].includes(e.status)) {
        const editable = { ...activeDraft, pending: undefined, requestKey: undefined };
        saveBrowserDraft(draftKey, editable);
        setDraftSession(editable);
      }
      throw e;
    }
    if (value.request_key === attempt.requestKey) {
      const committed = committedDraft(pending, value);
      saveBrowserDraft(browserDraftKey(value.id), committed);
      if (work) setDraftSession(committed);
    }
    if (work) {
      apply(value);
      setEditing(false);
      setSelection(null);
    } else {
      transferred.current = true;
      localStorage.removeItem(draftKey);
      await wb.navigate(panelHref({ work: value.id }, context));
    }
  });
  const generate = () => run(async () => {
    if (!configuration?.pixellab_configured && work?.spec.provider !== 'fixture') { settingsRef.current?.setAttribute('open', ''); throw new Error('请先配置 PixelLab API Key'); }
    await mutate('generate', { plan_sha256: work?.plan_sha256, expected_targets: work?.target_set_sha256,
      allow_unsupported_motion: work?.plan?.quality?.interactable?.motion_type === 'occluded_rigid_translation' });
  });
  const reviewBlocker = !candidate?.frames.length ? '候选帧尚未保存完成。'
    : candidate.status === 'approved' ? ''
    : candidate.hard_failures.length ? '请先处理阻断问题。'
    : candidate.status !== 'review_ready' ? '当前候选尚未就绪，请完成检查或修补。'
    : !watched ? '请先在检查页签确认已播放完整动作。'
    : note.trim().length < 4 ? '请在检查页签填写检查结论（至少 4 个字）。'
    : (candidate.warnings.length || (candidate.quality_review && candidate.quality_review.verdict !== 'pass')) && !acknowledge
      ? '请核对检查页签中的提醒并明确接受。' : '';
  const approve = () => run(async () => {
    await mutate('review', { candidate_index: candidateIndex, candidate_sha256: candidate?.review_token, note, acknowledge_warnings: acknowledge,
      ...(reviewSeconds === '' ? {} : { human_seconds: Number(reviewSeconds) }) });
    setTab('writeback');
  });
  const onAdjusted = (value: MotionWork) => {
    apply(value);
    if (value.revision !== work?.revision) void wb.navigate(panelHref({ work: value.id, version: value.revision, candidate: 1 }, context));
  };
  type Primary = { kind: 'plan' | 'generate' | 'pause' | 'resume' | 'review-stage' | 'approve' | 'writeback'; label: string; disabled: boolean; icon?: ReactNode };
  const primary: Primary | null = pendingPlan || editing || status.action === 'plan' || status.action === 'replan'
    ? { kind: 'plan', label: pendingPlan ? '重试原规划请求' : work ? '按状态图重新制定方案' : '制定方案', icon: <Sparkles size={16} />,
      disabled: busy || readOnly || !draftReady || (!pendingPlan && (work?.status === 'planning' || !objectId || draftProblems(draft).length > 0)) }
    : status.action === 'generate' ? { kind: 'generate', label: work?.plan?.quality?.interactable?.motion_type === 'occluded_rigid_translation'
      ? '已知遮挡平移不受支持，仍尝试制作' : '确认方案，开始制作', disabled: busy || readOnly || work?.status !== 'ready' }
    : status.action === 'wait' && work?.job ? { kind: 'pause', label: '暂停后续制作', disabled: busy || readOnly }
    : status.action === 'resume' ? { kind: 'resume', label: '继续已授权制作', disabled: busy || readOnly }
    : status.action === 'review-stage' ? { kind: 'review-stage', label: `播放并确认第 ${awaiting + 1} 段`, disabled: false }
    : status.action === 'review-candidate' ? { kind: 'approve', label: '采用此候选', disabled: busy || readOnly || Boolean(reviewBlocker) }
    : status.action === 'writeback' ? { kind: 'writeback', label: tab === 'writeback' ? '写回页签已打开' : '前往写回', disabled: tab === 'writeback' } : null;
  const runPrimary = (kind: Primary['kind']) => {
    if (kind === 'plan') void plan();
    else if (kind === 'generate') void generate();
    else if (kind === 'pause') void run(async () => { await mutate('pause'); });
    else if (kind === 'resume') void run(async () => { await mutate('resume'); });
    else if (kind === 'review-stage') {
      // Bring the review's own controls into view; confirmation needs the play/note steps inside it.
      setSelection({ kind: 'edge', stage: awaiting });
      requestAnimationFrame(() => {
        const play = [...document.querySelectorAll<HTMLButtonElement>('.im-center .motion-checkpoint button')].find(b => b.textContent?.includes('播放当前完整片段'));
        play?.scrollIntoView({ block: 'center', behavior: 'smooth' }); play?.focus({ preventScroll: true });
      });
    }
    else if (kind === 'approve') void approve();
    else setTab('writeback');
  };
  const footerMessage = busy ? '正在保存操作…'
    : pendingPlan ? '规划请求尚未确认。重试会沿用原请求编号和状态图。'
    : status.action === 'review-candidate' && reviewBlocker ? reviewBlocker
    : editing ? (draftProblems(draft)[0] || '重新制定方案会保存新版本；旧版本和调用记录保留。') : status.message;
  const missing = pendingPlan ? [] : editing ? draftProblems(draft) : status.missing;
  const pivotRadius = radius && Number.isFinite(radius) ? radius : null;
  const phase = panelPhase(work, editing);
  const jobReady = Boolean(work?.job && candidate);
  const draftDisabled = !draftReady || busy || readOnly || Boolean(pendingPlan);

  return <div className="motion-studio im-panel" data-sprite-editor>
    <header className="motion-header">
      <span className="motion-work"><strong title={work?.plan?.title}>{work?.plan?.title || '新状态动画'}</strong><SourceAssetLink /></span>
      <ol className="motion-steps im-phases" aria-label="交互物动画阶段">{panelPhases.map((name, i) =>
        <li key={name} aria-current={phase === i ? 'step' : undefined} data-done={i < phase || undefined}>
          <span>{i < phase ? <Check size={13} /> : i + 1}</span>{name}{i < panelPhases.length - 1 && <ChevronRight size={14} className="motion-step-chevron" />}
        </li>)}</ol>
      <span className="motion-save">{work ? `版本 ${work.revision} · 已保存本机` : '状态图保存在浏览器，制定方案后才提交'}</span>
      <details className="motion-popover">
        <summary><History size={16} />最近作品</summary>
        <div className="motion-popover-body">
          <button onClick={() => void wb.navigate(panelHref({}, context))}>＋ 新状态动画</button>
          {!recent.length && <p>还没有交互物动画作品。</p>}
          {recent.map(row => <button key={row.id} onClick={() => void wb.navigate(panelHref({ work: row.id }, context))}>
            {row.title}<small>{new Date(row.updated_at).toLocaleString()}</small></button>)}
          {work && <a href={`/tools/sprite-generator?work=${work.id}&layout=studio`}>在角色动画页查看同一作品</a>}
        </div>
      </details>
      <details className="motion-popover" ref={settingsRef} onToggle={e => { if (e.currentTarget.open) setSettingsShown(true); }}>
        <summary><Settings2 size={16} />模型设置</summary>
        {settingsShown && <Suspense fallback={<div className="motion-popover-body">正在读取模型设置…</div>}>
          <MotionModelSettings configuration={configuration} onSaved={setConfiguration} />
        </Suspense>}
      </details>
    </header>
    <div className="im-object-bar" aria-label="对象">
      {referenceUrl ? <img src={referenceUrl} alt="" width={40} height={40} /> : <span className="im-object-empty" aria-hidden="true" />}
      {work ? <span><b>{work.character.display_name}</b> · 交互物 · {work.character.cell_width}px · {propProvenanceLabel(work.character.provenance?.type)}</span>
        : <div className="im-object-select"><span id="im-object-label">交互物对象</span><NativeSelect aria-labelledby="im-object-label" aria-label="交互物对象" value={objectId} disabled={draftDisabled}
          onChange={e => setObjectId(e.target.value)}>
          <NativeSelectOption value="">{objects.length ? '请选择交互物' : '还没有交互物对象'}</NativeSelectOption>
          {objects.map(o => <NativeSelectOption key={o.id} value={o.id}>{o.name} · {o.width}px · {propProvenanceLabel(o.provenance?.type)}</NativeSelectOption>)}
        </NativeSelect></div>}
      <span className="im-binding">{documentId ? <>绑定：{project?.name || documentId} › {object?.displayName || definitionId || '未选物件'}
        {object && `（${({ toggle: '切换', sequence: '序列', inspect: '查看', pickup: '拾取' } as Record<string, string>)[object.behavior.kind]}）`}</>
        : '未绑定交互物工程；写回时再选择。'}</span>
      {work?.job && work.job.candidates.length > 1 && <label>候选<NativeSelect aria-label="候选" value={candidateIndex}
        onChange={e => { setCandidateIndex(Number(e.target.value)); setNote(''); setWatched(false); setAcknowledge(false); }}>
        {work.job.candidates.map(c => <NativeSelectOption key={c.candidate_index} value={c.candidate_index}>候选 {c.candidate_index}</NativeSelectOption>)}
      </NativeSelect></label>}
    </div>
    {error && <div role="alert" className="motion-error"><span>{error}</span>
      <button onClick={() => void run(async () => { await refreshLists(); await refresh(); })}>重新连接 / 查询</button></div>}
    {readOnly && <div className="motion-notice">正在查看历史版本。原文件保留；制作、采用与写回请进入<a href={panelHref({ work: work?.id }, context)}>当前版本</a>。</div>}
    {work && !work.plan?.quality?.interactable && work.plan && <div className="motion-notice">这个作品不是交互物方案，请在角色动画页查看。</div>}
    <main className="im-layout">
      {!loaded ? <div className="motion-loading"><LoaderCircle className="animate-spin" />正在读取作品…</div> : <>
        <aside className="motion-card im-left">
          <div className="motion-card-title"><h2>状态图</h2>
            {work && work.status !== 'planning' && !readOnly && !work.job && !editing &&
              <button className="motion-secondary" disabled={draftDisabled} onClick={() => setEditing(true)}><Pencil size={14} />修改</button>}
          </div>
          <StateGraphView work={editing ? null : work} nodes={graph.nodes} edges={graph.edges} selection={phase === 0 ? null : selection}
            onSelect={value => { if (phase === 0) return; setSelection(value); setFrame(0); }} referenceUrl={referenceUrl} />
          {phase === 0 && <p className="motion-muted im-graph-hint">在右侧编辑状态；制定方案后可以逐段查看。</p>}
        </aside>
        <section className="motion-card im-center" aria-label={phase === 0 ? '定义状态' : '过渡画布'}>
          {phase === 0 ? <>
            <div className="motion-card-title"><h2>{editing ? '修改状态与过渡' : '定义状态与过渡'}</h2>
              {editing && <button className="motion-secondary" disabled={busy || Boolean(pendingPlan)} onClick={() => setEditing(false)}>取消修改</button>}</div>
            {!objectId && !work && draftReady && <PropReferenceGenerator objectName={object?.displayName || ''} onTransferred={async id => { await refreshLists(); setObjectId(id); }} />}
            <StateEditor draft={draft} onDraft={setDraft} referenceUrl={referenceUrl} disabled={draftDisabled} />
            {objectId && <details className="im-structure"><summary>部件结构（铰接转动、形变需要）{structure ? ' · 已选择' : ''}</summary>
              <MotionStructure key={objectId} characterId={objectId} disabled={draftDisabled} registerDraftSaver={registerStructureSaver}
                modelConfiguration={JSON.stringify(configuration?.configuration || null)} generationStructure={structure} onGenerationStructure={setStructure} />
            </details>}
          </> : work && (!work.plan || work.status === 'planning') ? <>
            <div className="motion-card-title"><h2>{work.status === 'planning' ? '正在制定方案' : '方案未完成'}</h2></div>
            <p>{work.message}</p>
            <div className="motion-experts">{Object.entries(motionPlanningRoles).map(([role, name]) => {
              const progress = motionPlanningProgress(work, role);
              return <div key={role} data-planning-role={role} data-state={progress.state}>
                <span aria-hidden="true">{progress.state === 'complete' ? <Check size={17} /> : progress.state === 'running' ? <LoaderCircle size={17} className="animate-spin" /> : '·'}</span>
                <span>{name}<small>{progress.label}</small></span></div>;
            })}</div>
          </> : edge ? <>
            <div className="motion-card-title im-center-title"><h2>过渡 {edge.stage + 1}：{graph.nodes[edge.from]?.name} → {graph.nodes[edge.to]?.name}</h2>
              <span className="im-pill" data-status={edge.status}>{edgeStatusLabels[edge.status]}</span></div>
            {work && (edge.status === 'awaiting_review' || edge.status === 'state_only') ? <MotionStageReview key={`${work.id}:${work.revision}:${candidateIndex}:${edge.stage}:${adjustmentVersion}`}
              work={work} candidate={candidateIndex} stage={edge.stage} readOnly={readOnly} onSaved={apply} expertRecord={<ExpertRecord work={work} />} />
            : stageFrames.length ? <TransitionCanvas frames={stageFrames} referenceUrl={referenceUrl} fps={work?.job?.action.fps || 12}
              playback={rhythm?.playback || 'once'} durations={rhythm?.durations} overlays={overlays} measuredBoxes={measuredBoxes} measuredPivot={measuredPivot}
              radius={pivotRadius} marks={marks} drawMode={drawMode} onDraw={onDraw} frame={frame} onFrame={setFrame} readOnly={readOnly}
              onEditFrame={i => work && edge.timeline && setPixelTarget({ kind: 'motion-frame', workId: work.id, workRevision: work.revision, candidateIndex, frameIndex: edge.timeline.start + i })} />
            : work?.job ? <><div className="motion-canvas motion-large"><img src={motionUrl(`open-motion/${work.id}/progress-image`, { candidate: String(candidateIndex), revision: String(work.revision), job_revision: String(work.job.revision) })} alt="已确认状态或已保存片段的末帧" /></div>
              <p className="motion-muted">{work.job.plan_control.message || '这段过渡还在制作；显示已确认的状态或最近保存的末帧。'}</p></>
            : work ? <StagePlan work={work} stage={edge.stage} /> : null}
            {pixelTarget && <ImageEditWorkspace target={pixelTarget} readOnly={readOnly} onClose={() => setPixelTarget(null)}
              onAdopt={async () => { setPixelTarget(null); setAdjustmentVersion(v => v + 1); await refresh(); }} />}
          </> : node ? <div className="im-node-detail">
            <div className="motion-card-title im-center-title"><h2>状态 {String.fromCharCode(65 + node.index)}：{node.name}</h2><span className="im-pill">{nodeSourceLabels[node.source]}</span></div>
            <div className="motion-canvas motion-large">{stateImageUrl ? <img src={stateImageUrl} alt={node.name} />
              : <p>尚无真实状态图；确认通往这个状态的过渡后显示。</p>}</div>
            <p className="motion-muted">{node.source === 'confirmed' ? '真实生成帧，经人工确认后锁定。' : node.source === 'target' ? '绑定的段末目标图，约束生成但不是生成结果。'
              : node.source === 'reference' ? '对象原图就是初始状态。' : '只有文字描述。'}</p>
            {work?.job && <DerivedAssets work={work} candidate={candidateIndex} focus={{ kind: 'state', node: node.index }} readOnly={readOnly} onSaved={apply} />}
          </div> : <p className="motion-muted">在左侧选择一个状态或过渡。</p>}
        </section>
        <aside className="motion-card im-right">
          <div className="im-tabs" role="tablist" aria-label="检查与修正">{tabs.map(([id, label]) => {
            const unavailable = (id === 'tools' || id === 'check') && !jobReady;
            return <button key={id} role="tab" aria-selected={tab === id} disabled={unavailable}
              title={unavailable ? '开始制作后可用' : undefined} onClick={() => setTab(id)}>{label}</button>;
          })}</div>
          <div className="im-tab-body" role="tabpanel">
            {(tab === 'requirements' || ((tab === 'tools' || tab === 'check') && !jobReady)) &&
              <Requirements work={editing ? null : work} draft={editing ? draft : plannedDraft} onSaved={apply} readOnly={readOnly} />}
            {tab === 'check' && jobReady && <section className="im-check">
              <fieldset className="im-overlays"><legend>叠加检查层</legend>
                {([['fixed', '固定区域'], ['heat', '固定区变化热区'], ['onion', '上一帧洋葱皮'], ['pivot', '枢轴与铰接半径'], ['seam', '首帧叠末帧（循环接缝）']] as [keyof Overlays, string][])
                  .map(([key, label]) => <label key={key} className="motion-check"><input type="checkbox" checked={overlays[key]}
                    onChange={e => setOverlays(o => ({ ...o, [key]: e.target.checked }))} />{label}</label>)}
              </fieldset>
              {evidence && <><MotionVisualReview report={evidence.review} compact /><Measurements review={evidence.review} /></>}
              {!evidence && candidate?.quality_review && <MotionVisualReview report={candidate.quality_review} compact />}
              {candidate?.frames.length && candidate.status !== 'approved' && awaiting < 0 ? <div className="im-approve">
                <h3>采用完整候选</h3>
                {!!candidate.hard_failures.length && <div className="motion-error">{candidate.hard_failures.map((f, i) => <p key={i}>{f.message}</p>)}</div>}
                {!!candidate.warnings.length && <details><summary>{candidate.warnings.length} 条技术提醒</summary>{candidate.warnings.map((w, i) => <p key={i}>{w.message}</p>)}</details>}
                <label className="motion-check"><input type="checkbox" checked={watched} onChange={e => setWatched(e.target.checked)} />我已逐段播放，检查状态帧、固定部件和过渡衔接</label>
                <label>人工检查用时（秒，可留空）<input type="number" min={0} max={86400} value={reviewSeconds} onChange={e => setReviewSeconds(e.target.value)} /></label>
                <label>检查结论（至少 4 个字）<textarea aria-label="检查结论" rows={3} value={note} onChange={e => setNote(e.target.value)} /></label>
                {!!(candidate.warnings.length || (candidate.quality_review && candidate.quality_review.verdict !== 'pass')) &&
                  <label className="motion-check"><input type="checkbox" checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} />已核对技术与视觉提醒，接受当前结果</label>}
              </div> : candidate?.status === 'approved' ? <p className="motion-good">当前候选已采用，可写回或导出。</p> : null}
              {work && <ExpertRecord work={work} />}
            </section>}
            {tab === 'tools' && (jobReady && work?.job && candidate ? <ToolsTab key={`${work.revision}:${candidateIndex}:${adjustmentVersion}`} work={work} candidate={candidate} edge={edge}
              marks={marks} onMarks={setMarks} drawMode={drawMode} onDrawMode={setDrawMode} measuredBoxes={measuredBoxes} readOnly={readOnly}
              rhythm={rhythm} onRhythm={changeRhythm} onSubmitted={() => setAdjustmentVersion(v => v + 1)} onSaved={apply}>
              <MotionAdjustment key={`${work.id}:${work.revision}:${candidateIndex}:${awaiting}:${adjustmentVersion}`} work={work} candidate={candidateIndex}
                stage={awaiting >= 0 ? awaiting : undefined} readOnly={readOnly} onSaved={onAdjusted} />
            </ToolsTab> : null)}
            {tab === 'writeback' && <WritebackTab work={work} candidate={candidate} graph={graph} documentId={documentId} definitionId={definitionId}
              rhythms={rhythms} readOnly={readOnly} onProject={setProject} onSaved={apply} busy={busy} run={run} mutate={mutate} />}
          </div>
        </aside>
      </>}
    </main>
    <footer className="motion-footer">
      <output id="im-action-status">{busy ? <><LoaderCircle size={16} className="animate-spin" />{footerMessage}</>
        : <>{missing.length ? <span className="motion-missing">还需：{missing.join('、')}</span> : null} {footerMessage}
          {work?.frame_budget?.estimated_units != null && ` · 预计消耗 ${work.frame_budget.estimated_units} 单位`}</>}</output>
      <div className="motion-footer-actions">
        {primary && <button className="motion-primary" disabled={primary.disabled} aria-describedby="im-action-status" onClick={() => runPrimary(primary.kind)}>
          {primary.icon}{primary.label}<ArrowRight size={16} /></button>}
      </div>
    </footer>
  </div>;
}

function Requirements({ work, draft, onSaved, readOnly }: { work: MotionWork | null; draft: InteractableDraft; onSaved: (w: MotionWork) => void; readOnly: boolean }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const prop = work?.plan?.quality?.interactable;
  if (!work?.plan || !prop) {
    const { description, ending } = draftDescription(draft);
    return <section><h3>将提交的要求</h3><p className="motion-prompt">{description}</p><p>结束：{ending}</p>
      <p className="motion-muted">规划只调用规划模型，不生成动画。交互物合同（初态、目标状态、运动与固定部件、运动类型）在规划后列出，制作前可核对。</p>
      {work?.status === 'planning' && <p>正在形成制作方案…</p>}
      {work && !work.plan && work.status !== 'planning' && <p className="motion-notice">{work.message}</p>}</section>;
  }
  const pending = pendingDraftTargets(work, draft);
  const matchingStages = work.plan.stages.length === draftTransitionCount(draft);
  const canBind = !work.job && work.status === 'ready' && !readOnly && matchingStages && pending.length > 0;
  const bind = async () => {
    setBusy(true); setError('');
    try {
      let current = work;
      for (const { name, png, stage } of pending) {
        current = await motionRequest<MotionWork>(`open-motion/${work.id}/target`, {
          expected_revision: current.revision, stage_index: stage, expected_targets: current.target_set_sha256, png_base64: png,
          note: `状态图「${name}」的目标图，由交互物动画面板按状态顺序绑定`,
        });
        onSaved(current);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const checks = { satisfied: '符合', mismatch: '不符', ambiguous: '待澄清' } as Record<string, string>;
  return <section className="im-requirements">
    <h3>交互物合同</h3>
    <dl className="im-facts">
      <dt>状态</dt><dd>{prop.initial_state} → {prop.target_state}</dd>
      <dt>运动部件</dt><dd>{prop.moving_parts.join('、')}</dd>
      <dt>固定部件</dt><dd>{prop.fixed_parts.join('、') || '无'}</dd>
      <dt>运动类型</dt><dd>{({ appearance_change: '外观变化', hinge_rotation: '铰接转动', deformation: '形变', occluded_rigid_translation: '带遮挡的刚体平移（当前生成器不适合）' } as Record<string, string>)[prop.motion_type]}</dd>
      <dt>终点</dt><dd>{prop.endpoint}</dd>
      <dt>停留</dt><dd>{prop.hold}</dd>
    </dl>
    <h3>起始图核对</h3>
    <dl className="im-facts">{Object.entries(prop.reference_check).map(([key, check]) => <div key={key} className="im-fact-row">
      <dt>{({ viewpoint: '视角', initial_state: '初态', part_ownership: '部件归属' } as Record<string, string>)[key]}</dt>
      <dd><span className="im-pill" data-status={check.status === 'satisfied' ? 'accepted' : 'attention'}>{checks[check.status]}</span> {check.evidence}</dd></div>)}</dl>
    {prop.differences?.map((d, i) => <p key={i}>原描述「{d.description}」，参考图「{d.observed}」</p>)}
    {!!work.plan.questions.length && <div className="motion-notice"><h3>需要你补充</h3>{work.plan.questions.map(q => <p key={q}>{q}</p>)}</div>}
    {canBind && <div className="motion-notice"><p>状态图中有 {pending.length} 张目标图尚未绑定为段末目标。</p>
      <button disabled={busy} onClick={() => void bind()}>按状态顺序绑定目标图</button></div>}
    {!work.job && work.status === 'ready' && !readOnly && !matchingStages && pending.length > 0 &&
      <p className="motion-muted">方案分段数与状态图不一致，请在下方逐段选择目标图。</p>}
    <MotionTargets key={`${work.id}:${work.revision}`} work={work} onSaved={onSaved} />
    {error && <p className="motion-danger">{error}</p>}
  </section>;
}

function Measurements({ review }: { review: MotionReview }) {
  const tracked = review.motion_evidence?.tracked_parts;
  if (!tracked) return null;
  if (tracked.unavailable) return <p className="motion-muted">部件测量：{tracked.unavailable}</p>;
  const regions = Object.keys(tracked.frames?.[0]?.fixed_changed_pixels || {});
  return <details open><summary>部件逐帧测量</summary>
    <table className="im-measure"><thead><tr><th>帧</th>{regions.map(r => <th key={r}>{r}</th>)}{tracked.reference_radius_px != null && <th>半径（参考 {tracked.reference_radius_px.toFixed(1)}）</th>}</tr></thead>
      <tbody>{tracked.frames?.map(f => <tr key={f.frame}><td>{f.frame}</td>{regions.map(r => <td key={r}>{f.fixed_changed_pixels[r]}</td>)}
        {tracked.reference_radius_px != null && <td data-off={f.radius_px == null || Math.abs(f.radius_px - tracked.reference_radius_px) > (tracked.tolerance_px ?? 2) || undefined}>{f.radius_px ?? '—'}</td>}</tr>)}</tbody></table>
    <p className="motion-muted">固定区变化像素已扣除运动部件遮挡；测量与模型意见冲突时需要人工裁决。</p>
  </details>;
}

/** A planned transition before production: what it should do and how it will be checked. */
function StagePlan({ work, stage }: { work: MotionWork; stage: number }) {
  const s = work.plan?.stages[stage];
  if (!s) return null;
  return <div className="im-stage-plan">
    <dl className="im-facts">
      <dt>目标</dt><dd>{s.goal}</dd>
      <dt>计划帧数</dt><dd>{s.frame_count} 帧</dd>
      {s.checkpoint && <><dt>确认状态</dt><dd>{s.checkpoint.endpoint}</dd><dt>节奏</dt><dd>{s.checkpoint.rhythm}</dd></>}
      <dt>起点</dt><dd>{stage === 0 ? '对象原图' : '上一段确认的状态帧'}</dd>
    </dl>
    <h3>检查标准</h3>
    <ul>{s.acceptance.map(a => <li key={a}>{a}</li>)}</ul>
    <details><summary>生成描述</summary><p className="motion-prompt">{s.prompt}</p></details>
    <p className="motion-muted">确认方案后开始制作；每段生成后都在这里播放检查，确认后才继续下一段。</p>
  </div>;
}
