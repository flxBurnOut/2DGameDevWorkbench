import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';

async function proxy(request: Request, method: 'GET' | 'POST') {
  try {
    const search = method === 'GET' ? new URL(request.url).search : '';
    const response = await fetchWorkbenchRuntime(`/v1/assets/packages/commit${search}`, {
      method,
      ...(method === 'POST' ? { body: request.body, headers: { 'content-type': 'application/json' }, duplex: 'half' } : {}),
      signal: AbortSignal.timeout(370000),
    } as RequestInit);
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) { return runtimeUnavailable(error); }
}
export const POST = (request: Request) => proxy(request, 'POST');
export const GET = (request: Request) => proxy(request, 'GET');
