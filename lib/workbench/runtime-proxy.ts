import { fetchBridge } from './service-endpoints.mjs';

declare const __FORGE_WORKSPACE_ID__: string;

export async function fetchWorkbenchRuntime(pathname: string, init?: RequestInit, pinnedWorkspace?: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 370_000);
  try {
    return await fetchBridge(pathname, {
      ...init, cache: 'no-store', signal: init?.signal ?? controller.signal,
    }, typeof __FORGE_WORKSPACE_ID__ === 'string' ? __FORGE_WORKSPACE_ID__ : undefined, pinnedWorkspace);
  } finally {
    clearTimeout(timeout);
  }
}

export function runtimeUnavailable(error: unknown) {
  return Response.json(
    {
      status: 'failed',
      error:
        error instanceof Error && error.name === 'AbortError'
          ? '本地 Workbench Runtime Bridge 请求超时。'
          : '本地 Workbench Runtime Bridge 未启动；请使用 npm run dev 或 npm run workbench:http。',
    },
    { status: 503 },
  );
}
