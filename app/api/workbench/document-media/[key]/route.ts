import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';

async function forward(request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  if (!/^[a-f0-9]{64}\.(png|jpg|webp|wav|ogg|mp3|zip)$/.test(key)) return Response.json({ error: 'Invalid media identity.' }, { status: 400 });
  try {
    const response = await fetchWorkbenchRuntime(`/v1/document-media/${key}`, {
      method: request.method,
      ...(request.method === 'PUT' ? { headers: { 'content-type': request.headers.get('content-type') || '' }, body: request.body, duplex: 'half' } : {}),
    } as RequestInit);
    const headers = new Headers();
    for (const name of ['content-type', 'content-length', 'cache-control', 'etag', 'x-content-type-options']) {
      const value = response.headers.get(name); if (value) headers.set(name, value);
    }
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  } catch (error) { return runtimeUnavailable(error); }
}
export const GET = forward;
export const HEAD = forward;
export const PUT = forward;
