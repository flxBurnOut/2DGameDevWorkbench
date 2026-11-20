import {
  fetchWorkbenchRuntime,
  runtimeUnavailable,
} from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';
export async function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const input: Record<string, unknown> = Object.fromEntries(query);
  for (const key of ['offset', 'limit', 'candidateIndex', 'candidateCount'])
    if (query.has(key)) input[key] = Number(query.get(key));
  try {
    const response = await fetchWorkbenchRuntime(
      `/v1/agent/${query.has('assetId') ? 'asset' : 'assets'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    return new Response(response.body, {
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
export async function POST(request: Request) {
  const denied = trustedRequest(request, { json: true });
  if (denied) return denied;
  try {
    const response = await fetchWorkbenchRuntime('/v1/agent/asset-manifest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await request.json()),
    });
    return new Response(response.body, {
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
