'use client';
/* oxlint-disable next/no-img-element -- generated pixel art preview */
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { StoredTask } from '@/lib/workbench/work-items';
import { isPropArtTask, propArtJson, propImagePath } from '@/features/interactable-editor/prop-art.mjs';

const artifact = (path: string) => `/api/workbench/artifacts?path=${encodeURIComponent(path)}`;

/**
 * Generate a 128px PixelLab prop reference and transfer it as an animation
 * object without leaving the panel. Same `reference-art` generate/transfer
 * operations as the interactable editor; GPT Image props are not accepted.
 */
export function PropReferenceGenerator({ objectName, onTransferred }: { objectName: string; onTransferred: (objectId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [task, setTask] = useState<StoredTask | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    void propArtJson<{ configured: boolean }>('/api/workbench/reference-art/settings')
      .then(v => { if (alive.current) setConfigured(v.configured); }).catch(e => { if (alive.current) setMessage((e as Error).message); });
  }, [open]);
  const taskId = task?.id, running = task?.status === 'running';
  useEffect(() => {
    if (!taskId || !running) return;
    const timer = setTimeout(() => {
      void propArtJson<{ task: StoredTask }>(`/api/workbench/tasks/${encodeURIComponent(taskId)}?refresh=true`)
        .then(v => { if (alive.current) setTask(v.task); }).catch(e => { if (alive.current) setMessage((e as Error).message); });
    }, 6000);
    return () => clearTimeout(timer);
  }, [taskId, running, task]);
  const generate = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await propArtJson<{ taskId: string }>('/api/workbench/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilityId: 'reference-art', input: { operation: 'generate', subject: 'prop', prompt: prompt.trim(), name: objectName.slice(0, 80) || '物品原图' } }),
      });
      const { task: created } = await propArtJson<{ task: StoredTask }>(`/api/workbench/tasks/${encodeURIComponent(result.taskId)}`);
      if (!isPropArtTask(created)) throw new Error('生成记录无效。');
      setTask(created);
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  };
  const transfer = async () => {
    if (!task) return;
    setBusy(true); setMessage('');
    try {
      const result = await propArtJson<{ status: string; outputs: string[]; error?: string }>('/api/workbench/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilityId: 'reference-art', input: { operation: 'transfer', sourceTaskId: task.id } }),
      });
      const file = result.outputs?.find(v => v.endsWith('/result.json'));
      if (result.status !== 'completed' || !file) throw new Error(result.error || '物品移送未完成。');
      const handoff = await propArtJson<{ objectId: string; sourceTaskId: string }>(artifact(file));
      if (handoff.sourceTaskId !== task.id || !/^reference_[a-f0-9]{24}$/.test(handoff.objectId)) throw new Error('物品移送响应无效。');
      await onTransferred(handoff.objectId);
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  };
  const png = propImagePath(task);
  return <details className="im-tool" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>还没有 128 px 物品原图？在这里生成</summary>
    <p className="motion-muted">PixelLab 生成 128 × 128 透明物品原图，按实际调用计费。只有这种原图可以作为动画参考；“生成透明物件”的大图不能直接使用。</p>
    {configured === false && <p className="motion-notice">请先在交互物编辑器或角色原图页配置 PixelLab API Key。</p>}
    <label>物品外观描述<textarea rows={3} maxLength={1000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="例如：木制底座的金属拉杆，侧视，拉杆在左侧" /></label>
    <button disabled={busy || running || configured !== true || prompt.trim().length < 4} onClick={() => void generate()}>生成物品原图（计费一次）</button>
    {running && <p><LoaderCircle size={14} className="animate-spin" />正在生成…</p>}
    {task?.status === 'failed' && <p className="motion-danger">生成失败，请修改描述后重试。</p>}
    {png && <><img src={artifact(png)} alt="物品原图" width={128} height={128} style={{ imageRendering: 'pixelated' }} />
      <button className="motion-primary" disabled={busy} onClick={() => void transfer()}>用作交互物动画对象</button></>}
    {message && <p className="motion-danger">{message}</p>}
  </details>;
}
