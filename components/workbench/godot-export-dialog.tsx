'use client';
/* oxlint-disable next/no-html-link-for-pages -- WorkbenchProvider guards navigation. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { GameProjectBrowser } from './game-project-browser';
import { Button } from '@/components/ui/button';
import { FolderOpen, Download, CheckCircle2, LoaderCircle } from 'lucide-react';
import {
  prepareGodotPackage,
  type GodotPackageManifest,
} from '@/features/godot-export/package.mjs';
import { gameHandoff } from '@/features/godot-export/handoff.mjs';
import type { GodotExportOffer } from '@/lib/workbench/godot-export';
import { readGameDelivery, gameDeliveryHref } from '@/lib/workbench/game-export-client';
import {
  publishEditorSession,
  removeEditorSession,
} from '@/lib/workbench/editor-session';

type Project = {
  path: string;
  name: string;
  unavailable?: boolean;
  message?: string;
  versionWarning?: string | null;
};
type Delivery = {
  deliveryId: string;
  title: string;
  status: string;
  inboxPath: string;
  project: Project;
  integration?: {
    summary: string;
    engine: { status: string; version?: string };
  } | null;
};
const states: Record<string, string> = {
  awaiting_agent: '等待 WorkBuddy 接入',
  assets_installed: '资源已就位，等待代码接入',
  integrated: '代码已接入',
  needs_attention: '接入需要处理',
};
const kinds: Record<string, string> = {
  scene: '完整场景',
  map: '地图',
  interactable: '交互物',
  animation: '角色动画',
};
export function GodotExportDialog() {
  const [offer, setOffer] = useState<GodotExportOffer | null>(null);
  const [project, setProject] = useState<Project | null>(null),
    [pathValue, setPathValue] = useState('');
  const [pack, setPack] = useState<{
    blob: Blob;
    manifest: GodotPackageManifest;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [note, setNote] = useState('');
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const token = useRef(''),
    generation = useRef(0),
    inFlight = useRef(false);
  const [connected, setConnected] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const readToken = useCallback(() => token.current, []);
  const request = async (action: string, body?: Record<string, unknown>) => {
    const r = await fetch('/api/workbench/game-export/' + action, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? {
            'content-type': 'application/json',
            'x-forge-game-token': token.current,
          }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    const data = (await r.json()) as {
      token: string;
      project: Project;
      deliveries: Delivery[];
      cancelled?: boolean;
      error?: string;
    };
    if (!r.ok) throw new Error(data.error || '项目导出失败。');
    return data;
  };
  useEffect(() => {
    const receive = (event: Event) => {
      if (inFlight.current) return;
      const next = (event as CustomEvent<GodotExportOffer>).detail;
      setOffer(next);
      setBrowsing(false);
      setPack(null);
      setDelivery(null);
      setError('');
      setNote('');
      const turn = ++generation.current;
      setBusy(true);
      inFlight.current = true;
      void (async () => {
        try {
          let settings;
          try {
            settings = await request('settings');
            token.current = settings.token;
            setConnected(true);
            setProject(settings.project);
            setPathValue(settings.project?.path || '');
          } catch (e) {
            token.current = '';
            setConnected(false);
            setNote((e as Error).message + ' 仍可下载 ZIP。');
          }
          let blob = next.blob;
          if (!blob) {
            const r = await fetch(
              next.url || '/api/workbench/game-export/package',
              {
                ...(next.url
                  ? {}
                  : {
                      method: 'POST',
                      headers: {
                        'content-type': 'application/json',
                        'x-forge-game-token': token.current,
                      },
                      body: JSON.stringify(
                        next.jobId
                          ? { jobId: next.jobId, candidateIndex: next.candidateIndex }
                          : { assetId: next.assetId, revision: next.revision },
                      ),
                    }),
                cache: 'no-store',
                signal: AbortSignal.timeout(40000),
              },
            );
            if (!r.ok) {
              const e = (await r.json().catch(() => ({}))) as {
                error?: string;
              };
              throw new Error(
                e.error ||
                  '没有可用的 Godot 包，请先在原工具导出已采用的结果。',
              );
            }
            blob = await r.blob();
          }
          const prepared = await prepareGodotPackage(
            new Uint8Array(await blob.arrayBuffer()),
          );
          if (generation.current === turn)
            setPack({
              blob: new Blob([prepared.bytes], { type: 'application/zip' }),
              manifest: prepared.manifest,
            });
        } catch (e) {
          if (generation.current === turn) setError((e as Error).message);
        } finally {
          if (generation.current === turn) {
            setBusy(false);
            inFlight.current = false;
          }
        }
      })();
    };
    window.addEventListener('forge:godot-export', receive);
    return () => {
      window.removeEventListener('forge:godot-export', receive);
      removeEditorSession('godot-export');
    };
  }, []);
  useEffect(() => {
    if (!offer) {
      removeEditorSession('godot-export');
      return;
    }
    publishEditorSession({
      capabilityId: 'godot-export',
      items: [],
      dirty: false,
      busy,
      save: async () => {},
      beforeLeave: async () => !inFlight.current,
    });
    return () => removeEditorSession('godot-export');
  }, [offer, busy]);
  const run = async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };
  const deliver = () =>
    run(async () => {
      if (!pack) return;
      if (
        !project ||
        project.unavailable ||
        project.path !== pathValue.trim()
      ) {
        const p = await request('select', { projectPath: pathValue.trim() });
        setProject(p.project);
        setPathValue(p.project.path);
      }
      const r = await fetch('/api/workbench/game-export/deliver', {
        method: 'POST',
        headers: {
          'content-type': 'application/zip',
          'x-forge-game-token': token.current,
          'x-forge-project': encodeURIComponent(pathValue.trim()),
          'x-forge-title': encodeURIComponent(offer?.name || 'Godot 资产'),
        },
        body: pack.blob,
      });
      const data = (await r.json()) as Delivery & { error?: string };
      if (!r.ok) throw new Error(data.error || '写入游戏项目失败。');
      setDelivery(data);
      setNote('');
    });
  const download = () => {
    if (!pack) return;
    const url = URL.createObjectURL(pack.blob),
      a = document.createElement('a');
    a.href = url;
    a.download = (offer?.name || 'Forge') + '_godot.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    setNote('已发起 ZIP 下载；可解压到现有游戏项目根目录。');
  };
  const { summary: humanRequest, prompt: followup } = gameHandoff(delivery, pack?.manifest);
  return (
    <Dialog
      open={!!offer}
      onOpenChange={(open) => {
        if (!open && !inFlight.current) {
          generation.current++;
          setOffer(null);
          setBrowsing(false);
        }
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        style={{ width: 'calc(100vw - 32px)', maxWidth: 512 }}
        showCloseButton={!busy}
      >
        <DialogTitle>导出到 Godot 项目</DialogTitle>
        <DialogDescription>
          {offer?.name} ·{' '}
          {pack
            ? kinds[pack.manifest.kind]
            : busy
              ? '正在准备资源包'
              : '资源包尚未就绪'}
        </DialogDescription>
        {busy && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在处理…
          </p>
        )}
        {delivery ? (
          <>
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="size-5 text-[var(--theme-success)]" />
              {states[delivery.status] || delivery.status}
            </p>
            <p>
              已保存到 <strong>{delivery.project.name}</strong>
              。资源包和接入记录已就位，不需要手动解压或改资源路径。
            </p>
            <p className="text-muted-foreground">
              在 WorkBuddy
              里继续下面这句话，它会检测项目并完成接入。网页不会自行启动 Agent。
            </p>
            <p className="rounded-lg border border-border bg-muted p-3 text-sm">
              {humanRequest}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(followup);
                    setNote('接入请求已复制。');
                  })
                }
              >
                复制给 WorkBuddy
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setDelivery(await readGameDelivery(delivery.deliveryId));
                  })
                }
              >
                刷新接入进度
              </Button>
              <a className="wb-button" href={gameDeliveryHref(delivery.deliveryId)} onClick={() => setOffer(null)}>查看交付记录</a>
            </div>
            {delivery.integration && (
              <p>
                {delivery.integration.summary} ·{' '}
                {delivery.integration.engine.status === 'passed'
                  ? `Agent 已记录 Godot ${delivery.integration.engine.version || ''} 通过证据`
                  : delivery.integration.engine.status === 'failed'
                    ? '引擎验收未通过'
                    : '尚未执行引擎验收'}
              </p>
            )}
            <details>
              <summary>保存位置与完整接入请求</summary>
              <p className="break-all">{delivery.inboxPath}</p>
              <textarea
                aria-label="完整接入请求"
                readOnly
                rows={5}
                className="mt-2 w-full rounded border border-border p-2 text-sm"
                value={followup}
              />
            </details>
          </>
        ) : (
          <>
            <label className="grid gap-2 font-medium">
              游戏项目路径
              <input
                aria-label="游戏项目路径"
                disabled={busy}
                value={pathValue}
                onChange={(e) => setPathValue(e.target.value)}
                placeholder="选择已有 Godot 项目的根目录"
                className="w-full rounded-lg border border-border bg-background p-2 font-normal"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={busy || !connected}
                onClick={() => {
                  setError('');
                  setBrowsing((v) => !v);
                }}
              >
                <FolderOpen className="size-4" />
                选择项目…
              </Button>
              {project && !project.unavailable && (
                <span className="text-sm text-muted-foreground">
                  {project.name} · 已选择
                </span>
              )}
            </div>
            {browsing && (
              <GameProjectBrowser
                initialPath={pathValue}
                getToken={readToken}
                onCancel={() => setBrowsing(false)}
                onSelect={(chosen) => {
                  setProject(chosen);
                  setPathValue(chosen.path);
                  setBrowsing(false);
                  setError('');
                }}
              />
            )}
            <p className="text-muted-foreground">
              选择包含 project.godot
              的游戏文件夹，导出后会记住路径。也可以直接粘贴路径；WorkBuddy
              负责后续接入。
            </p>
            {project?.versionWarning && (
              <p className="text-sm text-muted-foreground">
                {project.versionWarning}
              </p>
            )}
            {pack && (
              <p className="text-sm">
                {pack.manifest.entryScenes.length} 个场景 ·{' '}
                {pack.manifest.spriteFrames.length} 个动画资源 ·
                包含实际图片与脚本
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || !pack || !pathValue.trim() || !connected}
                onClick={() => void deliver()}
              >
                导出到此项目
              </Button>
              <Button
                variant="outline"
                disabled={busy || !pack}
                onClick={download}
              >
                <Download className="size-4" />
                仅下载 ZIP
              </Button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive break-words">
            {error}
          </p>
        )}
        {note && (
          <output className="text-muted-foreground break-words">{note}</output>
        )}
      </DialogContent>
    </Dialog>
  );
}
