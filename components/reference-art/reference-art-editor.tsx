'use client';
/* oxlint-disable next/no-img-element -- Pixel art must retain its exact local PNG pixels. */
/* oxlint-disable next/no-html-link-for-pages -- Navigation is guarded by WorkbenchProvider. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Download,
  KeyRound,
  LoaderCircle,
  Paintbrush,
  RefreshCw,
} from 'lucide-react';
import { useWorkbench } from '@/components/workbench/workbench-provider';
import { SourceAssetLink } from '@/components/workbench/shared-navigation';
import { AssetImportPicker } from '@/components/workbench/lazy-dialogs';
import { clearImportQuery, type ImportBundle } from '@/lib/workbench/asset-import';
import { CharacterIdentityField } from '@/components/sprite-generator/character-identity-field';
import { referenceIdentityDescription, referenceIdentityLimit, referenceTransferInput } from '@/components/sprite-generator/character-identity';
import { referenceProgress, type StoredTask } from '@/lib/workbench/work-items';
import { usePaidTask } from '@/features/workbench/use-paid-task';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';

type Result = {
  taskId: string;
  status: string;
  outputs: string[];
  requiredEnvironment?: string;
};
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(90000),
  });
  const data = (await response.json()) as T & { error?: unknown };
  if (!response.ok)
    throw new Error(
      typeof data.error === 'string' ? data.error : '请求未完成，请稍后重试。',
    );
  return data as T;
}
const textField = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;
const artifactUrl = (path: string) =>
  `/api/workbench/artifacts?path=${encodeURIComponent(path)}`;
const taskLabels: Record<string, string> = {
  prepared: '尚未生成',
  running: '正在生成',
  completed: '原图已保存',
  failed: '生成失败',
  attention_required: '需要核对原请求',
  not_submitted: '未提交',
  awaiting_configuration: '等待配置',
};

export function ReferenceArtEditor() {
  const { tasks, modules, refresh, navigate } = useWorkbench();
  const paid = usePaidTask('reference-character');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [facing, setFacing] = useState('right');
  const [checkOrientation, setCheckOrientation] = useState(false);
  const [orientationNotes, setOrientationNotes] = useState<Record<string, string>>({});
  const [size, setSize] = useState(128);
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<StoredTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [readyHref, setReadyHref] = useState('');
  const [library, setLibrary] = useState<{ assetId?: string } | null>(null);
  const [identityDrafts, setIdentityDrafts] = useState<Record<string, string>>({});
  const busyRef = useRef(false);
  const selectionLoadingRef = useRef(false);
  const selectionMounted = useRef(true);
  const selectionEpoch = useRef(0);
  const selectedId = selected?.id;
  const orientationReview = selected?.adapter?.orientationReview;
  const needsObservation = Boolean(orientationReview && orientationReview.status !== 'matched');
  const observation = selectedId ? orientationNotes[selectedId]?.trim() || '' : '';
  const identityDescription = selectedId ? referenceIdentityDescription(tasks, selectedId, identityDrafts) : '';

  const checkSettings = useCallback(async () => {
    try {
      const settings = await json<{ configured: boolean }>(
        '/api/workbench/reference-art/settings',
      );
      setConfigured(settings.configured);
      setSettingsMessage('');
    } catch (error) {
      setConfigured(null);
      setSettingsMessage((error as Error).message);
    }
  }, []);

  const selectTask = useCallback(async (id: string, restorePrompt = true) => {
    if (!selectionMounted.current) return;
    const epoch = ++selectionEpoch.current;
    selectionLoadingRef.current = true;
    setSelectionLoading(true);
    setReadyHref('');
    setMessage('');
    try {
      const { task } = await json<{ task: StoredTask }>(
        `/api/workbench/tasks/${encodeURIComponent(id)}`,
      );
      if (!selectionMounted.current || epoch !== selectionEpoch.current) return;
      if (
        task.capabilityId !== 'reference-art' || !task.input ||
        !['generate','import'].includes(String(task.input?.operation)) || task.input.subject === 'prop'
      )
        throw new Error('这不是原图生成任务。');
      setSelected(task);
      if (restorePrompt) {
        setPrompt(textField(task.input.prompt));
        setName(textField(task.input.name));
        setFacing(task.input.facing === 'left' ? 'left' : 'right');
        setSize(task.input.size === 64 ? 64 : 128);
      }
      const url = new URL(location.href);
      url.searchParams.set('task', id);
      history.replaceState(history.state, '', url.pathname + url.search);
    } catch (error) {
      if (selectionMounted.current && epoch === selectionEpoch.current)
        setMessage((error as Error).message);
    } finally {
      if (selectionMounted.current && epoch === selectionEpoch.current) {
        selectionLoadingRef.current = false;
        setSelectionLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    selectionMounted.current = true;
    const timer = setTimeout(() => {
      void checkSettings();
      const params = new URLSearchParams(location.search);
      const assetId = params.get('importAsset');
      if (assetId && params.get('importPurpose') === 'image') { setLibrary({ assetId }); clearImportQuery(); }
      else { const id = params.get('task'); if (id) void selectTask(id); }
    }, 0);
    const onFocus = () => void checkSettings();
    window.addEventListener('focus', onFocus);
    return () => {
      selectionMounted.current = false;
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- Invalidate the request counter, not a DOM ref.
      selectionEpoch.current++;
      selectionLoadingRef.current = false;
      window.removeEventListener('focus', onFocus);
      clearTimeout(timer);
    };
  }, [checkSettings, selectTask]);

  useEffect(() => {
    if (!selectedId || selected?.status !== 'running') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { task, refreshError } = await json<{
          task: StoredTask;
          refreshError?: string;
        }>(
          `/api/workbench/tasks/${encodeURIComponent(selectedId)}?refresh=true`,
        );
        if (!stopped) {
          setSelected(task);
          setMessage(refreshError || '');
        }
      } catch (error) {
        if (!stopped) setMessage((error as Error).message);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 6000);
    };
    timer = setTimeout(() => void poll(), 6000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selectedId, selected?.status]);

  const saveKey = async () => {
    if (savingKey) return;
    setSavingKey(true);
    setSettingsMessage('');
    try {
      const settings = await json<{ configured: boolean }>(
        '/api/workbench/reference-art/settings',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKey.trim() }),
        },
      );
      setConfigured(settings.configured);
      setSettingsMessage('已保存，原图和序列帧共用。');
    } catch (error) {
      setSettingsMessage((error as Error).message);
    } finally {
      setApiKey('');
      setSavingKey(false);
    }
  };

  const importReference = async (bundle: ImportBundle) => {
    if (busyRef.current || selectionLoadingRef.current) throw new Error('请等待当前操作完成。');
    const file = bundle.files[0]?.file;
    if (bundle.asset.kind !== 'character' || bundle.purpose !== 'image' || bundle.files.length !== 1 || !file || file.type !== 'image/png' || file.size > 2_000_000)
      throw new Error('请选择 2 MB 以内、64×64 或 128×128 且带透明背景的角色 PNG。原素材保留在资产库。');
    const pixels = bundle.asset.width;
    if ((pixels !== 64 && pixels !== 128) || bundle.asset.height !== pixels)
      throw new Error('角色参考图仅支持 64×64 或 128×128 PNG；不会缩放或修改原素材。');
    busyRef.current = true; setBusy(true); setMessage(''); setReadyHref('');
    try {
      const sourceImage = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败。'));
        reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
        reader.readAsDataURL(file);
      });
      const result = await json<Result>('/api/workbench/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilityId: 'reference-art', input: { operation: 'import', sourceImage, prompt: prompt.trim() || bundle.asset.title, name: (name.trim() || bundle.asset.title).slice(0, 80), size: pixels, facing: bundle.asset.facing || facing } }),
      });
      if (result.status !== 'completed') throw new Error('角色参考图尚未保存，请查看制作记录。');
      await selectTask(result.taskId);
      setMessage('角色参考图已保存，未调用生成服务。检查外观后可用于角色动画。');
      void refresh();
    } finally { busyRef.current = false; setBusy(false); }
  };

  const run = async (operation: 'generate' | 'transfer') => {
    if (busyRef.current || selectionLoadingRef.current) return;
    if (operation === 'generate' && !paid.pending && !prompt.trim()) {
      setMessage('请先描述角色外观。');
      return;
    }
    if (operation === 'transfer' && selected?.status !== 'completed') return;
    if (operation === 'transfer' && needsObservation && observation.length < 4) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    setReadyHref('');
    try {
      if (operation === 'generate') {
        const result = await paid.run(paid.pending ? undefined : { capabilityId: 'reference-art', input: {
          operation, prompt: prompt.trim(), facing, size,
          ...(checkOrientation ? { checkOrientation: true } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
        } });
        if (!result) return;
        await selectTask(result.taskId, paid.pending);
        if (result.status === 'awaiting_configuration')
          setMessage('请先连接序列帧服务并保存 PixelLab Key，再点击生成。');
      } else {
        const result = await json<Result>('/api/workbench/tasks', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capabilityId: 'reference-art', input: {
            ...referenceTransferInput(selected!.id, identityDescription), ...(needsObservation ? { confirmation: { note: observation } } : {}),
          } }),
        });
        if (result.status !== 'completed')
          throw new Error('参考图尚未移送完成。');
        const resultPath = result.outputs.find((path) =>
          path.endsWith('/result.json'),
        );
        if (!resultPath) throw new Error('没有找到角色导入结果。');
        const handoff = await json<{ characterId: string; href: string }>(
          artifactUrl(resultPath),
        );
        if (!/^reference_[a-f0-9]{24}$/.test(handoff.characterId))
          throw new Error('角色导入结果无效。');
        const spriteModule = modules.find(
          (module) => module.id === 'sprite-generator',
        );
        if (!spriteModule) throw new Error('序列帧能力未注册。');
        const spriteHref = `${spriteModule.href}?character=${encodeURIComponent(handoff.characterId)}`;
        setReadyHref(spriteHref);
        setMessage('参考图已导入，可继续选择动作。');
        await navigate(spriteHref);
      }
      void refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const png =
    selected && (selected.status === 'completed' || selected.adapter?.orientationPending)
      ? selected.outputs?.find((path) => path.endsWith('/reference.png'))
      : undefined;
  // Why the generate button is unavailable, shown under it instead of a silent grey button.
  const generateBlocker = selectionLoading
    ? '正在读取所选原图，请稍候…'
    : busy || paid.pending || selected?.status === 'running'
    ? ''
    : configured === false
      ? '先在下方“PixelLab 设置”中保存 Key。'
      : configured === null
        ? '正在连接 PixelLab 服务…'
        : !prompt.trim()
          ? '填写角色描述后即可生成。'
          : '';
  const historyTasks = tasks.filter(
    (task) =>
      task.capabilityId === 'reference-art' && !!task.input &&
      ['generate','import'].includes(String(task.input?.operation)) && task.input.subject !== 'prop',
  );
  return (
    <main className="ra-workspace">
      <AssetImportPicker open={Boolean(library)} onClose={() => setLibrary(null)} purposes={['image']} kind="character" initialAsset={library?.assetId} onImport={importReference} />
      <header className="ra-header">
        <div>
          <h1>角色原图</h1>
          <p>描述外观，生成像素角色，再让它动起来。</p>
        </div>
        <SourceAssetLink />
      </header>
      <div className="ra-layout">
        <section className="ra-controls" aria-label="生成设置">
          <div className="ra-step">
            01 <span>描述你的角色</span>
          </div>
          <label htmlFor="ra-name">
            角色名称 <span>可选</span>
          </label>
          <Input
            id="ra-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="例如：森林守卫"
            disabled={busy || selectionLoading}
          />
          <label htmlFor="ra-prompt">角色描述</label>
          <Textarea
            id="ra-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={2000}
            rows={7}
            disabled={busy || selectionLoading}
            placeholder="一位披着绿色斗篷的森林守卫，手持木弓，棕色短靴，全身站姿，轮廓清晰，武器完整留在画面内。"
          />
          <div className="ra-form-row">
            <div>
              <label htmlFor="ra-facing">角色朝向</label>
              <NativeSelect
                className="w-full"
                id="ra-facing"
                value={facing}
                onChange={(event) => setFacing(event.target.value)}
                disabled={busy || selectionLoading}
              >
                <NativeSelectOption value="right">朝右</NativeSelectOption>
                <NativeSelectOption value="left">朝左</NativeSelectOption>
              </NativeSelect>
            </div>
            <div>
              <label htmlFor="ra-size">像素规格</label>
              <NativeSelect id="ra-size" className="w-full" value={size} onChange={(event) => setSize(Number(event.target.value))} disabled={busy || selectionLoading || selected?.status === 'running'}>
                <NativeSelectOption value={128}>128 × 128 · 精细像素</NativeSelectOption>
                <NativeSelectOption value={64}>64 × 64 · 粗像素</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
          <label>
            <input type="checkbox" checked={checkOrientation} onChange={(event) => setCheckOrientation(event.target.checked)} disabled={busy || selectionLoading || selected?.status === 'running'} />
            生成后调用一次视觉模型核对视角与朝向（使用模型额度）
          </label>
          <button
            className="wb-button wb-primary ra-generate"
            disabled={
              busy ||
              selectionLoading ||
              (!paid.pending && (selected?.status === 'running' || !prompt.trim() || configured !== true))
            }
            onClick={() => void run('generate')}
          >
            {busy ? (
              <LoaderCircle className="ra-spin" size={18} />
            ) : (
              <Paintbrush size={18} />
            )}
            {paid.pending ? '恢复原生成请求' : '生成一张原图'}
          </button>
          {generateBlocker && <p className="wb-disabled-reason">{generateBlocker}</p>}
          <p className="ra-note">
            每次生成使用 PixelLab 账户额度。移送参考图不生成动画。
          </p>
          <div className="ra-alternatives">
            <button className="wb-button" disabled={busy || selectionLoading || selected?.status === 'running'} onClick={() => setLibrary({})}>从资产库选用角色原图</button>
            <a className="wb-text-button" href={modules.find((module) => module.id === 'sprite-generator')?.href}>
              已有原图，直接制作动画 <ArrowRight size={14} />
            </a>
          </div>
          <details className="ra-settings">
            <summary>
              <KeyRound size={16} /> PixelLab 设置{' '}
              <span>
                {configured
                  ? '已配置'
                  : configured === false
                    ? '未配置'
                    : '未连接'}
              </span>
            </summary>
            <p>与序列帧工具共用一个 Key，保存在本机受保护的密钥存储中。</p>
            <label htmlFor="ra-key">API Key</label>
            <Input
              id="ra-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              maxLength={4096}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="输入后保存，不会回显已有 Key"
            />
            <div className="ra-actions">
              <button
                className="wb-button"
                disabled={savingKey || apiKey.trim().length < 8}
                onClick={() => void saveKey()}
              >
                保存 Key
              </button>
              <button
                className="wb-button wb-ghost"
                onClick={() => void checkSettings()}
              >
                <RefreshCw size={14} />
                刷新连接
              </button>
            </div>
          </details>
          {settingsMessage && (
            <output className="ra-notice">{settingsMessage}</output>
          )}
          {configured === false && (
            <p className="ra-notice">
              展开 PixelLab 设置并保存 Key；在序列帧中已保存的 Key 会自动共用。
            </p>
          )}
        </section>
        <section className="ra-result" aria-label="原图预览" aria-busy={selectionLoading}>
          <div className="ra-preview-heading">
            <div className="ra-step">
              02 <span>检查原图</span>
            </div>
            <span className="ra-status" aria-live="polite">
              {selectionLoading ? '正在读取所选原图…' : selected
                ? selected.adapter?.orientationPending ? '正在核对视角与朝向' : selected.input?.operation === 'import' ? '已导入' : referenceProgress(selected) || taskLabels[selected.status] || '等待处理'
                : '等待你的第一个角色'}
            </span>
          </div>
          {selected?.input?.operation === 'import' && <p className="ra-note">导入素材 · 提示词为展示描述，此图并非由本次生图 API 生成。</p>}
          <div className="ra-canvas">
            {png ? (
              <img
                decoding="async"
                src={artifactUrl(png)}
                alt={textField(selected?.input?.name, '生成的像素角色')}
                width={selected?.input?.size === 64 ? 64 : 128}
                height={selected?.input?.size === 64 ? 64 : 128}
              />
            ) : (
              <div className="ra-empty">
                {selected?.status === 'running' ? (
                  <LoaderCircle size={38} className="ra-spin" />
                ) : (
                  <Paintbrush size={38} />
                )}
                <strong>
                  {selected?.status === 'running'
                    ? referenceProgress(selected) || '正在绘制你的角色'
                    : '角色会出现在这里'}
                </strong>
                <p>
                  {selected?.status === 'running'
                    ? '可以离开页面，稍后从制作记录继续查看。'
                    : '在左侧填写角色描述并生成原图；已有原图可从角色动画直接开始。'}
                </p>
              </div>
            )}
          </div>
          <p className="ra-note">{orientationReview?.summary || '移送前请确认角色与武器完整、朝向正确。此处按整数倍放大显示。'}</p>
          {png && selectedId && needsObservation && <>
            <label htmlFor="ra-orientation-note">实际视角、朝向及采用理由</label>
            <Textarea id="ra-orientation-note" rows={2} maxLength={1000} value={orientationNotes[selectedId] || ''}
              placeholder="查看原图后填写，至少 4 字" disabled={busy || selectionLoading}
              onChange={(event) => setOrientationNotes(previous => ({ ...previous, [selectedId]: event.target.value }))} />
          </>}
          {png && selectedId && <>
            <CharacterIdentityField value={identityDescription} onChange={(value) => setIdentityDrafts((previous) => ({ ...previous, [selectedId]: value }))} maxLength={referenceIdentityLimit} disabled={busy || selectionLoading} />
            <p className="ra-note">此说明只用于移送角色。已移送的同一原图会复用角色身份；修改这里的说明不会覆盖已保存角色的外观约束。</p>
          </>}
          <div className="ra-actions">
            {png && (
              <a className="wb-button" href={artifactUrl(png)} download>
                <Download size={16} />
                下载 PNG
              </a>
            )}
            <button
              className="wb-button wb-primary"
              disabled={!png || selected?.status !== 'completed' || busy || selectionLoading || (needsObservation && observation.length < 4)}
              onClick={() => void run('transfer')}
            >
              用于制作序列帧 <ArrowRight size={16} />
            </button>
          </div>
          {!png && !busy && <p className="wb-disabled-reason">生成或从资产库选用一张原图后，才能用于制作序列帧。</p>}
          {readyHref && <a href={readyHref}>继续制作序列帧 →</a>}
          {(message || selected?.error) && (
            <output className="ra-notice">{message || selected?.error}</output>
          )}
        </section>
      </div>
      <section className="ra-history" aria-label="原图记录">
        <h2>最近制作</h2>
        {historyTasks.length === 0 ? (
          <p className="ra-note">生成记录会保存在这里。</p>
        ) : (
          <div className="ra-history-grid">
            {historyTasks.map((task) => (
              <button
                key={task.id}
                disabled={busy}
                className="ra-history-item"
                aria-pressed={selectedId === task.id}
                onClick={() => { if (!busyRef.current) void selectTask(task.id); }}
              >
                <strong>{textField(task.input?.name, '角色原图')}</strong>
                <span>{task.input?.operation === 'import' ? '导入素材 · 已保存' : referenceProgress(task) || taskLabels[task.status] || task.status}</span>
                <p>{textField(task.input?.prompt)}</p>
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
