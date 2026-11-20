import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

export async function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  try {
    const response = await fetchWorkbenchRuntime(`/v1/assets/packages/preview${new URL(request.url).search}`);
    return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch (error) { return runtimeUnavailable(error); }
}
