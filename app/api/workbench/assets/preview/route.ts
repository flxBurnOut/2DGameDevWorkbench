import {
  fetchWorkbenchRuntime,
  runtimeUnavailable,
} from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';
export async function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  try {
    const query = new URL(request.url).searchParams;
    const selected = new URLSearchParams();
    for (const key of ['assetId', 'projectRevision', 'task', 'batch', 'origin']) {
      const value = query.get(key);
      if (value) selected.set(key, value);
    }
    const response = await fetchWorkbenchRuntime('/v1/assets/preview?' + selected);
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type':
          response.headers.get('content-type') || 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return runtimeUnavailable(error);
  }
}
