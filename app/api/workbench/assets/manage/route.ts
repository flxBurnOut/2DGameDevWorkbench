import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';
export async function POST(request: Request) {
  const denied = trustedRequest(request, { json: true });
  if (denied) return denied;
  try {
    const response = await fetchWorkbenchRuntime('/v1/assets/manage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await request.json()),
    });
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) { return runtimeUnavailable(error); }
}
