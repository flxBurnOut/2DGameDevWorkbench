import { fetchWorkbenchRuntime, runtimeUnavailable } from './runtime-proxy';
import { trustedRequest } from './request-security.mjs';

export async function forwardDocumentHttp(request: Request, path = '') {
  const denied = trustedRequest(request, { json: request.method === 'POST' });
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const response = await fetchWorkbenchRuntime(`/v1/documents${path}${url.search}`, {
      method: request.method,
      ...(request.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: request.body, duplex: 'half' } : {}),
    } as RequestInit);
    return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } });
  } catch (error) { return runtimeUnavailable(error); }
}
