import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

const operations = new Set(['inspect', 'resolve', 'part-context', 'part-get', 'part-suggest', 'plan-prepare', 'plan-get', 'review-record', 'critic-prepare','critic-get','critic-run','edit', 'apply', 'session-create', 'session-get']);
export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  const denied = trustedRequest(request, { json: true });
  if (denied) return denied;
  const { operation } = await context.params;
  if (!operations.has(operation)) return Response.json({ error: 'Unknown image edit operation.' }, { status: 404 });
  try {
    const response = await fetchWorkbenchRuntime(`/v1/agent/image-${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.body, duplex: 'half' } as RequestInit);
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) { return runtimeUnavailable(error); }
}

export async function GET(request: Request, context: { params: Promise<{ operation: string }> }) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  if ((await context.params).operation !== 'media') return Response.json({ error: 'Unknown media route.' }, { status: 404 });
  try {
    const response = await fetchWorkbenchRuntime('/v1/image-edit/media' + new URL(request.url).search);
    const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    for (const name of ['content-type', 'etag', 'content-length']) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) { return runtimeUnavailable(error); }
}
