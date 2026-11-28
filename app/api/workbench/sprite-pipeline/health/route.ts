import { probeSpritePipelineUi } from '@/lib/workbench/sprite-pipeline-supervisor.mjs';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

const DEFAULT_API_URL = 'http://127.0.0.1:7860';

function endpointUrl(baseUrl: string) {
  return `${baseUrl.trim().replace(/\/+$/, '')}/health`;
}

export async function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  const baseUrl = process.env.SPRITE_PIPELINE_API_URL?.trim() || DEFAULT_API_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetch(endpointUrl(baseUrl), {
      cache: 'no-store',
      signal: controller.signal,
      headers: process.env.SPRITE_PIPELINE_API_TOKEN
        ? { authorization: `Bearer ${process.env.SPRITE_PIPELINE_API_TOKEN}` }
        : undefined,
    });
    const payload = (await response.json().catch(() => null)) as {
      ok?: unknown;
      version?: unknown;
      pixellab_configured?: unknown;
    } | null;
    if (!response.ok || payload?.ok !== true || typeof payload.version !== 'string') {
      return Response.json(
        { ok: false, error: '端口响应不是受支持的 SpritePipeline 健康协议。' },
        { status: 502 },
      );
    }
    const ui = await probeSpritePipelineUi(process.env.NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL?.trim() || DEFAULT_API_URL);
    return Response.json(
      {
        ok: true,
        uiReady: ui.ready,
        uiError: ui.error,
        version: payload.version,
        pixellabConfigured: payload.pixellab_configured === true,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error && error.name === 'AbortError'
            ? 'SpritePipeline 健康检查超时。'
            : 'SpritePipeline 本地服务不可达。',
      },
      { status: 503 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
