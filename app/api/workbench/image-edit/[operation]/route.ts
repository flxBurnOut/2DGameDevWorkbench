import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

const operations = new Set(['inspect', 'resolve', 'part-context', 'part-get', 'part-suggest', 'plan-prepare', 'plan-get', 'review-record', 'critic-prepare','critic-get','critic-run','edit', 'apply', 'session-create', 'session-get']);
export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  const denied = trustedRequest(request, { json: true });
  if (denied) return denied;
  const { operation: requested } = await context.params;
  const paid = ['paid-edit', 'paid-part-suggest', 'paid-critic-run'].includes(requested);
  const operation = paid ? requested.slice('paid-'.length) : requested;
  if (!paid && ['part-suggest', 'critic-run'].includes(operation))
    return Response.json({ code: 'WORKSPACE_REQUIRED', error: '请刷新页面，在原工作区恢复视觉分析。' }, { status: 409 });
  if (!operations.has(operation)) return Response.json({ error: 'Unknown image edit operation.' }, { status: 404 });
  try {
    const workspaceId = request.headers.get('x-forge-workspace') || undefined;
    if (paid && !/^[a-f0-9]{64}$/.test(workspaceId || ''))
      return Response.json({ code: 'IMAGE_SUBMISSION_UNKNOWN', error: '请刷新页面，在原工作区恢复 AI 修改请求。' }, { status: 409 });
    const route = operation === 'edit' ? (paid ? '/v1/web/image-edit/paid' : '/v1/web/image-edit/local') : `/v1/agent/image-${operation}`;
    const response = await fetchWorkbenchRuntime(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.body, duplex: 'half' } as RequestInit, workspaceId);
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) { return runtimeUnavailable(error); }
}

export async function GET(request: Request, context: { params: Promise<{ operation: string }> }) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  const { operation } = await context.params;
  if (operation === 'receipt') {
    const workspaceId = request.headers.get('x-forge-workspace') || '';
    if (!/^[a-f0-9]{64}$/.test(workspaceId)) return Response.json({ error: '缺少工作区身份。' }, { status: 409 });
    try { return await fetchWorkbenchRuntime('/v1/image-edit/receipt' + new URL(request.url).search, {}, workspaceId); }
    catch (error) { return runtimeUnavailable(error); }
  }
  if (operation !== 'media') return Response.json({ error: 'Unknown media route.' }, { status: 404 });
  try {
    const response = await fetchWorkbenchRuntime('/v1/image-edit/media' + new URL(request.url).search);
    const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    for (const name of ['content-type', 'etag', 'content-length']) {
      // Fetch decodes an encoded body but leaves its wire length in the headers.
      if (name === 'content-length' && response.headers.has('content-encoding')) continue;
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) { return runtimeUnavailable(error); }
}
