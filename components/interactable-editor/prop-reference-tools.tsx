'use client';
/* oxlint-disable next/no-img-element -- exact local prop previews */
import { useEffect, useRef, useState } from 'react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useWorkbench } from '@/components/workbench/workbench-provider';
import { propArtJson, propImagePath } from '@/features/interactable-editor/prop-art.mjs';
import type { StoredTask } from '@/lib/workbench/work-items';
import { motionReferenceObjects, motionRequest, type MotionReferenceObject } from '@/components/sprite-generator/open-motion-model';
import './prop-reference-tools.css';

type Recipe = { size: number; padding: number; anchor: string; resample: string; alphaThreshold: number; colors: number; removeIsolated: boolean; dither: boolean; outline: string; background: string; palette?: string };
type Report = { colors: number; semiTransparentPixels: number; semiTransparentRatio?: number; warnings?: string[]; recipeSha256?: string };
type Preview = { image: string; compare: string; report: Report };
const defaults: Recipe = { size: 128, padding: 4, anchor: 'bottom', resample: 'area', alphaThreshold: 128, colors: 24, removeIsolated: true, dither: false, outline: 'none', background: 'alpha' };
const artifact = (path: string) => `/api/workbench/artifacts?path=${encodeURIComponent(path)}`;
const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const isImageProp = (t: StoredTask) => t.status === 'completed' && t.capabilityId === 'image-assets' && (t.input?.operation === 'generate-prop' || (t.input?.operation === 'edit-image' && t.input?.kind === 'prop'));

export function propProvenanceLabel(type?: string) {
  return type === 'import' ? '导入' : type === 'convert-prop' ? '转换' : 'PixelLab 生成';
}

export function PropReferenceTools({ objectName = '', initialSourceTaskId = '', disabled = false, onTransferred, beforeSave, onBusy, onSaved }: {
  objectName?: string; initialSourceTaskId?: string; disabled?: boolean;
  onTransferred?: (id: string) => Promise<void>; beforeSave?: () => Promise<void>;
  onBusy?: (busy: boolean) => void; onSaved?: (task: StoredTask) => void;
}) {
  const { refresh } = useWorkbench();
  const [open, setOpen] = useState(!!initialSourceTaskId);
  const [mode, setMode] = useState<'import' | 'convert-prop'>(initialSourceTaskId ? 'convert-prop' : 'import');
  const [sourceTaskId, setSourceTaskId] = useState(initialSourceTaskId);
  const [upload, setUpload] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadReport, setUploadReport] = useState<Report | null>(null);
  const [tasks, setTasks] = useState<StoredTask[]>([]);
  const [historyPage, setHistoryPage] = useState<{ offset: number; snapshot: string } | null>(null);
  const [objects, setObjects] = useState<MotionReferenceObject[]>([]);
  const [recipe, setRecipe] = useState<Recipe>(defaults);
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [task, setTask] = useState<StoredTask | null>(null);
  const [savedReport, setSavedReport] = useState<Report | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [href, setHref] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [background, setBackground] = useState('checker');
  const lock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const uploadEpoch = useRef(0);
  const cache = useRef(new Map<string, Preview>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void propArtJson<{ tasks: StoredTask[]; nextOffset: number | null; snapshot: string }>('/api/workbench/tasks?limit=200&capabilityId=image-assets&status=completed').then(v => {
      if (cancelled) return;
      setTasks(v.tasks.filter(isImageProp));
      setHistoryPage(v.nextOffset === null ? null : {offset: v.nextOffset, snapshot: v.snapshot});
      const initialPrompt = v.tasks.find(t => t.id === initialSourceTaskId)?.input?.prompt;
      if (typeof initialPrompt === 'string') setPrompt(p => p || initialPrompt.slice(0, 1800));
    }).catch(e => { if (!cancelled) setMessage((e as Error).message); });
    void motionRequest<{ objects?: MotionReferenceObject[] }>('open-motion/references').then(v => {
      if (!cancelled) setObjects(motionReferenceObjects(v).filter(o => o.valid && o.object_type === 'interactable' && (!o.provenance || o.provenance.type === 'pixellab')));
    }).catch(() => { /* Upload/import works even when the object library is offline. */ });
    return () => { cancelled = true; };
  }, [open, initialSourceTaskId]);
  const source = sourceTaskId ? { sourceTaskId } : upload ? { sourceImage: upload } : null;
  const requestKey = JSON.stringify({ source, recipe });
  useEffect(() => {
    const {source: previewSource, recipe: previewRecipe} = JSON.parse(requestKey) as {source: {sourceTaskId?: string; sourceImage?: string} | null; recipe: Recipe};
    if (!open || mode !== 'convert-prop' || !previewSource) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setPreviewing(true); setPreview(null); setMessage('');
        try {
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestKey))), b => b.toString(16).padStart(2, '0')).join('');
          if (cancelled) return;
          const value = cache.current.get(hash) || await propArtJson<Preview>('/api/workbench/reference-art/convert-prop/preview', post({ ...previewSource, recipe: previewRecipe }));
          if (cancelled) return;
          if (!cache.current.has(hash) && cache.current.size >= 8) cache.current.delete(cache.current.keys().next().value!);
          cache.current.set(hash, value); setPreview(value);
        } catch (e) { if (!cancelled) setMessage((e as Error).message); }
        finally { if (!cancelled) setPreviewing(false); }
      })();
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, mode, requestKey]);
  const invalidate = () => { setTask(null); setSavedReport(null); setConfirmation(''); setHref(''); setPreview(null); setMessage(''); };
  const patchRecipe = (patch: Partial<Recipe>) => { invalidate(); setRecipe(r => ({ ...r, ...patch })); };
  const chooseTask = async (id: string) => {
    uploadEpoch.current++; invalidate(); setSourceTaskId(id); setUpload(''); setUploadReport(null);
    const selected = tasks.find(t => t.id === id);
    if (selected && typeof selected.input?.prompt === 'string') setPrompt(selected.input?.prompt.slice(0, 1800));
  };
  const olderTasks = () => action(async () => {
    if (!historyPage) return;
    const page = await propArtJson<{tasks: StoredTask[]; nextOffset: number | null; snapshot: string}>(`/api/workbench/tasks?limit=200&capabilityId=image-assets&status=completed&offset=${historyPage.offset}&snapshot=${historyPage.snapshot}`);
    if (!alive.current) return;
    setTasks(current => [...current, ...page.tasks.filter(isImageProp).filter(t => !current.some(old => old.id === t.id))]);
    setHistoryPage(page.nextOffset === null ? null : {offset: page.nextOffset, snapshot: page.snapshot});
  });
  const readUpload = async (file?: File) => {
    if (!file) return;
    const epoch = ++uploadEpoch.current;
    invalidate(); setUpload(''); setSourceTaskId(''); setUploadReport(null);
    try {
      if (file.size > (mode === 'import' ? 2_000_000 : 30_000_000)) throw new Error(mode === 'import' ? '导入 PNG 不得超过 2 MB。' : '源图片不得超过 30 MB。');
      if (!(mode === 'import' ? ['image/png'] : ['image/png', 'image/jpeg', 'image/webp']).includes(file.type)) throw new Error('请选择支持的图片格式。');
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('图片读取失败')); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
      const image = new Image(); image.src = data; await image.decode();
      if (Math.max(image.width, image.height) > 4096) throw new Error('源图片最长边不得超过 4096。');
      if (mode === 'import' && (image.width !== 128 || image.height !== 128)) throw new Error('请使用 128 × 128；大图可用“从物品图转换”。');
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const colors = new Set<number>(); let visible = 0, semi = 0, transparent = 0;
      for (let i = 0; i < pixels.length; i += 4) { if (pixels[i+3] < 255) transparent++; if (pixels[i+3]) { visible++; if (pixels[i+3] < 255) semi++; colors.add((pixels[i]<<16)|(pixels[i+1]<<8)|pixels[i+2]); } }
      if (!visible || (mode === 'import' && !transparent)) throw new Error('原图必须有可见内容和透明背景。');
      if (!alive.current || epoch !== uploadEpoch.current) return;
      setUpload(data); setUploadName(file.name); setUploadReport({colors: colors.size, semiTransparentPixels: semi, semiTransparentRatio: semi / visible});
    } catch (e) { if (alive.current && epoch === uploadEpoch.current) setMessage((e as Error).message); }
  };
  const action = async (run: () => Promise<void>) => {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); onBusy?.(true); setMessage('');
    try { await run(); } catch (e) { if (alive.current) setMessage((e as Error).message); }
    finally { lock.current = false; if (alive.current) setBusy(false); onBusy?.(false); }
  };
  const save = () => action(async () => {
    if (!source || !prompt.trim()) return;
    await beforeSave?.();
    const created = await propArtJson<{ taskId: string; status: string; error?: string }>('/api/workbench/tasks', post({ capabilityId: 'reference-art', input: { operation: mode, subject: 'prop', ...source, ...(mode === 'convert-prop' ? {recipe} : {}), prompt: prompt.trim(), name: (objectName || uploadName || '物品原图').slice(0, 80) } }));
    if (created.status !== 'completed') throw new Error(created.error || '保存未完成，请查看原任务。');
    const saved = (await propArtJson<{task: StoredTask}>(`/api/workbench/tasks/${encodeURIComponent(created.taskId)}`)).task;
    if (!alive.current) return;
    setTask(saved); setConfirmation(''); setHref(''); onSaved?.(saved); void refresh();
    const file = saved.outputs?.find(p => p.endsWith('/result.json'));
    if (file) { const result = await propArtJson<{diagnostics?: Report}>(artifact(file)); if (alive.current) setSavedReport(result.diagnostics || null); }
    setMessage('已保存本地任务，未调用付费接口。检查后填写确认说明。');
  });
  const transfer = () => action(async () => {
    if (!task || confirmation.trim().length < 4) return;
    const created = await propArtJson<{status: string; outputs: string[]; error?: string}>('/api/workbench/tasks', post({ capabilityId: 'reference-art', input: { operation: 'transfer', sourceTaskId: task.id, confirmation: {note: confirmation.trim()} } }));
    const file = created.outputs?.find(p => p.endsWith('/result.json'));
    if (created.status !== 'completed' || !file) throw new Error(created.error || '移送未完成。');
    const result = await propArtJson<{objectId: string; href: string; sourceTaskId: string}>(artifact(file));
    if (result.sourceTaskId !== task.id || !/^reference_[a-f0-9]{24}$/.test(result.objectId)) throw new Error('移送回执无效。');
    if (alive.current) setHref(result.href);
    await onTransferred?.(result.objectId);
  });
  const selectedSource = tasks.find(t => t.id === sourceTaskId);
  const sourcePath = selectedSource?.outputs?.find(p => p.endsWith('/image.png'));
  const sourceUrl = upload || (sourcePath ? artifact(sourcePath) : '');
  const savedPath = propImagePath(task);
  const resultUrl = savedPath ? artifact(savedPath) : mode === 'convert-prop' && preview ? 'data:image/png;base64,' + preview.image : mode === 'import' ? upload : '';
  const report = savedReport || (mode === 'convert-prop' ? preview?.report : uploadReport);
  const blocked = disabled || busy;
  return <details className="prop-reference-tools" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>导入 PNG / 从物品图转换</summary>
    <dialog ref={dialog} className="prop-tools-dialog" aria-label="物品原图导入与转换" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
    <div className="prop-tools-heading"><h3>物品原图导入与转换</h3><button disabled={busy} onClick={() => setOpen(false)}>关闭</button></div>
    <p>本机处理，无需额度。保存为 128 × 128 透明原图后，确认并移送到交互物动画。</p>
    <div role="tablist" aria-label="物品原图来源">
      <button role="tab" aria-selected={mode === 'import'} disabled={blocked} onClick={() => { uploadEpoch.current++; invalidate(); setUpload(''); setSourceTaskId(''); setMode('import'); }}>导入 128 px 物品原图</button>
      <button role="tab" aria-selected={mode === 'convert-prop'} disabled={blocked} onClick={() => { invalidate(); setMode('convert-prop'); }}>从物品图转换</button>
    </div>
    <div className="prop-tools-workspace">
    <fieldset disabled={blocked} className="prop-source-controls">
      {mode === 'convert-prop' && <label>GPT Image 物品任务<NativeSelect aria-label="转换源任务" value={sourceTaskId} onChange={e => void chooseTask(e.target.value)}>
        <NativeSelectOption value="">选择历史物品任务，或上传文件</NativeSelectOption>
        {initialSourceTaskId && !tasks.some(t => t.id === initialSourceTaskId) && <NativeSelectOption value={initialSourceTaskId}>当前物品候选</NativeSelectOption>}
        {tasks.map(t => <NativeSelectOption key={t.id} value={t.id}>{typeof t.input?.name === 'string' ? t.input.name : t.id}</NativeSelectOption>)}
      </NativeSelect></label>}
      {mode === 'convert-prop' && historyPage && <button onClick={() => void olderTasks()}>加载更早的物品任务</button>}
      <label>{mode === 'import' ? '选择 128 px PNG' : '上传物品图'}<input aria-label="物品源图片" type="file" accept={mode === 'import' ? 'image/png' : 'image/png,image/jpeg,image/webp'} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void readUpload(file); }} /></label>

      <label>物品外观说明<textarea aria-label="导入物品外观说明" rows={3} maxLength={1800} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述视角、初始状态、主要部件与颜色" /></label>
    </fieldset>
    <div className="prop-preview-column">
    {previewing && mode === 'convert-prop' && <output>正在本地预览…</output>}
    {resultUrl && <>
      <label>预览背景<NativeSelect aria-label="预览背景" value={background} onChange={e => setBackground(e.target.value)}><NativeSelectOption value="checker">棋盘格</NativeSelectOption><NativeSelectOption value="light">浅色</NativeSelectOption><NativeSelectOption value="dark">深色</NativeSelectOption></NativeSelect></label>
      <div className={'prop-convert-preview prop-bg-' + background}>
        {mode === 'convert-prop' && sourceUrl && <figure><img className="prop-source" src={sourceUrl} alt="转换源图" /><figcaption>源图</figcaption></figure>}
        <figure><img src={resultUrl} alt="物品原图 1 倍预览" width={128} height={128} /><figcaption>1× · 128 px</figcaption></figure>
        <figure><img className="prop-result-4x" src={resultUrl} alt="物品原图 4 倍预览" width={512} height={512} /><figcaption>4×</figcaption></figure>
      </div>
    </>}
    {report && <p>颜色数：{report.colors} · 半透明像素：{report.semiTransparentPixels}（{((report.semiTransparentRatio || 0) * 100).toFixed(1)}%）</p>}
    {report && report.colors > 64 && (report.semiTransparentRatio || 0) > .1 && <output>颜色和半透明像素较多，请检查是否符合像素画要求；也可尝试转换。</output>}
    {report?.warnings?.map(w => <output key={w}>{w}</output>)}
    </div>
      {mode === 'convert-prop' && <fieldset disabled={blocked} className="prop-convert-parameters">
        <label>转换预设<NativeSelect aria-label="转换预设" value="" onChange={e => {
          const preset = e.target.value;
          patchRecipe(preset === 'pixel' ? {...defaults, resample: 'nearest', colors: 0, removeIsolated: false} : preset === 'lines' ? {...defaults, resample: 'dominant', colors: 32, removeIsolated: false, alphaThreshold: 80} : {...defaults});
        }}><NativeSelectOption value="">选择预设</NativeSelectOption><NativeSelectOption value="flat">平涂插画</NativeSelectOption><NativeSelectOption value="lines">细线较多</NativeSelectOption><NativeSelectOption value="pixel">已是像素画</NativeSelectOption></NativeSelect></label>
        <label>缩小方式<NativeSelect aria-label="缩小方式" value={recipe.resample} onChange={e => patchRecipe({resample: e.target.value})}>{['area', 'dominant', 'nearest'].map(v => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></label>
        <label>对齐<NativeSelect aria-label="主体对齐" value={recipe.anchor} onChange={e => patchRecipe({anchor: e.target.value})}><NativeSelectOption value="bottom">底部</NativeSelectOption><NativeSelectOption value="center">居中</NativeSelectOption></NativeSelect></label>
        <label>留白<input aria-label="转换留白" type="number" min={0} max={16} value={recipe.padding} onChange={e => patchRecipe({padding: Number(e.target.value)})} /></label>
        <label>颜色数（0 不合并）<input aria-label="转换颜色数" type="number" min={0} max={64} value={recipe.colors} onChange={e => patchRecipe({colors: Number(e.target.value)})} /></label>
        <label>透明度阈值<input aria-label="透明度阈值" type="number" min={1} max={254} value={recipe.alphaThreshold} onChange={e => patchRecipe({alphaThreshold: Number(e.target.value)})} /></label>
        <label>外轮廓<NativeSelect aria-label="外轮廓" value={recipe.outline} onChange={e => patchRecipe({outline: e.target.value})}><NativeSelectOption value="none">无</NativeSelectOption><NativeSelectOption value="dark">深色 1 px</NativeSelectOption></NativeSelect></label>
        <label>背景<NativeSelect aria-label="源背景处理" value={recipe.background === 'alpha' ? 'alpha' : 'key'} onChange={e => patchRecipe({background: e.target.value === 'alpha' ? 'alpha' : 'key:#ffffff'})}><NativeSelectOption value="alpha">使用透明背景</NativeSelectOption><NativeSelectOption value="key">按颜色抠除</NativeSelectOption></NativeSelect></label>
        {recipe.background !== 'alpha' && <label>抠除颜色<input aria-label="抠除颜色" type="color" value={recipe.background.slice(4)} onChange={e => patchRecipe({background: 'key:' + e.target.value})} /></label>}
        <label>沿用已有物品调色板<NativeSelect aria-label="物品调色板" value={recipe.palette || ''} onChange={e => patchRecipe({palette: e.target.value || undefined})}><NativeSelectOption value="">自动调色板</NativeSelectOption>{objects.map(o => <NativeSelectOption key={o.id} value={'object:' + o.id}>{o.name} · PixelLab</NativeSelectOption>)}</NativeSelect></label>
        <label><input type="checkbox" checked={recipe.removeIsolated} onChange={e => patchRecipe({removeIsolated: e.target.checked})} />清理孤立像素</label>
        <label><input type="checkbox" checked={recipe.dither} onChange={e => patchRecipe({dither: e.target.checked})} />抖动</label>
      </fieldset>}
    </div>
    <button disabled={blocked || !source || !prompt.trim() || (mode === 'convert-prop' && (!preview || previewing))} onClick={() => void save()}>{mode === 'import' ? '保存为导入任务' : '保存转换结果'}</button>
    {task && <div className="prop-transfer-confirmation">
      <p>{mode === 'import' ? '导入' : '转换'}任务：{task.id}</p>
      <label>确认说明<textarea aria-label="移送确认说明" rows={3} minLength={4} maxLength={1000} value={confirmation} disabled={blocked} onChange={e => setConfirmation(e.target.value)} placeholder="请实际核对视角、初始状态、部件完整与透明背景，再填写说明（至少 4 字）" /></label>
      <button disabled={blocked || confirmation.trim().length < 4} onClick={() => void transfer()}>用作交互物动画对象</button>
      {savedPath && <a href={artifact(savedPath)} download>下载 128 px PNG</a>}
      {href && <a href={href}>打开交互物动画</a>}
    </div>}
    {message && <output>{message}</output>}
    </dialog>
  </details>;
}
