'use client';
/* oxlint-disable next/no-img-element -- Preserve original pixel-art PNGs. */
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download,
  KeyRound,
  LoaderCircle,
  Paintbrush,
  RefreshCw,
} from 'lucide-react';
import { useWorkbench } from '@/components/workbench/workbench-provider';
import type { StoredTask } from '@/lib/workbench/work-items';
import type { Asset } from '@/features/interactable-editor/contract.mjs';
import {
  isPropArtTask,
  propArtJson,
  propImagePath,
  readPropArtAsset,
  type PropArtTarget,
} from '@/features/interactable-editor/prop-art.mjs';

const labels: Record<string, string> = {
  running: '正在生成',
  completed: '原图已保存',
  failed: '生成失败',
  awaiting_configuration: '等待配置',
  prepared: '尚未生成',
};
const taskName = (task: StoredTask) =>
  typeof task.input?.name === 'string' ? task.input.name : '物品原图';
const artifactUrl = (path: string) =>
  `/api/workbench/artifacts?path=${encodeURIComponent(path)}`;

export function PropArtPanel({
  projectId,
  definitionId,
  objectName,
  imageId,
  disabled,
  beforeGenerate,
  onAdopt,
  onBusy,
}: {
  projectId: string;
  definitionId: string;
  objectName: string;
  imageId: string;
  disabled: boolean;
  beforeGenerate: () => Promise<void>;
  onAdopt: (target: PropArtTarget, asset: Asset) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { tasks, refresh } = useWorkbench();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<StoredTask | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [motionTarget, setMotionTarget] = useState<{source: string; id: string} | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const actionLock = useRef(false);
  const alive = useRef(true);
  const selectionEpoch = useRef(0);
  const selectedId = selected?.id;
  const png = propImagePath(selected);

  const checkSettings = useCallback(async () => {
    try {
      const data = await propArtJson<{ configured: boolean }>(
        '/api/workbench/reference-art/settings',
      );
      if (alive.current) {
        setConfigured(data.configured);
        setSettingsMessage('');
      }
    } catch (e) {
      if (alive.current) {
        setConfigured(null);
        setSettingsMessage((e as Error).message);
      }
    }
  }, []);
  const selectTask = useCallback(async (id: string) => {
    const epoch = ++selectionEpoch.current;
    try {
      const { task } = await propArtJson<{ task: StoredTask }>(
        `/api/workbench/tasks/${encodeURIComponent(id)}`,
      );
      if (!alive.current || epoch !== selectionEpoch.current) return;
      if (!isPropArtTask(task)) throw new Error('这不是物品原图生成记录。');
      setSelected(task);
      setPrompt(
        typeof task.input?.prompt === 'string' ? task.input?.prompt : '',
      );
      setMessage('');
      const url = new URL(location.href);
      url.searchParams.set('artTask', id);
      history.replaceState(null, '', url.pathname + url.search);
    } catch (e) {
      if (alive.current && epoch === selectionEpoch.current)
        setMessage((e as Error).message);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const timer = setTimeout(() => {
      const taskId = new URLSearchParams(location.search).get('artTask');
      if (taskId) {
        setOpen(true);
        void selectTask(taskId);
      }
    }, 0);
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [selectTask]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void checkSettings(), 0);
    window.addEventListener('focus', checkSettings);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', checkSettings);
    };
  }, [open, checkSettings]);
  useEffect(() => {
    if (!selectedId || selected?.status !== 'running') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { task, refreshError } = await propArtJson<{
          task: StoredTask;
          refreshError?: string;
        }>(
          `/api/workbench/tasks/${encodeURIComponent(selectedId)}?refresh=true`,
        );
        if (!stopped) {
          setSelected(task);
          setMessage(refreshError || '');
          if (task.status !== 'running') void refresh();
        }
      } catch (e) {
        if (!stopped) setMessage((e as Error).message);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 6000);
    };
    timer = setTimeout(() => void poll(), 6000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selectedId, selected?.status, refresh]);

  const generate = async () => {
    if (
      actionLock.current ||
      disabled ||
      !prompt.trim() ||
      configured !== true ||
      selected?.status === 'running'
    )
      return;
    actionLock.current = true;
    setBusy(true);
    onBusy(true);
    setMessage('');
    try {
      await beforeGenerate();
      const result = await propArtJson<{ taskId: string; status: string }>(
        '/api/workbench/tasks',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            capabilityId: 'reference-art',
            input: {
              operation: 'generate',
              subject: 'prop',
              prompt: prompt.trim(),
              name: objectName.slice(0, 80) || '物品原图',
            },
          }),
        },
      );
      if (alive.current) await selectTask(result.taskId);
      void refresh();
    } catch (e) {
      if (alive.current) setMessage((e as Error).message);
    } finally {
      actionLock.current = false;
      if (alive.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  };
  const transfer = async () => {
    if (actionLock.current || disabled || !selected || !png) return;
    actionLock.current = true;
    setBusy(true);
    onBusy(true);
    try {
      const result = await propArtJson<{status: string; outputs: string[]; error?: string}>('/api/workbench/tasks', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({capabilityId: 'reference-art', input: {operation: 'transfer', sourceTaskId: selected.id}}),
      });
      const file = result.outputs?.find(value => value.endsWith('/result.json'));
      if (result.status !== 'completed' || !file) throw new Error(result.error || '物品移送未完成。');
      const handoff = await propArtJson<{objectId: string; sourceTaskId: string}>(artifactUrl(file));
      if (handoff.sourceTaskId !== selected.id || !/^reference_[a-f0-9]{24}$/.test(handoff.objectId))
        throw new Error('物品移送响应无效。');
      if (alive.current) setMotionTarget({source: selected.id, id: handoff.objectId});
      void refresh();
    } catch (error) {
      if (alive.current) setMessage((error as Error).message);
    } finally {
      actionLock.current = false;
      if (alive.current) { setBusy(false); onBusy(false); }
    }
  };
  const adopt = async () => {
    if (actionLock.current || disabled || !selected || !png) return;
    actionLock.current = true;
    setBusy(true);
    onBusy(true);
    setMessage('');
    const target = { projectId, definitionId, previousAssetId: imageId };
    const name = objectName;
    try {
      const asset = await readPropArtAsset(selected.id);
      if (!alive.current) return;
      onAdopt(target, asset);
      setMessage(`已用作「${name}」的默认原图，草稿将自动保存。`);
    } catch (e) {
      if (alive.current) setMessage((e as Error).message);
    } finally {
      actionLock.current = false;
      if (alive.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  };
  const saveKey = async () => {
    if (savingKey || apiKey.trim().length < 8) return;
    setSavingKey(true);
    try {
      const data = await propArtJson<{ configured: boolean }>(
        '/api/workbench/reference-art/settings',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKey.trim() }),
        },
      );
      if (alive.current) {
        setConfigured(data.configured);
        setSettingsMessage('已保存，与角色原图和序列帧共用。');
      }
    } catch (e) {
      if (alive.current) setSettingsMessage((e as Error).message);
    } finally {
      if (alive.current) {
        setApiKey('');
        setSavingKey(false);
      }
    }
  };

  return (
    <details
      className="ie-prop-art"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <Paintbrush size={16} /> 生成物品原图 <small>PixelLab</small>
      </summary>
      {open && (
        <div className="ie-prop-art-body">
          <p>描述电池、宝箱、开关等单个物品，生成后预览并采用。</p>
          <label>
            物品外观描述
            <textarea
              aria-label="物品外观描述"
              rows={4}
              maxLength={1800}
              value={prompt}
              disabled={busy}
              placeholder="一块复古工业电池，深蓝金属外壳、黄色指示灯，侧视，轮廓清晰。"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <small>128 × 128 · 侧视 · 透明 PNG</small>
          <button
            className="ie-primary"
            disabled={
              disabled ||
              busy ||
              !prompt.trim() ||
              configured !== true ||
              selected?.status === 'running'
            }
            onClick={() => void generate()}
          >
            {busy || selected?.status === 'running' ? (
              <LoaderCircle size={16} className="ie-prop-spin" />
            ) : (
              <Paintbrush size={16} />
            )}
            {selected?.status === 'running'
              ? '正在生成物品原图'
              : '生成一张物品原图'}
          </button>
          <small>
            每次生成使用 PixelLab 账户额度。采用不会生成动画或改变交互行为。
          </small>
          <details className="ie-prop-settings">
            <summary>
              <KeyRound size={14} /> PixelLab 设置 ·{' '}
              {configured
                ? '已配置'
                : configured === false
                  ? '未配置'
                  : '未连接'}
            </summary>
            <p>自动复用角色原图与序列帧已保存的 Key，无需重复输入。</p>
            <label>
              API Key
              <input
                type="password"
                autoComplete="off"
                aria-label="物品原图 PixelLab API Key"
                value={apiKey}
                maxLength={4096}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="已有 Key 不会回显"
              />
            </label>
            <div className="ie-row">
              <button
                disabled={savingKey || apiKey.trim().length < 8}
                onClick={() => void saveKey()}
              >
                保存 Key
              </button>
              <button onClick={() => void checkSettings()}>
                <RefreshCw size={14} />
                刷新连接
              </button>
            </div>
          </details>
          {settingsMessage && <output>{settingsMessage}</output>}
          {selected && (
            <span aria-live="polite">
              {labels[selected.status] || selected.status}
            </span>
          )}
          {png && (
            <>
              <div className="ie-prop-preview">
                <img
                  decoding="async"
                  src={artifactUrl(png)}
                  alt="生成的物品原图"
                  width={128}
                  height={128}
                />
              </div>
              <div className="ie-row">
                <a href={artifactUrl(png)} download>
                  <Download size={14} />
                  下载 PNG
                </a>
                {motionTarget && motionTarget.source === selectedId
                  ? <a href={`/tools/interactable-motion?object=${motionTarget.id}`} target="_blank" rel="noreferrer">打开交互物动画</a>
                  : <button disabled={busy || disabled} onClick={() => void transfer()}>移送到交互物动画</button>}
              </div>
              <button
                className="ie-primary"
                disabled={busy || disabled}
                onClick={() => void adopt()}
              >
                采用到「{objectName}」
              </button>
              <small>
                替换默认图片并停用默认待机动画；原有帧、状态专用图片和行为保留。
              </small>
            </>
          )}
          {(message || selected?.error) && (
            <output>{message || selected?.error}</output>
          )}
          <label>
            最近物品原图
            <NativeSelect
              aria-label="最近物品原图"
              value={selectedId || ''}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) void selectTask(e.target.value);
              }}
            >
              <NativeSelectOption value="">选择已保存的生成记录</NativeSelectOption>
              {selected && !tasks.some((t) => t.id === selected.id) && (
                <NativeSelectOption value={selected.id}>
                  {taskName(selected)} · {labels[selected.status]}
                </NativeSelectOption>
              )}
              {tasks.filter(isPropArtTask).map((task) => (
                <NativeSelectOption key={task.id} value={task.id}>
                  {taskName(task)} · {labels[task.status] || task.status}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <small>
            可以离开页面，稍后从制作记录继续查看；结果不会自动覆盖物件。
          </small>
        </div>
      )}
    </details>
  );
}
