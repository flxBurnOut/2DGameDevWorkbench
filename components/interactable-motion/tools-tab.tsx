'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  backfillFixed, boxMask, cleanup, detectOffset, emptyMask, framePatch, maskCount, rotatePart, rotationAngles, seamDifference, translate,
  type Box, type Mask,
} from '@/features/interactable-motion/frame-tools';
import { base64Bytes, encodePng, type RgbaImage } from '@/features/interactable-motion/png-rgba';
import { motionRequest, motionUrl, type MotionCandidate, type MotionWork } from '../sprite-generator/open-motion-model';
import type { GraphEdge } from './motion-graph';
import type { DrawMode, ToolMarks } from './transition-canvas';
import type { Rhythm } from './writeback-tab';
import { fetchRgba } from './use-rgba-frames';
import { DerivedAssets } from './derived-assets';

type Context = { token: string; frames: { sha256: string }[]; width: number; height: number; fps: number; locked_frames: number[]; tasks: { state: string }[] };
const ACTIVE = new Set(['queued', 'planning', 'submitting', 'pending', 'reviewing', 'adopting', 'ready', 'unknown']);

/** Union of the explicit masks the user chose; nothing is inferred silently. */
function unionMasks(width: number, height: number, masks: Mask[]) {
  const out = emptyMask(width, height);
  for (const mask of masks) for (let i = 0; i < out.length; i++) if (mask[i]) out[i] = 1;
  return out;
}
function largeDeltas(reference: Uint8Array, frame: Uint8Array, threshold = 64): Mask {
  const out = new Uint8Array(reference.length / 4);
  for (let i = 0; i < out.length; i++) {
    let delta = 0;
    for (let k = 0; k < 4; k++) delta = Math.max(delta, Math.abs(reference[i * 4 + k] - frame[i * 4 + k]));
    out[i] = delta >= threshold ? 1 : 0;
  }
  return out;
}

export function ToolsTab({ work, candidate, edge, marks, onMarks, drawMode, onDrawMode, measuredBoxes, readOnly, rhythm, onRhythm, onSubmitted, onSaved, children }: {
  work: MotionWork; candidate: MotionCandidate; edge?: GraphEdge; marks: ToolMarks; onMarks: (m: ToolMarks) => void;
  drawMode: DrawMode; onDrawMode: (m: DrawMode) => void; measuredBoxes: Box[]; readOnly: boolean;
  rhythm?: Rhythm; onRhythm: (stage: number, value: Rhythm) => void; onSubmitted: () => void; onSaved: (w: MotionWork) => void; children: ReactNode;
}) {
  const awaiting = candidate.plan_execution.stages.findIndex(s => s.state === 'awaiting_review');
  const stage = awaiting >= 0 ? awaiting : undefined;
  const [context, setContext] = useState<Context | null>(null);
  const [frames, setFrames] = useState<RgbaImage[]>([]);
  const [reference, setReference] = useState<RgbaImage | null>(null);
  const [structureMasks, setStructureMasks] = useState<{ fixed: Mask | null; moving: Mask | null }>({ fixed: null, moving: null });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [useMeasured, setUseMeasured] = useState(true), [useStructure, setUseStructure] = useState(true), [skipLarge, setSkipLarge] = useState(true);
  const [alphaBelow, setAlphaBelow] = useState(32), [isolated, setIsolated] = useState(true);
  const [angle, setAngle] = useState(45);
  const query = { revision: String(work.revision), candidate: String(candidate.candidate_index), ...(stage === undefined ? {} : { stage: String(stage) }) };
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      const value = await motionRequest<Context>(`open-motion/${work.id}/adjustments`, undefined, JSON.parse(queryKey), abort.signal);
      const ref = await fetchRgba(motionUrl(`open-motion/${work.id}/reference`, { revision: String(work.revision) }), abort.signal);
      const loaded = await Promise.all(value.frames.map((_, i) => fetchRgba(motionUrl(`open-motion/${work.id}/edit-source/${i}`,
        { ...JSON.parse(queryKey), token: value.token }), abort.signal).then(r => r.image)));
      if (abort.signal.aborted) return;
      setContext(value); setReference(ref.image); setFrames(loaded);
    })().catch(e => { if (!abort.signal.aborted) setError((e as Error).message); });
    return () => abort.abort();
  }, [work.id, work.revision, queryKey]);
  // Fixed and moving part masks from the checked visual structure, when the plan used one.
  const selection = (work.visual_structure as { selection?: { analysis_id: string } } | null | undefined)?.selection;
  const prop = work.plan?.quality?.interactable;
  useEffect(() => {
    if (!selection || !prop || !reference) return;
    const abort = new AbortController();
    const load = (ids: string[]) => Promise.all(ids.map(id => fetchRgba(motionUrl(`open-motion/structures/${selection.analysis_id}/masks/${id}`,
      { revision: String(work.visual_structure?.revision || '') }), abort.signal).then(r => r.image).catch(() => null)));
    void Promise.all([load(prop.fixed_parts), load(prop.moving_parts)]).then(([fixed, moving]) => {
      if (abort.signal.aborted) return;
      const toMask = (images: (RgbaImage | null)[]) => {
        const valid = images.filter((m): m is RgbaImage => Boolean(m && m.width === reference.width));
        if (!valid.length) return null;
        return unionMasks(reference.width, reference.height, valid.map(m => Uint8Array.from({ length: m.width * m.height }, (_, i) => (m.pixels[i * 4 + 3] && Math.max(m.pixels[i * 4], m.pixels[i * 4 + 1], m.pixels[i * 4 + 2]) ? 1 : 0))));
      };
      setStructureMasks({ fixed: toMask(fixed), moving: toMask(moving) });
    });
    return () => abort.abort();
  }, [selection, prop, reference, work.visual_structure?.revision]);
  const width = context?.width || 0, height = context?.height || 0;
  // Candidate scope: the selected transition's editable frames. Stage scope: the awaiting segment.
  const range = useMemo(() => {
    if (!context) return [];
    const all = context.frames.map((_, i) => i).filter(i => !context.locked_frames.includes(i));
    if (stage !== undefined || !edge?.timeline) return all;
    return all.filter(i => i >= edge.timeline!.start && i < edge.timeline!.start + edge.timeline!.count);
  }, [context, stage, edge]);
  const pending = Boolean(context?.tasks.some(t => ACTIVE.has(t.state)));
  const fixedMask = useMemo(() => !width ? null : unionMasks(width, height, [
    ...(useMeasured ? [boxMask(width, height, measuredBoxes)] : []), boxMask(width, height, marks.fixed),
    ...(useStructure && structureMasks.fixed ? [structureMasks.fixed] : []),
  ]), [width, height, useMeasured, measuredBoxes, marks.fixed, useStructure, structureMasks.fixed]);
  const excluded = useMemo(() => !width ? null : unionMasks(width, height, [boxMask(width, height, marks.exclude), boxMask(width, height, marks.moving),
    ...(useStructure && structureMasks.moving ? [structureMasks.moving] : [])]), [width, height, marks.exclude, marks.moving, useStructure, structureMasks.moving]);
  const offsets = useMemo(() => reference && fixedMask && maskCount(fixedMask)
    ? range.map(i => ({ frame: i, ...detectOffset(reference.pixels, frames[i]?.pixels || reference.pixels, width, height, fixedMask) })) : [],
  [reference, fixedMask, range, frames, width, height]);

  async function submit(description: string, compute: (frame: RgbaImage, index: number) => Uint8Array) {
    if (!context) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const patches = [];
      for (const i of range) {
        const before = frames[i];
        const after = compute(before, i);
        const patch = framePatch(i, context.frames[i].sha256, before.pixels, after);
        if (!patch) continue;
        patches.push({ region: patch.region, png_base64: base64Bytes(await encodePng({ width, height, pixels: after })) });
      }
      if (!patches.length) { setMessage('所选帧没有需要修改的像素，未保存备选。'); return; }
      await motionRequest(`open-motion/${work.id}/local-frame-edits`, {
        expected_revision: work.revision, candidate_index: candidate.candidate_index, stage_index: stage ?? null, token: context.token,
        request_key: `im-${crypto.randomUUID()}`, description: description.slice(0, 500), frames: patches,
      });
      setMessage(`已保存 ${patches.length} 帧的备选。请在下方同步播放对比，再决定是否采用。`);
      onSubmitted();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const seam = frames.length && range.length ? seamDifference(frames[edge?.timeline ? edge.timeline.start + edge.timeline.count - 1 : frames.length - 1]?.pixels || frames[0].pixels,
    frames[edge?.timeline ? edge.timeline.start : 0]?.pixels || frames[0].pixels) : null;
  const pivot = marks.pivot;
  const disabled = readOnly || busy || pending || !context || !frames.length;
  const drawButton = (mode: Exclude<DrawMode, null>, label: string) => <button aria-pressed={drawMode === mode} onClick={() => onDrawMode(drawMode === mode ? null : mode)}>{label}</button>;
  return <section>
    {error && <p className="motion-danger">{error}</p>}
    {message && <p className="motion-good">{message}</p>}
    {pending && <p className="motion-notice">有待处理的备选。先在下方对比后采用或保留原版，再使用其他工具。</p>}
    <p className="motion-muted">{stage !== undefined ? `作用于待确认的第 ${stage + 1} 段。` : edge ? `作用于「${edge.name}」的可编辑帧。` : '作用于完整候选的可编辑帧。'}
      锁定帧（段首、确认的段尾与停留帧）不会被修改；结果先成为完整播放备选，确定性工具不消耗绘图次数。</p>
    <div className="im-tool"><h3>画面标记</h3>
      <div className="im-tool-row">{drawButton('fixed', '框选固定区')}{drawButton('exclude', '框选不回填区')}{drawButton('moving', '框选运动部件')}{drawButton('pivot', '点选枢轴')}
        <button onClick={() => onMarks({ fixed: [], exclude: [], moving: [], pivot: null })}>清除标记</button></div>
      <p className="motion-muted">在中间画布上拖动框选或点击。固定区 {marks.fixed.length} 个 · 不回填 {marks.exclude.length} 个 · 运动部件 {marks.moving.length} 个{pivot ? ` · 枢轴 (${pivot.x}, ${pivot.y})` : ''}</p>
      <label className="motion-check"><input type="checkbox" checked={useMeasured} onChange={e => setUseMeasured(e.target.checked)} />使用方案中的固定监测区（{measuredBoxes.length}）</label>
      {selection && <label className="motion-check"><input type="checkbox" checked={useStructure} onChange={e => setUseStructure(e.target.checked)} />使用已核对结构中的固定 / 运动部件{structureMasks.fixed ? '' : '（读取中或不可用）'}</label>}
    </div>
    <div className="im-tool"><h3>T1 固定部件回填</h3>
      <p className="motion-muted">把原图固定区的像素逐帧写回。运动部件、不回填区{skipLarge ? '以及通道差 ≥ 64 的像素（可能是运动部件遮挡）' : ''}会跳过。</p>
      <label className="motion-check"><input type="checkbox" checked={skipLarge} onChange={e => setSkipLarge(e.target.checked)} />跳过大幅变化像素</label>
      <button disabled={disabled || !fixedMask || !maskCount(fixedMask) || !reference} onClick={() => void submit('固定部件回填：从原图恢复固定区像素',
        (frame) => backfillFixed(reference!.pixels, frame.pixels, fixedMask!, unionMasks(width, height, [excluded!, ...(skipLarge ? [largeDeltas(reference!.pixels, frame.pixels)] : [])])))}>
        生成回填备选（{fixedMask ? maskCount(fixedMask) : 0} 像素固定区）</button>
    </div>
    <div className="im-tool"><h3>T3 对齐校正</h3>
      <p className="motion-muted">以固定区为基准检测每帧的整数像素偏移，平移整帧使其与原图对齐。</p>
      {offsets.some(o => o.x || o.y) ? <ul>{offsets.filter(o => o.x || o.y).map(o => <li key={o.frame}>第 {o.frame + 1} 帧：平移 ({o.x}, {o.y}) · 固定区差异 {o.before} → {o.after}</li>)}</ul>
        : <p>{fixedMask && maskCount(fixedMask) ? '未检测到帧间漂移。' : '先选择固定区。'}</p>}
      <button disabled={disabled || !offsets.some(o => o.x || o.y)} onClick={() => void submit('对齐校正：按固定区整数像素平移',
        (frame, i) => { const o = offsets.find(v => v.frame === i); return o && (o.x || o.y) ? translate(frame.pixels, width, height, o.x, o.y) : frame.pixels; })}>生成对齐备选</button>
    </div>
    <div className="im-tool"><h3>T4 批量清理</h3>
      <div className="im-tool-row"><label>透明度低于<input type="number" min={1} max={254} value={alphaBelow} onChange={e => setAlphaBelow(Number(e.target.value) || 1)} /></label>
        <label className="motion-check"><input type="checkbox" checked={isolated} onChange={e => setIsolated(e.target.checked)} />移除孤立像素</label></div>
      <button disabled={disabled} onClick={() => void submit(`批量清理：清除透明度低于 ${alphaBelow} 的像素${isolated ? '和孤立像素' : ''}`,
        (frame) => cleanup(frame.pixels, width, height, { alphaBelow, isolated }))}>生成清理备选</button>
    </div>
    <div className="im-tool"><h3>T8 绕轴旋转草稿（同帧数）</h3>
      <p className="motion-muted">以枢轴和运动部件框为准，从起始状态最近邻旋转到目标角度，替换本段可编辑帧。像素画会有锯齿，只作为起点，需要人工检查后采用。</p>
      <label>总角度（度，顺时针为正）<input type="number" min={-180} max={180} value={angle} onChange={e => setAngle(Number(e.target.value))} /></label>
      <button disabled={disabled || stage !== undefined || !pivot || (!marks.moving.length && !structureMasks.moving) || !edge?.timeline} onClick={() => {
        const t = edge!.timeline!;
        const base = frames[t.start];
        const moving = unionMasks(width, height, [boxMask(width, height, marks.moving), ...(useStructure && structureMasks.moving ? [structureMasks.moving] : [])]);
        const angles = rotationAngles(t.count, 0, angle);
        void submit(`绕轴旋转草稿：枢轴 (${pivot!.x}, ${pivot!.y})，总角度 ${angle}°`,
          (frame, i) => rotatePart(base.pixels, width, height, moving, pivot!, angles[i - t.start] ?? 0));
      }}>替换本段为旋转草稿</button>
      {stage !== undefined && <p className="motion-muted">待确认的段请先确认或拒绝后，再在完整候选上使用旋转草稿。</p>}
    </div>
    {edge && <div className="im-tool"><h3>T6 节奏 · T7 循环接缝</h3>
      <RhythmEditor key={edge.stage} work={work} candidate={candidate} edge={edge} rhythm={rhythm} onRhythm={v => onRhythm(edge.stage, v)} />
      {seam && <p>末帧到首帧差异：{seam.changed} / {seam.total} 像素{work.spec.loop ? '（循环动画，跳变会在每次循环出现）' : ''}。勾选“检查”页签的“首帧叠末帧”可在画布上查看。</p>}
    </div>}
    {edge && <DerivedAssets work={work} candidate={candidate.candidate_index} focus={{ kind: 'edge', stage: edge.stage }} readOnly={readOnly} onSaved={onSaved}
      rotation={pivot && edge.timeline && frames.length ? { pivot, angle, base: frames[edge.timeline.start], moving: unionMasks(width, height, [boxMask(width, height, marks.moving),
        ...(useStructure && structureMasks.moving ? [structureMasks.moving] : [])]) } : undefined} />}
    <div className="im-tool"><h3>备选对比与其他修正</h3>{children}</div>
  </section>;
}

/** T6: per-frame relative durations and end hold for writeback; the source frames are untouched. */
function RhythmEditor({ work, candidate, edge, rhythm, onRhythm }: { work: MotionWork; candidate: MotionCandidate; edge: GraphEdge; rhythm?: Rhythm; onRhythm: (v: Rhythm) => void }) {
  const [count, setCount] = useState<number | null>(null), [error, setError] = useState('');
  const chain = candidate.state_chain?.findIndex(s => s.stage === edge.stage) ?? -1;
  const accepted = candidate.plan_execution.stages[edge.stage]?.state === 'accepted';
  const assetId = work.job && chain > 0 ? `motion-transition:${work.job.job_id}:${candidate.candidate_index}:${chain}` : '';
  useEffect(() => {
    if (!assetId || !accepted) return;
    void fetch('/api/workbench/assets?' + new URLSearchParams({ assetId }), { cache: 'no-store' }).then(r => r.json() as Promise<{ asset?: { frameCount?: number } }>)
      .then(v => setCount(v.asset?.frameCount ?? null)).catch(e => setError((e as Error).message));
  }, [assetId, accepted]);
  if (!accepted) return <p className="motion-muted">过渡接受后可以设置写回时的逐帧时长与往返播放。</p>;
  if (!count) return <p className="motion-muted">{error || '正在读取过渡帧数…'}</p>;
  const durations = rhythm?.durations?.length === count ? rhythm.durations : Array(count).fill(1);
  return <>
    <div className="im-tool-row">{durations.map((d, i) => <label key={i}>第 {i + 1} 帧<input type="number" min={0.25} max={20} step={0.25} value={d}
      onChange={e => onRhythm({ ...rhythm, durations: durations.map((v, j) => (j === i ? Math.max(0.25, Number(e.target.value) || 1) : v)) })} /></label>)}</div>
    <div className="im-tool-row">
      <button onClick={() => onRhythm({ ...rhythm, durations: durations.map((v, i) => (i === count - 1 ? v + 2 : v)) })}>末帧多停 2 拍</button>
      <button onClick={() => onRhythm({ ...rhythm, durations: undefined })}>恢复均匀</button>
      <label>写回播放<NativeSelect aria-label="写回播放" value={rhythm?.playback || 'once'} onChange={e => onRhythm({ ...rhythm, playback: e.target.value as Rhythm['playback'] })}>
        <NativeSelectOption value="once">单次</NativeSelectOption><NativeSelectOption value="ping_pong">往返一次</NativeSelectOption></NativeSelect></label>
    </div>
    <p className="motion-muted">相对时长 1 = 一拍（{work.job?.action.fps} FPS）。只在写回时写入交互物动画片段的逐帧 duration，原帧与原导出不变；中间画布按此节奏预览。</p>
  </>;
}
