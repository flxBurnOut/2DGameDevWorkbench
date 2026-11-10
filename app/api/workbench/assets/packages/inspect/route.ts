import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';

export async function POST(request: Request) {
  try {
    const size = Number(request.headers.get('content-length'));
    if (Number.isFinite(size) && size > 768 * 1024 * 1024) return Response.json({ error: '素材包超过 768 MiB 上传上限。' }, { status: 413 });
    const response = await fetchWorkbenchRuntime('/v1/assets/packages/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-forge-filename': request.headers.get('x-forge-filename') || 'forge-assets.zip' },
      body: request.body,
      duplex: 'half',
      signal: AbortSignal.timeout(370000),
    } as RequestInit);
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) { return runtimeUnavailable(error); }
}
