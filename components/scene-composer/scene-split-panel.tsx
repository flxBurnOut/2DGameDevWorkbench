/* oxlint-disable react/react-compiler -- A durable request body and exact candidate revision drive recovery and preview. */
'use client';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Scene } from '@/features/scene-composer/model.mjs';
import type {
  MapSplitConflict,
  MapSplitElement,
  MapSplitMatch,
} from '@/features/scene-composer/map-split.mjs';
import type { SharedDocument } from '@/features/editor-documents/client';
import {
  readWorkspaceDraft,
  saveWorkspaceDraft,
} from '@/lib/workbench/browser-store';
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
  parseSplitSpecDraft,
  requestSceneSplit,
  splitPreviewUrl,
  watchSceneSplit,
} from './scene-split-client.mjs';

type ElementInfo = Omit<MapSplitElement, 'parts'> & {
  parts: Array<Omit<MapSplitElement['parts'][number], 'source' | 'mask'>>;
};
type Candidate = {
  candidateId: string;
  revision: number;
  sourceRevision: number;
  status: string;
  createdAt?: string;
  width?: number;
  height?: number;
  elements?: ElementInfo[];
  conflicts?: MapSplitConflict[];
  specs?: Array<Record<string, unknown>>;
  review?: string;
  warnings?: string[];
  method?: string;
  matches?: MapSplitMatch[];
  explicitMatches?: MapSplitMatch[];
  receipt?: {
    requestId?: string;
    responseId?: string;
    usage?: Record<string, number>;
  };
  usage?: Record<string, number>;
  error?: { message?: string; code?: string };
  adoption?: { revision: number; candidateRevision: number };
  remainderKind?: 'surface' | 'background';
  execution?: { id: string; commandId: string; resultRevision?: number };
  recoveryRequest?: Pending;
};
export type SceneSplitReceipt = {
  documentId: string;
  candidateId: string;
  revision: number;
  currentRevision: number;
  contentHash: string;
};
type Pending = { operation: string; input: Record<string, unknown> };
type Preview = {
  images: Array<{ role: string; data: string; mimeType: string }>;
  width: number;
  height: number;
};
type Crop = { x: number; y: number; width: number; height: number };
const describe = (value: unknown) =>
  value instanceof Error ? value.message : '请求未完成。';
const sourceId = (candidate: Candidate | null, elementId: string) =>
  candidate?.matches?.find((match) => match.oldId === elementId)?.newId ??
  elementId;
const example = (width = 64, height = 64) =>
  JSON.stringify(
    {
      id: `object_${crypto.randomUUID().slice(0, 8)}`,
      name: '新物件',
      kind: 'object',
      parts: [
        {
          id: 'art',
          role: 'art',
          plane: 'back',
          selection: {
            type: 'rect',
            x: 0,
            y: 0,
            width: Math.min(64, width),
            height: Math.min(64, height),
          },
        },
      ],
    },
    null,
    2,
  );

export function SceneSplitPanel({
  document,
  initialMode,
  beforeAdopt,
  onAdopt,
  onClose,
}: {
  document: SharedDocument<Scene>;
  initialMode?: 'auto' | 'local' | 'vision';
  beforeAdopt: () => Promise<void>;
  onAdopt: (receipt: SceneSplitReceipt) => Promise<void>;
  onClose: () => void;
}) {
  const [candidate, setCandidate] = useState<Candidate | null>(null),
    [history, setHistory] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(true),
    working = useRef(false),
    initialized = useRef(false);
  const [pollEpoch, setPollEpoch] = useState(0);
  const selection = useRef({ id: '' });
  const conflictRequest = useRef(0);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState<Pending | null>(null);
  const [elementId, setElementId] = useState(''),
    [partId, setPartId] = useState(''),
    [draft, setDraft] = useState('');
  const [view, setView] = useState<'candidate' | 'element' | 'part' | 'mask'>(
    'candidate',
  );
  const [background, setBackground] = useState<
    'transparent' | 'black' | 'white' | 'magenta'
  >('transparent');
  const [sourceImage, setSourceImage] = useState(''),
    [candidateImage, setCandidateImage] = useState(''),
    [viewedRevision, setViewedRevision] = useState('');
  const [cropText, setCropText] = useState(''),
    [crop, setCrop] = useState<Crop | undefined>(),
    [reviewNote, setReviewNote] = useState('');
  const [resolutions, setResolutions] = useState<
      Record<string, 'current' | 'incoming' | 'delete'>
    >({}),
    [matches, setMatches] = useState('[]');
  const [conflictImages, setConflictImages] = useState<{
    id: string;
    current?: string;
    incoming?: string;
    currentError?: string;
    incomingError?: string;
  } | null>(null);
  const pendingKey = `scene-split-pending:${document.id}`;
  const selectedElement = candidate?.elements?.find(
    (element) => element.id === elementId,
  );
  const ready = candidate?.status === 'ready' && candidate.revision > 0;
  const conflictCount =
    candidate?.conflicts?.filter((conflict) => !conflict.resolution).length ??
    0;
  const adoptedThisVersion = Boolean(
    candidate?.adoption &&
    candidate.adoption.candidateRevision === candidate.revision,
  );
  const bind = () => ({
    documentId: document.id,
    expectedRevision: document.revision,
    candidateId: candidate!.candidateId,
    candidateRevision: candidate!.revision,
  });
  const displayCandidate = (next: Candidate) => {
    const selected =
        next.elements?.find((element) => element.id === elementId) ??
        next.elements?.[0];
    setCandidate(next);
    setElementId(selected?.id ?? '');
    setPartId(selected?.parts[0]?.id ?? '');
    setDraft(
      selected
        ? JSON.stringify(
            next.specs?.filter(
              (spec) => spec.id === sourceId(next, selected.id),
            ) ?? [],
            null,
            2,
          )
        : '',
    );
    setResolutions({});
    setMatches(JSON.stringify(next.explicitMatches ?? [], null, 2));
    setReviewNote('');
    setConflictImages(null);
  };
  const load = async (id: string, revision?: number) => {
    const request = { id };
    selection.current = request;
    setCandidate(null);
    try {
      const result = await requestSceneSplit<{ candidate: Candidate }>('get', {
        documentId: document.id, candidateId: id, candidateRevision: revision, includeSpecs: true,
      });
      if (selection.current === request) displayCandidate(result.candidate);
    } catch (cause) {
      if (selection.current === request) throw cause;
    }
  };
  const list = async () => {
    const result = await requestSceneSplit<{ candidates: Candidate[] }>('get', {
      documentId: document.id,
      limit: 100,
    });
    setHistory(result.candidates);
    return result.candidates;
  };
  const execute = async (
    operation: string,
    fields: Record<string, unknown>,
    replay?: Pending,
  ) => {
    if (working.current) return;
    working.current = true;
    selection.current = { id: candidate?.candidateId ?? '' };
    setBusy(true);
    setError('');
    setMessage('');
    const intent = replay ?? {
      operation,
      input: {
        documentId: document.id,
        expectedRevision: document.revision,
        commandId: `split-${crypto.randomUUID()}`,
        ...fields,
      },
    };
    let awaitingResponse = false;
    try {
      if (intent.operation === 'adopt') await beforeAdopt();
      await saveWorkspaceDraft(pendingKey, intent, []);
      setPending(intent);
      awaitingResponse = true;
      const result = await requestSceneSplit<
        { candidate?: Candidate } & Partial<SceneSplitReceipt>
      >(intent.operation, intent.input);
      awaitingResponse = false;
      if (result.candidate) {
        if (result.candidate.status !== 'running')
          await load(
            result.candidate.candidateId,
            result.candidate.revision || undefined,
          );
        else {
          selection.current = { id: result.candidate.candidateId };
          setCandidate(result.candidate);
        }
      }
      if (intent.operation === 'adopt') {
        if (
          result.documentId !== document.id ||
          !result.contentHash ||
          !result.revision ||
          !result.currentRevision
        )
          throw new Error('采用回执缺少确切场景版本，请恢复原请求。');
        if (
          result.currentRevision === result.revision &&
          document.revision !== result.revision
        )
          await onAdopt(result as SceneSplitReceipt);
        setCandidate((previous) =>
          previous
            ? {
                ...previous,
                adoption: {
                  revision: result.revision!,
                  candidateRevision: intent.input.candidateRevision as number,
                },
              }
            : previous,
        );
        setMessage(
          result.currentRevision === result.revision
            ? '已采用此候选。对象可在场景里独立选择、移动和调整图片。'
            : `候选已采用至场景 v${result.revision}。共享场景已有 v${result.currentRevision}，请返回场景打开最新保存版本。`,
        );
      }
      if (result.candidate?.status === 'running') {
        setPollEpoch((value) => value + 1);
        setMessage(
          '请求已登记，正在处理。关闭面板后可查询同一候选，或恢复原请求。',
        );
      } else {
        await saveWorkspaceDraft(pendingKey, null, []);
        setPending(null);
      }
      await list();
    } catch (cause) {
      const status =
        cause instanceof Error && 'status' in cause ? Number(cause.status) : 0;
      if (awaitingResponse && status >= 400 && status < 500 && status !== 408) {
        await saveWorkspaceDraft(pendingKey, null, []);
        setPending(null);
        setError(`${describe(cause)} 可修正输入或重新打开最新版本后再提交。`);
      } else setError(describe(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const initialize = useEffectEvent(async () => {
    try {
      const original = await readWorkspaceDraft<Pending | null>(pendingKey);
      setPending(original ?? null);
      const rows = await list();
      if (original) {
        setMessage(
          '有尚待确认的原请求。先恢复该请求或查询原候选；恢复沿用相同命令身份。',
        );
        const selected =
          typeof original.input.candidateId === 'string'
            ? original.input.candidateId
            : rows[0]?.candidateId;
        if (selected) await load(selected);
      } else if (initialMode)
        await execute('prepare', {
          mode: initialMode,
          ...(initialMode === 'vision' ? { useSam: true } : {}),
        });
      else if (rows[0]) await load(rows[0].candidateId);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  });
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void initialize();
    }
  }, []);
  const poll = useEffectEvent(async () => {
    if (!candidate) return;
    const request = selection.current;
    if (working.current || request.id !== candidate.candidateId) return 'running';
    const result = await requestSceneSplit<{ candidate: Candidate }>('get', {
      documentId: document.id,
      candidateId: candidate.candidateId,
      includeSpecs: true,
    });
    if (working.current || request !== selection.current) return 'running';
    if (result.candidate.status === 'ready')
      displayCandidate(result.candidate);
    else setCandidate(result.candidate);
    if (
      result.candidate.status !== 'running' &&
      pending?.input.commandId === result.candidate.execution?.commandId
    ) {
      await saveWorkspaceDraft(pendingKey, null, []);
      setPending(null);
    }
    setError('');
    return result.candidate.status;
  });
  const pollError = useEffectEvent((cause: unknown, stopped: boolean) => {
    setError(
      `${describe(cause)} ${stopped ? '连续查询失败，请恢复原请求查询结果。' : '正在重试状态查询。'}`,
    );
  });
  useEffect(() => {
    if (candidate?.status !== 'running') return;
    return watchSceneSplit(
      () => poll(),
      (cause, stopped) => pollError(cause, stopped),
    );
  }, [candidate?.candidateId, candidate?.status, pollEpoch]);
  useEffect(() => {
    if (
      !candidate ||
      candidate.status !== 'ready' ||
      !candidate.revision ||
      (view !== 'candidate' && !elementId)
    )
      return;
    let alive = true;
    const common = {
      documentId: document.id,
      candidateId: candidate.candidateId,
      candidateRevision: candidate.revision,
      background,
      crop,
      maxEdge: 1536,
    };
    const identity = `${candidate.candidateId}:${candidate.revision}`;
    setViewedRevision('');
    void Promise.all([
      requestSceneSplit<Preview>('inspect', { ...common, view: 'source' }),
      requestSceneSplit<Preview>('inspect', {
        ...common,
        view,
        elementId: view === 'candidate' ? undefined : elementId,
        partId: view === 'part' || view === 'mask' ? partId : undefined,
      }),
    ])
      .then(([source, proposed]) => {
        if (!alive) return;
        setSourceImage(splitPreviewUrl(source.images[0]));
        setCandidateImage(splitPreviewUrl(proposed.images[0]));
        setViewedRevision(identity);
      })
      .catch((cause) => {
        if (alive) setError(describe(cause));
      });
    return () => {
      alive = false;
    };
  }, [document.id, candidate, view, elementId, partId, background, crop]);
  const select = (id: string) => {
    const element = candidate?.elements?.find((item) => item.id === id);
    setElementId(id);
    setPartId(element?.parts[0]?.id ?? '');
    setDraft(
      JSON.stringify(
        candidate?.specs?.filter(
          (spec) => spec.id === sourceId(candidate, id),
        ) ?? [],
        null,
        2,
      ),
    );
  };
  const showConflict = async (id: string, incomingId?: string) => {
    if (!candidate) return;
    const request = selection.current;
    const serial = ++conflictRequest.current;
    const read = async (side: 'current' | 'incoming') => {
      try {
        const result = await requestSceneSplit<Preview>('inspect', {
          documentId: document.id,
          candidateId: candidate.candidateId,
          candidateRevision: candidate.revision,
          view: 'conflict',
          conflictId: id,
          side,
          elementId: side === 'incoming' ? incomingId : undefined,
          background,
          maxEdge: 1024,
        });
        return {
          side,
          url: result.images.length
            ? splitPreviewUrl(result.images[0])
            : undefined,
        };
      } catch (cause) {
        return { side, error: describe(cause) };
      }
    };
    const [current, incoming] = await Promise.all([
      read('current'),
      read('incoming'),
    ]);
    if (selection.current !== request || serial !== conflictRequest.current) return;
    setConflictImages({
      id,
      current: current.url,
      incoming: incoming.url,
      currentError: current.error,
      incomingError: incoming.error,
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sc-split-modal">
        <DialogHeader>
          <DialogTitle>地图整图分层</DialogTitle>
          <DialogDescription>
            把这份场景的地图拆成背景、地表和独立物件。粗稿保留核验状态，移走物件后原位置露出透明洞。
          </DialogDescription>
        </DialogHeader>
        <div className="sc-actions">
          <Button
            size="sm"
            disabled={busy || !!pending}
            onClick={() => void execute('prepare', { mode: 'auto' })}
          >
            自动粗分（本地 SAM 优先）
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !!pending}
            onClick={() => void execute('prepare', { mode: 'local' })}
          >
            纯像素粗分
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !!pending}
            onClick={() =>
              void execute('prepare', { mode: 'vision', useSam: true })
            }
          >
            视觉定位 + 本地 SAM（1 次视觉调用）
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void list().catch((cause) => setError(describe(cause)))
            }
          >
            查询候选记录
          </Button>
          {(pending || candidate?.recoveryRequest) && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                const original = pending ?? candidate?.recoveryRequest;
                if (original) void execute(original.operation, {}, original);
              }}
            >
              恢复上次请求
            </Button>
          )}
          {history.length > 0 && (
            <label className="sc-field">
              候选记录
              <select
                aria-label="分层候选记录"
                value={candidate?.candidateId ?? ''}
                disabled={busy}
                onChange={(event) =>
                  void load(event.target.value).catch((cause) =>
                    setError(describe(cause)),
                  )
                }
              >
                <option value="" disabled>
                  选择候选
                </option>
                {history.map((row) => (
                  <option key={row.candidateId} value={row.candidateId}>
                    {row.candidateId.slice(-10)} · v{row.revision} ·{' '}
                    {row.status}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {error && (
          <p className="sc-error" role="alert">
            {error}
          </p>
        )}
        {message && <output>{message}</output>}
        {candidate && (
          <p className="sc-note">
            候选 {candidate.candidateId} · v{candidate.revision} · 场景 v
            {candidate.sourceRevision} · {candidate.status} ·{' '}
            {candidate.review === 'reviewed'
              ? '已记录核验'
              : '未经核验，建议用 Agent 检查漏分、边缘和前后关系'}
          </p>
        )}
        {candidate?.error && (
          <p className="sc-error" role="alert">
            {candidate.error.message}（{candidate.error.code}）
          </p>
        )}
        {candidate?.warnings?.map((warning, index) => (
          <p className="sc-note" key={index}>
            {warning}
          </p>
        ))}
        {ready && (
          <>
            <div className="sc-split-layout">
              <div className="sc-split-visuals">
                <div className="sc-actions">
                  <label className="sc-field">
                    查看
                    <select
                      aria-label="分层预览内容"
                      value={view}
                      onChange={(event) =>
                        setView(event.target.value as typeof view)
                      }
                    >
                      <option value="candidate">整幅候选</option>
                      <option value="element">选中物件</option>
                      <option value="part">选中子片</option>
                      <option value="mask">像素归属蒙版</option>
                    </select>
                  </label>
                  <label className="sc-field">
                    检查底色
                    <select
                      aria-label="分层检查底色"
                      value={background}
                      onChange={(event) =>
                        setBackground(event.target.value as typeof background)
                      }
                    >
                      <option value="transparent">透明棋盘</option>
                      <option value="black">深色</option>
                      <option value="white">浅色</option>
                      <option value="magenta">彩色</option>
                    </select>
                  </label>
                  <label className="sc-field">
                    子片
                    <select
                      aria-label="分层预览子片"
                      value={partId}
                      onChange={(event) => setPartId(event.target.value)}
                    >
                      {selectedElement?.parts.map((part) => (
                        <option key={part.id} value={part.id}>
                          {part.id} · {part.role} · {part.plane}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="sc-split-compare">
                  <figure>
                    <figcaption>冻结地图对照</figcaption>
                    {sourceImage && (
                      <svg viewBox="0 0 1 1" aria-label="分层源地图像素对照">
                        <image
                          href={sourceImage}
                          width="1"
                          height="1"
                          preserveAspectRatio="xMidYMid meet"
                        />
                      </svg>
                    )}
                  </figure>
                  <figure>
                    <figcaption>
                      候选 {view === 'mask' ? '像素归属' : '可见像素'}
                    </figcaption>
                    {candidateImage && (
                      <svg
                        viewBox="0 0 1 1"
                        aria-label="当前分层候选原像素预览"
                      >
                        <image
                          href={candidateImage}
                          width="1"
                          height="1"
                          preserveAspectRatio="xMidYMid meet"
                        />
                      </svg>
                    )}
                  </figure>
                </div>
                <details>
                  <summary>原像素窗口检查</summary>
                  <label className="sc-field" htmlFor="sc-split-inspect-crop">
                    全图坐标裁片 JSON（留空查看全图）
                    <Input
                      id="sc-split-inspect-crop"
                      value={cropText}
                      placeholder={'{"x":0,"y":0,"width":512,"height":512}'}
                      onChange={(event) => setCropText(event.target.value)}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      try {
                        const value = cropText.trim()
                          ? (JSON.parse(cropText) as Crop)
                          : undefined;
                        if (
                          value &&
                          (![value.x, value.y, value.width, value.height].every(
                            Number.isInteger,
                          ) ||
                            value.x < 0 ||
                            value.y < 0 ||
                            value.width < 1 ||
                            value.height < 1)
                        )
                          throw new Error('裁片需要非负整数位置与正整数尺寸。');
                        setCrop(value);
                        setError('');
                      } catch (cause) {
                        setError(describe(cause));
                      }
                    }}
                  >
                    查看窗口
                  </Button>
                </details>
              </div>
              <div className="sc-split-objects">
                <h3>对象清单 · {candidate.elements?.length ?? 0}</h3>
                <ul aria-label="分层物件候选">
                  {candidate.elements?.map((element) => (
                    <li key={element.id}>
                      <button
                        type="button"
                        className="sc-split-object"
                        aria-pressed={element.id === elementId}
                        onClick={() => select(element.id)}
                      >
                        <strong>{element.name}</strong>
                        <span>
                          {element.kind} · {element.parts.length} 片 · (
                          {element.x}, {element.y})
                        </span>
                        <small>{element.id}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <details open={!!selectedElement} className="sc-split-refine">
              <summary>补拆、合并与修边 · 原像素声明</summary>
              <p className="sc-note">
                同一 ID
                下的多个子片属于一个物件。矩形分配框内全部可见像素；轮廓可用
                polygon、精确 rle、auto 种子或受限 sam 窗口。修边通过 part.edge
                调整，归属蒙版独立保留。
              </p>
              <div className="sc-actions">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setDraft(example(candidate.width, candidate.height))
                  }
                >
                  添加补拆对象
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    !!pending ||
                    !selectedElement ||
                    !candidate.specs?.some(
                      (spec) => spec.id === sourceId(candidate, elementId),
                    )
                  }
                  onClick={() =>
                    void execute('revise', {
                      ...bind(),
                      remove: [sourceId(candidate, elementId)],
                    })
                  }
                >
                  将此对象像素归还余图
                </Button>
              </div>
              <label className="sc-field">
                选中对象声明（对象或数组）
                <textarea
                  aria-label="原像素分层对象JSON"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={12}
                  spellCheck={false}
                />
              </label>
              <Button
                size="sm"
                disabled={busy || !!pending || !draft.trim()}
                onClick={() => {
                  try {
                    void execute('revise', {
                      ...bind(),
                      upsert: parseSplitSpecDraft(draft),
                    });
                  } catch (cause) {
                    setError(describe(cause));
                  }
                }}
              >
                保存这些对象的修订
              </Button>
              <label className="sc-field">
                未分配像素归属
                <select
                  aria-label="未分配像素归属"
                  value={candidate.remainderKind ?? 'surface'}
                  disabled={busy || !!pending}
                  onChange={(event) =>
                    void execute('revise', {
                      ...bind(),
                      remainderKind: event.target.value,
                    })
                  }
                >
                  <option value="surface">地表</option>
                  <option value="background">场景背景</option>
                </select>
              </label>
            </details>
            {!!candidate.matches?.length && (
              <details>
                <summary>已匹配的物件 · {candidate.matches.length}</summary>
                <pre className="sc-split-receipt">
                  {JSON.stringify(candidate.matches, null, 2)}
                </pre>
              </details>
            )}
            {!!candidate.conflicts?.length && (
              <details open className="sc-split-refine">
                <summary>迁移冲突 · {conflictCount} 项待裁决</summary>
                <p className="sc-note">
                  对照源图和候选后逐项选择；未冲突对象已自动合并。
                </p>
                {candidate.conflicts.map((conflict) => (
                  <div key={conflict.id}>
                    <label className="sc-field">
                      {conflict.elementId} · {conflict.field}：{conflict.reason}
                      <select
                        aria-label={`裁决 ${conflict.id}`}
                        value={
                          resolutions[conflict.id] ?? conflict.resolution ?? ''
                        }
                        onChange={(event) =>
                          setResolutions((previous) => ({
                            ...previous,
                            [conflict.id]: event.target.value as
                              | 'current'
                              | 'incoming'
                              | 'delete',
                          }))
                        }
                      >
                        <option value="" disabled>
                          选择本项结果
                        </option>
                        <option value="current">保留当前场景</option>
                        <option value="incoming">采用新版地图</option>
                        <option value="delete">移除此对象</option>
                      </select>
                    </label>
                    {conflict.candidates?.length ? (
                      conflict.candidates.map((id) => (
                        <Button
                          key={id}
                          size="sm"
                          variant="outline"
                          onClick={() => void showConflict(conflict.id, id)}
                        >
                          对照新版 {id}
                        </Button>
                      ))
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void showConflict(conflict.id)}
                      >
                        查看此冲突的当前 / 新版画面
                      </Button>
                    )}
                    {conflictImages?.id === conflict.id && (
                      <div className="sc-split-compare">
                        {(['current', 'incoming'] as const).map((side) => (
                          <figure key={side}>
                            <figcaption>
                              {side === 'current' ? '当前场景' : '新版地图'}
                            </figcaption>
                            {conflictImages[side] ? (
                              <svg
                                viewBox="0 0 1 1"
                                aria-label={`${side === 'current' ? '当前场景' : '新版地图'}冲突画面`}
                              >
                                <image
                                  href={conflictImages[side]}
                                  width="1"
                                  height="1"
                                  preserveAspectRatio="xMidYMid meet"
                                />
                              </svg>
                            ) : (
                              <>
                                <p className="sc-note">
                                  {side === 'current'
                                    ? conflictImages.currentError
                                    : conflictImages.incomingError}
                                </p>
                                <pre className="sc-split-receipt">
                                  {JSON.stringify(conflict[side], null, 2)}
                                </pre>
                              </>
                            )}
                          </figure>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <details>
                  <summary>明确同一物件的匹配关系</summary>
                  <label className="sc-field">
                    匹配数组 [{'{'}oldId,newId{'}'}]
                    <textarea
                      aria-label="迁移匹配JSON"
                      rows={3}
                      value={matches}
                      onChange={(event) => setMatches(event.target.value)}
                    />
                  </label>
                </details>
                <Button
                  size="sm"
                  disabled={busy || !!pending}
                  onClick={() => {
                    try {
                      const entries = JSON.parse(matches);
                      if (!Array.isArray(entries))
                        throw new Error('匹配必须是数组。');
                      void execute('revise', {
                        ...bind(),
                        matches: entries,
                        resolutions: Object.entries(resolutions).map(
                          ([conflictId, choice]) => ({ conflictId, choice }),
                        ),
                      });
                    } catch (cause) {
                      setError(describe(cause));
                    }
                  }}
                >
                  保存匹配与冲突裁决
                </Button>
              </details>
            )}
            <div className="sc-split-review">
              <label className="sc-field" htmlFor="sc-split-review-note">
                此版本的核验记录
                <Input
                  id="sc-split-review-note"
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  maxLength={4000}
                  placeholder="记录已检查的漏分、边缘、深浅彩色底、前后关系或待修项"
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  !!pending ||
                  !elementId ||
                  !reviewNote.trim() ||
                  viewedRevision !==
                    `${candidate.candidateId}:${candidate.revision}`
                }
                onClick={() =>
                  void execute('revise', {
                    ...bind(),
                    review: {
                      elementIds: [elementId],
                      note: reviewNote.trim(),
                    },
                  })
                }
              >
                记录选中对象的核验
              </Button>
              <Button
                disabled={
                  busy || !!pending || conflictCount > 0 || adoptedThisVersion
                }
                onClick={() => void execute('adopt', bind())}
              >
                {adoptedThisVersion
                  ? `此版已采用至场景 v${candidate.adoption!.revision}`
                  : candidate.review === 'reviewed'
                    ? '采用已核验候选'
                    : '采用此未经核验候选'}
              </Button>
            </div>
          </>
        )}
        {(candidate?.receipt || candidate?.usage) && (
          <details>
            <summary>模型与用量回执</summary>
            <pre className="sc-split-receipt">
              {JSON.stringify(
                {
                  method: candidate.method,
                  receipt: candidate.receipt,
                  usage: candidate.usage,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
          返回场景
        </Button>
      </DialogContent>
    </Dialog>
  );
}
