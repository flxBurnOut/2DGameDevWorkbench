'use client';
/* oxlint-disable next/no-img-element -- exact derived pixel frames */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { paletteMap, rotatePart, rotationAngles, type Mask, type Point } from '@/features/interactable-motion/frame-tools';
import { base64Bytes, encodePng, type RgbaImage } from '@/features/interactable-motion/png-rgba';
import { motionRequest, motionUrl, type MotionWork } from '../sprite-generator/open-motion-model';
import { stateNames } from './motion-graph';
import { fetchRgba, paint } from './use-rgba-frames';

export type DerivedRecord = {
  id: string; asset_id: string; kind: 'state' | 'transition'; method: 'reverse' | 'rotation' | 'palette' | 'upload'; method_label: string;
  name: string; candidate: number; revision: number; source_stage: number | null; state: 'ready' | 'accepted' | 'rejected';
  token: string; frames: { sha256: string }[]; fps: number; note: string; review: { note: string } | null; source: Record<string, unknown>;
};
type Focus = { kind: 'state'; node: number } | { kind: 'edge'; stage: number };
type Rotation = { pivot: Point; angle: number; base: RgbaImage; moving: Mask };

const key = () => `im-derived-${crypto.randomUUID()}`;

export function DerivedAssets({ work, candidate, focus, readOnly, onSaved, rotation }: {
  work: MotionWork; candidate: number; focus: Focus; readOnly: boolean; onSaved: (w: MotionWork) => void; rotation?: Rotation;
}) {
  const [records, setRecords] = useState<DerivedRecord[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(''), [note, setNote] = useState('');
  const [from, setFrom] = useState('#808080'), [to, setTo] = useState('#f5c26b');
  const [upload, setUpload] = useState('');
  const [count, setCount] = useState(8);
  const [base, setBase] = useState<RgbaImage | null>(null);
  const [targetStage, setTargetStage] = useState(0);
  const job = work.job;
  const c = job?.candidates.find(x => x.candidate_index === candidate);
  const chainIndex = focus.kind === 'state' ? c?.state_chain?.findIndex(s => (s.stage === null ? 0 : s.stage + 1) === focus.node) ?? -1 : -1;
  const reload = useCallback(async () => {
    if (!job) return;
    const value = await motionRequest<{ derived: DerivedRecord[] }>(`open-motion/${work.id}/derived`, undefined, { revision: String(work.revision) });
    setRecords(value.derived.filter(r => r.candidate === candidate));
  }, [job, work.id, work.revision, candidate]);
  useEffect(() => { queueMicrotask(() => void reload().catch(e => setError((e as Error).message))); }, [reload]);
  // The state image a palette variant starts from: the confirmed image, or the reference before production.
  const baseUrl = focus.kind !== 'state' ? '' : chainIndex >= 0 && c?.state_chain
    ? (c.state_chain[chainIndex].stage === null ? motionUrl(`open-motion/${work.id}/reference`, { revision: String(work.revision) })
      : motionUrl(`open-motion/${work.id}/candidates/${candidate}/stages/${c.state_chain[chainIndex].stage}/state-image`, { revision: String(work.revision), expected_sha256: c.state_chain[chainIndex].sha256 }))
    : focus.node === 0 ? motionUrl(`open-motion/${work.id}/reference`, { revision: String(work.revision) }) : '';
  useEffect(() => {
    if (!baseUrl) return;
    const abort = new AbortController();
    void fetchRgba(baseUrl, abort.signal).then(r => setBase(r.image)).catch(() => setBase(null));
    return () => abort.abort();
  }, [baseUrl]);
  const preview = useMemo(() => base ? paletteMap(base.pixels, null, [{ source: from, target: to }]) : null, [base, from, to]);
  const changed = preview && base ? preview.reduce((n, v, i) => n + (i % 4 < 3 && v !== base.pixels[i] ? 1 : 0), 0) : 0;
  const create = async (body: Record<string, unknown>) => {
    setBusy(true); setError('');
    try {
      await motionRequest(`open-motion/${work.id}/derived`, { expected_revision: work.revision, candidate_index: candidate, request_key: key(), ...body });
      await reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const stageRun = focus.kind === 'edge' ? c?.plan_execution.stages[focus.stage] : undefined;
  const names = stateNames(work);
  const shown = records.filter(r => focus.kind === 'edge' ? r.kind === 'transition' && r.source_stage === focus.stage
    : r.kind === 'state' && (r.source as { stage?: number | null }).stage === (focus.node === 0 ? null : focus.node - 1));
  const others = focus.kind === 'state' ? records.filter(r => r.kind === 'state' && r.method === 'upload') : [];
  return <div className="im-tool">
    {focus.kind === 'edge' ? <>
      <h3>T9 反向过渡 · T8 旋转草稿为新过渡</h3>
      <p className="motion-muted">派生结果记录来源、方式与哈希，必须完整播放并写明结论后才会进入资产库；不计为模型通过，也不修改原帧。</p>
      <button disabled={readOnly || busy || !job || stageRun?.state !== 'accepted'} onClick={() => void create({ method: 'reverse', stage_index: focus.stage })}>
        由已接受的「{names[focus.stage]} → {names[focus.stage + 1]}」派生「{names[focus.stage + 1]} → {names[focus.stage]}」</button>
      {stageRun?.state !== 'accepted' && <p className="motion-muted">这段过渡接受后才能倒放派生。</p>}
      <div className="im-tool-row"><label>草稿帧数<input type="number" min={2} max={16} step={2} value={count} onChange={e => setCount(Math.max(2, Math.min(16, Number(e.target.value) || 2)))} /></label>
        <button disabled={readOnly || busy || !job || !rotation} onClick={() => void (async () => {
          if (!rotation) return;
          const angles = rotationAngles(count, 0, rotation.angle);
          const frames = await Promise.all(angles.map(async a => base64Bytes(await encodePng({ width: rotation.base.width, height: rotation.base.height,
            pixels: rotatePart(rotation.base.pixels, rotation.base.width, rotation.base.height, rotation.moving, rotation.pivot, a) }))));
          await create({ method: 'rotation', stage_index: focus.stage, frames_png: frames, params: { pivot_x: rotation.pivot.x, pivot_y: rotation.pivot.y, angle: rotation.angle, frames: count } });
        })()}>派生 {count} 帧旋转草稿</button></div>
      {!rotation && <p className="motion-muted">旋转草稿需要在工具页标出枢轴和运动部件，并有已保存的起始帧。</p>}
    </> : <>
      <h3>T5 状态色调派生 · T10 状态图替换</h3>
      {base && preview ? <div className="im-tool-row">
        <PixelPreview image={base} label="原状态" /><PixelPreview image={{ ...base, pixels: preview }} label="派生预览" />
        <label>原色<input type="color" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>新色<input type="color" value={to} onChange={e => setTo(e.target.value)} /></label>
        <span>{changed ? `${changed / 3 | 0} 个像素将改变` : '所选原色在图中不存在'}</span>
      </div> : <p className="motion-muted">{focus.node === 0 || chainIndex >= 0 ? '正在读取状态图…' : '这个状态还没有确认的状态图。'}</p>}
      <label>派生状态名称<input value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="例如：指示灯亮" /></label>
      {job ? <button disabled={readOnly || busy || !changed || !name.trim() || chainIndex < 0} onClick={() => void create({ method: 'palette', state_index: chainIndex, name, palette: [{ source: from, target: to }] })}>
        登记为派生状态图（待检查）</button>
        : <div className="im-tool-row"><label>设为段末目标<NativeSelect value={targetStage} onChange={e => setTargetStage(Number(e.target.value))}>
          {work.plan?.stages.map((s, i) => <NativeSelectOption key={i} value={i}>第 {i + 1} 段 · {s.name}</NativeSelectOption>)}</NativeSelect></label>
          <button disabled={readOnly || busy || !changed || !preview || work.status !== 'ready' || !base} onClick={() => void (async () => {
            setBusy(true); setError('');
            try {
              const png = base64Bytes(await encodePng({ width: base!.width, height: base!.height, pixels: preview! }));
              onSaved(await motionRequest<MotionWork>(`open-motion/${work.id}/target`, { expected_revision: work.revision, stage_index: targetStage,
                expected_targets: work.target_set_sha256, png_base64: png, note: `色调派生目标图：${from} → ${to}${name ? `（${name}）` : ''}` }));
            } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
          })()}>绑定为目标图</button></div>}
      {job && <>
        <label>T10 上传手绘状态图（128 × 128 透明 PNG）<input type="file" accept="image/png" onChange={e => {
          const file = e.target.files?.[0]; setUpload('');
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => { if (typeof reader.result === 'string') setUpload(reader.result.split(',')[1]); };
          reader.readAsDataURL(file);
        }} /></label>
        <label>来源与核对依据<textarea rows={2} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder="说明这张图的来源，以及视角、固定部件是否与原图一致" /></label>
        <button disabled={readOnly || busy || !upload || !name.trim() || note.trim().length < 4} onClick={() => void create({ method: 'upload', png_base64: upload, name, note })}>登记上传的状态图（待检查）</button>
        <p className="motion-muted">上传或派生的状态图与“生成后确认的状态图”分开显示；作为生成目标请在“要求”页签绑定目标图。</p>
      </>}
    </>}
    {[...shown, ...others].map(r => <DerivedReview key={r.id} work={work} record={r} readOnly={readOnly} onDecided={() => void reload()} />)}
    {error && <p className="motion-danger">{error}</p>}
  </div>;
}

function PixelPreview({ image, label }: { image: RgbaImage; label: string }) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => { paint(canvas, image); }, [canvas, image]);
  return <figure><canvas ref={setCanvas} className="im-target-preview" aria-label={label} /><figcaption>{label}</figcaption></figure>;
}

function DerivedReview({ work, record, readOnly, onDecided }: { work: MotionWork; record: DerivedRecord; readOnly: boolean; onDecided: () => void }) {
  const [frame, setFrame] = useState(0), [playing, setPlaying] = useState(false), [played, setPlayed] = useState(record.kind === 'state');
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (frame + 1 >= record.frames.length) { setPlaying(false); setPlayed(true); return; }
      setFrame(frame + 1);
    }, 1000 / record.fps);
    return () => clearTimeout(timer);
  }, [playing, frame, record]);
  const url = (i: number) => motionUrl(`open-motion/${work.id}/derived/${record.id}/frames/${i}`, { expected_sha256: record.frames[i].sha256 });
  const decide = async (decision: 'accept' | 'reject') => {
    setBusy(true); setError('');
    try { await motionRequest(`open-motion/${work.id}/derived/${record.id}/decision`, { token: record.token, decision, note, played }); onDecided(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="im-slot" data-current={record.state === 'accepted' ? 'true' : undefined}>
    <b>{record.name} · {record.method_label} · {({ ready: '待检查', accepted: '已接受，可写回', rejected: '已放弃' } as Record<string, string>)[record.state]}</b>
    <div className="motion-canvas"><img src={url(Math.min(frame, record.frames.length - 1))} alt={`${record.name} 第 ${frame + 1} 帧`} /></div>
    {record.kind === 'transition' && <div className="motion-player"><button onClick={() => { setFrame(0); setPlaying(true); }}>播放派生过渡</button>
      <input aria-label="派生逐帧" type="range" min={0} max={record.frames.length - 1} value={frame} onChange={e => { setPlaying(false); setFrame(Number(e.target.value)); }} />
      <span>{frame + 1} / {record.frames.length}</span></div>}
    <small>来源：{JSON.stringify(record.source).slice(0, 160)}</small>
    {record.review && <p>结论：{record.review.note}</p>}
    {record.state === 'ready' && !readOnly && <>
      <label>检查结论<textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="实际播放后说明是否可用" /></label>
      <div className="im-tool-row"><button className="motion-primary" disabled={busy || !played || note.trim().length < 4} onClick={() => void decide('accept')}>接受，进入资产库</button>
        <button disabled={busy || note.trim().length < 4} onClick={() => void decide('reject')}>放弃</button></div>
      {!played && <p className="motion-muted">先完整播放一次再接受。</p>}
    </>}
    {error && <p className="motion-danger">{error}</p>}
  </div>;
}
