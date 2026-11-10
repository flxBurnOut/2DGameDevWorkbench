'use client';
/* oxlint-disable next/no-img-element -- Pixel evidence must use original image bytes. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motionRequest, motionUrl } from './open-motion-model';
import { MotionStructureHistory, StructureHistoryImage } from './motion-structure-history';
import './motion-structure.css';

type Point = { x: number; y: number; label: 0 | 1 };
type Part = {
  id: string;
  name: string;
  kind: string;
  parent_id: string | null;
  box: number[] | null;
  points: Point[];
  visibility: 'visible' | 'occluded' | 'unknown';
  evidence: string;
};
type Anchor = {
  id: string;
  name: string;
  part_id: string;
  x: number | null;
  y: number | null;
  state: 'visible' | 'inferred' | 'occluded' | 'unknown';
  evidence: string;
};
type Relation = {
  id: string;
  type: string;
  source: string;
  target: string;
  state: 'visible' | 'inferred' | 'unknown';
  evidence: string;
};
type Proposal = {
  summary: string;
  parts: Part[];
  anchors: Anchor[];
  relations: Relation[];
  uncertainties: string[];
};
type Structure = {
  id: string;
  state: string;
  revision: number;
  source_current: boolean;
  pending: boolean;
  error: string | null;
  source: {
    character_id: string;
    sha256: string;
    width: number;
    height: number;
  };
  document: {
    revision: number;
    token: string;
    data: Proposal;
    masks: {
      id: string;
      file: string;
      sha256: string;
      compute?: { device?: string; seconds?: number; mps_fallback_enabled?: boolean };
    }[];
    issues: { id: string; message: string }[];
    confirmation: { note: string } | null;
  } | null;
  history: { revision: number; origin: string; note: string }[];
};
type Runtime = {
  ready: boolean;
  semantic_configured: boolean;
  message: string;
  semantic_model: { model: string };
};
type Lookup = { analysis: Structure | null; runtime: Runtime };
type Saver = (() => void) | null;
const pendingStates = new Set(['queued', 'parsing', 'segmenting']);
const stateNames: Record<string, string> = {
  queued: '等待解析',
  parsing: '识别角色部件中',
  segmenting: '计算可见区域中',
  unknown: '原调用结果待核对',
  failed: '解析未完成',
};

export function MotionStructure({
  characterId,
  disabled,
  registerDraftSaver,
  modelConfiguration,
  generationStructure,
  onGenerationStructure,
}: {
  characterId: string;
  disabled: boolean;
  registerDraftSaver: (save: Saver) => void;
  modelConfiguration: string;
  generationStructure?: {analysis_id:string;token:string}|null;
  onGenerationStructure?: (value:{analysis_id:string;token:string}|null)=>void;
}) {
  const [analysis, setAnalysis] = useState<Structure | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [draft, setDraft] = useState<Proposal | null>(null);
  const [dirty, setDirty] = useState(false);
  const [visible, setVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selection, setSelection] = useState('');
  const [relationSelection, setRelationSelection] = useState('');
  const [mode, setMode] = useState<'point' | 'exclude' | 'box' | 'anchor'>(
    'anchor',
  );
  const [boxStart, setBoxStart] = useState<Point | null>(null);
  const [note, setNote] = useState('手动核对并纠正角色结构，原图保持不变');
  const imageRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const document = analysis?.document;
  const analysisId = analysis?.id;
  const running = pendingStates.has(analysis?.state || '');
  const locked =
    disabled ||
    busy ||
    running ||
    Boolean(analysis && !analysis.source_current);
  const localKey = analysis ? `forge.structure.draft.${analysis.id}` : '';

  useEffect(() => {
    let current = true;
    void motionRequest<Runtime>('open-motion/structure-runtime')
      .then((value) => {
        if (current) setRuntime(value);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [modelConfiguration]);

  const saveLocal = useCallback(() => {
    if (!dirty || !draft || !document || !localKey) return;
    localStorage.setItem(
      localKey,
      JSON.stringify({ token: document.token, data: draft }),
    );
  }, [dirty, draft, document, localKey]);
  useEffect(() => {
    registerDraftSaver(saveLocal);
    void Promise.resolve()
      .then(saveLocal)
      .catch(() => setMessage('结构草稿未能保存，请保留当前页面。'));
    return () => registerDraftSaver(null);
  }, [registerDraftSaver, saveLocal]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      try {
        saveLocal();
      } catch {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [saveLocal]);

  const apply = useCallback((value: Structure | null, recover = false) => {
    setAnalysis(value);
    if (!value?.document) {
      setDraft(null);
      setDirty(false);
      return;
    }
    let data = value.document.data;
    let recovered = false;
    if (recover) {
      try {
        const raw = localStorage.getItem(`forge.structure.draft.${value.id}`);
        if (raw) {
          const saved = JSON.parse(raw) as { token: string; data: Proposal };
          if (
            saved.token === value.document.token &&
            Array.isArray(saved.data.parts) &&
            Array.isArray(saved.data.anchors) &&
            Array.isArray(saved.data.relations)
          ) {
            data = saved.data;
            recovered = true;
          } else
            setMessage(
              '本地结构草稿来自其他版本，已保留；当前显示服务端版本。',
            );
        }
      } catch {
        setMessage('本地结构草稿暂时不可读，已保留服务端结果。');
      }
    }
    setDraft(structuredClone(data));
    setDirty(recovered);
    setSelection((old) =>
      data.parts.some((p) => p.id === old) ||
      data.anchors.some((a) => a.id === old)
        ? old
        : data.parts[0]?.id || '',
    );
    if (recovered) {
      setVisible(true);
      setEditing(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let current = true;
    // The parent keys this component by character ID, preserving draft isolation.
    if (characterId)
      void motionRequest<Lookup>(
        `open-motion/references/${characterId}/structure`,
      )
        .then((value) => {
          if (!current) return;
          setRuntime(value.runtime);
          apply(value.analysis, true);
        })
        .catch((error: Error) => {
          if (current) setMessage(error.message);
        });
    return () => {
      current = false;
      alive.current = false;
    };
  }, [characterId, apply]);
  useEffect(() => {
    if (!analysisId || !running) return;
    let current = true,
      querying = false;
    const timer = window.setInterval(() => {
      if (querying) return;
      querying = true;
      void motionRequest<Structure>(`open-motion/structures/${analysisId}`)
        .then((value) => {
          if (current) {
            apply(value);
            if (value.error) setMessage(value.error);
          }
        })
        .catch((error: Error) => {
          if (current) setMessage(error.message);
        })
        .finally(() => {
          querying = false;
        });
    }, 1800);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [analysisId, running, apply]);

  const request = async (action: () => Promise<Structure>) => {
    if (busy) return false;
    setBusy(true);
    setMessage('');
    try {
      const value = await action();
      if (!alive.current) return false;
      try {
        if (localKey) localStorage.removeItem(localKey);
      } catch {
        setMessage('服务端已接收修改，但浏览器草稿未能清理；旧草稿仍保留。');
      }
      apply(value);
      setVisible(true);
      return true;
    } catch (error) {
      if (alive.current) setMessage((error as Error).message);
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const change = (next: Proposal) => {
    setDraft(next);
    setDirty(true);
  };
  const correct = (extra: Record<string, unknown>, requestKey = crypto.randomUUID()) => {
    if (!analysis || !document) return Promise.resolve(false);
    return request(() =>
      motionRequest<Structure>(
        `open-motion/structures/${analysis.id}/corrections`,
        {
          expected_revision: analysis.revision,
          token: document.token,
          request_key: requestKey,
          note,
          ...extra,
        },
      ),
    );
  };
  const part = draft?.parts.find((p) => p.id === selection);
  const anchor = draft?.anchors.find((p) => p.id === selection);
  const relation =
    draft?.relations.find((r) => r.id === relationSelection) ||
    draft?.relations[0];
  const nodeName = (id: string) =>
    [...(draft?.parts || []), ...(draft?.anchors || [])].find(
      (n) => n.id === id,
    )?.name || id;
  const editRelation = (value: Partial<Relation>) => {
    if (draft && relation)
      change({
        ...draft,
        relations: draft.relations.map((r) =>
          r.id === relation.id ? { ...r, ...value } : r,
        ),
      });
  };
  const removeSelection = () => {
    if (!draft || (!anchor && (!part || draft.parts.length <= 1))) return;
    const removed = new Set([
      selection,
      ...draft.anchors.filter((a) => a.part_id === selection).map((a) => a.id),
    ]);
    const parts = draft.parts
      .filter((p) => !removed.has(p.id))
      .map((p) =>
        removed.has(p.parent_id || '') ? { ...p, parent_id: null } : p,
      );
    change({
      ...draft,
      parts,
      anchors: draft.anchors.filter((a) => !removed.has(a.id)),
      relations: draft.relations.filter(
        (r) => !removed.has(r.source) && !removed.has(r.target),
      ),
    });
    setSelection(parts[0].id);
    setMode('point');
  };
  const pointAt = (event: React.PointerEvent) => {
    const rect = imageRef.current!.getBoundingClientRect();
    const width = analysis!.source.width,
      height = analysis!.source.height;
    return {
      x: Math.max(
        0,
        Math.min(
          width - 1,
          Math.floor(((event.clientX - rect.left) * width) / rect.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          height - 1,
          Math.floor(((event.clientY - rect.top) * height) / rect.height),
        ),
      ),
      label: 1 as const,
    };
  };
  const place = (event: React.PointerEvent, finish = false) => {
    if (!editing || locked || !draft || !analysis) return;
    event.preventDefault();
    const point = pointAt(event);
    if (mode === 'box' && part) {
      if (!finish) {
        setBoxStart(point);
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      if (!boxStart) return;
      change({
        ...draft,
        parts: draft.parts.map((p) =>
          p.id === selection
            ? {
                ...p,
                box: [
                  Math.min(point.x, boxStart.x),
                  Math.min(point.y, boxStart.y),
                  Math.max(point.x, boxStart.x) + 1,
                  Math.max(point.y, boxStart.y) + 1,
                ],
              }
            : p,
        ),
      });
      setBoxStart(null);
      return;
    }
    if (finish) return;
    if (anchor)
      change({
        ...draft,
        anchors: draft.anchors.map((a) =>
          a.id === selection
            ? {
                ...a,
                x: point.x,
                y: point.y,
                state: 'visible',
                evidence: '用户在原图上指定可见位置',
              }
            : a,
        ),
      });
    else if (part)
      change({
        ...draft,
        parts: draft.parts.map((p) =>
          p.id === selection
            ? {
                ...p,
                points: [
                  ...p.points.slice(-11),
                  { ...point, label: mode === 'exclude' ? 0 : 1 },
                ],
                evidence: '用户在原图上纠正区域提示',
              }
            : p,
        ),
      });
  };
  const mask = analysis && document?.masks.find((m) => m.id === selection);
  const maskUrl = mask
    ? motionUrl(`open-motion/structures/${analysis!.id}/masks/${mask.id}`, {
        revision: String(document!.revision),
      })
    : '';
  const sourceUrl = analysis
    ? motionUrl(`open-motion/structures/${analysis.id}/source`)
    : characterId
      ? motionUrl(`open-motion/references/${characterId}`)
      : '';
  const status = running
    ? stateNames[analysis!.state]
    : document
      ? `${document.data.parts.length} 个部件 · ${document.confirmation ? '已核对' : '待核对'}${document.issues.length ? ` · ${document.issues.length} 处待纠正` : ''}`
      : analysis
        ? stateNames[analysis.state]
        : '尚未解析';
  return (
    <div className="motion-structure">
      <div className="motion-canvas">
        {sourceUrl ? (
          <div
            ref={imageRef}
            className={`structure-image ${editing ? 'structure-editing' : ''}`}
            onPointerDown={(e) => place(e)}
            onPointerUp={(e) => place(e, true)}
          >
            <img src={sourceUrl} alt="所选角色参考图" draggable={false} />
            {visible && maskUrl && (
              <div
                className="structure-mask"
                style={{ maskImage: `url("${maskUrl}")` }}
              />
            )}
            {visible && analysis && draft && (
              <svg
                viewBox={`0 0 ${analysis.source.width} ${analysis.source.height}`}
                aria-label="角色结构叠加"
              >
                {part?.box && (
                  <rect
                    x={part.box[0]}
                    y={part.box[1]}
                    width={part.box[2] - part.box[0]}
                    height={part.box[3] - part.box[1]}
                    fill="none"
                    stroke="#ffd166"
                    strokeWidth=".5"
                  />
                )}
                {draft.anchors
                  .filter((a) => a.x !== null && a.y !== null)
                  .map((a) => (
                    <g key={a.id}>
                      <circle
                        cx={a.x!}
                        cy={a.y!}
                        r={a.id === selection ? 1.6 : 1}
                        fill={a.state === 'inferred' ? '#ffd166' : '#62e9df'}
                      />
                      <title>
                        {a.name} · {a.state === 'inferred' ? '推断' : '可见'}
                      </title>
                    </g>
                  ))}
                {editing &&
                  part?.points.map((p, index) => (
                    <circle
                      key={index}
                      cx={p.x}
                      cy={p.y}
                      r=".9"
                      fill={p.label ? '#62e9df' : '#ff6b85'}
                    />
                  ))}
              </svg>
            )}
          </div>
        ) : (
          <span>选择或上传角色</span>
        )}
      </div>
      {characterId && (
        <>
          <div className="structure-status">
            <small>角色结构 · {status}</small>
            {document && (
              <button
                type="button"
                aria-pressed={visible}
                onClick={() => setVisible(!visible)}
              >
                {visible ? '隐藏结构' : '查看结构'}
              </button>
            )}
          </div>
          {onGenerationStructure && (document?.confirmation || generationStructure) && (
            <label className="motion-checkbox">
              <input type="checkbox" checked={!!generationStructure}
                disabled={locked || (!generationStructure && (!analysis?.source_current || !document?.confirmation || !!document?.issues.length || dirty))}
                onChange={(e)=>onGenerationStructure(e.target.checked && analysis && document ? {analysis_id:analysis.id,token:document.token}:null)} />
              使用已核对的结构辅助本次制作
            </label>
          )}
          {generationStructure && generationStructure.token!==document?.token && (
            <p className="motion-notice">结构版本已改变；请重新选择当前已核对版本后制定方案。</p>
          )}
          {visible && draft && (
            <label>
              查看部件或锚点
              <select
                aria-label="结构选择"
                value={selection}
                onChange={(e) => {
                  setSelection(e.target.value);
                  setMode(
                    draft.anchors.some((a) => a.id === e.target.value)
                      ? 'anchor'
                      : 'point',
                  );
                }}
              >
                <optgroup label="部件">
                  {draft.parts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="锚点">
                  {draft.anchors.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.state === 'unknown'
                        ? ' · 未知'
                        : a.state === 'inferred'
                          ? ' · 推断'
                          : ''}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          )}
          <details className="structure-details" open={editing || undefined}>
            <summary>结构解析与纠正</summary>
            {!analysis && (
              <>
                <p>
                  识别部件与锚点，保留原图。解析调用一次模型；查看和手动纠正不调用模型。
                </p>
                <button
                  disabled={
                    locked || !runtime?.ready || !runtime.semantic_configured
                  }
                  onClick={() =>
                    void request(() =>
                      motionRequest<Structure>('open-motion/structures', {
                        character_id: characterId,
                        request_key: crypto.randomUUID(),
                        authorized: true,
                      }),
                    )
                  }
                >
                  解析角色结构
                </button>
                <small>
                  {runtime?.message}
                  {runtime?.semantic_model &&
                    ` 语义模型：${runtime.semantic_model.model}`}
                </small>
              </>
            )}
            {analysis && !analysis.source_current && (
              <p role="alert">
                原图已变化，此结构保留为历史，不能继续采用或纠正。
              </p>
            )}
            {running && (
              <p>可以离开页面，回来后继续查看同一次解析，不会重复调用。</p>
            )}
            {document && draft && (
              <>
                <p>{document.data.summary}</p>
                {document.masks.some(mask => mask.compute?.device) && (
                  <small>
                    分割设备：{[...new Set(document.masks.map(mask => mask.compute?.device?.toUpperCase()).filter(Boolean))].join(' / ')}
                    {document.masks.some(mask => mask.compute?.mps_fallback_enabled)
                      ? ' · 已允许部分算子使用 CPU' : ''}
                  </small>
                )}
                {document.issues.length > 0 && (
                  <ul>
                    {document.issues.map((issue, i) => (
                      <li key={i}>
                        <button
                          onClick={() => {
                            setSelection(issue.id);
                            setVisible(true);
                            setEditing(true);
                          }}
                        >
                          {draft.parts.find((p) => p.id === issue.id)?.name ||
                            draft.anchors.find((a) => a.id === issue.id)
                              ?.name ||
                            issue.id}
                          ：{issue.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="structure-actions">
                  <button
                    disabled={locked}
                    onClick={() => {
                      setVisible(true);
                      setEditing(!editing);
                    }}
                  >
                    {editing ? '结束定位' : '纠正位置或关系'}
                  </button>
                  {!dirty && !document.confirmation && (
                    <button
                      disabled={locked || Boolean(document.issues.length)}
                      onClick={() => correct({ confirm: true })}
                    >
                      确认已核对结构
                    </button>
                  )}
                </div>
                {editing && (
                  <fieldset className="structure-controls" disabled={locked}>
                    <p>
                      选中部件后在上图定位。青色为保留点，红色为排除点；区域保存后重新计算。锚点不清楚时保留未知。
                    </p>
                    <details>
                      <summary>补充遗漏的部件或锚点</summary>
                      <div className="structure-actions">
                        <button
                          disabled={locked || draft.parts.length >= 24}
                          onClick={() => {
                            const id = `part_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
                            change({
                              ...draft,
                              parts: [
                                ...draft.parts,
                                {
                                  id,
                                  name: '新部件',
                                  kind: 'other',
                                  parent_id: null,
                                  box: null,
                                  points: [],
                                  visibility: 'visible',
                                  evidence: '用户新增，等待定位',
                                },
                              ],
                            });
                            setSelection(id);
                            setMode('box');
                          }}
                        >
                          新增部件
                        </button>
                        <button
                          disabled={locked || draft.anchors.length >= 32}
                          onClick={() => {
                            const id = `anchor_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
                            change({
                              ...draft,
                              anchors: [
                                ...draft.anchors,
                                {
                                  id,
                                  name: '新锚点',
                                  part_id:
                                    part?.id ||
                                    anchor?.part_id ||
                                    draft.parts[0].id,
                                  x: null,
                                  y: null,
                                  state: 'unknown',
                                  evidence: '用户新增，等待定位',
                                },
                              ],
                            });
                            setSelection(id);
                            setMode('anchor');
                          }}
                        >
                          新增锚点
                        </button>
                        <button
                          disabled={
                            locked || Boolean(part && draft.parts.length <= 1)
                          }
                          onClick={removeSelection}
                        >
                          {part ? '移除此部件及其锚点' : '移除此锚点'}
                        </button>
                      </div>
                    </details>
                    {part && (
                      <>
                        <label>
                          部件名称
                          <input
                            value={part.name}
                            maxLength={120}
                            onChange={(e) =>
                              change({
                                ...draft,
                                parts: draft.parts.map((p) =>
                                  p.id === part.id
                                    ? { ...p, name: e.target.value }
                                    : p,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          部件类别
                          <select
                            value={part.kind}
                            onChange={(e) =>
                              change({
                                ...draft,
                                parts: draft.parts.map((p) =>
                                  p.id === part.id
                                    ? { ...p, kind: e.target.value }
                                    : p,
                                ),
                              })
                            }
                          >
                            {Object.entries({
                              body: '身体',
                              head: '头部',
                              limb: '肢体',
                              hand: '手',
                              foot: '脚',
                              equipment: '装备',
                              clothing: '服饰',
                              other: '其他',
                            }).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          区域操作
                          <select
                            aria-label="区域操作"
                            value={mode === 'anchor' ? 'point' : mode}
                            onChange={(e) =>
                              setMode(e.target.value as typeof mode)
                            }
                          >
                            <option value="point">添加保留点</option>
                            <option value="exclude">添加排除点</option>
                            <option value="box">拖动框选区域</option>
                          </select>
                        </label>
                        <button
                          disabled={locked}
                          onClick={() =>
                            change({
                              ...draft,
                              parts: draft.parts.map((p) =>
                                p.id === part.id ? { ...p, points: [] } : p,
                              ),
                            })
                          }
                        >
                          清除该部件提示点
                        </button>
                        <label>
                          可见性
                          <select
                            value={part.visibility}
                            onChange={(e) =>
                              change({
                                ...draft,
                                parts: draft.parts.map((p) =>
                                  p.id === part.id
                                    ? {
                                        ...p,
                                        visibility: e.target
                                          .value as Part['visibility'],
                                      }
                                    : p,
                                ),
                              })
                            }
                          >
                            <option value="visible">可见</option>
                            <option value="occluded">被遮挡</option>
                            <option value="unknown">无法确定</option>
                          </select>
                        </label>
                      </>
                    )}
                    {anchor && (
                      <>
                        <p>点击上图移动“{anchor.name}”。</p>
                        <label>
                          锚点名称
                          <input
                            value={anchor.name}
                            maxLength={120}
                            onChange={(e) =>
                              change({
                                ...draft,
                                anchors: draft.anchors.map((a) =>
                                  a.id === anchor.id
                                    ? { ...a, name: e.target.value }
                                    : a,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          所属部件
                          <select
                            value={anchor.part_id}
                            onChange={(e) =>
                              change({
                                ...draft,
                                anchors: draft.anchors.map((a) =>
                                  a.id === anchor.id
                                    ? { ...a, part_id: e.target.value }
                                    : a,
                                ),
                              })
                            }
                          >
                            {draft.parts.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          观察依据
                          <select
                            value={anchor.state}
                            onChange={(e) => {
                              const state = e.target.value as Anchor['state'];
                              change({
                                ...draft,
                                anchors: draft.anchors.map((a) =>
                                  a.id === anchor.id
                                    ? {
                                        ...a,
                                        state,
                                        x: ['unknown', 'occluded'].includes(
                                          state,
                                        )
                                          ? null
                                          : (a.x ?? 0),
                                        y: ['unknown', 'occluded'].includes(
                                          state,
                                        )
                                          ? null
                                          : (a.y ?? 0),
                                      }
                                    : a,
                                ),
                              });
                            }}
                          >
                            <option value="visible">可见</option>
                            <option value="inferred">推断位置</option>
                            <option value="occluded">被遮挡</option>
                            <option value="unknown">未知</option>
                          </select>
                        </label>
                      </>
                    )}
                    <details>
                      <summary>连接与握持关系</summary>
                      {relation && (
                        <div className="structure-relation">
                          <label>
                            选择关系
                            <select
                              aria-label="选择关系"
                              value={relation.id}
                              onChange={(e) =>
                                setRelationSelection(e.target.value)
                              }
                            >
                              {draft.relations.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {nodeName(r.source)} → {nodeName(r.target)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            关系类型
                            <select
                              aria-label="关系类型"
                              value={relation.type}
                              onChange={(e) =>
                                editRelation({
                                  type: e.target.value,
                                  state: 'inferred',
                                })
                              }
                            >
                              {Object.entries({
                                connected: '连接',
                                holds: '握持',
                                supports: '支撑',
                                part_of: '属于',
                                axis: '轴向',
                                contact: '接触',
                              }).map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            关系起点
                            <select
                              aria-label="关系起点"
                              value={relation.source}
                              onChange={(e) =>
                                editRelation({
                                  source: e.target.value,
                                  state: 'inferred',
                                })
                              }
                            >
                              {[...draft.parts, ...draft.anchors].map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            关系终点
                            <select
                              aria-label="关系终点"
                              value={relation.target}
                              onChange={(e) =>
                                editRelation({
                                  target: e.target.value,
                                  state: 'inferred',
                                })
                              }
                            >
                              {[...draft.parts, ...draft.anchors].map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            关系依据
                            <select
                              aria-label="关系依据"
                              value={relation.state}
                              onChange={(e) =>
                                editRelation({
                                  state: e.target.value as Relation['state'],
                                })
                              }
                            >
                              <option value="visible">可见</option>
                              <option value="inferred">推断</option>
                              <option value="unknown">未知</option>
                            </select>
                          </label>
                          <button
                            onClick={() => {
                              change({
                                ...draft,
                                relations: draft.relations.filter(
                                  (r) => r.id !== relation.id,
                                ),
                              });
                              setRelationSelection('');
                            }}
                          >
                            移除此关系
                          </button>
                        </div>
                      )}
                      <button
                        disabled={
                          locked ||
                          draft.relations.length >= 48 ||
                          draft.parts.length + draft.anchors.length < 2
                        }
                        onClick={() => {
                          const nodes = [...draft.parts, ...draft.anchors];
                          const id = `relation_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
                          change({
                            ...draft,
                            relations: [
                              ...draft.relations,
                              {
                                id,
                                type: 'connected',
                                source: nodes[0].id,
                                target: nodes[1].id,
                                state: 'unknown',
                                evidence: '用户新增，等待核对',
                              },
                            ],
                          });
                          setRelationSelection(id);
                        }}
                      >
                        新增关系
                      </button>
                    </details>
                    <label>
                      纠正说明
                      <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        maxLength={1000}
                      />
                    </label>
                  </fieldset>
                )}
                {dirty && (
                  <div className="structure-actions">
                    <button
                      className="primary"
                      disabled={locked || note.trim().length < 4}
                      onClick={() => correct({ data: draft })}
                    >
                      保存结构纠正
                    </button>
                    <button
                      disabled={locked}
                      onClick={() => {
                        localStorage.removeItem(localKey);
                        apply(analysis);
                      }}
                    >
                      放弃未保存修改
                    </button>
                  </div>
                )}
                <MotionStructureHistory current={analysis} route={`open-motion/structures/${analysis.id}`} disabled={locked} dirty={dirty}
                  onRestore={(request) => correct(request, request.request_key)}
                  onRefresh={async () => {
                    try { apply(await motionRequest<Structure>(`open-motion/structures/${analysis.id}`), true); }
                    catch (error) { setMessage((error as Error).message); }
                  }}>
                  {(historical) => <>
                    <p>{historical.document?.data.summary}</p>
                    <StructureHistoryImage key={`${historical.id}:${historical.document?.revision}`} image={motionUrl(`open-motion/structures/${historical.id}/source`)} width={historical.source.width} height={historical.source.height}
                      caption={`角色结构版本 ${historical.document?.revision} 的原图`}
                      parts={(historical.document?.data.parts || []).map((part) => ({ id: part.id, name: part.name, maskUrl: historical.document?.masks.some((mask) => mask.id === part.id) ? motionUrl(`open-motion/structures/${historical.id}/masks/${part.id}`, { revision: String(historical.document.revision) }) : undefined }))}
                      anchors={historical.document?.data.anchors || []} />
                    {!!historical.document?.data.relations.length && <details><summary>历史连接与握持关系</summary><ul>{historical.document.data.relations.map((relation) => {
                      const nodes = [...historical.document!.data.parts, ...historical.document!.data.anchors];
                      const label = (id: string) => nodes.find((node) => node.id === id)?.name || id;
                      return <li key={relation.id}>{label(relation.source)} → {label(relation.target)} · {relation.type} · {relation.state}：{relation.evidence}</li>;
                    })}</ul></details>}
                    {historical.document?.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}
                  </>}
                </MotionStructureHistory>
                {draft.uncertainties.length > 0 && (
                  <details>
                    <summary>不确定项与依据</summary>
                    <ul>
                      {draft.uncertainties.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                    <p>
                      推断和未知项不会成为已观察事实。确认结构也不会生成或采用动画。
                    </p>
                  </details>
                )}
              </>
            )}
          </details>
          {(message || analysis?.error) && (
            <p className="structure-message" role="alert">
              {message || analysis?.error}
              <button
                onClick={() => {
                  if (analysis)
                    void motionRequest<Structure>(
                      `open-motion/structures/${analysis.id}`,
                    )
                      .then((v) => {
                        if (!dirty) apply(v);
                        setMessage(v.error || '已查询原记录');
                      })
                      .catch((e: Error) => setMessage(e.message));
                  else
                    void motionRequest<Lookup>(
                      `open-motion/references/${characterId}/structure`,
                    )
                      .then((v) => {
                        setRuntime(v.runtime);
                        apply(v.analysis, true);
                        setMessage('');
                      })
                      .catch((e: Error) => setMessage(e.message));
                }}
              >
                查询原记录
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
