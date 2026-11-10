'use client';
import { MotionTargets } from './motion-targets';
import { CharacterIdentityField } from './character-identity-field';
import { uploadedIdentityLimit, uploadedReferenceIdentity } from './character-identity';
/* oxlint-disable next/no-img-element -- Inspection uses unmodified pixel frames, not optimized display images. */

import Link from 'next/link';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ChevronRight,
  Play,
  Pause,
  ArrowLeft,
  ArrowRight,
  LoaderCircle,
  Check,
  CircleAlert,
  History,
  Settings2,
  Upload,
  Sparkles,
} from 'lucide-react';
import { WorkbenchBreadcrumb } from '@/components/workbench/shared-navigation';
import { EditorWorkbenchMenu } from '@/components/workbench/editor-chrome';
import { useWorkbench } from '@/components/workbench/workbench-provider';
import {
  publishEditorSession,
  removeEditorSession,
  markEditorSaved,
} from '@/lib/workbench/editor-session';
import { offerGodotExport } from '@/lib/workbench/godot-export';
import type { WorkbenchModule } from '@/lib/workbench/modules';
import { SpritePipelineWorkspace } from './sprite-pipeline-workspace';
import {
  MotionModelSettings,
  type MotionConfiguration as Configuration,
} from './motion-model-settings';
import {
  blankSpec,
  motionSteps,
  motionStep,
  motionSpecsEqual,
  motionPlanningProgress,
  motionPlanningRequestKey,
  motionRequest,
  motionUrl,
  type MotionSpec,
  type MotionWork,
  type MotionJob,
  type MotionCandidate,
} from './open-motion-model';
import './open-motion.css';
import { MotionStageReview } from './motion-stage-review';
import { MotionAdjustment } from './motion-adjustment';
import { MotionPanel } from './motion-panel';
import { MotionTemporalStructure } from './motion-temporal-structure';
import { MotionVisualReview } from './motion-visual-review';
import { MotionStructure } from './motion-structure';

type Character = {
  id: string;
  name: string;
  width: number;
  facing: string;
  valid: boolean;
};
type Recent = {
  id: string;
  title: string;
  updated_at: string;
  diagnostic_only: boolean;
  revision: number;
};
const roles: Record<string, string> = {
  appearance: '外观专家',
  motion: '动作专家',
  strategy: '生成策略专家',
  coordinator: '协调专家',
  validator: '本机方案校验',
};
const stageLabels: Record<string, string> = {
  created: '等待制作',
  submitting: '提交中',
  pending: '生成中',
  complete: '已保存',
  unknown: '需核对原请求',
  failed: '需要处理',
  reviewing: '检查实际片段中',
  awaiting_review: '等待确认姿势',
  accepted: '已确认并锁定',
  rejected: '片段不合格，已停止',
};
const subscribe = (fn: () => void) => {
  window.addEventListener('popstate', fn);
  return () => window.removeEventListener('popstate', fn);
};

export function SpriteStudioEntry({ module }: { module: WorkbenchModule }) {
  const search = useSyncExternalStore(
    subscribe,
    () => location.search,
    () => '',
  );
  const [resolved, setResolved] = useState<{
    job: string;
    work?: string;
    revision?: number;
  } | null>(null);
  const [error, setError] = useState('');
  const params = new URLSearchParams(search),
    job = params.get('job'),
    work = params.get('work');
  const legacy = params.get('legacy') === '1';
  useEffect(() => {
    if (!job) return;
    const abort = new AbortController();
    void motionRequest<{ data: { job: MotionJob } }>(
      `jobs/${job}`,
      undefined,
      {},
      abort.signal,
    )
      .then((value) => {
        const binding = value.data.job.request.open_plan;
        setResolved({
          job,
          work: binding?.work_id,
          revision: binding?.revision,
        });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [job]);
  if (
    params.get('legacy') === '1' ||
    (job && resolved?.job === job && !resolved.work)
  )
    return (
      <SpritePipelineWorkspace
        module={module}
        returnToMotion={
          legacy && resolved?.job === job && resolved.work
            ? `/tools/sprite-generator?${new URLSearchParams({
                work: resolved.work,
                version: String(resolved.revision),
                candidate: params.get('candidate') || '1',
              })}`
            : undefined
        }
      />
    );
  if (job && resolved?.job !== job)
    return (
      <div className="motion-loading">
        {error || '正在打开所选动画…'}
        {error && <button onClick={() => location.reload()}>重新连接</button>}
      </div>
    );
  return (
    <OpenMotionStudio
      key={`${work || resolved?.work || 'new'}:${params.get('version') || resolved?.revision || ''}`}
      workId={work || resolved?.work || ''}
      version={Number(params.get('version')) || resolved?.revision}
      characterId={params.get('character') || ''}
      initialCandidate={Number(params.get('candidate')) || 1}
    />
  );
}

function OpenMotionStudio({
  workId,
  version,
  characterId,
  initialCandidate,
}: {
  workId: string;
  version?: number;
  characterId: string;
  initialCandidate: number;
}) {
  const wb = useWorkbench();
  const [work, setWork] = useState<MotionWork | null>(null);
  const [spec, setSpec] = useState<MotionSpec>({
    ...blankSpec,
    character_id: characterId,
  });
  const [characters, setCharacters] = useState<Character[]>([]);
  const [configuration, setConfiguration] = useState<Configuration | null>(
    null,
  );
  const [recent, setRecent] = useState<Recent[]>([]);
  const [step, setStep] = useState(0),
    [candidateIndex, setCandidateIndex] = useState(initialCandidate);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false);
  const [note, setNote] = useState(''),
    [acknowledge, setAcknowledge] = useState(false),
    [watched, setWatched] = useState(false);
  const [inspectionToken, setInspectionToken] = useState('');
  const [uploadName, setUploadName] = useState(''),
    [uploadFacing, setUploadFacing] = useState('right');
  const [uploadIdentity, setUploadIdentity] = useState('');
  const [remoteId, setRemoteId] = useState('');
  const [adjustmentOpen,setAdjustmentOpen]=useState(false);
  const structureDraftSaver = useRef<(() => void) | null>(null);
  const registerStructureDraftSaver = useCallback((save: (() => void) | null) => { structureDraftSaver.current = save; }, []);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const requestKey = useRef(''),
    lastStatus = useRef(-1),
    pollRevision = useRef(0);
  const submittedDraft = useRef(false);
  const draftKey = `forge.motion.draft.${workId || 'new'}`;
  const readOnly = Boolean(work && work.revision !== work.latest_revision);
  const candidate = work?.job?.candidates.find(
    (c) => c.candidate_index === candidateIndex,
  );
  const finished = Boolean(candidate?.frames.length),
    approved = candidate?.status === 'approved';
  const watchedCurrent = watched && inspectionToken === candidate?.review_token;
  // Explain the same gate that controls the primary action. Never silently
  // accept warnings or a candidate with unresolved frame repairs.
  const reviewBlocker = readOnly
    ? '当前是历史版本，请先进入最新版本。'
    : !finished
      ? '候选帧尚未保存完成。'
      : approved
        ? ''
        : candidate?.hard_failures.length
          ? '请先处理上方的阻断问题，再重新检查。'
          : ['pending', 'running'].includes(
                candidate?.quality_review?.state || '',
              )
            ? '正在核对实际帧，请等待视觉验收完成。'
            : candidate?.frames.some((f) =>
                  ['repair_requested', 'rejected'].includes(f.review_status),
                )
              ? '还有标记为需要修补或弃用的帧，请先在逐帧编辑器处理。'
              : candidate?.status !== 'review_ready'
                ? '当前候选尚未就绪，请完成检查或修补后再采用。'
                : !watchedCurrent
                  ? '请先播放检查，再勾选“我已播放完整动作”。'
                  : note.trim().length < 4
                    ? '请填写检查结论（至少 4 个字）。'
                    : (candidate.warnings.length ||
                          (candidate.quality_review &&
                            candidate.quality_review.verdict !== 'pass')) &&
                        !acknowledge
                      ? candidate.quality_review
                        ? '请核对技术与视觉报告，再明确接受提醒；不满意可以先调整。'
                        : '请展开技术提醒，核对后勾选“已核对上述技术提醒并接受”。'
                      : '';
  const active = Boolean(
    work?.job?.plan_control.enabled &&
    work.job.candidates.some(
      (c) => !c.frames.length && !['failed', 'rejected'].includes(c.status),
    ),
  );
  const maxStep = motionStep(work);
  const planningStopped = Boolean(work && !work.plan && !work.job &&
    ['planning_failed', 'budget_exhausted'].includes(work.status));
  const checkpoint = work?.job?.candidates.flatMap(c=>c.plan_execution.stages.flatMap((s,i)=>
    s.state==='awaiting_review'?[{candidate:c.candidate_index,stage:i}]:[]))[0];
  const recoverable=work?.job?.candidates.some(c=>c.plan_execution.stages.some(s=>
    s.state==='unknown'||(!work.job?.plan_control.enabled&&['submitting','pending'].includes(s.state))));

  const applyWork = useCallback((value: MotionWork) => {
    setWork(value);
    const next = motionStep(value);
    if (lastStatus.current !== next) {
      const previous = lastStatus.current;
      setStep((current) =>
        previous === -1 || current === previous ? next : current,
      );
      lastStatus.current = next;
    }
  }, []);
  const refreshLists = useCallback(async () => {
    const [refs, config, history] = await Promise.all([
      motionRequest<{ characters: Character[] }>('open-motion/references'),
      motionRequest<Configuration>('open-motion/settings'),
      motionRequest<{ works: Recent[] }>('open-motion'),
    ]);
    setCharacters(
      refs.characters.filter((c) => c.valid && c.id !== 'diagnostic_dummy'),
    );
    setConfiguration(config);
    setRecent(history.works.filter((w) => !w.diagnostic_only));
  }, []);

  useEffect(() => {
    let live = true;
    const initialize = async () => {
      try {
        let loaded: MotionWork | null = null;
        if (workId) {
          const value = await motionRequest<MotionWork>(
            `open-motion/${workId}`,
            undefined,
            version ? { revision: String(version) } : {},
          );
          if (!live) return;
          applyWork(value);
          setSpec(value.spec);
          loaded = value;
        } else if (characterId) {
          setSpec({ ...blankSpec, character_id: characterId });
        }
        try {
          const draft = localStorage.getItem(draftKey);
          if (draft) {
            const saved = JSON.parse(draft) as {
              spec: MotionSpec;
              requestKey?: string;
              revision?: number;
            };
            if (
              !workId ||
              (loaded &&
                saved.revision === loaded.revision &&
                loaded.revision === loaded.latest_revision)
            ) {
              setSpec({
                ...blankSpec,
                ...saved.spec,
                review_protocol: saved.spec.review_protocol,
                ...(characterId ? { character_id: characterId,
                  ...(characterId !== saved.spec.character_id ? { visual_structure: null } : {}),
                } : {}),
              });
              requestKey.current = saved.requestKey || '';
              if (loaded && !motionSpecsEqual(saved.spec, loaded.spec))
                setStep(0);
            }
          }
        } catch {
          if (live)
            setError('草稿未能读取。服务器中的作品仍可从制作记录打开。');
        }
        await refreshLists();
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) setReady(true);
      }
    };
    void initialize();
    return () => {
      live = false;
    };
  }, [workId, version, characterId, draftKey, applyWork, refreshLists]);

  useEffect(() => {
    if (!workId || !ready) return;
    let running = false;
    const abort = new AbortController();
    const poll = async () => {
      if (running || busy) return;
      running = true;
      const revision = pollRevision.current;
      try {
        const value = await motionRequest<MotionWork>(
          `open-motion/${workId}`,
          undefined,
          version ? { revision: String(version) } : {},
          abort.signal,
        );
        if (!abort.signal.aborted && revision === pollRevision.current)
          applyWork(value);
      } catch {
        /* Keep last saved work visible; explicit refresh reports connectivity errors. */
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [workId, version, ready, busy, applyWork]);

  const saveDraft = useCallback(async () => {
    if (submittedDraft.current) {
      localStorage.removeItem(draftKey);
      return;
    }
    localStorage.setItem(
      draftKey,
      JSON.stringify({
        spec,
        requestKey: requestKey.current,
        revision: work?.revision,
      }),
    );
  }, [draftKey, spec, work?.revision]);
  useEffect(() => {
    if (!ready) return;
    void saveDraft().catch(() =>
      setError('浏览器未能保存草稿，请保留此页；提交后的任务另存于本机服务。'),
    );
    publishEditorSession({
      capabilityId: 'sprite-generator',
      dirty: true,
      busy,
      items: work
        ? [
            {
              id: `motion:${work.id}`,
              capabilityId: 'sprite-generator',
              title: work.plan?.title || work.spec.description.slice(0, 60),
              detail: work.job?.plan_control.message || work.message,
              state:
                active || work.status === 'planning'
                  ? 'running'
                  : approved
                    ? 'completed'
                    : 'attention',
              href: `/tools/sprite-generator?work=${work.id}`,
              updatedAt: work.job?.updated_at || work.updated_at,
              stage: step,
            },
          ]
        : [],
      save: async () => {
        await saveDraft();
        structureDraftSaver.current?.();
        markEditorSaved('sprite-generator');
      },
    });
    return () => removeEditorSession('sprite-generator');
  }, [ready, saveDraft, work, step, busy, active, approved]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    pollRevision.current++;
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mutate = async (
    operation: string,
    values: Record<string, unknown> = {},
  ) => {
    if (!work || readOnly) return;
    const value = await motionRequest<MotionWork>(
      `open-motion/${work.id}/${operation}`,
      { expected_revision: work.revision, ...values },
    );
    applyWork(value);
    return value;
  };
  const edit = (value: Partial<MotionSpec>) => {
    requestKey.current = '';
    setSpec((previous) => ({ ...previous, ...('character_id' in value && value.character_id!==previous.character_id ? {visual_structure:null}:{}), ...value }));
  };
  const plan = () =>
    run(async () => {
      if (readOnly || work?.status === 'planning') return;
      if (
        work &&
        ['ready', 'executing'].includes(work.status) &&
        motionSpecsEqual(spec, work.spec)
      ) {
        setStep(1);
        return;
      }
      if (!configuration?.planning_configured) {
        settingsRef.current?.setAttribute('open', '');
        throw new Error(
          '先配置规划模型，再制定方案。PixelLab 用于后续动画制作。',
        );
      }
      requestKey.current = motionPlanningRequestKey(work, requestKey.current);
      await saveDraft();
      const value = await motionRequest<MotionWork>(
        work ? `open-motion/${work.id}/revise` : 'open-motion',
        {
          spec,
          request_key: requestKey.current,
          planning_authorized: true,
          ...(work ? { expected_revision: work.revision } : {}),
        },
      );
      if (work) {
        applyWork(value);
        lastStatus.current = 1;
        setStep(1);
      } else {
        submittedDraft.current = true;
        await wb.navigate(`/tools/sprite-generator?work=${value.id}`);
      }
    });
  const deliver = () =>
    run(async () => {
      const value = await mutate('export', { candidate_index: candidateIndex });
      if (value?.job?.export?.godot_package_path)
        offerGodotExport({
          name: `${value.plan?.title} · 候选 ${candidateIndex}`,
          jobId: value.job.job_id,
          candidateIndex,
        });
    });

  return (
    <div className="motion-studio" data-sprite-editor>
      <header className="motion-header">
        <EditorWorkbenchMenu />
        <WorkbenchBreadcrumb compact projectName={work?.plan?.title || '新动作'} />
        <span className="motion-save">
          {work ? `版本 ${work.revision} · 已保存本机` : '准备阶段不创建任务'}
        </span>
        <details className="motion-popover">
          <summary>
            <History size={16} />
            最近动作
          </summary>
          <div className="motion-popover-body">
            <button onClick={() => void wb.navigate('/tools/sprite-generator')}>
              ＋ 新动作
            </button>
            {!recent.length && (
              <p>还没有新流程作品。旧任务保留在资产库和旧版工作区。</p>
            )}
            {recent.map((row) => (
              <button
                key={row.id}
                onClick={() =>
                  void wb.navigate(`/tools/sprite-generator?work=${row.id}`)
                }
              >
                {row.title}
                <small>{new Date(row.updated_at).toLocaleString()}</small>
              </button>
            ))}
            <Link href="/assets">资产库</Link>
            <Link href="/tools/sprite-generator?legacy=1">旧版工作区</Link>
          </div>
        </details>
        <details className="motion-popover" ref={settingsRef}>
          <summary>
            <Settings2 size={16} />
            模型设置
          </summary>
          <MotionModelSettings
            configuration={configuration}
            onSaved={(value) => setConfiguration(value)}
          />
        </details>
      </header>
      <nav className="motion-steps" aria-label="角色动画制作阶段">
        {motionSteps.map((name, i) => (
          <button
            key={name}
            aria-current={step === i ? 'step' : undefined}
            disabled={i > maxStep || busy}
            onClick={() => setStep(i)}
          >
            <span>{i < maxStep ? <Check size={14} /> : i + 1}</span>
            {name}
            {i < 4 && (
              <ChevronRight size={14} className="motion-step-chevron" />
            )}
          </button>
        ))}
      </nav>
      {error && (
        <div role="alert" className="motion-error">
          <span>{error}</span>
          <button
            onClick={() =>
              void run(async () => {
                await refreshLists();
                if (workId)
                  applyWork(
                    await motionRequest<MotionWork>(
                      `open-motion/${workId}`,
                      undefined,
                      version ? { revision: String(version) } : {},
                    ),
                  );
              })
            }
          >
            重新连接 / 查询
          </button>
        </div>
      )}
      {readOnly && (
        <div className="motion-notice">
          正在查看历史版本。原文件保留；生成、采用与导出请进入
          <a href={`/tools/sprite-generator?work=${work?.id}`}>当前版本</a>
          。已有导出仍可下载。
        </div>
      )}
      <main className="motion-content">
        {!ready ? (
          <div className="motion-loading">
            <LoaderCircle className="animate-spin" />
            正在连接角色工作区…
          </div>
        ) : (
          <>
            <div className="motion-heading">
              <small>
                CHARACTER / MOTION · {String(step + 1).padStart(2, '0')}
              </small>
              <h1>{motionSteps[step]}</h1>
              <p>
                {
                  [
                    '选好角色，用自己的话描述它要做什么。',
                    '核对动作顺序、结束姿势和调用范围。',
                    '生成在本机服务持续运行，可以离开页面后回来。',
                    '完整播放并检查动作；技术检查不能替代你的视觉判断。',
                    '将选中的动画送入游戏项目，保留其他动作和游戏逻辑。',
                  ][step]
                }
              </p>
            </div>
            {step === 0 && (
              <div className="motion-grid">
                <section className="motion-card motion-reference">
                  <h2>使用哪个角色</h2>
                  <MotionStructure key={spec.character_id} characterId={spec.character_id} disabled={readOnly || busy} registerDraftSaver={registerStructureDraftSaver} modelConfiguration={JSON.stringify(configuration?.configuration || null)} generationStructure={spec.visual_structure} onGenerationStructure={(value)=>edit({visual_structure:value})} />
                  <label>
                    已有角色
                    <select
                      value={spec.character_id}
                      disabled={readOnly}
                      onChange={(e) => { edit({ character_id: e.target.value }); setUploadIdentity(''); }}
                    >
                      <option value="">请选择角色</option>
                      {characters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.width}px · 朝
                          {c.facing === 'left' ? '左' : '右'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <details>
                    <summary>上传自己的原图</summary>
                    <div className="motion-stack">
                      <p>
                        64 × 64 或 128 × 128 透明
                        PNG；上传只保存素材，不调用模型。
                      </p>
                      <label>
                        角色名称
                        <input
                          value={uploadName}
                          onChange={(e) => setUploadName(e.target.value)}
                          maxLength={200}
                        />
                      </label>
                      <label>
                        原图朝向
                        <select
                          value={uploadFacing}
                          onChange={(e) => setUploadFacing(e.target.value)}
                        >
                          <option value="right">向右</option>
                          <option value="left">向左</option>
                        </select>
                      </label>
                      <CharacterIdentityField value={uploadIdentity} onChange={setUploadIdentity} maxLength={uploadedIdentityLimit} disabled={busy || readOnly} />
                      <label className="motion-upload">
                        <Upload size={16} />
                        选择 PNG
                        <input
                          type="file"
                          accept="image/png"
                          disabled={busy || readOnly}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            void run(async () => {
                              if (!uploadName.trim())
                                throw new Error('请先填写角色名称');
                              if (file.size > 1_400_000)
                                throw new Error(
                                  '图片过大，请使用 64 或 128 像素 PNG',
                                );
                              const data = await new Promise<string>(
                                (resolve, reject) => {
                                  const reader = new FileReader();
                                  reader.onload = () => {
                                    if (typeof reader.result === 'string')
                                      resolve(reader.result.split(',')[1]);
                                    else reject(new Error('无法读取 PNG'));
                                  };
                                  reader.onerror = reject;
                                  reader.readAsDataURL(file);
                                },
                              );
                              const value = await motionRequest<{
                                character: { character_id: string };
                              }>('open-motion/references', {
                                display_name: uploadName,
                                facing: uploadFacing,
                                identity_description: uploadedReferenceIdentity(uploadIdentity),
                                png_base64: data,
                              });
                              await refreshLists();
                              edit({
                                character_id: value.character.character_id,
                              });
                              setUploadIdentity('');
                            });
                            e.target.value = '';
                          }}
                        />
                      </label>
                    </div>
                  </details>
                  <Link href="/tools/reference-art">
                    还没有角色？先制作原图 <ArrowRight size={14} />
                  </Link>
                </section>
                <section className="motion-card motion-brief">
                  <h2>描述这段动作</h2>
                  <label>
                    角色要做什么
                    <textarea
                      aria-label="角色要做什么"
                      value={spec.description}
                      onChange={(e) => edit({ description: e.target.value })}
                      disabled={readOnly}
                      maxLength={2000}
                      rows={6}
                      placeholder="例如：角色发现脚边的物品，蹲下捡起，再站起来查看。最后保持手持物品的姿势。"
                    />
                  </label>
                  <label>
                    结束时希望保持什么姿势
                    <input
                      value={spec.ending}
                      onChange={(e) => edit({ ending: e.target.value })}
                      disabled={readOnly}
                      maxLength={300}
                      placeholder="可选；留空时由方案提出建议"
                    />
                  </label>
                  <label className="motion-check">
                    <input
                      type="checkbox"
                      checked={spec.loop}
                      onChange={(e) => edit({ loop: e.target.checked })}
                      disabled={readOnly}
                    />
                    需要循环播放
                  </label>
                  <label className="motion-check">
                    <input
                      type="checkbox"
                      checked={spec.return_to_reference || false}
                      onChange={(e) =>
                        edit({ return_to_reference: e.target.checked })
                      }
                      disabled={readOnly}
                    />
                    结束时回到原图姿势（默认保留描述的结束姿势）
                  </label>
                  <details>
                    <summary>候选数量、播放速度与调用上限</summary>
                    <div className="motion-options">
                      <label>
                        候选数量
                        <input
                          type="number"
                          min={1}
                          max={8}
                          value={spec.candidate_count}
                          onChange={(e) =>
                            edit({
                              candidate_count: Number(e.target.value),
                              budget: {
                                ...spec.budget,
                                max_review_calls: Math.max(
                                  spec.budget.max_review_calls || 2,
                                  Number(e.target.value) * (spec.review_protocol==='experts_v1'?25:10),
                                ),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        播放 FPS
                        <input
                          type="number"
                          min={1}
                          max={60}
                          value={spec.fps}
                          onChange={(e) =>
                            edit({
                              fps: Number(e.target.value),
                              timing_mode: 'fixed',
                            })
                          }
                        />
                      </label>
                      <label className="motion-check">
                        <input
                          type="checkbox"
                          checked={spec.timing_mode !== 'fixed'}
                          onChange={(e) =>
                            edit({
                              timing_mode: e.target.checked ? 'auto' : 'fixed',
                            })
                          }
                        />
                        由方案安排播放节奏
                      </label>
                      <label>
                        规划调用上限
                        <input
                          type="number"
                          min={4}
                          max={16}
                          value={spec.budget.max_planning_calls}
                          onChange={(e) =>
                            edit({
                              budget: {
                                ...spec.budget,
                                max_planning_calls: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        生成调用上限
                        <input
                          type="number"
                          min={1}
                          max={32}
                          value={spec.budget.max_generation_calls}
                          onChange={(e) =>
                            edit({
                              budget: {
                                ...spec.budget,
                                max_generation_calls: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        视觉复核方式
                        <select aria-label="视觉复核方式" value={spec.review_protocol || 'baseline'} onChange={e=>edit({
                          review_protocol:e.target.value as 'baseline'|'experts_v1',
                          budget:{...spec.budget,max_review_calls:Math.max(spec.budget.max_review_calls||2,(e.target.value==='experts_v1'?25:10)*spec.candidate_count)},
                        })}>
                          <option value="experts_v1">独立专家与争议复核</option>
                          <option value="baseline">基础视觉检查</option>
                        </select>
                      </label>
                      <label>
                        视觉验收调用上限
                        <input
                          type="number"
                          min={2}
                          max={200}
                          value={spec.budget.max_review_calls || 2}
                          onChange={(e) =>
                            edit({
                              budget: {
                                ...spec.budget,
                                max_review_calls: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <p>{spec.review_protocol==='experts_v1'
                        ? '每段及整段各含 2 次基础检查、2 次独立判断；有争议时再复核 1 次。每候选预留 5 ×（分段数 + 1）次，修复后的重新检查也计入总额度。'
                        : '每个候选包含逐段检查和整段复核，需要 2 × 分段数 + 2 次视觉请求。'}</p>
                    </div>
                  </details>
                  <div className="motion-notice">
                    复核方式：{spec.review_protocol==='experts_v1'?'独立专家与争议复核':'基础视觉检查'}。{' '}
                    制定方案最多调用规划模型 {spec.budget.max_planning_calls}{' '}
                    次；此按钮不会生成动画。PixelLab 最多{' '}
                    {spec.budget.max_generation_calls} 次；视觉验收最多{' '}
                    {spec.budget.max_review_calls || 2}{' '}
                    次。确认方案后才开始绘制和验收，均按服务商实际计费。
                  </div>
                </section>
              </div>
            )}
            {step === 1 && work && (
              <div className="motion-grid motion-plan-grid">
                <section className="motion-card">
                  <h2>{work.plan?.title || (work.status === 'planning' ? '正在形成制作方案' : '制作方案未完成')}</h2>
                  <p>{work.plan?.summary || work.message}</p>
                  {work.visual_structure && <p className="motion-muted">已使用核对后的角色结构 · 版本 {work.visual_structure.revision}。各段采用的结构依据可在描述中展开查看。</p>}
                  {work.plan?.quality&&<p className="motion-muted">复核方式：{work.spec.review_protocol==='experts_v1'?'独立专家与争议复核':'基础视觉检查'}；
                    本方案最多预留 {(work.spec.review_protocol==='experts_v1'?5:2)*(work.plan.quality.version>=3?work.plan.stages.length+1:1)*work.spec.candidate_count} 次视觉请求，
                    已设总上限 {work.spec.budget.max_review_calls ?? 10} 次。按实际调用计费；确认片段和最终采用仍由你决定。</p>}
                  {!work.plan && (
                    <div className="motion-experts">
                      {Object.entries(roles).map(([role, name]) => {
                        const progress = motionPlanningProgress(work, role);
                        return (
                          <div key={role} data-planning-role={role} data-state={progress.state}>
                            <span aria-hidden="true">
                              {progress.state === 'complete' ? <Check size={17} />
                                : progress.state === 'running' ? <LoaderCircle size={17} className="animate-spin" />
                                : ['failed', 'unknown', 'blocked'].includes(progress.state) ? <CircleAlert size={17} /> : '·'}
                            </span>
                            <span>{name}<small>{progress.label}</small></span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {work.plan?.questions.length ? (
                    <div className="motion-notice">
                      <h3>需要你补充</h3>
                      {work.plan.questions.map((q) => (
                        <p key={q}>{q}</p>
                      ))}
                      <p>返回描述补充后，再制定新版本方案。</p>
                    </div>
                  ) : null}
                  <ol className="motion-timeline">
                    {work.plan?.stages.map((s, i) => (
                      <li key={i}>
                        <b>{i + 1}</b>
                        <div>
                          <h3>
                            {s.name}
                            <small>{s.frame_count} 帧</small>
                          </h3>
                          <p>{s.goal}</p>
                          {s.checkpoint&&<p>确认姿势：{s.checkpoint.endpoint}</p>}
                          <p className="motion-muted">
                            {i === 0 ? '从角色原图开始' : '接上一段末帧'} ·{' '}
                            {s.last_frame === 'original'
                              ? '以原图作为终点参考'
                              : '保留本段要求的结束姿势'}
                          </p>
                          <details>
                            <summary>检查标准与生成描述</summary>
                            <ul>
                              {s.acceptance.map((a) => (
                                <li key={a}>{a}</li>
                              ))}
                            </ul>
                            <p className="motion-prompt">{s.prompt}</p>
                            {s.structure_usage && <p>结构依据：{s.structure_usage.effect}</p>}
                            {s.checkpoint&&<p>{s.checkpoint.rhythm} · {s.checkpoint.reason}</p>}
                            {s.motion&&<><p>视角与朝向：{s.motion.camera} · {s.motion.orientation}</p><p>支撑与发力：{s.motion.support} · {s.motion.drive}</p><p>物体与轨迹：{s.motion.appearance} · {s.motion.trajectory}</p><p>衔接：{s.motion.entry} → {s.motion.exit} · {({pass_through:'连续经过',settle:'逐渐收稳',intentional_hold:'有意停顿'} as Record<string,string>)[s.motion.boundary]}</p>{s.motion.holds.map((h,i)=><p key={i}>第 {h.start}–{h.end} 帧停顿：{h.reason}</p>)}</>}
                          </details>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {work.plan && <MotionTargets key={`${work.id}:${work.revision}`} work={work} onSaved={applyWork} />}
                  {work.status !== 'planning' && !work.plan && (
                    <div className="motion-notice">
                      本轮规划已停止，未提交绘图。可直接重新制定方案，或返回修改要求；旧版本和调用记录保留。
                    </div>
                  )}
                </section>
                <aside className="motion-card">
                  <h2>制作范围</h2>
                  <div className="motion-small-reference">
                    <img
                      src={motionUrl(`open-motion/${work.id}/reference`, {
                        revision: String(work.revision),
                      })}
                      alt="本次方案参考图"
                    />
                    <span>
                      {work.character.display_name}
                      <small>
                        原图朝{work.character.facing === 'left' ? '左' : '右'} ·{' '}
                        {work.character.cell_width}px
                      </small>
                    </span>
                  </div>
                  <p>{work.spec.description}</p>
                  {work.spec.ending && <p>结束姿势：{work.spec.ending}</p>}
                  <p>
                    {work.spec.candidate_count} 个候选 ·{' '}
                    {work.plan?.quality?.playback_fps || work.spec.fps} FPS ·{' '}
                    {work.spec.loop ? '循环' : '单次播放'}
                  </p>
                  {work.plan?.quality && (
                    <details>
                      <summary>完整动作与质量约束</summary>
                      <p>{work.plan.quality.event_contract}</p>
                      <p>{work.plan.quality.appearance_contract}</p>
                      <p>结束：{work.plan.quality.ending_contract}</p>
                      <p>节奏：{work.plan.quality.rhythm_contract}</p>
                      {work.plan.quality.key_poses?.map((p) => (
                        <p key={p.frame}>
                          约第 {p.frame} 帧：{p.description}
                        </p>
                      ))}
                    </details>
                  )}
                  <div className="motion-notice">
                    {work.plan
                      ? `预计 ${work.plan.stages.length * work.spec.candidate_count} 次生成请求`
                      : '生成次数待方案确定'}
                    <br />
                    规划已用 {work.planning_calls.length} /{' '}
                    {work.spec.budget.max_planning_calls} 次
                  </div>
                  <details>
                    <summary>要求的依据</summary>
                    {work.plan?.requirements.map((r, i) => (
                      <p key={i}>
                        <b>
                          {
                            (
                              {
                                user: '用户要求',
                                reference: '参考图观察',
                                expert: '专家建议',
                              } as Record<string, string>
                            )[r.source]
                          }
                        </b>{' '}
                        · {r.text}
                        <small>{r.evidence}</small>
                      </p>
                    ))}
                  </details>
                  <ExpertRecord work={work} />
                </aside>
              </div>
            )}
            {step === 2 && work && (
              <div className={`motion-grid${checkpoint?' motion-review-grid':''}`}>
                {checkpoint ? <MotionStageReview key={`${work.id}:${work.revision}:${checkpoint.candidate}:${checkpoint.stage}`} work={work} candidate={checkpoint.candidate} stage={checkpoint.stage} readOnly={readOnly} onSaved={applyWork} expertRecord={<ExpertRecord work={work}/>} /> : <section className="motion-card">
                  <h2>{work.job?.plan_control.message || work.message}</h2>
                  <div className="motion-canvas motion-large">
                    {work.job && (
                      <img
                        src={motionUrl(
                          `open-motion/${work.id}/progress-image`,
                          {
                            candidate: String(candidateIndex),
                            v: String(work.job.revision),
                          },
                        )}
                        alt="原图或已保存片段的最后一帧"
                      />
                    )}
                  </div>
                  <p className="motion-muted">
                    显示原图或已保存片段的末帧。完整动画完成后进入播放检查。
                  </p>
                </section>}
                <aside className="motion-card">
                  <h2>实际进度</h2>
                  {work.job?.candidates.map((c) => (
                    <div key={c.candidate_index} className="motion-progress">
                      <h3>候选 {c.candidate_index}</h3>
                      {c.plan_execution.stages.map((s, i) => (
                        <p key={i}>
                          <span
                            className={
                              s.state === 'complete' ? 'motion-good' : ''
                            }
                          >
                            {stageLabels[s.state] || s.state}
                          </span>
                          {work.plan?.stages[i].name}
                          <small>
                            {s.actual_frame_count
                              ? `${s.actual_frame_count} 帧已保存`
                              : ''}
                          </small>
                        </p>
                      ))}
                      {c.error && (
                        <p className="motion-danger">{c.error.message}</p>
                      )}
                    </div>
                  ))}
                  <p>
                    刷新或关闭页面不会重发已提交的请求。暂停会阻止下一段提交，已发出的请求仍会取回。
                  </p>
                  {recoverable&&<MotionPanel title="中断后的恢复">
                    <p>
                      查询只取回原请求。如果提交结果未知，需从 PixelLab
                      查到原请求编号后绑定；不会自动重做。
                    </p>
                    <label>
                      候选
                      <select
                        value={candidateIndex}
                        onChange={(e) =>
                          setCandidateIndex(Number(e.target.value))
                        }
                      >
                        {work.job?.candidates.map((c) => (
                          <option
                            key={c.candidate_index}
                            value={c.candidate_index}
                          >
                            {c.candidate_index}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      已核对的原请求编号（可选）
                      <input
                        value={remoteId}
                        onChange={(e) => setRemoteId(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={busy || readOnly}
                      onClick={() =>
                        void run(async () => {
                          await mutate('recover', {
                            candidate_index: candidateIndex,
                            ...(remoteId ? { provider_job_id: remoteId } : {}),
                          });
                        })
                      }
                    >
                      查询原请求
                    </button>
                  </MotionPanel>}
                  {!checkpoint&&<MotionPanel title="检查详情"><ExpertRecord work={work} /></MotionPanel>}
                </aside>
              </div>
            )}
            {(step === 3 || step === 4) && work?.job && (
              <div className={`motion-grid motion-review-grid${step===3&&adjustmentOpen?' motion-adjusting':''}`}>
                <section className="motion-card motion-source-preview">
                  <div className="motion-card-title">
                    <h2>{work.plan?.title}</h2>
                    <label>
                      候选
                      <select
                        value={candidateIndex}
                        onChange={(e) => {
                          setCandidateIndex(Number(e.target.value));
                          setNote('');
                          setWatched(false);
                          setAcknowledge(false);
                        }}
                      >
                        {work.job.candidates.map((c) => (
                          <option
                            key={c.candidate_index}
                            value={c.candidate_index}
                          >
                            候选 {c.candidate_index} ·{' '}
                            {c.status === 'approved'
                              ? '已采用'
                              : c.frames.length
                                ? '待检查'
                                : '未完成'}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {candidate && (
                    <FramePlayer
                      key={`${work.job.job_id}:${candidateIndex}`}
                      job={work.job}
                      candidate={candidate}
                      work={work}
                      readOnly={readOnly}
                    />
                  )}
                  {work.diagnostic_only && (
                    <div className="motion-notice">
                      诊断素材，仅用于验证工具链，不能作为模型生成效果。
                    </div>
                  )}
                </section>
                <aside className="motion-card">
                  <h2>{step === 3 ? '人工检查与采用' : '交付这个动作'}</h2>
                  {step === 3 ? (
                    <>
                      {!adjustmentOpen&&<>
                      <div className="motion-notice">
                        {candidate?.quality_review
                          ? '请查看下方视觉验收状态与帧证据，并实际播放检查。最终是否采用由你决定。'
                          : '本任务仅有尺寸、透明度等技术检查；动作是否正确仍需人工确认。'}
                      </div>
                      {candidate?.quality_review && (
                        <MotionVisualReview report={candidate.quality_review} compact />
                      )}
                      <MotionPanel title="检查详情">
                      {candidate?.quality_review&&<MotionVisualReview report={candidate.quality_review}/>}
                      <ul className="motion-criteria">
                        {work.plan?.stages
                          .flatMap((s) => s.acceptance)
                          .map((a, i) => (
                            <li key={i}>{a}</li>
                          ))}
                      </ul>
                      <ExpertRecord work={work}/>
                      </MotionPanel>
                      {!!candidate?.hard_failures.length && (
                        <div className="motion-error">
                          {candidate.hard_failures.map((f, i) => (
                            <p key={i}>{f.message}</p>
                          ))}
                        </div>
                      )}
                      {!!candidate?.warnings.length && (
                        <details>
                          <summary>
                            {candidate.warnings.length} 条技术提醒，展开检查
                          </summary>
                          {candidate.warnings.map((w, i) => (
                            <p key={i}>{w.message}</p>
                          ))}
                        </details>
                      )}
                      {approved ? (
                        <p className="motion-good">已采用，可重复进入导出。</p>
                      ) : (
                        <>
                          <label className="motion-check">
                            <input
                              type="checkbox"
                              checked={watchedCurrent}
                              onChange={(e) => {
                                setInspectionToken(
                                  candidate?.review_token || '',
                                );
                                setWatched(e.target.checked);
                              }}
                            />
                            我已播放完整动作并检查衔接、外观与结束姿势
                          </label>
                          <label>
                            检查结论（至少 4 个字）
                            <textarea
                              aria-label="检查结论"
                              rows={3}
                              value={note}
                              onChange={(e) => setNote(e.target.value)}
                              placeholder="至少 4 个字，说明检查结果或接受的瑕疵"
                            />
                          </label>
                          {!!(
                            candidate?.warnings.length ||
                            (candidate?.quality_review &&
                              candidate.quality_review.verdict !== 'pass')
                          ) && (
                            <label className="motion-check">
                              <input
                                type="checkbox"
                                checked={acknowledge}
                                disabled={['pending', 'running'].includes(
                                  candidate?.quality_review?.state || '',
                                )}
                                onChange={(e) =>
                                  setAcknowledge(e.target.checked)
                                }
                              />
                              {candidate?.quality_review
                                ? '已核对技术与视觉提醒，接受当前结果'
                                : '已核对上述技术提醒并接受'}
                            </label>
                          )}
                        </>
                      )}
                      </>}
                      <MotionAdjustment key={`${work.id}:${work.revision}:${candidateIndex}`} work={work} candidate={candidateIndex} readOnly={readOnly} onOpenChange={setAdjustmentOpen} onSaved={value=>{
                        applyWork(value);
                        if(value.revision!==work.revision){
                          setCandidateIndex(1);
                          void wb.navigate(`/tools/sprite-generator?work=${value.id}&version=${value.revision}&candidate=1`).catch(e=>setError(e.message));
                        }
                      }} />
                      {!adjustmentOpen&&<MotionPanel title="高级工具">
                        <p>
                          修改动作要求会保存旧版本，并重新规划。逐帧编辑沿用现有工具；修改后须重新检查和采用。
                        </p>
                        <button
                          disabled={busy || active || readOnly}
                          onClick={() => setStep(0)}
                        >
                          修改要求
                        </button>
                        <a
                          href={`/tools/sprite-generator?legacy=1&job=${work.job.job_id}&candidate=${candidateIndex}`}
                        >
                          打开逐帧编辑工作区
                        </a>
                      </MotionPanel>}
                    </>
                  ) : (
                    <>
                      <p>
                        {candidate?.frames.length || 0} 帧 ·{' '}
                        {work.job.action.fps} FPS ·{' '}
                        {work.job.action.loop ? '循环' : '单次'}
                      </p>
                      <p>
                        导出包含实际 PNG、预览和 Godot
                        SpriteFrames。选择游戏项目路径后，复制接入提示词交给
                        WorkBuddy。
                      </p>
                      <div className="motion-notice">
                        导出不代表脚本已接好。WorkBuddy
                        会检查目标项目，合并这个动作，并保留角色其他动作、朝向、缩放和游戏逻辑。
                      </div>
                      {work.job.export?.candidate_index === candidateIndex && (
                        <div className="motion-downloads">
                          <a
                            href={motionUrl(
                              `jobs/${work.job.job_id}/exports/godot`,
                            )}
                            download
                          >
                            Godot ZIP
                          </a>
                          <a
                            href={motionUrl(
                              `jobs/${work.job.job_id}/exports/sheet`,
                            )}
                            download
                          >
                            PNG 精灵表
                          </a>
                          <a
                            href={motionUrl(
                              `jobs/${work.job.job_id}/exports/preview`,
                            )}
                            download
                          >
                            GIF 预览
                          </a>
                        </div>
                      )}
                      {!approved && <p>请先回到检查阶段采用当前候选。</p>}
                    </>
                  )}
                  {!!work.history.length && (
                    <details>
                      <summary>保留的历史版本</summary>
                      {work.history.map((h) => (
                        <a
                          key={h.revision}
                          href={`/tools/sprite-generator?work=${work.id}&version=${h.revision}`}
                        >
                          版本 {h.revision} · {h.title}
                        </a>
                      ))}
                    </details>
                  )}
                </aside>
              </div>
            )}
          </>
        )}
      </main>
      <footer className="motion-footer">
        <output id="motion-action-status">
          {busy ? (
            <>
              <LoaderCircle size={16} className="animate-spin" />
              正在保存操作…
            </>
          ) : step === 0 ? (
            work ? (
              '修改保存在当前浏览器；重新制定方案会保留旧版本。'
            ) : (
              '描述草稿保存在当前浏览器；提交后由本机服务保存。'
            )
          ) : step === 3 ? (
            (adjustmentOpen?'选择允许修改的帧，生成备选后再比较采用。原版保持保留。':reviewBlocker) ||
            (approved
              ? '当前候选已采用，可以进入导出。'
              : '检查确认已完成，可以采用当前候选。')
          ) : step === 4 && approved ? (
            '当前候选已采用，可以导出或再次交付。'
          ) : step === 1 && planningStopped ? (
            `重新制定会沿用当前要求并保存新版本，最多再次调用规划模型 ${spec.budget.max_planning_calls} 次；不会自动绘图。`
          ) : work?.job ? (
            work.job.plan_control.message
          ) : work ? (
            work.message
          ) : (
            '描述草稿保存在当前浏览器；提交后由本机服务保存。'
          )}
        </output>
        <div className="motion-footer-actions">
          {step > 0 && (
            <button
              className="motion-secondary"
              disabled={busy}
              onClick={() => setStep(step - 1)}
            >
              <ArrowLeft size={15} />
              返回{motionSteps[step - 1]}
            </button>
          )}
          {step === 0 && (
            <button
              className="motion-primary"
              disabled={
                busy ||
                !ready ||
                readOnly ||
                work?.status === 'planning' ||
                active ||
                !spec.character_id ||
                spec.description.trim().length < 4
              }
              onClick={plan}
            >
              <Sparkles size={16} />
              {work ? '按修改重新制定方案' : '制定方案'}
            </button>
          )}
          {step === 1 && planningStopped && (
            <button
              className="motion-primary"
              disabled={busy || !ready || readOnly || !spec.character_id || spec.description.trim().length < 4}
              onClick={plan}
            >
              <Sparkles size={16} />
              重新制定方案
            </button>
          )}
          {step === 1 && !planningStopped && (
            <button
              className="motion-primary"
              disabled={
                busy ||
                readOnly ||
                !work?.plan ||
                (work.status !== 'ready' && !work.job)
              }
              onClick={() =>
                work?.job
                  ? setStep(Math.max(2, maxStep))
                  : void run(async () => {
                      if (
                        !configuration?.pixellab_configured &&
                        work?.spec.provider !== 'fixture'
                      ) {
                        settingsRef.current?.setAttribute('open', '');
                        throw new Error('请先配置 PixelLab API Key');
                      }
                      await mutate('generate', {
                        plan_sha256: work?.plan_sha256,
                      });
                    })
              }
            >
              {work?.job ? '查看制作结果' : '确认方案，开始制作'}
              <ArrowRight size={16} />
            </button>
          )}
          {step === 2 && !checkpoint && (
            <button
              className="motion-primary"
              disabled={busy || readOnly || !work?.job}
              onClick={() =>
                finished
                  ? setStep(3)
                  : void run(async () => {
                      await mutate(active ? 'pause' : 'resume');
                    })
              }
            >
              {finished
                ? '检查动画'
                : active
                  ? '暂停后续制作'
                  : '继续已授权制作'}
            </button>
          )}
          {step === 3 && !adjustmentOpen && (
            <button
              className="motion-primary"
              disabled={busy || Boolean(reviewBlocker)}
              aria-describedby="motion-action-status"
              onClick={() =>
                approved
                  ? setStep(4)
                  : void run(async () => {
                      await mutate('review', {
                        candidate_index: candidateIndex,
                        candidate_sha256: candidate?.review_token,
                        note,
                        acknowledge_warnings: acknowledge,
                      });
                      setStep(4);
                    })
              }
            >
              {approved ? '进入导出' : '采用此候选，进入导出'}
              <ArrowRight size={16} />
            </button>
          )}
          {step === 4 && (
            <button
              className="motion-primary"
              disabled={busy || readOnly || !approved}
              onClick={deliver}
            >
              导出到 Godot 项目
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function ExpertRecord({ work }: { work: MotionWork }) {
  return (
    <details>
      <summary>专家协作记录 · {work.planning_calls.length} 次调用</summary>
      <div className="motion-expert-record">
        {work.messages.map((m, i) => (
          <article key={i}>
            <b>
              {roles[m.role]} ·{' '}
              {
                (
                  {
                    propose: '提出建议',
                    consult: '请求协作',
                    inspect_reference: '观察参考图',
                    finalize: '形成方案',
                    validation_feedback: '返回校验意见',
                  } as Record<string, string>
                )[m.response.action]
              }
            </b>
            <p>{m.response.summary}</p>
            {m.response.question && <p>{m.response.question}</p>}
          </article>
        ))}
      </div>
    </details>
  );
}

function FramePlayer({
  job,
  candidate,
  work,
  readOnly,
}: {
  job: MotionJob;
  candidate: MotionCandidate;
  work: MotionWork;
  readOnly: boolean;
}) {
  const [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [imageError, setImageError] = useState(false);
  const [speed, setSpeed] = useState(1);
  const count = candidate.frames.length;
  useEffect(() => {
    if (!playing || count === 0) return;
    const timer = setInterval(
      () =>
        setFrame((previous) => {
          if (previous + 1 >= count && !job.action.loop) {
            setPlaying(false);
            return count - 1;
          }
          return (previous + 1) % count;
        }),
      1000 / (job.action.fps * speed),
    );
    return () => clearInterval(timer);
  }, [playing, count, job.action.fps, job.action.loop, speed]);
  if (!count)
    return (
      <div className="motion-canvas motion-large">此候选尚无完整动画。</div>
    );
  const current = candidate.frames[Math.min(frame, count - 1)];
  const url = motionUrl(
    `jobs/${job.job_id}/candidates/${candidate.candidate_index}/frames/${current.index}/image`,
    { v: current.sha256 },
  );
  const stage = candidate.plan_execution.timeline.find(
    (s) => current.index >= s.start && current.index < s.start + s.count,
  );
  return (
    <>
      <MotionTemporalStructure work={work} candidate={candidate.candidate_index} frame={Math.min(frame,count-1)} frameSha={current.sha256}
        playing={playing} readOnly={readOnly} onFrame={value=>setFrame(Math.max(0,Math.min(count-1,value)))} onStop={()=>setPlaying(false)}>
        <img
          src={url}
          alt={`候选 ${candidate.candidate_index} · 第 ${current.index + 1} 帧`}
          onLoad={() => setImageError(false)}
          onError={() => {
            setImageError(true);
            setPlaying(false);
          }}
        />
      </MotionTemporalStructure>
      {imageError && (
        <p role="alert" className="motion-danger">
          当前帧加载失败，请恢复服务后重新查询；此时不能确认画面。
        </p>
      )}
      <div className="motion-player">
        <button
          aria-label={playing ? '暂停播放' : '播放完整动作'}
          onClick={() => {
            if (frame === count - 1) setFrame(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          aria-label="上一帧"
          onClick={() => {
            setPlaying(false);
            setFrame((f) => Math.max(0, f - 1));
          }}
        >
          <ArrowLeft size={16} />
        </button>
        <input
          aria-label="逐帧查看"
          type="range"
          min={0}
          max={count - 1}
          value={Math.min(frame, count - 1)}
          onChange={(e) => {
            setPlaying(false);
            setFrame(Number(e.target.value));
          }}
        />
        <button
          aria-label="下一帧"
          onClick={() => {
            setPlaying(false);
            setFrame((f) => Math.min(count - 1, f + 1));
          }}
        >
          <ArrowRight size={16} />
        </button>
        <span>
          {current.index + 1} / {count}
        </span>
        <select
          aria-label="预览速度"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        >
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
      </div>
      <p className="motion-muted">
        {stage?.name} · {job.action.fps} FPS ·{' '}
        {job.action.loop ? '循环播放' : '播放到末帧停止'}
      </p>
    </>
  );
}
