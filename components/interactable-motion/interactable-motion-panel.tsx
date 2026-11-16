'use client';
/* oxlint-disable next/no-img-element -- Exact pixel frames and state images. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowRight, History, LoaderCircle, Settings2, Sparkles, Pencil } from 'lucide-react';
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
  blankSpec, motionPlanningRequestKey, motionReferenceObjects, motionRequest, motionUrl,
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
  defaultDraft, panelHref, draftDescription, draftProblems, draftSkeleton, edgeStatusLabels, nodeSourceLabels, panelStatus, workGraph,
  type InteractableDraft, type Selection,
} from './motion-graph';
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

export function InteractableMotionEntry() {
  const search = useSyncExternalStore(subscribe, () => location.search, () => '');
  const params = new URLSearchParams(search);
  const work = params.get('work') || '';
  const version = Number(params.get('version')) || undefined;
  return <InteractableMotionPanel key={`${work || 'new'}:${version || ''}`} workId={work} version={version}
    objectId={params.get('object') || ''} initialCandidate={Number(params.get('candidate')) || 1}
    documentId={params.get('document') || ''} definitionId={params.get('definition') || ''} />;
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
  const [objectId, setObjectId] = useState(initialObject);
  const [project, setProject] = useState<InteractableProject | null>(null);
  const draftKey = `forge.interactable-motion.draft.${workId || initialObject || 'new'}`;
  const [draft, setDraft] = useState<InteractableDraft>(() => defaultDraft());
  const [draftReady, setDraftReady] = useState(false);
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
  const [structure, setStructure] = useState<MotionSpec['visual_structure']>(null);
  const structureSaver = useRef<(() => void) | null>(null);
  const registerStructureSaver = useCallback((save: (() => void) | null) => { structureSaver.current = save; }, []);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const requestKey = useRef('');
  const submitted = useRef(false);

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
  // Restore the browser draft, or seed it from the bound toggle/sequence object.
  useEffect(() => {
    if (draftReady || (documentId && !project)) return;
    queueMicrotask(() => {
      try {
        const saved = localStorage.getItem(draftKey);
        if (saved) { const value = JSON.parse(saved) as { draft: InteractableDraft; requestKey?: string; objectId?: string };
          setDraft(value.draft); requestKey.current = value.requestKey || ''; if (!initialObject && value.objectId) setObjectId(value.objectId); }
        else if (object && (object.behavior.kind === 'toggle' || object.behavior.kind === 'sequence'))
          setDraft(defaultDraft(object.behavior.kind, (object.behavior.kind === 'toggle' ? object.behavior.states : object.behavior.entries).map(e => e.name)));
      } catch { setError('浏览器草稿未能读取；服务器中的作品不受影响。'); }
      setDraftReady(true);
    });
  }, [draftReady, documentId, project, object, draftKey, initialObject, setError]);
  useEffect(() => {
    if (!draftReady) return;
    try {
      if (submitted.current) localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, JSON.stringify({ draft, requestKey: requestKey.current, objectId }));
    } catch { /* The work itself is saved by the local service. */ }
  }, [draft, draftReady, draftKey, objectId]);
  useEffect(() => { if (work) queueMicrotask(() => { setObjectId(work.spec.object_id || ''); setStructure(s => s ?? work.spec.visual_structure ?? null); }); }, [work]);
  const { setPageTitle } = wb;
  useEffect(() => { setPageTitle(work?.plan?.title || '交互物动画'); return () => setPageTitle(''); }, [work?.plan?.title, setPageTitle]);

  const candidate = work?.job?.candidates.find(c => c.candidate_index === candidateIndex);
  const graph = useMemo(() => workGraph(editing ? null : work, candidateIndex, draft), [work, candidateIndex, draft, editing]);
  const status = panelStatus(editing ? null : work, candidateIndex, draft, objectId);
  const referenceUrl = work ? motionUrl(`open-motion/${work.id}/reference`, { revision: String(work.revision) })
    : objectId ? motionUrl(`open-motion/references/${objectId}`) : '';
  const edge = selection?.kind === 'edge' ? graph.edges.find(e => e.stage === selection.stage) : undefined;
  const node = selection?.kind === 'node' ? graph.nodes.find(n => n.index === selection.index) : undefined;
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
    const current = work?.job?.candidates.find(c => c.candidate_index === candidateIndex);
    if (!timeline || !current || !work?.job) return [];
    const { start, count, hold } = timeline;
    return current.frames.slice(start, start + count).map((f, i) => ({
      url: motionUrl(`jobs/${work.job?.job_id}/candidates/${current.candidate_index}/frames/${f.index}/image`, { v: f.sha256 }),
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
        detail: work.job?.plan_control.message || work.message, state: work.status === 'planning' ? 'running' : candidate?.status === 'approved' ? 'completed' : 'attention',
        href: panelHref({ work: work.id }, context), updatedAt: work.job?.updated_at || work.updated_at, stage: 1 }] : [],
      save: async () => {
        try { if (!submitted.current) localStorage.setItem(draftKey, JSON.stringify({ draft, requestKey: requestKey.current, objectId })); } catch { /* best effort */ }
        structureSaver.current?.();
        markEditorSaved('interactable-motion');
      },
    });
    return () => removeEditorSession('interactable-motion');
  }, [work, busy, candidate?.status, context, draft, draftKey, objectId]);

  const plan = () => run(async () => {
    if (!configuration?.planning_configured) { settingsRef.current?.setAttribute('open', ''); throw new Error('先配置规划模型，再制定方案。'); }
    const problems = draftProblems(draft);
    if (!objectId || problems.length) throw new Error(problems[0] || '请选择交互物对象');
    const { description, ending } = draftDescription(draft);
    const spec: MotionSpec = { ...blankSpec, object_id: objectId, object_type: 'interactable', description, ending,
      loop: draft.loop, return_to_reference: draft.returnToStart, interactable_skeleton: draftSkeleton(draft),
      ...(structure ? { visual_structure: structure } : {}) };
    requestKey.current = motionPlanningRequestKey(work, requestKey.current);
    const value = await motionRequest<MotionWork>(work ? `open-motion/${work.id}/revise` : 'open-motion', {
      spec, request_key: requestKey.current, planning_authorized: true, ...(work ? { expected_revision: work.revision } : {}),
    });
    if (work) { apply(value); setEditing(false); setSelection(null); }
    else { submitted.current = true; localStorage.removeItem(draftKey); await wb.navigate(panelHref({ work: value.id }, context)); }
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
  const primary: Primary | null = editing || status.action === 'plan' || status.action === 'replan'
    ? { kind: 'plan', label: work ? '按状态图重新制定方案' : '制定方案', icon: <Sparkles size={16} />,
      disabled: busy || readOnly || work?.status === 'planning' || !objectId || draftProblems(draft).length > 0 }
    : status.action === 'generate' ? { kind: 'generate', label: work?.plan?.quality?.interactable?.motion_type === 'occluded_rigid_translation'
      ? '已知遮挡平移不受支持，仍尝试制作' : '确认方案，开始制作', disabled: busy || readOnly || work?.status !== 'ready' }
    : status.action === 'wait' && work?.job ? { kind: 'pause', label: '暂停后续制作', disabled: busy || readOnly }
    : status.action === 'resume' ? { kind: 'resume', label: '继续已授权制作', disabled: busy || readOnly }
    : status.action === 'review-stage' ? { kind: 'review-stage', label: `检查第 ${awaiting + 1} 段过渡`, disabled: false }
    : status.action === 'review-candidate' ? { kind: 'approve', label: '采用此候选', disabled: busy || readOnly || Boolean(reviewBlocker) }
    : status.action === 'writeback' ? { kind: 'writeback', label: '写回交互物', disabled: false } : null;
  const runPrimary = (kind: Primary['kind']) => {
    if (kind === 'plan') void plan();
    else if (kind === 'generate') void generate();
    else if (kind === 'pause') void run(async () => { await mutate('pause'); });
    else if (kind === 'resume') void run(async () => { await mutate('resume'); });
    else if (kind === 'review-stage') { setSelection({ kind: 'edge', stage: awaiting }); setTab('check'); }
    else if (kind === 'approve') void approve();
    else setTab('writeback');
  };
  const footerMessage = busy ? '正在保存操作…'
    : status.action === 'review-candidate' && reviewBlocker ? reviewBlocker
    : editing ? (draftProblems(draft)[0] || '重新制定方案会保存新版本；旧版本和调用记录保留。') : status.message;
  const missing = editing ? draftProblems(draft) : status.missing;
  const editableGraph = (!work || editing) && !readOnly;
  const pivotRadius = radius && Number.isFinite(radius) ? radius : null;

  return <div className="motion-studio im-panel" data-sprite-editor>
    <header className="motion-header">
      <span className="motion-work"><strong>{work?.plan?.title || '交互物动画'}</strong><SourceAssetLink /></span>
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
        : <label>交互物对象<NativeSelect aria-label="交互物对象" value={objectId} disabled={busy}
          onChange={e => setObjectId(e.target.value)}>
          <NativeSelectOption value="">请选择交互物</NativeSelectOption>
          {objects.map(o => <NativeSelectOption key={o.id} value={o.id}>{o.name} · {o.width}px · {propProvenanceLabel(o.provenance?.type)}</NativeSelectOption>)}
        </NativeSelect></label>}
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
            {work?.plan && !readOnly && !work.job && !editing && <button className="motion-secondary" onClick={() => setEditing(true)}><Pencil size={14} />修改状态</button>}
            {editing && <button className="motion-secondary" onClick={() => setEditing(false)}>取消修改</button>}
          </div>
          {!objectId && !work && <PropReferenceGenerator objectName={object?.displayName || ''} onTransferred={async id => { await refreshLists(); setObjectId(id); }} />}
          <StateGraphView workId={work?.id || null} nodes={graph.nodes} edges={graph.edges} selection={selection}
            onSelect={value => { setSelection(value); setFrame(0); }} draft={draft} onDraft={setDraft} editable={editableGraph} referenceUrl={referenceUrl} />
          {editableGraph && objectId && <details className="im-tool"><summary>部件结构（铰接转动、形变需要）</summary>
            <MotionStructure key={objectId} characterId={objectId} disabled={busy || readOnly} registerDraftSaver={registerStructureSaver}
              modelConfiguration={JSON.stringify(configuration?.configuration || null)} generationStructure={structure} onGenerationStructure={setStructure} />
          </details>}
          {work && !work.plan && work.status === 'planning' && <div className="motion-experts">{Object.entries(motionPlanningRoles).map(([role, name]) => {
            const progress = motionPlanningProgress(work, role);
            return <div key={role} data-planning-role={role} data-state={progress.state}><span aria-hidden="true">·</span><span>{name}<small>{progress.label}</small></span></div>;
          })}</div>}
        </aside>
        <section className="motion-card im-center" aria-label="过渡画布">
          {edge ? <>
            <div className="motion-card-title"><h2>{graph.nodes[edge.from]?.name} → {graph.nodes[edge.to]?.name}</h2><span>{edgeStatusLabels[edge.status]}</span></div>
            {work && (edge.status === 'awaiting_review' || edge.status === 'state_only') ? <MotionStageReview key={`${work.id}:${work.revision}:${candidateIndex}:${edge.stage}:${adjustmentVersion}`}
              work={work} candidate={candidateIndex} stage={edge.stage} readOnly={readOnly} onSaved={apply} expertRecord={<ExpertRecord work={work} />} />
            : stageFrames.length ? <TransitionCanvas frames={stageFrames} referenceUrl={referenceUrl} fps={work?.job?.action.fps || 12}
              playback={rhythm?.playback || 'once'} durations={rhythm?.durations} overlays={overlays} measuredBoxes={measuredBoxes} measuredPivot={measuredPivot}
              radius={pivotRadius} marks={marks} drawMode={drawMode} onDraw={onDraw} frame={frame} onFrame={setFrame} readOnly={readOnly}
              onEditFrame={i => work && edge.timeline && setPixelTarget({ kind: 'motion-frame', workId: work.id, workRevision: work.revision, candidateIndex, frameIndex: edge.timeline.start + i })} />
            : work?.job ? <div className="motion-canvas motion-large"><img src={motionUrl(`open-motion/${work.id}/progress-image`, { candidate: String(candidateIndex), revision: String(work.revision), v: String(work.job.revision) })} alt="已确认状态或已保存片段的末帧" /></div>
            : <p className="motion-muted">{work?.plan ? `计划 ${edge.frames} 帧。确认方案后开始制作。` : '制定方案后显示这段过渡的帧数和检查标准。'}</p>}
            {pixelTarget && <ImageEditWorkspace target={pixelTarget} readOnly={readOnly} onClose={() => setPixelTarget(null)}
              onAdopt={async () => { setPixelTarget(null); setAdjustmentVersion(v => v + 1); await refresh(); }} />}
          </> : node ? <div className="im-node-detail">
            <div className="motion-card-title"><h2>{String.fromCharCode(65 + node.index)} · {node.name}</h2><span>{nodeSourceLabels[node.source]}</span></div>
            <div className="motion-canvas motion-large">{node.index === 0 && referenceUrl ? <img src={referenceUrl} alt={node.name} />
              : node.image && work ? <img src={motionUrl(`open-motion/${work.id}/${node.image.path}`, { v: node.image.v })} alt={node.name} />
              : <p>{draft.states[node.index]?.appearance || '尚无真实状态图；确认这一段的状态帧后显示。'}</p>}</div>
            <p className="motion-muted">{node.source === 'confirmed' ? '真实生成帧，经人工确认后锁定。' : node.source === 'target' ? '绑定的段末目标图，约束生成但不是生成结果。'
              : node.source === 'reference' ? '对象原图就是初始状态。' : '只有文字描述。'}</p>
            {work?.job && <DerivedAssets work={work} candidate={candidateIndex} focus={{ kind: 'state', node: node.index }} readOnly={readOnly} onSaved={apply} />}
          </div> : <p className="motion-muted">在左侧选择一个状态或过渡。</p>}
        </section>
        <aside className="motion-card im-right">
          <div className="im-tabs" role="tablist" aria-label="检查与修正">{tabs.map(([id, label]) =>
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
          <div className="im-tab-body" role="tabpanel">
            {tab === 'requirements' && <Requirements work={work} draft={draft} onSaved={apply} readOnly={readOnly} stage={edge?.stage} />}
            {tab === 'check' && <section className="im-check">
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
            {tab === 'tools' && (work?.job && candidate ? <ToolsTab key={`${work.revision}:${candidateIndex}:${adjustmentVersion}`} work={work} candidate={candidate} edge={edge}
              marks={marks} onMarks={setMarks} drawMode={drawMode} onDrawMode={setDrawMode} measuredBoxes={measuredBoxes} readOnly={readOnly}
              rhythm={rhythm} onRhythm={changeRhythm} onSubmitted={() => setAdjustmentVersion(v => v + 1)} onSaved={apply}>
              <MotionAdjustment key={`${work.id}:${work.revision}:${candidateIndex}:${awaiting}:${adjustmentVersion}`} work={work} candidate={candidateIndex}
                stage={awaiting >= 0 ? awaiting : undefined} readOnly={readOnly} onSaved={onAdjusted} />
            </ToolsTab> : <p className="motion-muted">开始制作并保存片段后可以使用修正工具。</p>)}
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

function Requirements({ work, draft, onSaved, readOnly, stage }: { work: MotionWork | null; draft: InteractableDraft; onSaved: (w: MotionWork) => void; readOnly: boolean; stage?: number }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const prop = work?.plan?.quality?.interactable;
  if (!work?.plan || !prop) {
    const { description, ending } = draftDescription(draft);
    return <section><h3>将提交的要求</h3><p className="motion-prompt">{description}</p><p>结束：{ending}</p>
      <p className="motion-muted">规划只调用规划模型，不生成动画。交互物合同（初态、目标状态、运动与固定部件、运动类型）在规划后列出，制作前可核对。</p>
      {work?.status === 'planning' && <p>正在形成制作方案…</p>}
      {work && !work.plan && work.status !== 'planning' && <p className="motion-notice">{work.message}</p>}</section>;
  }
  const s = stage !== undefined ? work.plan.stages[stage] : undefined;
  const pending = draft.states.map((state, i) => ({ state, i })).filter(({ state, i }) => i > 0 && state.targetPng && !work.end_targets?.some(t => t.stage === i - 1));
  const canBind = !work.job && work.status === 'ready' && !readOnly && work.plan.stages.length === draft.states.length - 1 && pending.length > 0;
  const bind = async () => {
    setBusy(true); setError('');
    try {
      let current = work;
      for (const { state, i } of pending) current = await motionRequest<MotionWork>(`open-motion/${work.id}/target`, {
        expected_revision: current.revision, stage_index: i - 1, expected_targets: current.target_set_sha256, png_base64: state.targetPng,
        note: `状态图「${state.name}」的目标图，由交互物动画面板按状态顺序绑定`,
      });
      onSaved(current);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="im-requirements">
    <h3>交互物合同</h3>
    <p>{prop.initial_state} → {prop.target_state}</p>
    <p>运动部件：{prop.moving_parts.join('、')}</p><p>固定部件：{prop.fixed_parts.join('、') || '无'}</p>
    <p>运动类型：{({ appearance_change: '外观变化', hinge_rotation: '铰接转动', deformation: '形变', occluded_rigid_translation: '带遮挡的刚体平移（当前生成器不适合）' } as Record<string, string>)[prop.motion_type]}</p>
    <p>终点：{prop.endpoint} · 停留：{prop.hold}</p>
    {Object.entries(prop.reference_check).map(([key, check]) => <p key={key}>
      {({ viewpoint: '视角', initial_state: '初态', part_ownership: '部件归属' } as Record<string, string>)[key]} ·
      {({ satisfied: '符合', mismatch: '不符', ambiguous: '待澄清' } as Record<string, string>)[check.status]} · {check.evidence}</p>)}
    {prop.differences?.map((d, i) => <p key={i}>原描述「{d.description}」，参考图「{d.observed}」</p>)}
    {!!work.plan.questions.length && <div className="motion-notice"><h3>需要你补充</h3>{work.plan.questions.map(q => <p key={q}>{q}</p>)}</div>}
    {s && <><h3>第 {stage! + 1} 段 · {s.name}</h3><p>{s.goal}</p>{s.checkpoint && <p>确认状态：{s.checkpoint.endpoint}</p>}
      <ul>{s.acceptance.map(a => <li key={a}>{a}</li>)}</ul></>}
    {canBind && <div className="motion-notice"><p>状态图中有 {pending.length} 张目标图尚未绑定为段末目标。</p>
      <button disabled={busy} onClick={() => void bind()}>按状态顺序绑定目标图</button></div>}
    {!work.job && work.status === 'ready' && work.plan.stages.length !== draft.states.length - 1 && draft.states.some(st => st.targetPng) &&
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
