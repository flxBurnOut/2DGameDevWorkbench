import {
  fetchWorkbenchRuntime,
  runtimeUnavailable,
} from '@/lib/workbench/runtime-proxy';

async function proxy(request: Request) {
  const url = new URL(request.url),
    action = url.pathname.split('/').pop() || '';
  if (!['settings', 'history', 'record', 'select', 'browse', 'pick', 'deliver', 'package'].includes(action))
    return new Response(null, { status: 404 });
  const origin = request.headers.get('origin');
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin && origin !== url.origin)
  )
    return Response.json(
      { error: '仅允许从工作台页面选择或写入游戏项目。' },
      { status: 403 },
    );
  try {
    const headers = new Headers();
    for (const name of [
      'content-type',
      'x-forge-game-token',
      'x-forge-project',
      'x-forge-title',
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const query = ['history', 'record'].includes(action) ? url.search : '';
    const response = await fetchWorkbenchRuntime('/v1/game-export/' + action + query, {
      method: request.method,
      headers,
      ...(request.method === 'POST'
        ? { body: request.body, duplex: 'half' }
        : {}),
    } as RequestInit);
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type':
          response.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return runtimeUnavailable(error);
  }
}
export const GET = proxy;
export const POST = proxy;
