import {
  fetchWorkbenchRuntime,
  runtimeUnavailable,
} from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';
export async function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const input = Object.fromEntries(query);
  try {
    const response = await fetchWorkbenchRuntime('/v1/agent/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input,
        ...(input.detail !== undefined
          ? { detail: input.detail === 'true' }
          : {}),
        ...(input.candidateIndex
          ? { candidateIndex: Number(input.candidateIndex) }
          : {}),
        ...(input.offset !== undefined ? { offset: Number(input.offset) } : {}),
      }),
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
