import {
  fetchWorkbenchRuntime,
  runtimeUnavailable,
} from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

async function forward(request: Request) {
  const denied = trustedRequest(request, { json: request.method === 'POST' });
  if (denied) return denied;
  try {
    const response = await fetchWorkbenchRuntime(
      '/v1/reference-art/settings',
      request.method === 'POST'
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: await request.text(),
          }
        : undefined,
    );
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return runtimeUnavailable(error);
  }
}
export const GET = forward;
export const POST = forward;
