'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Lock, Pause, Play } from 'lucide-react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import type { Box, Point } from '@/features/interactable-motion/frame-tools';
import type { RgbaImage } from '@/features/interactable-motion/png-rgba';
import { paint, useRgbaFrames } from './use-rgba-frames';

export type CanvasFrame = { url: string; sha256: string; locked: boolean; label?: string };
export type Overlays = { onion: boolean; fixed: boolean; heat: boolean; pivot: boolean; seam: boolean };
export type DrawMode = null | 'fixed' | 'exclude' | 'moving' | 'pivot';
export type ToolMarks = { fixed: Box[]; exclude: Box[]; moving: Box[]; pivot: Point | null };
export type Playback = 'once' | 'loop' | 'ping_pong';

/** Order of shown frames for a playback mode; ping-pong repeats neither end. */
export function playbackOrder(count: number, mode: Playback) {
  const forward = Array.from({ length: count }, (_, i) => i);
  return mode === 'ping_pong' && count > 2 ? [...forward, ...forward.slice(1, -1).reverse()] : forward;
}

const colors = { fixed: '#22d3ee', exclude: '#f97316', moving: '#a855f7', measured: '#facc15' };

export function TransitionCanvas({ frames, referenceUrl, fps, playback, durations, overlays, measuredBoxes, measuredPivot, radius,
  marks, drawMode, onDraw, frame, onFrame, onPlayed, onEditFrame, readOnly }: {
  frames: CanvasFrame[]; referenceUrl: string; fps: number; playback: Playback; durations?: number[];
  overlays: Overlays; measuredBoxes: Box[]; measuredPivot: Point | null; radius: number | null;
  marks: ToolMarks; drawMode: DrawMode; onDraw: (mode: Exclude<DrawMode, null>, value: Box | Point) => void;
  frame: number; onFrame: (index: number) => void; onPlayed?: () => void; onEditFrame?: (index: number) => void; readOnly: boolean;
}) {
  const urls = useMemo(() => [referenceUrl, ...frames.map(f => f.url)], [referenceUrl, frames]);
  const { frames: images, ready, error } = useRgbaFrames(urls);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [cursor, setCursor] = useState(0);
  const base = useRef<HTMLCanvasElement>(null), layer = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Point | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const count = frames.length;
  const order = useMemo(() => playbackOrder(count, playback), [count, playback]);
  const reference = images[0];
  const current = images[1 + Math.min(frame, count - 1)];
  useEffect(() => {
    if (!playing || !count) return;
    const index = order[cursor] ?? 0;
    const weight = durations?.[index] ?? 1;
    const timer = setTimeout(() => {
      if (cursor + 1 >= order.length) {
        if (playback === 'loop') { setCursor(0); onFrame(order[0]); return; }
        setPlaying(false); onPlayed?.(); return;
      }
      setCursor(cursor + 1); onFrame(order[cursor + 1]);
    }, (1000 / (fps * speed)) * weight);
    return () => clearTimeout(timer);
  }, [playing, cursor, order, durations, fps, speed, playback, count, onFrame, onPlayed]);
  useEffect(() => {
    if (!current) return;
    const canvas = base.current;
    if (!canvas) return;
    canvas.width = current.width; canvas.height = current.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const draw = (image: RgbaImage, alpha: number) => {
      const scratch = document.createElement('canvas');
      paint(scratch, image);
      context.globalAlpha = alpha;
      context.drawImage(scratch, 0, 0);
      context.globalAlpha = 1;
    };
    const previous = images[1 + frame - 1];
    if (overlays.onion && frame > 0 && previous) draw(previous, 0.35);
    if (overlays.seam && frame === 0 && images[count]) draw(images[count], 0.35);
    draw(current, 1);
  }, [current, images, frame, count, overlays.onion, overlays.seam]);
  useEffect(() => {
    const canvas = layer.current;
    if (!canvas || !current) return;
    canvas.width = current.width * 4; canvas.height = current.height * 4;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.scale(4, 4);
    if (overlays.heat && reference) {
      // Pixels that differ from the reference inside measured or marked fixed regions.
      const boxes = [...measuredBoxes, ...marks.fixed];
      context.fillStyle = 'rgba(239,68,68,0.55)';
      for (const b of boxes) for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) {
        const i = (y * current.width + x) * 4;
        if (i < 0 || i >= current.pixels.length) continue;
        const differs = [0, 1, 2, 3].some(k => current.pixels[i + k] !== reference.pixels[i + k]) &&
          !(current.pixels[i + 3] === 0 && reference.pixels[i + 3] === 0);
        if (differs) context.fillRect(x, y, 1, 1);
      }
    }
    context.lineWidth = 0.5;
    const outline = (b: Box, color: string, dash = false) => {
      context.strokeStyle = color;
      context.setLineDash(dash ? [1.5, 1] : []);
      context.strokeRect(b.x0 + 0.25, b.y0 + 0.25, b.x1 - b.x0 - 0.5, b.y1 - b.y0 - 0.5);
    };
    if (overlays.fixed) measuredBoxes.forEach(b => outline(b, colors.measured, true));
    marks.fixed.forEach(b => outline(b, colors.fixed));
    marks.exclude.forEach(b => outline(b, colors.exclude));
    marks.moving.forEach(b => outline(b, colors.moving));
    if (draft) outline(draft, '#ffffff', true);
    const pivot = marks.pivot || measuredPivot;
    if (overlays.pivot && pivot) {
      context.setLineDash([]);
      context.strokeStyle = colors.measured;
      context.beginPath(); context.arc(pivot.x, pivot.y, 1.2, 0, Math.PI * 2); context.stroke();
      if (radius) { context.setLineDash([1, 1]); context.beginPath(); context.arc(pivot.x, pivot.y, radius, 0, Math.PI * 2); context.stroke(); }
    }
  }, [current, reference, overlays, measuredBoxes, measuredPivot, radius, marks, draft]);
  const pixel = (event: React.PointerEvent<HTMLCanvasElement>): Point | null => {
    if (!current) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(current.width, Math.round(((event.clientX - rect.left) / rect.width) * current.width))),
      y: Math.max(0, Math.min(current.height, Math.round(((event.clientY - rect.top) / rect.height) * current.height))),
    };
  };
  if (!count) return <div className="motion-canvas motion-large">这段过渡还没有保存的帧。</div>;
  const shown = frames[Math.min(frame, count - 1)];
  return <div className="im-canvas-wrap">
    <div className="im-canvas" data-draw={drawMode || undefined}>
      <canvas ref={base} className="im-canvas-base" aria-label={`第 ${frame + 1} 帧`} />
      <canvas ref={layer} className="im-canvas-layer"
        onPointerDown={event => {
          if (!drawMode) return;
          const p = pixel(event); if (!p) return;
          if (drawMode === 'pivot') { onDraw('pivot', p); return; }
          drag.current = p; setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (!drag.current) return;
          const p = pixel(event); if (!p) return;
          const s = drag.current;
          setDraft({ x0: Math.min(s.x, p.x), y0: Math.min(s.y, p.y), x1: Math.max(s.x, p.x), y1: Math.max(s.y, p.y) });
        }}
        onPointerUp={() => {
          if (drag.current && draft && drawMode && drawMode !== 'pivot' && draft.x1 > draft.x0 && draft.y1 > draft.y0) onDraw(drawMode, draft);
          drag.current = null; setDraft(null);
        }} />
      {!ready && <span className="im-canvas-note">{error || '正在读取帧…'}</span>}
    </div>
    {(() => {
      // Only explain what is actually drawn on this frame.
      const items: [string, string][] = [
        ...(overlays.fixed && measuredBoxes.length ? [[colors.measured, '方案中的固定监测区（虚线）'] as [string, string]] : []),
        ...(marks.fixed.length ? [[colors.fixed, '你框选的固定区'] as [string, string]] : []),
        ...(marks.exclude.length ? [[colors.exclude, '不回填区'] as [string, string]] : []),
        ...(marks.moving.length ? [[colors.moving, '运动部件'] as [string, string]] : []),
        ...(overlays.heat ? [['rgba(239,68,68,0.8)', '与原图不同的固定区像素'] as [string, string]] : []),
        ...(overlays.pivot && (marks.pivot || measuredPivot) ? [[colors.measured, radius ? '枢轴与铰接半径' : '枢轴'] as [string, string]] : []),
      ];
      return items.length ? <ul className="im-legend" aria-label="叠加层图例">{items.map(([color, label]) =>
        <li key={label}><span style={{ borderColor: color }} aria-hidden="true" />{label}</li>)}</ul> : null;
    })()}
    <div className="im-strip" aria-label="帧条">
      {frames.map((f, i) => <button key={i} aria-pressed={i === frame} aria-label={`第 ${i + 1} 帧${f.locked ? '（锁定）' : ''}`} onClick={() => { setPlaying(false); onFrame(i); }}
        title={f.locked ? '锁定帧：任何编辑工具都不能修改' : f.label}>
        {/* oxlint-disable-next-line next/no-img-element -- exact pixel frame */}
        <img src={f.url} alt="" loading="lazy" decoding="async" />
        <span>{i + 1}{f.locked && <Lock size={10} aria-label="锁定" />}{durations && durations[i] !== 1 ? ` ×${durations[i]}` : ''}</span>
      </button>)}
    </div>
    <div className="motion-player">
      <button aria-label={playing ? '暂停播放' : '播放这段过渡'} disabled={!ready} onClick={() => {
        if (!playing) { setCursor(0); onFrame(order[0]); }
        setPlaying(p => !p);
      }}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
      <button aria-label="上一帧" onClick={() => { setPlaying(false); onFrame(Math.max(0, frame - 1)); }}><ArrowLeft size={16} /></button>
      <input aria-label="逐帧查看" type="range" min={0} max={count - 1} value={Math.min(frame, count - 1)}
        onChange={e => { setPlaying(false); onFrame(Number(e.target.value)); }} />
      <button aria-label="下一帧" onClick={() => { setPlaying(false); onFrame(Math.min(count - 1, frame + 1)); }}><ArrowRight size={16} /></button>
      <span>{frame + 1} / {count}</span>
      <NativeSelect aria-label="预览速度" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
        <NativeSelectOption value={0.5}>0.5×</NativeSelectOption>
        <NativeSelectOption value={1}>1×</NativeSelectOption>
        <NativeSelectOption value={2}>2×</NativeSelectOption>
      </NativeSelect>
    </div>
    <p className="motion-muted">{shown.locked ? '当前帧已锁定（段首、确认的段尾或停留帧）。' : shown.label || ''} {fps} FPS ·
      {playback === 'loop' ? ' 循环预览' : playback === 'ping_pong' ? ' 往返预览' : ' 播放到末帧停止'}</p>
    {onEditFrame && <button disabled={readOnly || playing || shown.locked} onClick={() => onEditFrame(frame)}>局部调整当前帧</button>}
  </div>;
}
