'use client';
/* oxlint-disable next/no-img-element -- History previews use immutable, hash-checked source images. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motionRequest, motionUrl } from './open-motion-model';
import { structureRestoreRequest, type StructureHistoryEntry, type StructureRestoreRequest, type StructureSnapshot } from './motion-structure-history-model';
export type { StructureHistoryEntry } from './motion-structure-history-model';
import './motion-authoring-controls.css';


/** Historical responses are never applied to the editor's current write baseline. */
export function MotionStructureHistory<T extends StructureSnapshot>({ current, route, disabled, dirty, onRestore, onRefresh, onPreview, children }: {
  current: T & { history: StructureHistoryEntry[] };
  route: string;
  disabled: boolean;
  dirty: boolean;
  onRestore: (request: StructureRestoreRequest) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onPreview?: () => void;
  children: (value: T) => ReactNode;
}) {
  const owner = `${current.id}:${current.revision}`;
  const [view, setView] = useState<{ owner: string; revision: number; value?: T; error?: string; loading: boolean } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const read = useRef<AbortController | null>(null);
  const restoreRequest = useRef<{ identity: string; key: string } | null>(null);
  useEffect(() => () => read.current?.abort(), [owner]);
  const shown = view?.owner === owner ? view : null;
  const changed = Boolean(shown?.value && shown.value.revision !== current.revision);
  const entries = [...current.history].sort((a, b) => b.revision - a.revision);
  async function preview(revision: number) {
    read.current?.abort();
    if (!revision) { setView(null); return; }
    onPreview?.();
    const abort = new AbortController(); read.current = abort;
    setView({ owner, revision, loading: true });
    try {
      const value = await motionRequest<T>(route, undefined, { revision: String(revision) }, abort.signal);
      if (value.id !== current.id || value.document?.revision !== revision) throw new Error('历史版本身份不匹配，请刷新当前结构。');
      if (!abort.signal.aborted) setView({ owner, revision, value, loading: false });
    } catch (error) {
      if (!abort.signal.aborted) setView({ owner, revision, error: (error as Error).message, loading: false });
    }
  }
  async function restore() {
    if (!shown?.value || disabled || dirty || changed || !shown.value.source_current || shown.revision === current.revision || restoring) return;
    const identity = `${owner}:${shown.revision}`;
    if (restoreRequest.current?.identity !== identity) restoreRequest.current = { identity, key: crypto.randomUUID() };
    setRestoring(true);
    try { if (await onRestore(structureRestoreRequest(current, shown.value, restoreRequest.current.key))) setView(null); }
    catch (error) { setView({ ...shown, error: (error as Error).message }); }
    finally { setRestoring(false); }
  }
  return <details className="structure-history">
    <summary>结构历史版本 · 当前版本 {current.revision}</summary>
    <label>查看历史版本<select aria-label="查看结构历史版本" value={shown?.revision || 0} disabled={restoring} onChange={(event) => void preview(Number(event.target.value))}>
      <option value={0}>返回当前版本 {current.revision}</option>
      {entries.map((entry) => <option key={entry.revision} value={entry.revision}>版本 {entry.revision}{entry.revision === current.revision ? '（当前）' : ''} · {entry.note || '已保存结构'}</option>)}
    </select></label>
    {shown?.loading && <output>正在读取历史结构…</output>}
    {shown?.error && <p role="alert">{shown.error}</p>}
    {shown?.value && <section aria-label="历史结构预览">
      <p>正在预览版本 {shown.revision}。编辑与确认仍以当前版本 {current.revision} 为准。</p>
      {children(shown.value)}
      {changed && <p role="alert">服务端已有新版本，请刷新当前结构后再恢复。</p>}
      {!shown.value.source_current && <p role="alert">源图片或参考结构已经改变，此历史仅供查看。</p>}
      {dirty && <p>当前还有结构草稿，请先保存或放弃草稿，再恢复历史。</p>}
      <p>恢复会创建新版本，当前版本及其他历史继续保留；恢复后需要重新核对。</p>
      <button disabled={disabled || dirty || changed || restoring || !shown.value.source_current || shown.revision === current.revision} onClick={() => void restore()}>{restoring ? '正在恢复…' : `恢复为版本 ${shown.revision} 的内容`}</button>
      <button disabled={disabled || dirty || restoring} onClick={() => void onRefresh()}>刷新当前结构</button>
      <p>提交结果未确认时先刷新当前结构；直接重试会沿用同一次恢复请求。</p>
    </section>}
  </details>;
}

type PreviewPart = { id: string; name: string; maskUrl?: string };
type PreviewAnchor = { id: string; name: string; x: number | null; y: number | null; state: string };
export function StructureHistoryImage({ image, width, height, parts, anchors = [], caption }: { image: string; width: number; height: number; parts: PreviewPart[]; anchors?: PreviewAnchor[]; caption: string }) {
  const [selected, setSelected] = useState('');
  const part = parts.find((entry) => entry.id === selected) || parts[0];
  return <div className="structure-history-preview">
    <label>预览部件<select aria-label="历史结构预览部件" value={part?.id || ''} onChange={(event) => setSelected(event.target.value)}>{parts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
    <div className="motion-canvas motion-structure"><div className="structure-image">
      <img src={image} alt={caption} draggable={false} />
      {part?.maskUrl && <div className="structure-mask" style={{ maskImage: `url("${part.maskUrl}")` }} />}
      <svg viewBox={`0 0 ${width} ${height}`} aria-label="历史结构锚点">{anchors.filter((anchor) => anchor.x !== null && anchor.y !== null).map((anchor) => <circle key={anchor.id} cx={anchor.x!} cy={anchor.y!} r={1.2} fill={anchor.state === 'inferred' ? '#ffd166' : '#62e9df'}><title>{anchor.name}</title></circle>)}</svg>
    </div></div>
  </div>;
}

export function temporalHistoryImage(route: string, frame: number, revision: number, part: string, sha: string) {
  return motionUrl(`${route}/frames/${frame}/parts/${part}`, { revision: String(revision), v: sha });
}
