'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { motionRequest, motionUrl, type MotionWork } from './open-motion-model';
import { MotionStructureHistory, StructureHistoryImage, temporalHistoryImage, type StructureHistoryEntry } from './motion-structure-history';
import './motion-structure.css';

type Point = { x: number; y: number; label: 0 | 1 };
type Region = {
  id: string;
  state: string;
  area: number;
  centroid: number[] | null;
  axis_degrees_mod_180: number | null;
  sha256: string;
};
type Anchor = {
  id: string;
  part_id: string;
  name: string;
  x: number | null;
  y: number | null;
  state: string;
};
type Temporal = {
  id: string;
  state: string;
  revision: number;
  source_current: boolean;
  pending: boolean;
  error?: string;
  supports_review?: boolean;
  calls: { state: string }[];
  history: StructureHistoryEntry[];
  structured_review?: {
    state: string;
    current: boolean;
    new_calls?: number;
    error?: string;
    result?: {
      summary: string;
      checks?: {
        dimension: string;
        status: string;
        frames: number[];
        evidence: string;
      }[];
    };
  } | null;
  document: null | {
    token: string;
    revision: number;
    width: number;
    height: number;
    confirmation: { note: string } | null;
    manual_corrections: unknown[];
    compute?: { device?: string; seconds?: number; mps_fallback_enabled?: boolean };
    parts: { id: string; name: string }[];
    frames: { frame_index: number; source_sha256: string; parts: Region[] }[];
    observations: {
      frames: {
        frame_index: number;
        structure: {
          anchors: Anchor[];
          relations: { id: string; state: string; evidence: string }[];
        };
      }[];
      issues: { frame_index: number; message: string }[];
    };
    cues: { cues: { frame_index: number; parts: string[]; reason: string }[] };
  };
};
type Reference = {
  analysis: null | {
    id: string;
    source_current: boolean;
    document: null | {
      token: string;
      confirmation: unknown;
      issues: unknown[];
    };
  };
};
type Draft = {
  token: string;
  frame: number;
  part: string;
  state: 'visible' | 'unknown' | 'occluded';
  points: Point[];
};
const pending = new Set(['queued', 'observing', 'tracking']);
const states: Record<string, string> = {
  queued: '等待分析',
  observing: '核对关键帧中',
  tracking: '本地追踪中',
  ready: '结构已保存',
  failed: '分析未完成',
  unknown: '核验结果待确认',
};
const visibility: Record<string, string> = {
  estimated: '估计区域，需看原图',
  visible: '可见',
  inferred: '推断',
  unknown: '未知',
  occluded: '遮挡',
};

export function MotionTemporalStructure({
  work,
  candidate,
  stage,
  frame,
  frameSha,
  playing,
  readOnly,
  onFrame,
  onStop,
  children,
}: {
  work: MotionWork;
  candidate: number;
  stage?: number;
  frame: number;
  frameSha: string;
  playing: boolean;
  readOnly: boolean;
  onFrame: (frame: number) => void;
  onStop: () => void;
  children: ReactNode;
}) {
  const [analysis, setAnalysis] = useState<Temporal | null>(null),
    [opened, setOpened] = useState(false),
    [overlay, setOverlay] = useState(false);
  const [part, setPart] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [semantic, setSemantic] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null),
    [pointLabel, setPointLabel] = useState<0 | 1>(1),
    [note, setNote] = useState('');
  const draftOwner = useRef('');
  const applyAnalysis = useCallback((value: Temporal | null) => {
    setAnalysis(value);
    const owner = value ? `forge-temporal-draft:${value.id}` : '';
    if (draftOwner.current === owner) return;
    draftOwner.current = owner;
    try {
      const saved = owner ? localStorage.getItem(owner) : null;
      setDraft(saved ? (JSON.parse(saved) as Draft) : null);
    } catch {
      setDraft(null);
    }
  }, []);
  const route = `open-motion/${work.id}/temporal`;
  const queryStage = stage === undefined ? '' : String(stage);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await motionRequest<{ analysis: Temporal | null }>(
        route,
        undefined,
        {
          candidate: String(candidate),
          revision: String(work.revision),
          ...(queryStage ? { stage: queryStage } : {}),
        },
        signal,
      );
      if (!signal?.aborted) applyAnalysis(result.analysis);
    },
    [route, candidate, work.revision, queryStage, applyAnalysis],
  );
  useEffect(() => {
    const abort = new AbortController();
    void Promise.resolve()
      .then(() => load(abort.signal))
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [load, work.job?.revision]);
  const running =
    !!analysis &&
    (pending.has(analysis.state) ||
      ['queued', 'running'].includes(analysis.structured_review?.state || ''));
  useEffect(() => {
    if (!running) return;
    const abort = new AbortController();
    const timer = setInterval(
      () =>
        void load(abort.signal).catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        }),
      2000,
    );
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [running, load]);
  const doc = analysis?.document;
  const selected = doc?.parts.some((p) => p.id === part)
    ? part
    : doc?.parts[0]?.id || '';
  const region = doc?.frames[frame]?.parts.find((p) => p.id === selected);
  const matched =
    !!analysis?.source_current &&
    doc?.frames[frame]?.source_sha256 === frameSha;
  const key = analysis ? `forge-temporal-draft:${analysis.id}` : '';
  useEffect(() => {
    if (!key || draftOwner.current !== key) return;
    try {
      if (draft) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
    } catch {
      /* visible draft remains in memory */
    }
  }, [key, draft]);
  async function create(useSemantic = semantic) {
    setBusy(true);
    setError('');
    try {
      const ref = await motionRequest<Reference>(
        `open-motion/references/${work.spec.character_id}/structure`,
      );
      if (
        !ref.analysis?.source_current ||
        !ref.analysis.document?.confirmation ||
        ref.analysis.document.issues.length
      )
        throw new Error(
          '请先在准备阶段核对并确认该角色的参考结构；未知部位可以保留。',
        );
      const value = await motionRequest<Temporal>(route, {
        expected_revision: work.revision,
        candidate_index: candidate,
        stage_index: stage ?? null,
        structure_id: ref.analysis.id,
        structure_token: ref.analysis.document.token,
        request_key: crypto.randomUUID(),
        authorized: useSemantic,
        use_semantic: useSemantic,
      });
      applyAnalysis(value);
      setOverlay(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutate(payload: Record<string, unknown>, requestKey = crypto.randomUUID()) {
    if (!analysis || !doc || busy) return false;
    setBusy(true);
    setError('');
    try {
      const value = await motionRequest<Temporal>(
        `open-motion/temporal-structures/${analysis.id}/corrections`,
        {
          expected_revision: analysis.revision,
          token: doc.token,
          request_key: requestKey,
          ...payload,
        },
      );
      applyAnalysis(value);
      setDraft(null);
      setNote('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    if (!analysis || !doc) return;
    setBusy(true);
    setError('');
    try {
      applyAnalysis(
        await motionRequest<Temporal>(
          `open-motion/temporal-structures/${analysis.id}/review`,
          { token: doc.token, authorized: true },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const editable = !readOnly && !running && !busy && matched;
  const draftCurrent =
    !!draft &&
    draft.token === doc?.token &&
    draft.frame === frame &&
    draft.part === selected;
  const maskUrl =
    analysis && doc && region
      ? motionUrl(
          `open-motion/temporal-structures/${analysis.id}/frames/${frame}/parts/${selected}`,
          { revision: String(doc.revision), v: region.sha256 },
        )
      : '';
  const anchors =
    doc?.observations.frames
      .find((f) => f.frame_index === frame)
      ?.structure.anchors.filter((a) => a.part_id === selected) || [];
  return (
    <>
      <div className="motion-canvas motion-large motion-structure">
        <div
          className={`structure-image ${draftCurrent ? 'structure-editing' : ''}`}
          onPointerDown={(event) => {
            if (
              !draftCurrent ||
              !editable ||
              !doc ||
              !draft ||
              draft.state !== 'visible'
            )
              return;
            onStop();
            const box = event.currentTarget.getBoundingClientRect();
            const x = Math.floor(
                ((event.clientX - box.left) / box.width) * doc.width,
              ),
              y = Math.floor(
                ((event.clientY - box.top) / box.height) * doc.height,
              );
            if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
            setDraft({
              ...draft,
              points: [...draft.points.slice(-11), { x, y, label: pointLabel }],
            });
          }}
        >
          {children}
          {overlay &&
            matched &&
            region &&
            !['unknown', 'occluded'].includes(region.state) &&
            maskUrl && (
              <div
                className="structure-mask"
                style={{ maskImage: `url("${maskUrl}")` }}
              />
            )}
          {doc && overlay && matched && (
            <svg viewBox={`0 0 ${doc.width} ${doc.height}`} aria-hidden="true">
              {anchors
                .filter((a) => a.x !== null && a.y !== null)
                .map((a) => (
                  <circle
                    key={a.id}
                    cx={a.x!}
                    cy={a.y!}
                    r={1.2}
                    fill={a.state === 'visible' ? '#5ce0ff' : '#ffd36b'}
                  />
                ))}
              {draftCurrent &&
                draft?.points.map((p, i) => (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={1.2}
                    fill={p.label ? '#77f298' : '#ff6c84'}
                  />
                ))}
            </svg>
          )}
        </div>
      </div>
      <details
        className="structure-details"
        open={opened}
        onToggle={(event) => setOpened(event.currentTarget.open)}
      >
        <summary>
          结构观察
          {analysis
            ? ` · ${states[analysis.state] || analysis.state}`
            : '（可选）'}
        </summary>
        <p>
          查看部件在实际帧中的变化。结构是辅助证据，不修改图片，不自动采用或重新生成。
        </p>
        {analysis && !analysis.source_current && (
          <p className="motion-danger">
            原动画或参考结构已改变；旧观察仅供查看，不能用于当前版本。
          </p>
        )}
        {doc && (
          <>
            {doc.compute?.device && (
              <p>
                追踪设备：{doc.compute.device.toUpperCase()}
                {doc.compute.seconds != null ? ` · ${doc.compute.seconds.toFixed(1)} 秒` : ''}
                {doc.compute.mps_fallback_enabled ? ' · 已允许部分算子使用 CPU' : ''}
              </p>
            )}
            <div className="structure-actions">
              <label>
                <input
                  type="checkbox"
                  checked={overlay}
                  onChange={(e) => setOverlay(e.target.checked)}
                />
                显示结构叠加
              </label>
              <label>
                查看部件
                <select
                  value={selected}
                  onChange={(e) => setPart(e.target.value)}
                >
                  {doc.parts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p>
              第 {frame + 1} 帧 · {visibility[region?.state || 'unknown']}
              。区域中心与长轴不等于关节、握点或身体朝向。
            </p>
            {!!anchors.length && (
              <p>
                {anchors
                  .map((a) => `${a.name}：${visibility[a.state] || a.state}`)
                  .join('；')}
              </p>
            )}
            <details>
              <summary>查看追踪依据与不确定项</summary>
              <p>
                关键帧语义核验 {analysis?.calls.length || 0} 次；当前结构版本{' '}
                {doc.revision}。原始动画与 FPS 保持不变。
              </p>
              {doc.observations.issues.map((item, i) => (
                <p key={i}>
                  第 {item.frame_index + 1} 帧：{item.message}
                </p>
              ))}
              {Array.from(new Set(doc.cues.cues.map((c) => c.frame_index))).map(
                (index) => (
                  <p key={index}>
                    <button
                      onClick={() => {
                        onStop();
                        onFrame(index);
                      }}
                    >
                      查看第 {index + 1} 帧
                    </button>{' '}
                    区域扩大、重叠或可见性待核对；不是自动缺陷结论。
                  </p>
                ),
              )}
              {analysis?.calls.length === 0 &&
                !doc.manual_corrections.length && (
                  <>
                    <p>
                      可追加最多一次语义核验，重新定位关键帧。原本地追踪保留，动画不改变。
                    </p>
                    <button
                      disabled={!editable || !!draft}
                      onClick={() => void create(true)}
                    >
                      核对关键帧并更新追踪
                    </button>
                  </>
                )}
            </details>
            <details>
              <summary>纠正当前帧的观察</summary>
              <p>
                只纠正结构记录。保留点放在部件上，排除点放在误收的部位上；看不清时标记未知。
              </p>
              {!draft && (
                <button
                  disabled={!editable || playing}
                  onClick={() => {
                    onStop();
                    setOverlay(true);
                    setDraft({
                      token: doc.token,
                      frame,
                      part: selected,
                      state: 'visible',
                      points: [],
                    });
                  }}
                >
                  开始纠正此部件
                </button>
              )}
              {draft && (
                <>
                  {!draftCurrent && (
                    <p className="motion-notice">
                      草稿绑定第 {draft.frame + 1}{' '}
                      帧及保存时的结构版本，未套用到当前帧。
                      <button
                        onClick={() => {
                          onStop();
                          onFrame(draft.frame);
                          setPart(draft.part);
                        }}
                      >
                        返回草稿帧
                      </button>
                    </p>
                  )}
                  <label>
                    可见性
                    <select
                      value={draft.state}
                      disabled={!draftCurrent || !editable}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          state: e.target.value as Draft['state'],
                          points: [],
                        })
                      }
                    >
                      <option value="visible">可见，点击图像放置提示点</option>
                      <option value="unknown">身份或位置未知</option>
                      <option value="occluded">已确认被遮挡</option>
                    </select>
                  </label>
                  {draft.state === 'visible' && (
                    <label>
                      点的作用
                      <select
                        value={pointLabel}
                        onChange={(e) =>
                          setPointLabel(Number(e.target.value) as 0 | 1)
                        }
                      >
                        <option value={1}>保留部件</option>
                        <option value={0}>排除误收部位</option>
                      </select>
                    </label>
                  )}
                  <div className="structure-actions">
                    <button
                      disabled={
                        !editable ||
                        !draftCurrent ||
                        (draft.state === 'visible' &&
                          !draft.points.some((p) => p.label === 1))
                      }
                      onClick={() =>
                        void mutate({
                          correction: {
                            frame_index: draft.frame,
                            part_id: draft.part,
                            state: draft.state,
                            points: draft.points,
                          },
                          note: `实际第 ${draft.frame + 1} 帧：纠正 ${draft.part} 的可见区域或不确定状态`,
                        })
                      }
                    >
                      保存观察纠正
                    </button>
                    <button onClick={() => setDraft(null)}>放弃草稿</button>
                  </div>
                </>
              )}
            </details>
            <details>
              <summary>确认或恢复结构版本</summary>
              <label>
                实际核对说明
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="记录查看到的部件与仍不确定的地方"
                  maxLength={1000}
                />
              </label>
              <div className="structure-actions">
                <button
                  disabled={!editable || note.trim().length < 4 || !!draft}
                  onClick={() => void mutate({ confirm: true, note })}
                >
                  确认这些观察
                </button>
              </div>
              {doc.confirmation && (
                <p>已保存观察确认。它不代表动画审批或导出。</p>
              )}
              {analysis && <MotionStructureHistory current={analysis} route={`open-motion/temporal-structures/${analysis.id}`} disabled={!editable} dirty={Boolean(draft)} onPreview={onStop}
                onRestore={(request) => mutate(request, request.request_key)}
                onRefresh={async () => { try { await load(); } catch (e) { setError((e as Error).message); } }}>
                {(historical) => <TemporalHistoryPreview key={`${historical.id}:${historical.document?.revision}`} analysis={historical} initialFrame={frame} />}
              </MotionStructureHistory>}
            </details>
            <details>
              <summary>用结构辅助专家复核</summary>
              <p>
                复用原有两次基础检查，追加两位独立专家及最多一次争议复核，共最多
                3 次视觉请求。只保存意见，是否采用仍看实际动画。
              </p>
              {analysis?.supports_review === false && (
                <p>
                  此旧作品没有已保存的视觉基线；可使用结构观察与纠正，不自动补跑收费检查。
                </p>
              )}
              <button
                disabled={
                  !editable ||
                  !doc.confirmation ||
                  !!draft ||
                  analysis?.supports_review === false ||
                  !!analysis?.structured_review?.current
                }
                onClick={() => void review()}
              >
                开始结构辅助复核
              </button>
              {analysis?.structured_review && (
                <>
                  <p>
                    {analysis.structured_review.current
                      ? `当前复核：${analysis.structured_review.state} · 新增 ${analysis.structured_review.new_calls ?? 0} / 3 次`
                      : '结构已经更新，以下旧意见仅供追溯。'}
                  </p>
                  <p>
                    {analysis.structured_review.result?.summary ||
                      analysis.structured_review.error}
                  </p>
                  {analysis.structured_review.result?.checks?.map((c) => (
                    <p key={c.dimension}>
                      <b>
                        {
                          (
                            {
                              completeness: '动作完整性',
                              equipment: '外观与装备',
                              rhythm: '节奏',
                            } as Record<string, string>
                          )[c.dimension]
                        }
                      </b>{' '}
                      · 第 {c.frames.join('、')} 帧：{c.evidence}
                    </p>
                  ))}
                </>
              )}
            </details>
          </>
        )}
        {(!analysis || ['failed', 'unknown'].includes(analysis.state)) && (
          <>
            <label>
              <input
                type="checkbox"
                checked={semantic}
                onChange={(e) => setSemantic(e.target.checked)}
                disabled={busy || readOnly}
              />
              同时核对关键帧，最多 1 次结构模型请求
            </label>
            <p>
              {semantic
                ? '使用模型辨认关键帧，再本地追踪。未知请求不会自动重发。'
                : '仅本地追踪，不调用外部模型；大幅动作和特效可能造成身份漂移。'}
            </p>
            <button disabled={busy || readOnly} onClick={() => void create()}>
              分析动作结构
            </button>
          </>
        )}
        {analysis?.error && <p className="motion-danger">{analysis.error}</p>}
        {error && (
          <p role="alert" className="motion-danger">
            {error}
          </p>
        )}
      </details>
    </>
  );
}

function TemporalHistoryPreview({ analysis, initialFrame }: { analysis: Temporal; initialFrame: number }) {
  const doc = analysis.document;
  const [frame, setFrame] = useState(initialFrame);
  if (!doc) return null;
  const index = Math.min(frame, doc.frames.length - 1);
  const route = `open-motion/temporal-structures/${analysis.id}`;
  const observation = doc.observations.frames.find((entry) => entry.frame_index === index);
  return <>
    <p>历史结构第 {index + 1} / {doc.frames.length} 帧 · {doc.manual_corrections.length} 条观察纠正</p>
    <input aria-label="历史时序结构预览帧" type="range" min={0} max={doc.frames.length - 1} value={index} onChange={(event) => setFrame(Number(event.target.value))} />
    <StructureHistoryImage image={motionUrl(`${route}/frames/${index}`)} width={doc.width} height={doc.height} caption={`时序结构版本 ${doc.revision} 第 ${index + 1} 帧`}
      parts={doc.parts.map((part) => {
        const region = doc.frames[index]?.parts.find((entry) => entry.id === part.id);
        return { id: part.id, name: `${part.name} · ${visibility[region?.state || 'unknown'] || '未知'}`, maskUrl: region && !['unknown', 'occluded'].includes(region.state) ? temporalHistoryImage(route, index, doc.revision, part.id, region.sha256) : undefined };
      })} anchors={observation?.structure.anchors || []} />
    {!!observation?.structure.relations.length && <ul>{observation.structure.relations.map((relation) => <li key={relation.id}>{relation.id} · {relation.state}：{relation.evidence}</li>)}</ul>}
    {doc.observations.issues.filter((issue) => issue.frame_index === index).map((issue, key) => <p key={key}>{issue.message}</p>)}
  </>;
}
