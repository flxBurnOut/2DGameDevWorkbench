import {
  fetchWorkbenchRuntime,
  runtimeUnavailable,
} from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

export async function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  const requestedPath = new URL(request.url).searchParams.get('path');
  if (!requestedPath) {
    return Response.json({ error: '缺少产物路径。' }, { status: 400 });
  }
  try {
    const response = await fetchWorkbenchRuntime(
      `/v1/artifacts?path=${encodeURIComponent(requestedPath)}`,
    );
    const headers = new Headers();
    for (const name of ['content-type', 'content-length', 'content-disposition', 'cache-control']) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return runtimeUnavailable(error);
  }
}
