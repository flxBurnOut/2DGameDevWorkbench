'use client';
/* oxlint-disable next/no-img-element -- Display exact generated artifacts and reference uploads. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, KeyRound, LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react';
import { useWorkbench } from '@/components/workbench/workbench-provider';
import { ImageEditWorkspace } from '@/components/image-edit/image-edit-workspace';
import type { StoredTask } from '@/lib/workbench/work-items';
import { validateImageAssetDimensions } from '@/lib/workbench/image-dimensions.mjs';
import {
  imageArtifactUrl, imageAssetJson, imageAssetKind, imageAssetPath, imageReferenceUpload, readImageAsset,
  type ImageAssetKind,
} from '@/features/image-assets/browser-client.mjs';
import './image-assets.css';

const statusLabels: Record<string, string> = {
  running: '正在生成', completed: '图片已保存，待采用', failed: '生成失败',
  attention_required: '需要处理', awaiting_configuration: '等待配置', prepared: '尚未生成',
};
type Settings = { active: boolean; provider: string | null; providers: { id: string; configured: boolean; name: string; model: string }[] };
type Reference = { name: string; data: string; bytes: number };
const taskName = (task: StoredTask) => typeof task.input?.name === 'string' ? task.input.name : '图片';
const presetSizes = ['1024x1024', '1536x1024', '1024x1536'];
type OutputSize = { preset: string; width: string; height: string };
function outputSize(kind: ImageAssetKind, dimensions?: { width?: unknown; height?: unknown }): OutputSize {
  const hasDimensions = typeof dimensions?.width === 'number' && typeof dimensions?.height === 'number';
  const [width, height] = hasDimensions
    ? [String(dimensions.width), String(dimensions.height)] : (kind === 'prop' ? '1024x1024' : '1536x1024').split('x');
  return { preset: presetSizes.includes(`${width}x${height}`) ? `${width}x${height}` : 'custom', width, height };
}

export function ImageAssetsPanel({
  kind, name, disabled = false, beforeGenerate, onAdopt, onBusy, adoptionLabel,
}: {
  kind: ImageAssetKind;
  name: string;
  disabled?: boolean;
  beforeGenerate?: () => Promise<void>;
  onAdopt: (taskId: string) => Promise<void>;
  onBusy?: (busy: boolean) => void;
  adoptionLabel: string;
}) {
  const { tasks, refresh } = useWorkbench();
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState(() => outputSize(kind));
  const [references, setReferences] = useState<Reference[]>([]);
  const [selected, setSelected] = useState<StoredTask | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingTask, setLoadingTask] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [message, setMessage] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const [localEditTask, setLocalEditTask] = useState<string | null>(null);
  const actionLock = useRef(false);
  const alive = useRef(true);
  const selectionEpoch = useRef(0);
  const previousKind = useRef(kind);
  const input = useRef<HTMLInputElement>(null);
  const image = imageAssetPath(selected);
  const selectedId = selected?.id;
  const configured = settings?.providers.some((provider) => provider.id === 'gpt-image-2.6' && provider.configured) === true;
  const running = selected?.status === 'running';
  let sizeError = '';
  try { validateImageAssetDimensions(Number(size.width), Number(size.height)); }
  catch (error) { sizeError = (error as Error).message; }

  const checkSettings = useCallback(async () => {
    try {
      const value = await imageAssetJson<Settings>('/api/workbench/image-assets/settings');
      if (alive.current) { setSettings(value); setSettingsMessage(''); }
    } catch (error) {
      if (alive.current) { setSettings(null); setSettingsMessage((error as Error).message); }
    }
  }, []);
  const selectTask = useCallback(async (id: string) => {
    const epoch = ++selectionEpoch.current;
    setLoadingTask(true);
    try {
      const { task } = await imageAssetJson<{ task: StoredTask }>(`/api/workbench/tasks/${encodeURIComponent(id)}`);
      if (!alive.current || epoch !== selectionEpoch.current) return;
      if (imageAssetKind(task) !== kind) throw new Error('这张图片的类型与当前编辑器不符。');
      setSelected(task);
      setPrompt(typeof task.input?.prompt === 'string' ? task.input.prompt : '');
      setSize(outputSize(kind, task.input));
      setMessage('');
      if (typeof task.input?.width !== 'number' || typeof task.input?.height !== 'number') {
        const resultPath = task.status === 'completed' && task.outputs?.find(path => path.endsWith(`/${task.id}/result.json`));
        if (resultPath) {
          try {
            const result = await imageAssetJson<{ width?: unknown; height?: unknown }>(imageArtifactUrl(resultPath));
            if (!alive.current || epoch !== selectionEpoch.current) return;
            if (typeof result.width !== 'number' || typeof result.height !== 'number') throw new Error('尺寸记录缺失');
            setSize(outputSize(kind, result));
          } catch {
            if (!alive.current || epoch !== selectionEpoch.current) return;
            setMessage('未能读取此任务的输出尺寸，已恢复默认尺寸；再次生成前请确认。');
          }
        } else setMessage('此任务未记录输出尺寸，已恢复默认尺寸；再次生成前请确认。');
      }
      const url = new URL(location.href);
      url.searchParams.set('imageTask', id);
      history.replaceState(null, '', url.pathname + url.search);
    } catch (error) {
      if (alive.current && epoch === selectionEpoch.current) setMessage((error as Error).message);
    } finally {
      if (alive.current && epoch === selectionEpoch.current) setLoadingTask(false);
    }
  }, [kind]);
  useEffect(() => {
    if (previousKind.current === kind) return;
    previousKind.current = kind;
    selectionEpoch.current++;
    setSize(outputSize(kind)); setSelected(null); setPrompt(''); setReferences([]); setMessage(''); setLoadingTask(false);
  }, [kind]);
  useEffect(() => {
    alive.current = true;
    const timer = setTimeout(() => {
      void checkSettings();
      const id = new URLSearchParams(location.search).get('imageTask');
      if (id) void selectTask(id);
    }, 0);
    window.addEventListener('focus', checkSettings);
    return () => { alive.current = false; clearTimeout(timer); window.removeEventListener('focus', checkSettings); };
  }, [checkSettings, selectTask]);
  useEffect(() => {
    if (!selectedId || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { task, refreshError } = await imageAssetJson<{ task: StoredTask; refreshError?: string }>(`/api/workbench/tasks/${encodeURIComponent(selectedId)}?refresh=true`);
        if (!stopped) {
          if (task.id !== selectedId || imageAssetKind(task) !== kind) throw new Error('任务状态响应不匹配。');
          setSelected(task); setMessage(refreshError || '');
          if (task.status !== 'running') { void refresh(); return; }
        }
      } catch (error) { if (!stopped) setMessage((error as Error).message); }
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [selectedId, running, kind, refresh]);

  const withAction = async (action: () => Promise<void>) => {
    if (actionLock.current || disabled) return;
    actionLock.current = true; setBusy(true); onBusy?.(true); setMessage('');
    try { await action(); }
    catch (error) { if (alive.current) setMessage((error as Error).message); }
    finally {
      actionLock.current = false;
      if (alive.current) setBusy(false);
      onBusy?.(false);
    }
  };
  const generate = () => withAction(async () => {
    if (!prompt.trim() || !configured || running || loadingTask) return;
    const { width, height } = validateImageAssetDimensions(Number(size.width), Number(size.height));
    await beforeGenerate?.();
    const result = await imageAssetJson<{ taskId: string }>('/api/workbench/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilityId: 'image-assets', input: {
        operation: kind === 'prop' ? 'generate-prop' : 'generate-background',
        provider: 'gpt-image-2.6', name: name.slice(0, 80), prompt: prompt.trim(), width, height,
        ...(references.length ? { references: references.map((reference) => reference.data) } : {}),
      } }),
    });
    if (!result.taskId) throw new Error('未收到任务编号，请从制作记录检查本次提交；不要直接重复生成。');
    if (alive.current) await selectTask(result.taskId);
    void refresh();
  });
  const adopt = () => withAction(async () => {
    if (!selectedId || !image) return;
    await onAdopt(selectedId);
    if (alive.current) setMessage(kind === 'prop' ? '已采用为当前物件默认图片，草稿将自动保存。' : '背景已载入地图，可继续编辑并用于制作场景。');
  });
  const cleanAlpha = () => withAction(async () => {
    if (!selectedId || !image || kind !== 'prop' || running) return;
    const verified = await readImageAsset(selectedId, kind);
    const result = await imageAssetJson<{ taskId: string }>('/api/workbench/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilityId: 'image-assets', input: { operation: 'process-image', kind, image: verified.imagePath, alphaCleanupThreshold: 1, name: `${verified.name} · 清理透明噪点`.slice(0, 80) } }),
    });
    if (!result.taskId) throw new Error('未收到本地处理记录，请刷新制作记录检查。');
    if (alive.current) {
      await selectTask(result.taskId);
      setMessage('已生成本地处理版本：仅清理 Alpha=1 的极淡像素，原图保留，尚未采用。没有调用图片 API。');
    }
    void refresh();
  });
  const upload = (files: File[]) => withAction(async () => {
    if (references.length + files.length > 8) throw new Error('最多添加 8 张参考图。');
    if (references.reduce((sum, reference) => sum + reference.bytes, 0) + files.reduce((sum, file) => sum + file.size, 0) > 80 * 1024 * 1024)
      throw new Error('参考图总计不能超过 80 MB。');
    const incoming: Reference[] = [];
    for (const file of files) incoming.push({ name: file.name, data: await imageReferenceUpload(file), bytes: file.size });
    if (alive.current) setReferences((current) => [...current, ...incoming]);
  });
  const saveKey = async () => {
    if (savingKey || !apiKey.trim()) return;
    setSavingKey(true); setSettingsMessage('');
    try {
      const value = await imageAssetJson<Settings>('/api/workbench/image-assets/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'gpt-image-2.6', active: true, apiKey: apiKey.trim() }),
      });
      if (alive.current) { setSettings(value); setSettingsMessage('密钥已保存在本机，与地图图片生成共用。'); }
    } catch (error) { if (alive.current) setSettingsMessage((error as Error).message); }
    finally { if (alive.current) { setApiKey(''); setSavingKey(false); } }
  };
  return <div className="image-assets-panel" data-image-assets-kind={kind} aria-busy={busy || running}>
    <p>{kind === 'prop' ? '描述独立物件，生成透明 PNG。预览后采用到当前物件。' : '描述场景背景，可添加风格或构图参考。预览后用作地图中心图。'}</p>
    <label>{kind === 'prop' ? '透明物件描述' : '场景背景描述'}
      <textarea aria-label={kind === 'prop' ? '透明物件描述' : '场景背景描述'} rows={4} maxLength={12000} value={prompt} disabled={busy || running} onChange={(event) => setPrompt(event.target.value)} placeholder={kind === 'prop' ? '侧视的废弃金属宝箱，蓝色外壳、黄色锁扣，完整轮廓。' : '纯 2D 横版森林营地，远处树木与山脉，留出地面活动空间，无人物、无文字。'} />
    </label>
    <label>输出尺寸
      <select aria-label="图片输出尺寸" value={size.preset} disabled={disabled || busy || running || loadingTask} onChange={(event) => {
        const preset = event.target.value;
        if (preset === 'custom') setSize(current => ({ ...current, preset }));
        else { const [width, height] = preset.split('x'); setSize({ preset, width, height }); }
      }}>
        <option value="1024x1024">1024 × 1024 · 方形</option>
        <option value="1536x1024">1536 × 1024 · 横向</option>
        <option value="1024x1536">1024 × 1536 · 竖向</option>
        <option value="custom">自定义宽高</option>
      </select>
    </label>
    {size.preset === 'custom' && <div className="image-assets-actions">
      <label>宽度（像素）<input type="number" aria-label="自定义图片宽度" min={16} max={3840} step={16} value={size.width} disabled={disabled || busy || running || loadingTask} aria-invalid={!!sizeError} onChange={event => setSize(current => ({ ...current, width: event.target.value }))} /></label>
      <label>高度（像素）<input type="number" aria-label="自定义图片高度" min={16} max={3840} step={16} value={size.height} disabled={disabled || busy || running || loadingTask} aria-invalid={!!sizeError} onChange={event => setSize(current => ({ ...current, height: event.target.value }))} /></label>
    </div>}
    <small>宽高须为 16 的倍数，总像素 655,360–8,294,400；最长边不超过 3840，宽高比在 1:3–3:1 内。</small>
    {sizeError && <output role="alert">{sizeError}</output>}
    {loadingTask && <output>正在读取所选任务与输出尺寸…</output>}
    <div className="image-assets-references">
      <input ref={input} hidden type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; void upload(files); }} />
      <button disabled={disabled || busy || running || references.length >= 8} onClick={() => input.current?.click()}>添加参考图 · {references.length}/8</button>
      {references.map((reference, index) => <div className="image-assets-reference" key={`${reference.name}-${index}`}>
        <img src={reference.data} alt={`参考图 ${index + 1}`} /><span title={reference.name}>{reference.name}</span>
        <button aria-label={`移除参考图 ${index + 1}`} disabled={busy || running} onClick={() => setReferences((current) => current.filter((_, item) => item !== index))}><X size={14} /></button>
      </div>)}
      <small>PNG / JPEG / WebP，每张最多 30 MB，总计 80 MB。参考图会随任务保留。</small>
    </div>
    <details className="image-assets-settings">
      <summary><KeyRound size={14} /> GPT Image 2.6 设置 · {configured ? '已配置' : settings ? '未配置' : '未连接'}</summary>
      <label>API Key<input type="password" autoComplete="off" aria-label="GPT Image 2.6 API Key" value={apiKey} maxLength={4096} onChange={(event) => setApiKey(event.target.value)} placeholder="已有密钥不会回显" /></label>
      <div className="image-assets-actions"><button disabled={savingKey || !apiKey.trim()} onClick={() => void saveKey()}>保存密钥</button><button disabled={savingKey} onClick={() => void checkSettings()}><RefreshCw size={14} />刷新连接</button></div>
      <small>自动复用地图生成中已保存的 GPT Image 2.6 密钥。</small>
    </details>
    {settingsMessage && <output>{settingsMessage}</output>}
    <button className="image-assets-primary" disabled={disabled || busy || running || loadingTask || !!sizeError || !configured || !prompt.trim()} onClick={() => void generate()}>
      {busy || running ? <LoaderCircle size={16} className="image-assets-spin" /> : <Sparkles size={16} />}{running ? '正在生成，等待原任务' : '生成一张图片'}
    </button>
    <small>每次生成会使用图片 API 额度。只查询原任务，断线后不会自动重新生成。</small>
    {selected && <output aria-live="polite">{statusLabels[selected.status] || selected.status}</output>}
    {image && <>
      <div className={`image-assets-preview ${kind === 'prop' ? 'image-assets-transparent' : ''}`}><img src={imageArtifactUrl(image)} alt={kind === 'prop' ? '待采用的透明物件' : '待采用的场景背景'} /></div>
      <div className="image-assets-actions"><a href={imageArtifactUrl(image)} download><Download size={14} />下载 PNG</a><button className="image-assets-primary" disabled={disabled || busy || loadingTask} onClick={() => void adopt()}>{adoptionLabel}</button></div>
      {kind === 'prop' && <button disabled={disabled || busy || running || loadingTask} onClick={() => void cleanAlpha()}>清理透明噪点（本地，无需额度）</button>}
      <button disabled={disabled || busy || running || loadingTask || !!localEditTask} onClick={() => { if (selectedId) { setLocalEditTask(selectedId); onBusy?.(true); } }}>局部调整图片</button>
      <small>{kind === 'prop' ? '采用会替换默认图片并停用默认动画，保留各状态图片、原有素材和行为。' : '采用时先保存当前地图，再以此背景建立新地图；后续可沿用“用于制作场景”。'}</small>
    </>}
    {(message || selected?.error) && <output>{message || selected?.error}</output>}
    <label>最近{kind === 'prop' ? '透明物件' : '场景背景'}
      <select aria-label={kind === 'prop' ? '最近透明物件' : '最近场景背景'} value={selectedId || ''} disabled={busy} onChange={(event) => { if (event.target.value) void selectTask(event.target.value); }}>
        <option value="">选择已保存的图片任务</option>
        {selected && !tasks.some((task) => task.id === selected.id) && <option value={selected.id}>{taskName(selected)} · {statusLabels[selected.status] || selected.status}</option>}
        {tasks.filter((task) => imageAssetKind(task) === kind).map((task) => <option key={task.id} value={task.id}>{taskName(task)} · {statusLabels[task.status] || task.status}</option>)}
      </select>
    </label>
    {selectedId && <button disabled={busy} onClick={() => void selectTask(selectedId)}><RefreshCw size={14} />重新读取原任务</button>}
    {localEditTask && <ImageEditWorkspace target={{ kind: 'image-task', taskId: localEditTask }} onClose={() => { setLocalEditTask(null); onBusy?.(false); }} onAdopt={async receipt => {
      const taskId = receipt.adoption.sourceTaskId;
      if (!taskId) throw new Error('局部调整回执缺少已保存的图片任务。');
      await selectTask(taskId);
      setLocalEditTask(null); onBusy?.(false); void refresh();
      setMessage('局部调整版本已保存，原图保留。检查后可采用到工程。');
    }} />}
  </div>;
}
