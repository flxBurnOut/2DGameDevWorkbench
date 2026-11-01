import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';

const operations = new Set(['inspect', 'resolve', 'panel-suggest', 'edit', 'apply', 'session-create', 'session-get']);
export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  if (!operations.has(operation)) return Response.json({ error: 'Unknown image edit operation.' }, { status: 404 });
  try {
    const response = await fetchWorkbenchRuntime(`/v1/agent/image-${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.body, duplex: 'half' } as RequestInit);
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) { return runtimeUnavailable(error); }
}
