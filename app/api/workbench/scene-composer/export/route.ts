import {
  fetchWorkbenchRuntime,
  runtimeUnavailable,
} from '@/lib/workbench/runtime-proxy';
export async function POST(request: Request) {
  try {
    const response = await fetchWorkbenchRuntime('/v1/scene-composer/export', {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') || 'application/zip' },
      body: request.body,
      duplex: 'half',
    } as RequestInit);
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
