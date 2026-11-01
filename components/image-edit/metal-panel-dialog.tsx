'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { rasterIntegerLine, type PixelPoint, type RegionSpec } from '@/features/image-edit/core.mjs';
import { paintMetalPanel, panelRegion, tracePanelSeam, type MetalPanelOperation, type PanelCrop } from '@/features/image-edit/metal-panel.mjs';
import { imageEditRequest, imageGuards, imageResolveInput, type ImageAiReference, type ImageTargetInfo } from '@/features/image-edit/client';

type Hint = PixelPoint & { kind: 'seam' | 'include' | 'exclude' };
type Tool = Hint['kind'] | 'add' | 'subtract';
interface Props {
  crop: PanelCrop; target: ImageTargetInfo; region: RegionSpec; editId: string; revision: number; baseVersion: string; baseHash: string;
  onClose: () => void; onSave: (operation: MetalPanelOperation, region: RegionSpec) => void;
  onAiDraft: (region: RegionSpec, reference: ImageAiReference) => void;
}
const toolNames: Record<Tool, string> = { seam: '标板缝', include: '板面点', exclude: '排除点', add: '补选', subtract: '减去' };
const help: Record<Tool, string> = { seam: '点在水平暗缝附近，黄色标出找到的缝。', include: '在木板上点一下，然后点「辅助分板」。', exclude: '在铁箍、铆钉等要保留的物件上给点，然后点「辅助分板」。', add: '拖动补选漏掉的板面，范围限于原选区。', subtract: '拖动保护铁箍、铆钉或误选区域。' };

export function MetalPanelDialog({ crop, target, region, editId, revision, baseVersion, baseHash, onClose, onSave, onAiDraft }: Props) {
  const { frame, rgba, allowed } = crop;
  const { width, height } = frame;
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [settings, setSettings] = useState<MetalPanelOperation>(() => ({ type: 'metal-panel', frame, color: '#56616b', angle: 16, position: 42,
    bandWidth: Math.max(1, Math.round(width / 5)), strength: 63, cellSize: 1 }));
  const [tool, setTool] = useState<Tool>('seam'), [tab, setTab] = useState<'mask' | 'result' | 'source'>('mask');
  const [hints, setHints] = useState<Hint[]>([]), [brush, setBrush] = useState(3);
  const [proposal, setProposal] = useState<Uint8Array | null>(null);
  const [corrections, setCorrections] = useState<Int8Array>(() => new Int8Array(allowed.length));
  const stroke = useRef<PixelPoint | null>(null);
  const [lastCorrection, setLastCorrection] = useState<Int8Array | null>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { request.current?.abort(); element.close(); };
  }, []);

  const seams = useMemo(() => hints.filter(h => h.kind === 'seam').map(h => tracePanelSeam(crop, h.y, settings.cellSize)), [hints, crop, settings.cellSize]);
  const unresolved = seams.some(s => !s);
  const mask = useMemo(() => {
    const next = new Uint8Array(allowed.length);
    for (let i = 0; i < next.length; i++) next[i] = Number(!!allowed[i] && (corrections[i] ? corrections[i] > 0 : !!(proposal || allowed)[i]));
    for (const seam of seams) if (seam) next.fill(0, seam.top * width, (seam.bottom + 1) * width);
    return next;
  }, [allowed, proposal, corrections, seams, width]);
  const count = useMemo(() => mask.reduce((sum, bit) => sum + bit, 0), [mask]);
  function metalPixels() {
    const output = rgba.slice();
    paintMetalPanel(output, width, mask, settings, frame);
    return output;
  }
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const output = rgba.slice();
    if (tab === 'result') paintMetalPanel(output, width, mask, settings, frame);
    if (tab === 'mask') {
      for (let i = 0; i < mask.length; i++) if (mask[i]) {
        const o = i * 4;
        output[o] *= .53; output[o + 1] = output[o + 1] * .53 + 115; output[o + 2] = output[o + 2] * .53 + 100;
      }
    }
    ctx.putImageData(new ImageData(output, width, height), 0, 0);
    if (tab !== 'mask') return;
    ctx.fillStyle = 'rgba(255,190,40,.72)';
    for (const seam of seams) if (seam) for (let y = seam.top; y <= seam.bottom; y++) {
      for (let x = 0; x < width; x++) if (allowed[y * width + x]) ctx.fillRect(x, y, 1, 1);
    }
    const size = Math.max(2, Math.round(width / 100));
    for (const hint of hints) {
      ctx.strokeStyle = hint.kind === 'exclude' ? '#d75177' : hint.kind === 'include' ? '#4de1d4' : '#ffc14b';
      ctx.lineWidth = Math.max(1, size / 3);
      ctx.strokeRect(hint.x - size, hint.y - size, 2 * size, 2 * size);
    }
  }, [rgba, allowed, width, height, frame, mask, settings, tab, seams, hints]);

  function addHint(point: PixelPoint, kind: Hint['kind']) {
    if (kind !== 'exclude' && !allowed[point.y * width + point.x]) throw new Error('请在原选区中的可见板面上给点。');
    if (kind === 'seam' && hints.filter(h => h.kind === 'seam').length >= 15) throw new Error('每次最多标记 15 条水平板缝。');
    if (kind !== 'seam' && hints.filter(h => h.kind !== 'seam').length >= 32) throw new Error('每次最多使用 32 个分板定位点。');
    setHints([...hints, { ...point, kind }]); setProposal(null);
  }
  function pointer(event: React.PointerEvent<HTMLCanvasElement>, start: boolean) {
    if (busy || tab !== 'mask' || (!start && !stroke.current)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: Math.max(0, Math.min(width - 1, Math.floor((event.clientX - rect.left) * width / rect.width))),
      y: Math.max(0, Math.min(height - 1, Math.floor((event.clientY - rect.top) * height / rect.height))) };
    setError('');
    if (tool !== 'add' && tool !== 'subtract') {
      if (start) try { addHint(point, tool); } catch (e) { setError((e as Error).message); }
      return;
    }
    if (start) { event.currentTarget.setPointerCapture(event.pointerId); setLastCorrection(corrections); }
    const line = rasterIntegerLine(stroke.current || point, point);
    stroke.current = point;
    setCorrections(old => {
      const next = old.slice(), offset = Math.floor((brush - 1) / 2);
      for (const p of line) for (let y = Math.max(0, p.y - offset); y < Math.min(height, p.y - offset + brush); y++) {
        for (let x = Math.max(0, p.x - offset); x < Math.min(width, p.x - offset + brush); x++) {
          if (allowed[y * width + x]) next[y * width + x] = tool === 'add' ? 1 : -1;
        }
      }
      return next;
    });
  }
  async function suggest() {
    if (request.current) return;
    const abort = new AbortController(); request.current = abort; setBusy(true); setError('');
    try {
      const { regionRef } = await imageEditRequest<{ regionRef: string }>('resolve', imageResolveInput(target, region), abort.signal);
      const result = await imageEditRequest<{ region: RegionSpec; baseRgbaSha256: string }>('panel-suggest', {
        ...imageGuards(target), regionRef, editId, expectedEditRevision: revision, baseCandidateVersion: baseVersion, cellSize: settings.cellSize,
        splitRows: seams.flatMap(s => s ? [Math.floor((s.top + s.bottom) / 2)] : []).filter(y => y > 0),
        points: hints.filter(h => h.kind !== 'seam').map(h => ({ x: h.x, y: h.y, include: h.kind === 'include' })),
      }, abort.signal);
      if (abort.signal.aborted) return;
      if (result.baseRgbaSha256 !== baseHash) throw new Error('分析基准已变化，请重新打开试验。');
      // The server returns original-image coordinates. Bring only this crop back into the draft.
      const suggested = new Uint8Array(allowed.length);
      if (result.region.type === 'rectangle') {
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const px = x + frame.x, py = y + frame.y, r = result.region;
          if (px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height) suggested[y * width + x] = 1;
        }
      } else if (result.region.type === 'mask-runs') {
        for (const span of result.region.spans) for (let i = span.startPixel; i < span.startPixel + span.length; i++) {
          const x = i % target.width - frame.x, y = Math.floor(i / target.width) - frame.y;
          if (x >= 0 && x < width && y >= 0 && y < height) suggested[y * width + x] = 1;
        }
      } else throw new Error('分板返回的选区格式无效。');
      setProposal(suggested); setTab('mask');
    } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { request.current = null; if (!abort.signal.aborted) setBusy(false); }
  }
  function finish(ai: boolean) {
    try {
      const finalRegion = panelRegion(mask, frame, target.width);
      if (!ai) { onSave(settings, finalRegion); return; }
      const guide = document.createElement('canvas'); guide.width = width; guide.height = height;
      guide.getContext('2d')!.putImageData(new ImageData(metalPixels(), width, height), 0, 0);
      const source = guide.toDataURL('image/png');
      onAiDraft(finalRegion, { id: crypto.randomUUID(), name: '金属板反光示意.png', source, bytes: atob(source.split(',')[1]).length });
    } catch (e) { setError((e as Error).message); }
  }
  const slider = (name: 'angle' | 'bandWidth' | 'position' | 'strength' | 'cellSize', label: string, min: number, max: number, unit: string) =>
    <label>{label} <output>{settings[name]}{unit}</output><input aria-label={label} type="range" min={min} max={max} value={settings[name]} onChange={e => {
      setSettings({ ...settings, [name]: Number(e.target.value) });
      if (name === 'cellSize') setProposal(null);
      else setTab('result');
    }} /></label>;

  return createPortal(<dialog ref={dialog} className="ie-metal-dialog" aria-labelledby="ie-metal-title" onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={e => e.stopPropagation()}>
    <header><h2 id="ie-metal-title">拼板换金属 · 试验</h2><Button variant="ghost" onClick={onClose}>返回编辑器</Button></header>
    <p>框内只改板面。标记水平板缝，可用补选、减去修正铁箍和铆钉边缘。</p>
    <div className="ie-metal-layout"><section>
      <div className="ie-row">{(['source', 'mask', 'result'] as const).map((value, i) => <Button key={value} size="sm" variant={tab === value ? 'secondary' : 'ghost'} aria-pressed={tab === value} onClick={() => setTab(value)}>{['基准', '板面选区', '金属预览'][i]}</Button>)}</div>
      <div className="ie-metal-image"><canvas ref={canvas} width={width} height={height} style={{ width: `min(100%, calc(50vh * ${width / height}))` }} aria-label="板面操作画布"
        onPointerDown={e => { if (e.button === 0) pointer(e, true); }} onPointerMove={e => pointer(e, false)}
        onLostPointerCapture={() => { stroke.current = null; }} onPointerUp={() => { stroke.current = null; }} onPointerCancel={() => { stroke.current = null; }} /></div>
      <p>{tab === 'mask' ? help[tool] : '切换到「板面选区」可继续修正。'}</p>
      <output aria-live="polite">{count.toLocaleString()} 个可改像素 · 已定位 {seams.filter(Boolean).length}/{seams.length} 条缝{proposal ? ' · 已使用分板建议' : ''}</output>
      {unresolved && <p role="alert">有提示附近缺少唯一连续暗缝。请撤回提示并重新定位，或用「减去」手工保护。</p>}
    </section><fieldset disabled={busy}><legend>板面与反光</legend>
      <div className="ie-row">{(Object.keys(toolNames) as Tool[]).map(t => <Button key={t} size="sm" variant={tool === t ? 'secondary' : 'outline'} aria-pressed={tool === t} onClick={() => { setTool(t); setTab('mask'); }}>{toolNames[t]}</Button>)}</div>
      {(tool === 'add' || tool === 'subtract') && <label>涂选笔宽 <input aria-label="板面涂选笔宽" type="number" min="1" max="64" value={brush} onChange={e => setBrush(Math.max(1, Math.min(64, Math.round(Number(e.target.value)))))} /></label>}
      <div className="ie-row"><Button size="sm" variant="ghost" disabled={!hints.length} onClick={() => { setHints(hints.slice(0, -1)); setProposal(null); setError(''); }}>撤回上一提示</Button>
        <Button size="sm" variant="ghost" disabled={!lastCorrection} onClick={() => { if (lastCorrection) setCorrections(lastCorrection); setLastCorrection(null); }}>撤销上一笔修选</Button></div>
      <Button size="sm" variant="outline" disabled={unresolved} onClick={() => void suggest()}>{busy ? '正在本地分板…' : '辅助分板（SAM）'}</Button>
      <label>铁板底色 <input type="color" value={settings.color} onChange={e => { setSettings({ ...settings, color: e.target.value }); setTab('result'); }} /></label>
      {slider('cellSize', '美术像素步长', 1, 16, ' px')}
      {slider('position', '亮带位置', 0, 100, '%')}{slider('angle', '倾斜角度', -90, 90, '°')}
      {slider('bandWidth', '亮带宽度', 1, Math.ceil(Math.hypot(width, height)), ' px')}{slider('strength', '反光强度', 0, 100, '%')}
    </fieldset></div>
    {error && <p role="alert">{error}</p>}
    <footer><Button variant="outline" disabled={busy || unresolved || !count || !target.aiEdit?.supported} onClick={() => finish(true)}>用选区和反光图准备 AI 草稿</Button>
      <Button disabled={busy || unresolved || !count} onClick={() => finish(false)}>保存本地金属候选</Button></footer>
  </dialog>, document.body);
}
