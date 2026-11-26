import manifest from '@/workbench/manifest.json';
import { fetchWorkbenchRuntime } from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

export async function DELETE(request: Request) {
  const denied = trustedRequest(request, { requireOrigin: true });
  if (denied) return denied;
  const connector = manifest.capabilities.find(
    (c) => c.id === 'sprite-generator',
  )!.connector;
  const base =
    (connector.urlEnv && process.env[connector.urlEnv]?.trim()) ||
    connector.defaultUrl;
  if (!base)
    return Response.json({ error: '序列帧服务地址未配置。' }, { status: 503 });
  const token = connector.tokenEnv
    ? process.env[connector.tokenEnv]
    : undefined;
  const sprite = (check: boolean) =>
    fetch(`${base.replace(/\/+$/, '')}/v1/history?check=${check}`, {
      method: 'DELETE',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10000),
    });
  const blockers: { id: string; href: string }[] = [];
  let spriteCount = 0;
  const verify = async (response: Response) => {
    const body = (await response.json()) as {
      count?: number;
      error?: string | { message?: string; details?: { job_ids?: string[] } };
    };
    if (!response.ok) {
      if (typeof body.error === 'object')
        for (const id of body.error.details?.job_ids || []) {
          const capability = manifest.capabilities.find(
            (entry) => entry.id === 'sprite-generator',
          );
          blockers.push({
            id,
            href: `${capability!.ui.route}?job=${encodeURIComponent(id)}`,
          });
        }
      if (
        typeof body.error === 'string' &&
        body.error.startsWith('后台任务仍在制作') &&
        body.error.includes('：')
      ) {
        for (const id of body.error.split('：')[1].split('、'))
          blockers.push({
            id,
            href: `/advanced?tab=records&task=${encodeURIComponent(id)}`,
          });
      }
      throw new Error(
        typeof body.error === 'string'
          ? body.error
          : body.error?.message || '归档接口不可用，请重启本地服务后重试。',
      );
    }
    return body;
  };
  try {
    await verify(
      await fetchWorkbenchRuntime('/v1/history?check=true', {
        method: 'DELETE',
      }),
    );
    await verify(await sprite(true));
    spriteCount = (await verify(await sprite(false))).count ?? 0;
    const runtime = await verify(
      await fetchWorkbenchRuntime('/v1/history', { method: 'DELETE' }),
    );
    return Response.json({
      ok: true,
      runtimeCount: runtime.count ?? 0,
      spriteCount,
    });
  } catch (error) {
    return Response.json(
      {
        error: `${spriteCount ? `已归档 ${spriteCount} 条序列帧作业；后台归档未完成。` : ''}${error instanceof Error ? error.message : '归档失败，请确认本地服务已启动。'}`,
        blockers,
      },
      { status: 409 },
    );
  }
}
