import {
  fetchWorkbenchRuntime,
  runtimeUnavailable,
} from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';
export async function POST(request: Request) {
  const denied = trustedRequest(request, { json: true });
  if (denied) return denied;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: '下载请求格式无效。' }, { status: 400 });
  }
  try {
    const response = await fetchWorkbenchRuntime('/v1/assets/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const headers = new Headers({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    for (const name of [
      'content-type',
      'content-disposition',
      'content-length',
      'x-asset-count',
      'x-asset-file-count',
    ]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return runtimeUnavailable(error);
  }
}
