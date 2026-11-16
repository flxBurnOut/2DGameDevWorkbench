import {
  fetchWorkbenchRuntime,
  runtimeUnavailable,
} from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

export async function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  const searchParams = new URL(request.url).searchParams;
  const limit = searchParams.get('limit') ?? '30';
  const refresh = searchParams.get('refresh') === 'true' ? 'true' : 'false';
  const query = new URLSearchParams({ limit, refresh });
  for (const key of ['offset', 'snapshot', 'since', 'query', 'capabilityId', 'status']) {
    if (searchParams.has(key)) query.set(key, searchParams.get(key)!);
  }
  try {
    const response = await fetchWorkbenchRuntime(
      `/v1/tasks?${query}`,
    );
    return forwardJson(response);
  } catch (error) {
    return runtimeUnavailable(error);
  }
}

export async function POST(request: Request) {
  const denied = trustedRequest(request, { json: true });
  if (denied) return denied;
  try {
    const response = await fetchWorkbenchRuntime('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: await request.text(),
    });
    return forwardJson(response);
  } catch (error) {
    return runtimeUnavailable(error);
  }
}

async function forwardJson(response: Response) {
  return new Response(await response.text(), {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
