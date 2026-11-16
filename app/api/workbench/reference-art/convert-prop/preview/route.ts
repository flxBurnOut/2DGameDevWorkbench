import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

export async function POST(request: Request) {
  const denied = trustedRequest(request, { json: true });
  if (denied) return denied;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body) > 42_000_000) return Response.json({error: '源图片超过 30 MB'}, {status: 413});
    const response = await fetchWorkbenchRuntime('/v1/reference-art/convert-prop/preview', {
      method: 'POST', headers: {'content-type': 'application/json'}, body,
    });
    return new Response(response.body, {status: response.status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
  } catch (error) { return runtimeUnavailable(error); }
}
