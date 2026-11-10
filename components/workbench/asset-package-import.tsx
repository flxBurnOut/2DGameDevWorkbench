'use client';
/* oxlint-disable next/no-img-element -- Stage previews preserve animation and original pixels. */
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { publishEditorSession, removeEditorSession } from '@/lib/workbench/editor-session';

import { packageSelectionKey as keyFor, packageSelections, remainingPackageChoices, type Parameters, type Inspection, type Submission, type Receipt } from '@/lib/workbench/asset-package-selection';
const recoveryKey = 'forge-package-import-recovery-v1';
const statuses = { editable: '可完整编辑', material: '仅素材可用', 'needs-input': '需要补充信息', incomplete: '文件不完整' };
const kinds: Record<string, string> = { character: '角色原图', prop: '物品原图', animation: '动画', map: '地图', interactable: '交互物', scene: '场景' };

function PackageCandidatePreview({ url, frames, fps, loop, durations }: { url: string; frames: number; fps?: number; loop?: boolean; durations?: number[] }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (frames < 2 || !fps || !Number.isFinite(fps) || fps <= 0) return;
    const duration = durations?.[frame] || 1;
    const timer = setTimeout(() => setFrame(value => value + 1 < frames ? value + 1 : loop === true ? 0 : value), 1000 / fps * duration);
    return () => clearTimeout(timer);
  }, [frames, fps, loop, durations, frame]);
  return <div>
    <img src={frames > 1 ? `${url}&frame=${frame}` : url} alt="素材包内容预览" style={{ width: '100%', height: 160, objectFit: 'contain', imageRendering: 'pixelated' }} />
    {frames > 1 && <button type="button" className="wb-button" onClick={() => setFrame(0)}>重新播放预览</button>}
  </div>;
}

export function AssetPackageImport({ onClose, onImported }: { onClose: () => void; onImported: (ids: string[]) => void }) {
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [choices, setChoices] = useState<Record<string, Parameters>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [pending, setPending] = useState<Submission | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const commitRequest = useRef<Submission | null>(null);

  useEffect(() => {
    mounted.current = true;
    try {
      const raw = sessionStorage.getItem(recoveryKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved.inspections) && Array.isArray(saved.selected) && saved.choices) {
          // oxlint-disable-next-line react/react-compiler -- Restore a browser-only interrupted import after hydration.
          setInspections(saved.inspections); setSelected(saved.selected); setChoices(saved.choices);
          if (saved.pending?.commandId) { commitRequest.current = saved.pending; setPending(saved.pending); }
        }
      }
    } catch { /* An unavailable browser cache does not prevent a new inspection. */ }
    return () => { mounted.current = false; removeEditorSession('asset-package-import'); };
  }, []);
  function persist(nextInspections: Inspection[], nextSelected: string[], nextChoices: Record<string, Parameters>, submission: Submission | null) {
    sessionStorage.setItem(recoveryKey, JSON.stringify({ inspections: nextInspections, selected: nextSelected, choices: nextChoices, pending: submission }));
  }
  function begin(message: string) {
    lock.current = true; setBusy(message); setError('');
    publishEditorSession({ capabilityId: 'asset-package-import', items: [], dirty: false, busy: true, save: async () => {}, beforeLeave: () => { throw new Error('素材包正在检查或入库，请完成后再离开。'); } });
  }
  function end() { lock.current = false; if (mounted.current) setBusy(''); removeEditorSession('asset-package-import'); }
  async function inspect(files: File[]) {
    if (lock.current || pending || !files.length) return;
    begin('正在上传并检查素材包…');
    let nextInspections = [...inspections];
    const nextSelected = [...selected], nextChoices = { ...choices };
    const errors: string[] = [];
    try {
      for (const file of files) {
        try {
          if (file.size > 768 * 1024 * 1024) throw new Error('文件超过 768 MiB，请分批下载后导入。');
          setBusy(`正在检查 ${file.name}…`);
          const response = await fetch('/api/workbench/assets/packages/inspect', {
            method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-forge-filename': encodeURIComponent(file.name) }, body: file,
          });
          const value = await response.json() as Inspection & { error?: string };
          if (!response.ok) throw new Error(value.error || '检查失败，请重试。');
          if (nextInspections.some(entry => entry.inspectionId === value.inspectionId)) continue;
          nextInspections = [...nextInspections, value];
          for (const candidate of value.candidates) {
            const key = keyFor(value.inspectionId, candidate.id);
            if (candidate.status !== 'incomplete') nextSelected.push(key);
            nextChoices[key] = { fps: candidate.metadata?.fps, loop: candidate.metadata?.loop };
          }
          setInspections(nextInspections); setSelected(nextSelected); setChoices(nextChoices);
          try { persist(nextInspections, nextSelected, nextChoices, null); } catch { /* Commit requires durable recovery below. */ }
        } catch (e) { errors.push(`${file.name}：${(e as Error).message}`); }
      }
      setError(errors.join('\n'));
    } finally { end(); }
  }
  function updateChoice(key: string, patch: Partial<Parameters>) {
    const next = { ...choices, [key]: { ...choices[key], ...patch } };
    setChoices(next);
    try { persist(inspections, selected, next, null); } catch { /* Retry at commit. */ }
  }
  function toggle(key: string, checked: boolean) {
    const next = checked ? [...selected, key] : selected.filter(value => value !== key);
    setSelected(next);
    try { persist(inspections, next, choices, null); } catch { /* Retry at commit. */ }
  }
  const missing = inspections.flatMap(inspection => inspection.candidates.flatMap(candidate => {
    const key = keyFor(inspection.inspectionId, candidate.id), value = choices[key] || {};
    if (!selected.includes(key)) return [];
    return candidate.requiredParameters.filter(parameter => parameter.key === 'fps'
      ? !Number.isFinite(value.fps) || Number(value.fps) <= 0
      : parameter.key === 'loop' ? typeof value.loop !== 'boolean' : !value.definitionIds?.length)
      .map(parameter => `${candidate.label}：${parameter.label}`);
  }));
  async function commit() {
    if (lock.current || (!pending && (!selected.length || missing.length))) return;
    const submission = commitRequest.current || {
      commandId: crypto.randomUUID(), inspectionIds: inspections.map(value => value.inspectionId),
      selections: packageSelections(inspections, selected, choices),
    };
    try { persist(inspections, selected, choices, submission); }
    catch { setError('浏览器无法保存提交恢复记录，请允许本机存储后重试。尚未提交入库。'); return; }
    commitRequest.current = submission; setPending(submission); begin('正在确认入库…');
    try {
      const response = await fetch('/api/workbench/assets/packages/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
      const value = await response.json() as Receipt & { error?: string };
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409 && response.status !== 429) {
          commitRequest.current = null; setPending(null); persist(inspections, selected, choices, null);
        }
        throw new Error(value.error || '提交结果未确认，请使用原请求重试。');
      }
      if (value.status !== 'completed' || !Array.isArray(value.assets)) throw new Error('未收到入库回执，请使用原请求重试。');
      commitRequest.current = null; setPending(null); setReceipt(value);
      const { inspections: remaining, selected: remainingSelected, choices: remainingChoices } = remainingPackageChoices(inspections, selected, choices, submission);
      setInspections(remaining); setSelected(remainingSelected); setChoices(remainingChoices);
      try {
        if (remaining.length) persist(remaining, remainingSelected, remainingChoices, null);
        else sessionStorage.removeItem(recoveryKey);
      } catch { /* The completed command remains safe to replay if browser storage becomes unavailable. */ }
      onImported(value.assets.map(asset => asset.id));
    } catch (e) { setError((e as Error).message); }
    finally { end(); }
  }
  const disabled = Boolean(busy || pending);
  return <Dialog open onOpenChange={open => { if (!open && !lock.current) onClose(); }}>
    <DialogContent className="wb-import-modal" showCloseButton={!busy} style={{ maxWidth: 880, maxHeight: '88vh', overflowY: 'auto' }}>
      <DialogHeader>
        <DialogTitle>导入 Forge 素材包</DialogTitle>
        <DialogDescription>选择资产库下载的 ZIP 或编辑器源文件。先检查可恢复内容，确认后保存到资产库。</DialogDescription>
      </DialogHeader>
      {receipt ? <>
        <output>已导入 {receipt.importedCount} 件，复用 {receipt.reusedCount} 件已有素材。</output>
        <ul>{receipt.assets.map(asset => <li key={asset.id}><a href={asset.viewPath}>{asset.label}</a>{asset.reused ? ' · 已有素材' : ' · 新素材'}</li>)}</ul>
        {!!inspections.length && <button className="wb-button" onClick={() => setReceipt(null)}>继续处理剩余项</button>}
        <button className="wb-button wb-primary" onClick={onClose}>返回资产库</button>
      </> : <>
        <label className="wb-notice">
          选择文件或拖入此处，可一次选择多个源包
          <input type="file" multiple onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!disabled) void inspect(Array.from(event.dataTransfer.files)); }} accept=".zip,.json,.png,.jpg,.jpeg,.webp,.gif,.psd" aria-label="选择 Forge 素材包" disabled={disabled} onChange={event => { void inspect(Array.from(event.target.files || [])); event.target.value = ''; }} style={{ display: 'block', marginTop: 12, maxWidth: '100%' }} />
        </label>
        {busy && <output>{busy}</output>}
        {pending && !busy && <output>上次提交结果尚未确认。重试会使用同一请求，不会重复创建素材。</output>}
        {error && <p role="alert" style={{ whiteSpace: 'pre-wrap' }}>{error}</p>}
        {inspections.map(inspection => <section key={inspection.inspectionId}>
          <h3 style={{ overflowWrap: 'anywhere' }}>{inspection.filename}</h3>
          {inspection.candidates.map(candidate => {
            const key = keyFor(inspection.inspectionId, candidate.id), value = choices[key] || {};
            return <fieldset key={key} disabled={disabled || candidate.status === 'incomplete'} style={{ padding: '16px 0', borderBottom: '1px solid var(--wb-line)' }}>
              <label><input type="checkbox" checked={selected.includes(key)} onChange={event => toggle(key, event.target.checked)} /> {candidate.label} · {candidate.mapType === 'project' ? '地图工程' : kinds[candidate.kind] || candidate.kind} · {statuses[candidate.status]}</label>
              {candidate.previewUrl && <PackageCandidatePreview key={candidate.previewUrl + String(value.fps) + String(value.loop)} url={candidate.previewUrl} frames={candidate.frameCount || candidate.metadata?.frameCount || 1} fps={value.fps} loop={value.loop} durations={candidate.metadata?.frameDurations} />}
              <p>{candidate.recoverable.join('；')}</p>
              {candidate.duplicate && <p>{candidate.duplicate.exact ? '相同素材已存在，将复用已有资产。' : '同来源存在不同内容，将保留原件并创建副本。'}</p>}
              {[...candidate.warnings, ...candidate.missing].map((message, i) => <p key={i} className="wb-muted">{message}</p>)}
              {candidate.requiredParameters.some(parameter => parameter.key === 'fps') && <label>播放帧率 <input type="number" min="1" max="120" step="1" value={value.fps ?? ''} onChange={event => updateChoice(key, { fps: event.target.value ? Number(event.target.value) : undefined })} /></label>}
              {candidate.requiredParameters.some(parameter => parameter.key === 'loop') && <label style={{ marginLeft: 12 }}>播放方式 <select value={value.loop === undefined ? '' : String(value.loop)} onChange={event => updateChoice(key, { loop: event.target.value === '' ? undefined : event.target.value === 'true' })}><option value="">请选择</option><option value="true">循环</option><option value="false">单次</option></select></label>}
              {candidate.requiredParameters.some(parameter => parameter.key === 'definitionIds') && <div>选择要恢复的物件：{candidate.objects?.map(object => <label key={object.definitionId} style={{ display: 'block' }}><input type="checkbox" checked={value.definitionIds?.includes(object.definitionId) || false} onChange={event => updateChoice(key, { definitionIds: event.target.checked ? [...value.definitionIds || [], object.definitionId] : value.definitionIds?.filter(id => id !== object.definitionId) })} />{object.displayName}</label>)}</div>}
            </fieldset>;
          })}
        </section>)}
        {!!missing.length && <output>确认入库前请补充：{missing.join('；')}</output>}
        <div className="wb-tool-links">
          <button className="wb-button" disabled={Boolean(busy)} onClick={onClose}>关闭</button>
          {!!inspections.length && !pending && <button className="wb-button" disabled={Boolean(busy)} onClick={() => { setInspections([]); setSelected([]); setChoices({}); sessionStorage.removeItem(recoveryKey); setError(''); }}>清空检查结果</button>}
          <button className="wb-button wb-primary" disabled={Boolean(busy) || (!pending && (!selected.length || !!missing.length))} onClick={() => void commit()}>{pending ? '恢复原请求并确认结果' : `确认入库（${selected.length}）`}</button>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
