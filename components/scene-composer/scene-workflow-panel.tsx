'use client';
/* oxlint-disable next/no-img-element -- These are versioned, hash-verified evidence images. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type SharedDocument,
  type SharedDocumentSummary,
} from '@/features/editor-documents/client';
import { readSharedDocumentLibrary } from '@/features/editor-documents/library';
import { browserRequestJournal } from '@/features/editor-documents/browser-journal';
import type { Scene } from '@/features/scene-composer/model.mjs';
import {
  adoptionInput,
  canAdoptWorkflow,
  canReviseWorkflow,
  mapModeNames,
  newerWorkflow,
  mergeWorkflowHistory,
  validateMutationResult,
  workflowRequest,
  WorkflowClientError,
  roleNames,
  statusNames,
} from '@/features/scene-workflow/client';
import type {
  Evidence,
  ModelConfiguration,
  ModelProfile,
  ModelSettings,
  Role,
  SceneWorkflow,
  WorkflowAdoption,
  WorkflowBudget,
  WorkflowMapMode,
  WorkflowResult,
  WorkflowHistoryPage,
} from '@/features/scene-workflow/client';
import './scene-workflow.css';
import { WorkflowAcceptanceDetails, WorkflowStepDetails } from './scene-workflow-plan-details';

const defaultProfile: ModelProfile = {
  provider: 'openai',
  model: '',
  maxOutputTokens: 12000,
  timeoutSeconds: 180,
  tokenParameter: 'max_tokens',
  reasoningEffort: 'auto',
};
const defaultBudget: WorkflowBudget = {
  planningCalls: 16,
  reviewCalls: 9,
  imageCalls: 0,
  generationCalls: 0,
  mapTiles: 0,
  revisions: 2,
};
const budgetLabels: Record<keyof WorkflowBudget, string> = {
  planningCalls: '规划调用',
  reviewCalls: '复核调用',
  imageCalls: 'AI 改图',
  generationCalls: '新素材生成',
  mapTiles: '地图瓦片',
  revisions: '修订轮数',
};
const bounds: Record<keyof WorkflowBudget, [number, number]> = {
  planningCalls: [4, 48],
  reviewCalls: [2, 30],
  imageCalls: [0, 8],
  generationCalls: [0, 16],
  mapTiles: [0, 16],
  revisions: [0, 3],
};
const findingNames: Record<string, string> = {
  met: '满足要求',
  defect: '明确缺陷',
  preference: '审美建议',
  insufficient: '证据不足',
};
const stepKindNames: Record<string, string> = {
  scene: '场景布局',
  object: '物件配置',
  image: '局部改图',
  generate: '生成素材',
  map: '地图制作',
};
const stepStatusNames: Record<string, string> = {
  completed: '已完成',
  started: '执行中',
  pending: '等待制作完成',
  failed: '执行失败',
  attention_required: '需要检查',
  paused: '已暂停',
  running: '制作中',
  recorded: '请求已记录',
  prepared: '作业已准备',
  outcome_unknown: '提交结果未知',
  awaiting_configuration: '等待服务配置',
};
const operationNames: Record<string, string> = {
  create: '创建任务',
  execute: '执行方案',
  revise: '补充与修订',
  pause: '暂停任务',
  resume: '继续任务',
  adopt: '采用候选',
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : '请求未完成。';
type Pending = { operation: string; input: Record<string, unknown> };
interface Props {
  document: SharedDocument<Scene>;
  initialWorkId?: string;
  onSelection?: (workId: string | null) => void;
  beforeAdopt: () => Promise<void>;
  onAdopt: (receipt: WorkflowAdoption) => Promise<void>;
  onClose: () => void;
}

function ProfileFields({
  value,
  change,
  label,
}: {
  value: ModelProfile;
  change: (profile: ModelProfile) => void;
  label: string;
}) {
  const prefix = useId();
  return (
    <div className="sw-profile">
      <label>
        服务
        <select
          aria-label={`${label}服务`}
          value={value.provider}
          onChange={(e) =>
            change({
              ...value,
              provider: e.target.value as ModelProfile['provider'],
            })
          }
        >
          <option value="openai">OpenAI</option>
          <option value="tokenhub">TokenHub</option>
        </select>
      </label>
      <label htmlFor={`${prefix}-model`}>
        模型
        <Input
          id={`${prefix}-model`}
          aria-label={`${label}模型`}
          value={value.model}
          placeholder="支持图片与结构化输出的模型 ID"
          onChange={(e) => change({ ...value, model: e.target.value })}
        />
      </label>
      <details>
        <summary>请求参数</summary>
        <div className="sw-grid">
          <label htmlFor={`${prefix}-tokens`}>
            最大输出 Token
            <Input
              id={`${prefix}-tokens`}
              type="number"
              min={1024}
              max={32768}
              value={value.maxOutputTokens}
              onChange={(e) =>
                change({ ...value, maxOutputTokens: e.target.valueAsNumber })
              }
            />
          </label>
          <label htmlFor={`${prefix}-timeout`}>
            超时（秒）
            <Input
              id={`${prefix}-timeout`}
              type="number"
              min={30}
              max={600}
              value={value.timeoutSeconds}
              onChange={(e) =>
                change({ ...value, timeoutSeconds: e.target.valueAsNumber })
              }
            />
          </label>
          <label>
            推理强度
            <select
              value={value.reasoningEffort}
              onChange={(e) =>
                change({
                  ...value,
                  reasoningEffort: e.target
                    .value as ModelProfile['reasoningEffort'],
                })
              }
            >
              <option value="auto">模型默认</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
          {value.provider === 'tokenhub' && (
            <label>
              Token 参数
              <select
                value={value.tokenParameter}
                onChange={(e) =>
                  change({
                    ...value,
                    tokenParameter: e.target
                      .value as ModelProfile['tokenParameter'],
                  })
                }
              >
                <option value="max_tokens">max_tokens</option>
                <option value="max_completion_tokens">
                  max_completion_tokens
                </option>
              </select>
            </label>
          )}
        </div>
      </details>
    </div>
  );
}

function EvidenceImage({
  workId,
  evidence,
  title,
}: {
  workId: string;
  evidence?: Evidence;
  title: string;
}) {
  const [state, setState] = useState<{
    key: string;
    url?: string;
    error?: string;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const evidenceId = evidence?.id,
    evidenceRevision = evidence?.revision,
    evidenceHash = evidence?.contentHash,
    expectedHashes =
      evidence?.images.map((image) => image.sha256).join(',') || '';
  const evidenceKey = JSON.stringify([
    workId,
    evidenceId,
    evidenceRevision,
    evidenceHash,
    expectedHashes,
  ]);
  useEffect(() => {
    if (!evidenceId || evidenceRevision === undefined || !evidenceHash) return;
    let alive = true;
    void workflowRequest<{
      evidence: Evidence;
      images: Array<{
        data: string;
        mimeType: string;
        role: string;
        sha256: string;
      }>;
    }>('observe', { workId, evidenceId })
      .then(async (value) => {
        const image =
          value.images.find((item) => item.role === 'composite') ||
          value.images[0];
        if (
          !image ||
          value.evidence.id !== evidenceId ||
          value.evidence.contentHash !== evidenceHash ||
          value.evidence.revision !== evidenceRevision
        )
          throw new Error('图片证据版本不匹配。');
        const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          (n) => n.toString(16).padStart(2, '0'),
        ).join('');
        if (
          digest !== image.sha256 ||
          !expectedHashes.split(',').includes(digest)
        )
          throw new Error('图片证据校验未通过。');
        if (alive)
          setState({
            key: evidenceKey,
            url: `data:image/png;base64,${image.data}`,
          });
      })
      .catch((error) => {
        if (alive) setState({ key: evidenceKey, error: message(error) });
      });
    return () => {
      alive = false;
    };
  }, [
    workId,
    evidenceId,
    evidenceRevision,
    evidenceHash,
    expectedHashes,
    evidenceKey,
  ]);
  const current = state?.key === evidenceKey ? state : null;
  return (
    <figure className="sw-evidence">
      <figcaption>
        {title}
        {evidence && ` · v${evidence.revision}`}
      </figcaption>
      {current?.url ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`放大${title}`}
        >
          <img src={current.url} alt={title} />
        </button>
      ) : (
        <p>{current?.error || (evidence ? '正在读取证据…' : '尚未生成画面')}</p>
      )}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="sw-image-view">
          <DialogHeader>
            <DialogTitle>
              {title} · v{evidence?.revision}
            </DialogTitle>
            <DialogDescription>
              按原始像素查看已保存的观察图，可滚动检查细节。
            </DialogDescription>
          </DialogHeader>
          <div className="sw-image-scroll">
            {current?.url && <img src={current.url} alt={`${title}原始尺寸`} />}
          </div>
        </DialogContent>
      </Dialog>
    </figure>
  );
}

export function WorkflowProductionAuthorization({
  work,
}: {
  work: SceneWorkflow;
}) {
  const configuration = work.generationConfiguration;
  return (
    <section className="sw-authorization" aria-label="冻结的制作授权">
      <h3>创建时的制作授权</h3>
      <dl className="sw-grid">
        <div>
          <dt>地图范围</dt>
          <dd>{mapModeNames[work.spec.mapMode || 'preserve']}</dd>
        </div>
        <div>
          <dt>保护范围</dt>
          <dd>
            {work.spec.protectedInstanceIds.length} 个指定物件 ·{' '}
            {work.spec.editableMapLayerIds.length} 个允许改图的地图层
          </dd>
        </div>
        {(['prop', 'map'] as const).map((kind) => {
          const profile = configuration?.[kind];
          return (
            <div key={kind}>
              <dt>{kind === 'prop' ? '物件素材服务' : '地图图像服务'}</dt>
              <dd>
                {profile
                  ? `${profile.provider} / ${profile.model}`
                  : (work.spec.budget.generationCalls ?? 0) === 0
                    ? '新图像生成额度为 0'
                    : '未冻结此类生成服务'}
              </dd>
            </div>
          );
        })}
      </dl>
      <p>修订共用此授权和剩余额度。锁定物件始终受到保护。</p>
    </section>
  );
}

export function WorkflowProductionReceipts({ work }: { work: SceneWorkflow }) {
  const steps = work.steps.filter((step) =>
    ['image', 'generate', 'map'].includes(step.kind),
  );
  if (!steps.length && !work.generationCalls?.length) return null;
  return (
    <details className="sw-production-receipts">
      <summary>素材与地图制作回执（{steps.length} 个步骤）</summary>
      <p>异步作业沿用已保存的身份。继续任务会查询原作业并恢复后续步骤。</p>
      {steps.map((step, index) => {
        const production = step.mapJob || step;
        const job = production.generationJob;
        const evidence = production.generationEvidence;
        return (
          <article key={`${step.planHash}:${step.id}:${index}`}>
            <h4>
              {step.title} · {stepKindNames[step.kind] || step.kind} ·{' '}
              {stepStatusNames[step.status] || step.status}
            </h4>
            {step.beforeRevision && (
              <p>
                候选 v{step.beforeRevision}
                {step.afterRevision ? ` → v${step.afterRevision}` : ''}
              </p>
            )}
            {job && (
              <dl className="sw-job-identity">
                <div>
                  <dt>请求身份</dt>
                  <dd>{job.requestId}</dd>
                </div>
                <div>
                  <dt>原作业</dt>
                  <dd>
                    {job.taskId || '尚未取得作业 ID'} ·{' '}
                    {stepStatusNames[job.status] || job.status}
                  </dd>
                </div>
              </dl>
            )}
            {evidence && (
              <dl className="sw-job-identity">
                <div>
                  <dt>生成服务</dt>
                  <dd>
                    {evidence.provider} / {evidence.model}
                  </dd>
                </div>
                <div>
                  <dt>图片证据</dt>
                  <dd>
                    {evidence.image.width} × {evidence.image.height} · SHA-256{' '}
                    {evidence.image.sha256}
                  </dd>
                </div>
              </dl>
            )}
            {step.mapOutput && (
              <dl className="sw-job-identity">
                <div>
                  <dt>
                    {step.mapOutput.operation === 'create'
                      ? '创建地图'
                      : '扩建地图'}{' '}
                    · 瓦片 {step.mapOutput.tileKey}
                  </dt>
                  <dd>
                    地图源坐标（{step.mapOutput.tileBounds.x}，
                    {step.mapOutput.tileBounds.y}）·{' '}
                    {step.mapOutput.tileBounds.width} ×{' '}
                    {step.mapOutput.tileBounds.height}
                  </dd>
                </div>
                <div>
                  <dt>拼接图片 SHA-256</dt>
                  <dd>{step.mapOutput.stitchedSha256}</dd>
                </div>
                <div>
                  <dt>地图版本哈希</dt>
                  <dd>
                    {step.mapOutput.beforeMapHash} →{' '}
                    {step.mapOutput.afterMapHash}
                  </dd>
                </div>
              </dl>
            )}
            <details>
              <summary>查看确切作业身份与回执</summary>
              <pre>{JSON.stringify(step, null, 2)}</pre>
            </details>
          </article>
        );
      })}
      {!!work.generationCalls?.length && (
        <details>
          <summary>新素材生成用量记录（{work.generationCalls.length}）</summary>
          <pre>{JSON.stringify(work.generationCalls, null, 2)}</pre>
        </details>
      )}
    </details>
  );
}

export function WorkflowResumeAction({
  work,
  disabled,
  onResume,
}: {
  work: SceneWorkflow;
  disabled: boolean;
  onResume: () => void;
}) {
  if (work.running) return null;
  if (work.status === 'paused')
    return (
      <Button disabled={disabled} onClick={onResume}>
        继续任务
      </Button>
    );
  if (work.status === 'attention_required' && work.recoverableProduction)
    return (
      <Button disabled={disabled} onClick={onResume}>
        {work.configurationRequired ? '配置完成后继续制作' : '核对原制作请求'}
      </Button>
    );
  return null;
}

export function SceneWorkflowPanel({
  document,
  initialWorkId,
  onSelection,
  beforeAdopt,
  onAdopt,
  onClose,
}: Props) {
  const [settings, setSettings] = useState<ModelSettings | null>(null),
    [config, setConfig] = useState<ModelConfiguration>({
      default: defaultProfile,
      roles: {},
    });
  const [keys, setKeys] = useState({ openai: '', tokenhub: '' }),
    [sources, setSources] = useState<Array<SharedDocumentSummary>>([]);
  const [works, setWorks] = useState<SceneWorkflow[]>([]),
    [work, setWork] = useState<SceneWorkflow | null>(null);
  const [historyPage, setHistoryPage] = useState<WorkflowHistoryPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyRequest = useRef(0);
  const [description, setDescription] = useState(''),
    [selectedSources, setSelectedSources] = useState<string[]>([]),
    [protectedIds, setProtectedIds] = useState<string[]>([]),
    [layers, setLayers] = useState<string[]>([]);
  const [budget, setBudget] = useState(defaultBudget),
    [autoExecute, setAutoExecute] = useState(true);
  const [mapMode, setMapMode] = useState<WorkflowMapMode>('preserve'),
    [generationProviders, setGenerationProviders] = useState<
      Partial<Record<'prop' | 'map', string>>
    >({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [recovering, setRecovering] = useState(true);
  const [clarification, setClarification] = useState(''),
    [acknowledged, setAcknowledged] = useState<string[]>([]),
    [reviewNote, setReviewNote] = useState('');
  const [detail, setDetail] = useState(''),
    [pending, setPending] = useState<Pending | null>(null);
  const mutation = useRef(false),
    selectedId = useRef<string | null>(null);
  const selectionCallback = useRef(onSelection);
  useEffect(() => { selectionCallback.current = onSelection; }, [onSelection]);
  const storageKey = `forge-scene-workflow-pending:${document.id}`;
  const journal = useMemo(() => browserRequestJournal('scene-workflow', document.id), [document.id]);
  const select = (next: SceneWorkflow | null) => {
    selectedId.current = next?.id || null;
    setWork((current) => (next ? newerWorkflow(current, next) : null));
    setAcknowledged([]);
    setReviewNote('');
    setDetail('');
    setError('');
    onSelection?.(next?.id || null);
  };
  const refresh = async () => {
    const request = ++historyRequest.current;
    const result = await workflowRequest<WorkflowHistoryPage>('list', {
      documentId: document.id,
    });
    if (request !== historyRequest.current) return;
    setHistoryPage(result);
    setWorks((current) =>
      result.works.map((incoming) =>
        newerWorkflow(
          current.find((row) => row.id === incoming.id) || null,
          incoming,
        ),
      ),
    );
  };
  const loadMore = async () => {
    if (historyLoading || !historyPage || historyPage.nextOffset === null) return;
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    setError('');
    try {
      const result = await workflowRequest<WorkflowHistoryPage>('list', {
        documentId: document.id, offset: historyPage.nextOffset, snapshot: historyPage.snapshot,
      });
      if (request !== historyRequest.current) return;
      setWorks((rows) => mergeWorkflowHistory(rows, result.works));
      setHistoryPage(result);
    } catch (cause) {
      if (request === historyRequest.current) setError(message(cause));
    } finally {
      setHistoryLoading(false);
    }
  };
  useEffect(() => {
    let alive = true;
    const sourceController = new AbortController();
    const initialize = async () => {
      try {
        const saved = sessionStorage.getItem(storageKey);
        if (saved) {
          await journal.begin(JSON.parse(saved) as Pending);
          sessionStorage.removeItem(storageKey);
        }
        const original = await journal.pending();
        if (alive) setPending(original?.request ?? null);
        const [models, history, requested] = await Promise.allSettled([
          workflowRequest<ModelSettings>('settings'),
          workflowRequest<WorkflowHistoryPage>('list', {
            documentId: document.id,
          }),
          initialWorkId ? workflowRequest<WorkflowResult>('get', { workId: initialWorkId }) : Promise.resolve(null),
        ]);
        if (!alive) return;
        if (models.status === 'fulfilled') {
          setSettings(models.value);
          if (models.value.configuration) setConfig(models.value.configuration);
        } else setError(message(models.reason));
        if (history.status === 'fulfilled') {
          setWorks(history.value.works);
          setHistoryPage(history.value);
          if (!initialWorkId && history.value.works[0]) {
            selectedId.current = history.value.works[0].id;
            setWork(history.value.works[0]);
            selectionCallback.current?.(history.value.works[0].id);
          }
        } else setError(message(history.reason));
        if (initialWorkId) {
          if (requested.status === 'fulfilled' && requested.value) {
            if (requested.value.work.id !== initialWorkId || requested.value.work.spec.documentId !== document.id)
              throw new Error('场景任务与当前共享场景不匹配，未切换到其他任务。');
            selectedId.current = initialWorkId;
            setWork(requested.value.work);
          } else if (requested.status === 'rejected') setError(message(requested.reason));
        }
        const result = await readSharedDocumentLibrary('interactable', sourceController.signal);
        if (alive) setSources(result.documents);
      } catch (cause) {
        if (alive) setError(message(cause));
      } finally { if (alive) setRecovering(false); }
    };
    void initialize();
    return () => {
      alive = false;
      sourceController.abort();
    };
  }, [document.id, storageKey, initialWorkId, journal]);
  const pollingId = work?.id,
    pollingRunning = work?.running;
  useEffect(() => {
    if (!pollingId || !pollingRunning) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await workflowRequest<WorkflowResult>('get', {
          workId: pollingId,
        });
        if (active && selectedId.current === result.work.id) {
          setWork((current) => newerWorkflow(current, result.work));
          setWorks((rows) =>
            rows.map((row) =>
              row.id === result.work.id ? newerWorkflow(row, result.work) : row,
            ),
          );
        }
      } catch (cause) {
        if (active) setError(message(cause));
      }
      if (active) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pollingId, pollingRunning]);
  const run = async (attempt: Pending) => {
    if (mutation.current || recovering) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    let awaitingResponse = false;
    try {
      if (attempt.operation === 'adopt') await beforeAdopt();
      const entry = await journal.begin(attempt);
      attempt = entry.request;
      setPending(attempt);
      awaitingResponse = true;
      const result = await workflowRequest<WorkflowResult>(
        attempt.operation,
        attempt.input,
      );
      awaitingResponse = false;
      validateMutationResult(
        result,
        attempt.operation,
        attempt.input,
        document.id,
      );
      await journal.respond(attempt, result);
      select(result.work);
      if (attempt.operation === 'adopt') {
        await onAdopt(result.adoption!);
        setNotice('候选已采用，场景编辑器已更新。');
      }
      await journal.complete(attempt);
      setPending(null);
      await refresh();
    } catch (cause) {
      if (
        awaitingResponse && cause instanceof WorkflowClientError &&
        cause.status >= 400 &&
        cause.status < 500 && cause.status !== 408
      ) {
        try { await journal.complete(attempt, 'rejected'); }
        catch (storageError) { setError(message(storageError)); return; }
        setPending(null);
      }
      setError(message(cause));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  const act = (operation: string, extra: Record<string, unknown> = {}) => {
    if (!work) return;
    void run({
      operation,
      input: {
        workId: work.id,
        ...(operation !== 'pause' ? { expectedRevision: work.revision } : {}),
        commandId: crypto.randomUUID(),
        ...extra,
      },
    });
  };
  const toggle = (values: string[], id: string) =>
    values.includes(id)
      ? values.filter((value) => value !== id)
      : [...values, id];
  const plan = work?.plans.at(-1),
    review = work?.reviews.at(-1);
  const canAdopt = !!work && canAdoptWorkflow(work);
  const disabled = recovering || busy || !!pending;
  const latestEvidence = work?.evidence.find(
    (e) =>
      e.contentHash === review?.candidateHash &&
      e.revision === review?.candidateRevision &&
      e.id.startsWith('candidate-'),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sw-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>场景协作</DialogTitle>
          <DialogDescription>
            在指定素材、地图范围和额度内制作候选。专家规划、执行和独立复核的记录会保存，查看对比后再采用。
          </DialogDescription>
        </DialogHeader>
        <div className="sw-layout">
          <aside className="sw-sidebar">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => select(null)}
            >
              新建协作任务
            </Button>
            <nav aria-label="场景协作历史">
              {works.map((item) => (
                <button
                  key={item.id}
                  aria-current={work?.id === item.id ? 'page' : undefined}
                  disabled={busy}
                  onClick={() => select(item)}
                >
                  <strong>
                    {item.plans.at(-1)?.plan.title ||
                      item.spec.description.slice(0, 36)}
                  </strong>
                  <span>{statusNames[item.status] || item.status}</span>
                </button>
              ))}
            </nav>
            {historyPage && <div className="sw-history-pages">
              <small>已显示 {works.length} / {historyPage.total} 条</small>
              {historyPage.nextOffset !== null && <Button size="sm" variant="outline" disabled={busy || historyLoading} onClick={() => void loadMore()}>
                {historyLoading ? '正在加载…' : '加载更早任务'}
              </Button>}
              <Button size="sm" variant="ghost" disabled={busy || historyLoading} onClick={() => {
                setError('');
                void refresh().catch((cause) => setError(message(cause)));
              }}>刷新列表</Button>
            </div>}
            <details open={!settings?.configured}>
              <summary>
                专家模型设置{settings?.configured ? ' · 已配置' : ' · 需要配置'}
              </summary>
              <p>六种角色可共用一个模型，也可分别设置。模型调用可能计费。</p>
              <ProfileFields
                label="默认"
                value={config.default}
                change={(value) =>
                  setConfig((previous) => ({ ...previous, default: value }))
                }
              />
              <details>
                <summary>按角色选择模型</summary>
                {Object.entries(roleNames).map(([key, name]) => {
                  const role = key as Role;
                  return (
                    <div key={role}>
                      <label className="sw-check">
                        <input
                          type="checkbox"
                          checked={!!config.roles[role]}
                          onChange={(e) =>
                            setConfig((previous) => {
                              const roles = { ...previous.roles };
                              if (e.target.checked)
                                roles[role] = { ...previous.default };
                              else delete roles[role];
                              return { ...previous, roles };
                            })
                          }
                        />
                        {name}
                      </label>
                      {config.roles[role] && (
                        <ProfileFields
                          label={name}
                          value={config.roles[role]!}
                          change={(value) =>
                            setConfig((previous) => ({
                              ...previous,
                              roles: { ...previous.roles, [role]: value },
                            }))
                          }
                        />
                      )}
                    </div>
                  );
                })}
              </details>
              {(['openai', 'tokenhub'] as const).map((provider) => (
                <label key={provider}>
                  {provider === 'openai' ? 'OpenAI' : 'TokenHub'} Key{' '}
                  {settings?.services.find((s) => s.id === provider)?.configured
                    ? '（已有可用 Key）'
                    : ''}
                  <Input
                    type="password"
                    autoComplete="off"
                    value={keys[provider]}
                    placeholder="留空沿用已配置的 Key"
                    onChange={(e) =>
                      setKeys((previous) => ({
                        ...previous,
                        [provider]: e.target.value,
                      }))
                    }
                  />
                </label>
              ))}
              <Button
                size="sm"
                disabled={busy || !config.default.model.trim()}
                onClick={() => {
                  setBusy(true);
                  setError('');
                  void workflowRequest<ModelSettings>('settings', {
                    configuration: config,
                    keys,
                  })
                    .then((value) => {
                      setSettings(value);
                      setKeys({ openai: '', tokenhub: '' });
                      setNotice(
                        '模型设置已保存；现有任务继续使用创建时的模型配置。',
                      );
                    })
                    .catch((cause) => setError(message(cause)))
                    .finally(() => setBusy(false));
                }}
              >
                保存模型设置
              </Button>
            </details>
          </aside>
          <div className="sw-content">
            {error && (
              <p className="sw-error" role="alert">
                {error}
              </p>
            )}
            {notice && <output>{notice}</output>}
            {pending && (
              <div className="sw-pending">
                <p>上次请求尚未完成确认，原请求已保留。</p>
                <p className="sw-muted">
                  {operationNames[pending.operation] || pending.operation} ·{' '}
                  {typeof pending.input.workId === 'string'
                    ? pending.input.workId
                    : document.id}
                </p>
                <details>
                  <summary>查看原请求身份</summary>
                  <p>
                    {typeof pending.input.commandId === 'string'
                      ? pending.input.commandId
                      : ''}
                  </p>
                </details>
                <Button disabled={busy} onClick={() => void run(pending)}>
                  恢复原请求
                </Button>
              </div>
            )}
            {!work ? (
              <div className="sw-form">
                <h2>描述希望完成的场景</h2>
                <label>
                  制作要求
                  <textarea
                    aria-label="制作要求"
                    rows={5}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="例如：复用已有拉杆和铁门，拉杆打开门并关闭碰撞，保留平台和其他物件。"
                  />
                </label>
                <p>
                  使用「{document.name}」v{document.revision}
                  。支持复用或生成素材、物件配置、摆放、联动与地图制作。
                </p>
                <label>
                  地图制作范围
                  <select
                    aria-label="地图制作范围"
                    value={mapMode}
                    onChange={(e) => {
                      const next = e.target.value as WorkflowMapMode;
                      setMapMode(next);
                      if (next !== 'preserve') setLayers([]);
                    }}
                  >
                    <option value="preserve">
                      {document.content.map
                        ? '保持现有地图几何'
                        : '制作物件，暂不创建地图'}
                    </option>
                    {document.content.map ? (
                      <option value="extend">扩建现有地图</option>
                    ) : (
                      <option value="create">创建新地图</option>
                    )}
                  </select>
                </label>
                <p className="sw-muted">
                  {mapMode === 'preserve'
                    ? '物件可以新增、摆放和联动；地图图片仅在下方指定层内局部修改。'
                    : mapMode === 'create'
                      ? '从新地图原点开始制作；新增图像和瓦片分别计入生成与地图额度。'
                      : '沿已保存且可验证的地图源工程扩建，保留现有瓦片；新增图像和瓦片分别计入额度。'}
                </p>
                <details>
                  <summary>
                    补充已有交互物素材（{selectedSources.length}）
                  </summary>
                  {sources.length ? (
                    sources.map((source) => (
                      <label className="sw-check" key={source.id}>
                        <input
                          type="checkbox"
                          checked={selectedSources.includes(source.id)}
                          onChange={() =>
                            setSelectedSources(
                              toggle(selectedSources, source.id),
                            )
                          }
                        />
                        {source.name} · v{source.revision}
                      </label>
                    ))
                  ) : (
                    <p>没有其他共享交互物工程，可使用当前场景中的素材。</p>
                  )}
                </details>
                <details>
                  <summary>保护物件与允许改图的地图层</summary>
                  {mapMode !== 'preserve' && (
                    <p>
                      创建或扩建期间支持物件局部改图；地图层局部改图在保持地图几何的任务中使用。
                    </p>
                  )}
                  {document.content.instances.map((instance) => (
                    <label className="sw-check" key={instance.id}>
                      <input
                        type="checkbox"
                        disabled={instance.locked}
                        checked={
                          instance.locked || protectedIds.includes(instance.id)
                        }
                        onChange={() =>
                          setProtectedIds(toggle(protectedIds, instance.id))
                        }
                      />
                      保护 {instance.name}
                      {instance.locked ? '（已锁定）' : ''}
                    </label>
                  ))}
                  {document.content.map?.layers.map((layer) => (
                    <label className="sw-check" key={layer.id}>
                      <input
                        type="checkbox"
                        disabled={layer.locked || mapMode !== 'preserve'}
                        checked={
                          mapMode === 'preserve' && layers.includes(layer.id)
                        }
                        onChange={() => setLayers(toggle(layers, layer.id))}
                      />
                      允许局部改图：{layer.name}
                      {layer.locked ? '（需先在场景中解锁）' : ''}
                    </label>
                  ))}
                </details>
                <details>
                  <summary>新素材与地图的图像服务</summary>
                  <p>
                    为本次任务选择已有图像服务。创建任务后会冻结服务与模型。
                  </p>
                  <div className="sw-grid">
                    {(['prop', 'map'] as const).map((kind) => {
                      const production = settings?.production?.[kind];
                      const defaultProvider = production?.providers.find(
                        (provider) => provider.id === production.provider,
                      );
                      return (
                        <label key={kind}>
                          {kind === 'prop' ? '物件素材服务' : '地图图像服务'}
                          <select
                            aria-label={
                              kind === 'prop' ? '物件素材服务' : '地图图像服务'
                            }
                            value={generationProviders[kind] || ''}
                            onChange={(e) =>
                              setGenerationProviders((previous) => {
                                const next = { ...previous };
                                if (e.target.value) next[kind] = e.target.value;
                                else delete next[kind];
                                return next;
                              })
                            }
                          >
                            <option value="">
                              沿用当前默认服务
                              {defaultProvider
                                ? ` · ${defaultProvider.name}`
                                : ''}
                            </option>
                            {production?.providers.map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.name} · {provider.model}
                                {provider.configured
                                  ? ' · 已配置'
                                  : ' · 待配置'}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                  <p className="sw-muted">
                    图像服务沿用素材与地图页面的配置。生成额度为 0
                    时只使用已有素材。
                  </p>
                </details>
                <fieldset>
                  <legend>本任务总额度</legend>
                  <div className="sw-budget">
                    {(
                      Object.keys(budgetLabels) as Array<keyof WorkflowBudget>
                    ).map((key) => (
                      <label key={key}>
                        {budgetLabels[key]}
                        <Input
                          type="number"
                          step={1}
                          min={bounds[key][0]}
                          max={bounds[key][1]}
                          value={budget[key]}
                          onChange={(e) =>
                            setBudget((previous) => ({
                              ...previous,
                              [key]: e.target.valueAsNumber,
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <p>
                    额度覆盖全部讨论、制作、复核和修订。新素材生成与 AI
                    改图分别计数，默认均为 0；本地替色不占 AI 改图额度。
                  </p>
                  <p>
                    创建或扩建地图需要地图瓦片额度；生成瓦片图像还需要新素材生成额度。
                  </p>
                </fieldset>
                <label className="sw-check">
                  <input
                    type="checkbox"
                    checked={autoExecute}
                    onChange={(e) => setAutoExecute(e.target.checked)}
                  />
                  方案就绪后，在额度和范围内自动制作、检查与修订候选
                </label>
                <Button
                  disabled={
                    disabled ||
                    !settings?.configured ||
                    description.trim().length < 4
                  }
                  onClick={() =>
                    void run({
                      operation: 'create',
                      input: {
                        commandId: crypto.randomUUID(),
                        spec: {
                          documentId: document.id,
                          expectedRevision: document.revision,
                          description,
                          sourceDocumentIds: selectedSources,
                          protectedInstanceIds: protectedIds,
                          editableMapLayerIds:
                            mapMode === 'preserve' ? layers : [],
                          mapMode,
                          generationProviders,
                          budget,
                          autoExecute,
                        },
                      },
                    })
                  }
                >
                  开始专家协作
                </Button>
              </div>
            ) : (
              <div className="sw-task">
                <div className="sw-task-heading">
                  <h2>{plan?.plan.title || '场景协作任务'}</h2>
                  <span>{statusNames[work.status] || work.status}</span>
                </div>
                <output>{work.message}</output>
                <p className="sw-muted">
                  来源 v{work.sourceRevision}
                  {work.candidateRevision
                    ? ` · 候选 v${work.candidateRevision}`
                    : ''}
                </p>
                <div className="sw-budget">
                  {(
                    Object.keys(budgetLabels) as Array<keyof WorkflowBudget>
                  ).map((key) => (
                    <div key={key}>
                      <span>{budgetLabels[key]}</span>
                      <strong>
                        {work.usage[key] ?? 0} / {work.spec.budget[key] ?? 0}
                      </strong>
                    </div>
                  ))}
                </div>
                <WorkflowProductionAuthorization work={work} />
                <div className="sw-actions">
                  {work.running && (
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={() => act('pause')}
                    >
                      在安全步骤暂停
                    </Button>
                  )}
                  <WorkflowResumeAction
                    work={work}
                    disabled={disabled}
                    onResume={() => act('resume')}
                  />
                  {work.status === 'ready' && (
                    <Button
                      disabled={disabled}
                      onClick={() => act('execute', { planHash: plan!.hash })}
                    >
                      执行此方案
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      void workflowRequest<WorkflowResult>('get', {
                        workId: work.id,
                      })
                        .then((value) => {
                          if (selectedId.current === value.work.id)
                            setWork((current) =>
                              newerWorkflow(current, value.work),
                            );
                        })
                        .catch((cause) => setError(message(cause)));
                    }}
                  >
                    刷新状态
                  </Button>
                </div>
                {work.questions?.length ? (
                  <div className="sw-pending">
                    <strong>需要补充</strong>
                    <ul>
                      {work.questions.map((question) => (
                        <li key={question}>{question}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <details open>
                  <summary>制作方案与执行进度</summary>
                  <p>{plan?.plan.summary || work.spec.description}</p>
                  {plan && (
                    <>
                      <ul>
                        {plan.plan.requirements.map((item) => (
                          <li key={item.id}>
                            {item.source === 'user' ? '用户要求' : '专家建议'}：
                            {item.text}
                          </li>
                        ))}
                      </ul>
                      <ol>
                        {plan.plan.steps.map((item) => {
                          const receipt = work.steps.find(
                            (step) =>
                              step.id === item.id &&
                              step.planHash === plan.hash,
                          );
                          return (
                            <li key={item.id}>
                              <strong>{item.title}</strong> ·{' '}
                              {stepKindNames[item.kind] || item.kind} ·{' '}
                              {receipt
                                ? stepStatusNames[receipt.status] ||
                                  receipt.status
                                : '待执行'}
                              {item.dependsOn.length > 0 && (
                                <span className="sw-muted">
                                  {' '}
                                  · 前置：
                                  {item.dependsOn
                                    .map(
                                      (id) =>
                                        plan.plan.steps.find((s) => s.id === id)
                                          ?.title || id,
                                    )
                                    .join('、')}
                                </span>
                              )}
                              <WorkflowStepDetails step={item} scene={document.content} steps={plan.plan.steps} />
                            </li>
                          );
                        })}
                      </ol>
                    </>
                  )}
                </details>
                {plan && <WorkflowAcceptanceDetails plan={plan.plan} scene={document.content} />}
                <WorkflowProductionReceipts work={work} />
                {work.evidence.length > 0 && (
                  <section aria-label="候选画面对比">
                    <h3>画面对比</h3>
                    <p>新增素材和地图会呈现在已保存、校验过的候选观察图中。</p>
                    <div className="sw-comparison">
                      <EvidenceImage
                        workId={work.id}
                        evidence={work.evidence[0]}
                        title="任务开始时"
                      />
                      <EvidenceImage
                        workId={work.id}
                        evidence={latestEvidence}
                        title="当前检查候选"
                      />
                    </div>
                    <label>
                      局部、素材与行为回放
                      <select
                        value={detail}
                        onChange={(e) => setDetail(e.target.value)}
                      >
                        <option value="">选择证据</option>
                        {work.evidence
                          .filter(
                            (e) =>
                              e.id !== work.evidence[0].id &&
                              e.id !== latestEvidence?.id,
                          )
                          .map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.id.startsWith('replay-')
                                ? '行为回放'
                                : e.id.startsWith('detail-')
                                  ? '局部检查'
                                  : '追加观察'}{' '}
                              · {e.id} · v{e.revision}
                            </option>
                          ))}
                      </select>
                    </label>
                    {detail && (
                      <EvidenceImage
                        workId={work.id}
                        evidence={work.evidence.find((e) => e.id === detail)}
                        title="所选证据"
                      />
                    )}
                  </section>
                )}
                {work.reviews.map((item) => (
                  <details key={item.id} open={item === review}>
                    <summary>
                      复核 · 候选 v{item.candidateRevision} ·{' '}
                      {item.status === 'passed'
                        ? '通过'
                        : item.status === 'failed'
                          ? '有明确问题'
                          : item.status === 'needs_human'
                            ? '待裁决'
                            : '检查中'}
                    </summary>
                    <p>
                      结构与行为断言：
                      {item.technical.passed ? '通过' : '未通过'}
                      。尚未在游戏引擎中验证玩家通行和物理。
                    </p>
                    {item.technical.checks.map((check) => (
                      <p key={check.id}>
                        {check.passed ? '✓' : '✕'} {check.description}
                      </p>
                    ))}
                    {Object.entries(item.opinions).map(([role, opinion]) => (
                      <div key={role}>
                        <h4>{roleNames[role as Role]}</h4>
                        <p>{opinion.summary}</p>
                        {opinion.findings.map((finding) => (
                          <p key={finding.criterionId}>
                            <strong>
                              {findingNames[finding.classification]}
                            </strong>{' '}
                            · {finding.explanation}
                            {finding.suggestion &&
                              ` 建议：${finding.suggestion}`}
                          </p>
                        ))}
                      </div>
                    ))}
                    {item.dispute && (
                      <div>
                        <h4>追加裁决（原意见保留）</h4>
                        <p>{item.dispute.summary}</p>
                        {item.dispute.findings.map((finding) => (
                          <p key={finding.criterionId}>
                            {findingNames[finding.classification]} ·{' '}
                            {finding.explanation}
                          </p>
                        ))}
                      </div>
                    )}
                  </details>
                ))}
                <details>
                  <summary>专家讨论（{work.messages.length}）</summary>
                  {work.messages.map((entry, index) => (
                    <article key={entry.key || index}>
                      <h4>
                        {entry.role === 'validator'
                          ? '本地方案校验'
                          : roleNames[entry.role]}{' '}
                        · 第 {entry.round + 1} 轮
                      </h4>
                      {entry.question && (
                        <p className="sw-muted">{entry.question}</p>
                      )}
                      <p>{entry.response.summary}</p>
                      {entry.response.question && (
                        <p>{entry.response.question}</p>
                      )}
                    </article>
                  ))}
                </details>
                <details>
                  <summary>调用回执（{work.calls.length}）</summary>
                  <ul>
                    {work.calls.map((call) => (
                      <li key={call.id}>
                        {roleNames[call.role]} · {call.profile.provider} /{' '}
                        {call.profile.model} · {call.status}
                        {call.receipt?.usage && (
                          <span>
                            {' '}
                            ·{' '}
                            {Object.entries(call.receipt.usage)
                              .map(([key, value]) => `${key}: ${value}`)
                              .join('，')}
                          </span>
                        )}
                        {call.receipt?.responseId && (
                          <small> · {call.receipt.responseId}</small>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
                {canAdopt && (
                  <section className="sw-adopt">
                    <h3>采用已检查的候选</h3>
                    {review!.requiresHuman.map((id) => (
                      <label className="sw-check" key={id}>
                        <input
                          type="checkbox"
                          checked={acknowledged.includes(id)}
                          onChange={() =>
                            setAcknowledged(toggle(acknowledged, id))
                          }
                        />
                        已查看证据并确认：
                        {[
                          ...plan!.plan.visualCriteria,
                          ...plan!.plan.acceptance,
                        ].find((c) => c.id === id)?.description || id}
                      </label>
                    ))}
                    {review!.requiresHuman.length > 0 && (
                      <label>
                        确认结论
                        <textarea
                          rows={2}
                          value={reviewNote}
                          onChange={(e) => setReviewNote(e.target.value)}
                        />
                      </label>
                    )}
                    <Button
                      disabled={
                        disabled ||
                        review!.requiresHuman.some(
                          (id) => !acknowledged.includes(id),
                        ) ||
                        (review!.requiresHuman.length > 0 &&
                          reviewNote.trim().length < 4)
                      }
                      onClick={() => {
                        try {
                          void run({
                            operation: 'adopt',
                            input: adoptionInput(
                              work,
                              acknowledged,
                              reviewNote,
                            ),
                          });
                        } catch (cause) {
                          setError(message(cause));
                        }
                      }}
                    >
                      采用到原场景
                    </Button>
                    <p>原场景发生修改时会停止采用并提示版本冲突。</p>
                  </section>
                )}
                {canReviseWorkflow(work) && (
                  <details>
                    <summary>补充要求 / 请求局部修订</summary>
                    <p>保持原目标、保护范围和预算，仅调整已有方案。</p>
                    <textarea
                      aria-label="补充要求"
                      rows={3}
                      value={clarification}
                      onChange={(e) => setClarification(e.target.value)}
                    />
                    <Button
                      disabled={disabled || clarification.trim().length < 4}
                      onClick={() => act('revise', { clarification })}
                    >
                      提交补充要求
                    </Button>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
