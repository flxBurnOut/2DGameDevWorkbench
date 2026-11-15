'use client';
import {offerGodotExport} from '@/lib/workbench/godot-export';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Server,
  TerminalSquare,
  Wifi,
  WifiOff,
  ArrowLeft,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { WorkbenchModule } from '@/lib/workbench/modules';
import { useWorkbench } from '@/components/workbench/workbench-provider';
import { publishEditorSession, removeEditorSession } from '@/lib/workbench/editor-session';
import { useWorkbenchTheme } from '@/components/workbench/theme-toggle';
import { getTheme } from '@/lib/workbench/theme';

type PipelineStatus = 'checking' | 'ready' | 'offline' | 'api-only';

const defaultPipelineUrl = 'http://127.0.0.1:7860';

function normalizedPipelineUrl() {
  const configured = process.env.NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL?.trim();
  const value = configured || defaultPipelineUrl;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return defaultPipelineUrl;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return defaultPipelineUrl;
  }
}

export function SpritePipelineWorkspace({
  module,
  returnToMotion,
}: {
  module: WorkbenchModule;
  returnToMotion?: string;
}) {
  const [status, setStatus] = useState<PipelineStatus>('checking');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [pipelineVersion, setPipelineVersion] = useState<string | null>(null);
  const pipelineUrl = normalizedPipelineUrl();
  const iframe = useRef<HTMLIFrameElement>(null);
  const theme = useWorkbenchTheme();
  const [initialTheme, setInitialTheme] = useState('');
  const { spriteItems } = useWorkbench();
  const [entryJob, setEntryJob] = useState('');
  const [entryCharacter, setEntryCharacter] = useState('');
  const [entryCandidate, setEntryCandidate] = useState('');
  const [activeJob, setActiveJob] = useState('');
  const [parentOrigin, setParentOrigin] = useState('');
  const embedded = new URL(pipelineUrl);
  embedded.searchParams.set('workbench_embedded', '1');
  if (entryJob) {
    embedded.searchParams.set('workbench_job', entryJob);
    if (entryCandidate)
      embedded.searchParams.set('workbench_candidate', entryCandidate);
  } else if (entryCharacter)
    embedded.searchParams.set('workbench_character', entryCharacter);
  if (parentOrigin) embedded.searchParams.set('workbench_origin', parentOrigin);
  if (initialTheme) embedded.searchParams.set('workbench_theme', initialTheme);
  const embeddedUrl = embedded.toString();
  const standalone = new URL(embeddedUrl);
  standalone.searchParams.delete('workbench_embedded');
  standalone.searchParams.set('workbench_theme', theme);
  const sendTheme = () => iframe.current?.contentWindow?.postMessage({ type: 'workbench:theme', theme }, new URL(pipelineUrl).origin);
  useEffect(() => {
    const send = () => iframe.current?.contentWindow?.postMessage({ type: 'workbench:theme', theme }, new URL(pipelineUrl).origin);
    const onReady = (event: MessageEvent) => {
      if (event.origin === new URL(pipelineUrl).origin && event.source === iframe.current?.contentWindow && event.data?.type === 'workbench:theme-ready') send();
    };
    send();
    window.addEventListener('message', onReady);
    return () => window.removeEventListener('message', onReady);
  }, [theme, pipelineUrl]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const job = params.get('job') || '';
    // oxlint-disable-next-line react/react-compiler -- Hydrate the browser-only deep link after server rendering.
    setEntryJob(job);
    setActiveJob(job);
    setParentOrigin(location.origin);
    setEntryCharacter(params.get('character') || '');
    setEntryCandidate(params.get('candidate') || '');
    setInitialTheme(getTheme());
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== new URL(pipelineUrl).origin ||
        event.source !== iframe.current?.contentWindow
      )
        return;
      if (event.data?.type === 'workbench:sprite-godot-export') {
        const { jobId, candidateIndex } = event.data;
        if (typeof jobId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(jobId) && Number.isInteger(candidateIndex) && candidateIndex >= 1) {
          const title = typeof event.data.name === 'string' ? event.data.name.slice(0,160) : '角色动画';
          offerGodotExport({ name: title + ' · 候选 ' + candidateIndex, jobId, candidateIndex });
        }
        return;
      }
      if (
        event.data?.type === 'workbench:sprite-job' &&
        typeof event.data.jobId === 'string' &&
        event.data.jobId.length <= 200
      )
        setActiveJob(event.data.jobId);
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      removeEditorSession('sprite-generator');
    };
  }, [pipelineUrl]);
  const activeItem = spriteItems.find(
    (item) => item.id === `sprite:${activeJob}`,
  );
  useEffect(() => {
    publishEditorSession({
      capabilityId: 'sprite-generator',
      items: activeItem ? [activeItem] : [],
      dirty: false,
      busy: false,
      save: async () => {},
    });
  }, [activeItem]);

  const checkConnection = useCallback(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6000);

    try {
      const response = await fetch('/api/workbench/sprite-pipeline/health', {
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        version?: string;
        uiReady?: boolean;
        uiError?: string;
        error?: string;
      } | null;
      if (
        !response.ok ||
        payload?.ok !== true ||
        typeof payload.version !== 'string'
      ) {
        throw new Error(payload?.error || '序列帧服务未就绪。');
      }
      setPipelineVersion(payload.version);
      setConnectionMessage(payload.uiError || '');
      setStatus(payload.uiReady === true ? 'ready' : 'api-only');
    } catch (error) {
      setConnectionMessage(
        error instanceof Error ? error.message : '序列帧服务未就绪。',
      );
      setPipelineVersion(null);
      setStatus('offline');
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- This effect synchronizes the UI with an external sidecar service.
    void checkConnection();
  }, [checkConnection]);

  return (
    <main data-sprite-editor className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-3 py-2 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-[var(--theme-accent)] bg-[var(--theme-accent-soft)] text-[var(--theme-accent)]">
            <Server className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {module.name}
            </p>
          </div>
        </div>

        <div
          aria-live="polite"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          {status === 'checking' ? (
            <LoaderCircle className="size-3.5 animate-spin text-[var(--theme-accent)]" />
          ) : status === 'ready' ? (
            <Wifi className="size-3.5 text-[var(--theme-success)]" />
          ) : (
            <WifiOff className="size-3.5 text-[var(--theme-warning)]" />
          )}
          {status === 'checking'
            ? '正在连接'
            : status === 'ready'
              ? `本地管线已连接${pipelineVersion ? ` · v${pipelineVersion}` : ''}`
              : status === 'api-only'
                ? '接口已连接，界面未就绪'
                : '本地管线未启动'}
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus('checking');
              void checkConnection();
            }}
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
            重试
          </Button>
          <a
            href={standalone.toString()}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-muted px-2.5 text-[0.8rem] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)]"
          >
            <ExternalLink className="size-3.5" />
            单独打开
          </a>
        </div>
      </header>

      <nav aria-label="返回动作工作区" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-sm">
        <a
          href={returnToMotion || '/tools/sprite-generator'}
          className="inline-flex items-center gap-1 font-medium text-[var(--theme-accent)]"
        >
          <ArrowLeft className="size-4" />
          {returnToMotion ? '返回当前作品' : '返回五阶段工作区'}
        </a>
        <span className="text-xs text-muted-foreground">
          逐帧修改请先保存；返回后会加载已保存的结果，修改过的动画需要重新检查。
        </span>
      </nav>

      {status === 'ready' ? (
        <iframe
          ref={iframe}
          onLoad={sendTheme}
          key={embeddedUrl}
          src={embeddedUrl}
          title="NativeFramesGeneration 序列帧生成工作区"
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      ) : (
        <section className="grid min-h-0 flex-1 place-items-center overflow-auto px-4 py-8">
          <div className="w-full max-w-2xl rounded-3xl border border-border bg-background p-5 shadow-2xl shadow-black/25 sm:p-7">
            <div className="flex items-start gap-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-[var(--theme-warning)] bg-[var(--theme-warning-soft)] text-[var(--theme-warning)]">
                <TerminalSquare className="size-5" />
              </span>
              <div>
                <h1 className="text-lg font-semibold text-foreground">
                  本地序列帧管线未就绪
                </h1>
                {connectionMessage && <p role="alert" className="mt-2 text-sm text-[var(--theme-warning)]">{connectionMessage}</p>}
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                  完整的生成、播放检查、逐帧修补和 Sprite Sheet
                  导出界面由本项目内置的 Python 管线提供。正常情况下它会随
                  Workbench 自动启动；首次使用只需安装一次依赖。
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-3 rounded-2xl border border-border bg-muted p-4 font-mono text-sm">
              <div>
                <p className="mb-1 text-xs font-sans text-muted-foreground">首次安装</p>
                <code className="select-all text-[var(--theme-accent)]">
                  npm run sprite-pipeline:setup
                </code>
              </div>
              <div className="border-t border-border pt-3">
                <p className="mb-1 text-xs font-sans text-muted-foreground">仅单独调试管线时</p>
                <code className="select-all text-[var(--theme-cyan)]">
                  npm run sprite-pipeline
                </code>
              </div>
            </div>

            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              服务默认只监听本机 {pipelineUrl}。PixelLab Key 由管线使用当前
              Windows 用户的安全存储管理，不会进入网页项目或 Git。
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
