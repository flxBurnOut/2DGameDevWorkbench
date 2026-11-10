'use client';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { workbenchModules, productionLines } from '@/lib/workbench/modules';
import { readTaskHistory } from '@/lib/workbench/task-history';
import { AgentFollow } from './agent-follow';
import { GodotExportDialog } from './godot-export-dialog';
import {
  listWorkItems,
  subscribeWorkItems,
} from '@/lib/workbench/browser-store';
import {
  getEditorSessions,
  getServerEditorSessions,
  subscribeEditorSessions,
  saveBeforeNavigation,
} from '@/lib/workbench/editor-session';
import {
  mergeWorkItems,
  taskWorkItems,
  spriteWorkItem,
  openMotionWorkItem,
  type OpenMotionSummary,
  type WorkItem,
  type StoredTask,
  type SpriteJob,
} from '@/lib/workbench/work-items';

function subscribePath(fn: () => void) {
  window.addEventListener('popstate', fn);
  return () => window.removeEventListener('popstate', fn);
}
import {workbenchContext as context} from './workbench-context';
export type WorkbenchState=ReturnType<typeof useWorkbenchState>;

function useWorkbenchState() {
  const pathname = useSyncExternalStore(
    subscribePath,
    () => location.pathname,
    () => '/',
  );
  const sessions = useSyncExternalStore(
    subscribeEditorSessions,
    getEditorSessions,
    getServerEditorSessions,
  );
  const [localItems, setLocalItems] = useState<WorkItem[]>([]);
  const [tasks, setTasks] = useState<StoredTask[]>([]);
  const [sprites, setSprites] = useState<WorkItem[]>([]);
  const [runtimeOnline, setRuntimeOnline] = useState<boolean | null>(null);
  const [spriteOnline, setSpriteOnline] = useState<boolean | null>(null);
  const [storageError, setStorageError] = useState('');
  const [navigationError, setNavigationError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const refreshLock = useRef(false);
  const navigating = useRef(false);
  const mounted = useRef(true);
  const refreshLocal = useCallback(async () => {
    try {
      const items = await listWorkItems();
      if (mounted.current) {
        setLocalItems(items);
        setStorageError('');
      }
    } catch {
      if (mounted.current)
        setStorageError('本机草稿暂时无法读取；请保留当前页面并保存源文件。');
    }
  }, []);
  const refresh = useCallback(async () => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    const request = async (url: string) => {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('状态读取失败');
      return response.json() as Promise<{
        tasks?: StoredTask[];
        jobs?: SpriteJob[];
        works?: OpenMotionSummary[];
        nextOffset?: number | null;
        snapshot?: string;
      }>;
    };
    await Promise.allSettled([
      refreshLocal(),
      readTaskHistory(request)
        .then((tasks) => {
          if (mounted.current) {
            setTasks(tasks);
            setRuntimeOnline(true);
          }
        })
        .catch(() => {
          if (mounted.current) setRuntimeOnline(false);
        }),
      request('/api/workbench/sprite-pipeline/jobs')
        .then((data) => {
          if (!Array.isArray(data.jobs)) throw new Error('序列帧响应无效');
          const capabilityModule = workbenchModules.find(
            (m) => m.id === 'sprite-generator',
          );
          if (mounted.current) {
            setSprites(
              capabilityModule
                ? [...data.jobs.filter((job: SpriteJob) => !data.works?.some(work => work.id === job.open_work_id)).map((job: SpriteJob) =>
                    spriteWorkItem(job, capabilityModule.href),
                  ), ...(data.works || []).map(work => openMotionWorkItem(work, capabilityModule.href))]
                : [],
            );
            setSpriteOnline(true);
          }
        })
        .catch(() => {
          if (mounted.current) setSpriteOnline(false);
        }),
    ]);
    refreshLock.current = false;
    if (mounted.current) setRefreshing(false);
  }, [refreshLocal]);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void tick(), 6000);
    };
    void tick();
    const unsubscribe = subscribeWorkItems(() => void refreshLocal());
    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh, refreshLocal]);
  const navigate = useCallback(async (href: string) => {
    if (navigating.current) return;
    navigating.current = true;
    window.dispatchEvent(new Event('workbench:manual-navigation'));
    setNavigationError('');
    try {
      await saveBeforeNavigation();
      window.location.assign(href);
    } catch (error) {
      setNavigationError(
        error instanceof Error ? error.message : '保存未完成，请先保存源文件。',
      );
    } finally {
      navigating.current = false;
    }
  }, []);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element)?.closest<HTMLAnchorElement>(
        'a[href]',
      );
      if (
        !anchor ||
        anchor.hasAttribute('download') ||
        anchor.target ||
        anchor.dataset.nativeNavigation
      )
        return;
      const url = new URL(anchor.href, location.href);
      if (
        url.origin !== location.origin ||
        url.pathname.startsWith('/api/') ||
        (url.pathname === location.pathname && url.search === location.search)
      )
        return;
      event.preventDefault();
      void navigate(url.href);
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      if (getEditorSessions().some((s) => s.dirty || s.busy))
        event.preventDefault();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [navigate]);
  const items = useMemo(() => {
    const merged = mergeWorkItems(
      localItems,
      taskWorkItems(tasks, workbenchModules),
      sprites,
    );
    const byId = new Map(merged.map((item) => [item.id, item]));
    for (const session of sessions)
      for (const item of session.items) {
        const previous = byId.get(item.id);
        byId.set(item.id, {
          ...previous,
          ...item,
          taskIds: previous?.taskIds,
          outputs: previous?.outputs,
        });
      }
    return [...byId.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [localItems, tasks, sprites, sessions]);
  return {
    pathname,
    modules: workbenchModules,
    lines: productionLines,
    items,
    tasks,
    spriteItems: sprites,
    localItems,
    sessions,
    runtimeOnline,
    spriteOnline,
    storageError,
    navigationError,
    setNavigationError,
    refreshing,
    refresh,
    navigate,
    guideOpen,
    setGuideOpen,
    helpOpen,
    setHelpOpen,
    queueOpen,
    setQueueOpen,
  };
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const value = useWorkbenchState();
  return (
    <context.Provider value={value}>
      <AgentBridge />
      <AgentFollow />
      <GodotExportDialog />
      {children}
    </context.Provider>
  );
}
export function useWorkbench() {
  const value = useContext(context);
  if (!value) throw new Error('WorkbenchProvider is required');
  return value;
}

function AgentBridge() {
  const { modules, refresh, setQueueOpen } = useWorkbench();
  useEffect(() => {
    type Tool = {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: object;
      execute: (input: unknown) => unknown;
    };
    const bridge = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: Tool,
            options: { signal: AbortSignal },
          ) => unknown;
        };
      }
    ).modelContext;
    if (!bridge?.registerTool) return;
    const controller = new AbortController();
    const tools: Tool[] = [
      {
        name: 'list_workbench_capabilities',
        title: '列出 2D 工作台能力',
        description: '从工作台 Manifest 读取可用生产能力。',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: () => ({
          capabilities: modules
            .filter((m) => m.executable)
            .map((m) => ({
              id: m.id,
              name: m.name,
              description: m.description,
              features: m.capabilities,
            })),
        }),
      },
      {
        name: 'start_workbench_task',
        title: '启动 2D 工作台任务',
        description: '执行用户已授权的工作台能力，并在制作状态栏显示真实状态。',
        inputSchema: {
          type: 'object',
          required: ['capabilityId', 'input'],
          additionalProperties: false,
          properties: {
            capabilityId: {
              type: 'string',
              enum: modules.filter((m) => m.executable).map((m) => m.id),
            },
            input: {
              type: 'object',
              description: '符合该能力 Manifest 中的 inputSchema。',
            },
          },
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (raw) => {
          const value = raw as {
            capabilityId?: string;
            input?: unknown;
          } | null;
          if (
            !value ||
            !modules.some((m) => m.id === value.capabilityId && m.executable) ||
            !value.input ||
            typeof value.input !== 'object' ||
            Array.isArray(value.input)
          )
            throw new Error('capabilityId 或 input 无效。');
          const response = await fetch('/api/workbench/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(value),
          });
          const result = (await response.json()) as {
            error?: string;
            taskId?: string;
            status?: string;
            outputs?: string[];
          };
          setQueueOpen(true);
          await refresh();
          if (!response.ok) throw new Error(result.error || '任务执行失败');
          return result;
        },
      },
    ];
    for (const tool of tools) {
      try {
        void Promise.resolve(
          bridge.registerTool(tool, { signal: controller.signal }),
        ).catch(() => undefined);
      } catch {
        /* Older clients may not support the browser bridge; MCP and CLI remain available. */
      }
    }
    return () => controller.abort();
  }, [modules, refresh, setQueueOpen]);
  return null;
}
