import manifest from '@/workbench/manifest.json';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';
const label = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;

/** Read only: observe native UI jobs without creating tasks or submitting generation. */
export async function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  const capability = manifest.capabilities.find(
    (c) => c.id === 'sprite-generator',
  );
  const connector = capability?.connector as
    | { urlEnv?: string; defaultUrl?: string; tokenEnv?: string }
    | undefined;
  const baseUrl =
    (connector?.urlEnv && process.env[connector.urlEnv]) ||
    connector?.defaultUrl;
  if (!baseUrl)
    return Response.json({ error: '序列帧服务未配置' }, { status: 503 });
  const token = connector?.tokenEnv
    ? process.env[connector.tokenEnv]
    : undefined;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/jobs`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3500),
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    const payload = (await response.json()) as {
      data?: { jobs?: Record<string, unknown>[] };
    };
    if (!response.ok || !Array.isArray(payload.data?.jobs))
      throw new Error('Invalid job response');
    const jobs = payload.data.jobs
      .filter(
        (job: Record<string, unknown>) =>
          typeof job.job_id === 'string' &&
          job.character_id !== 'diagnostic_dummy' &&
          job.provider !== 'fixture' &&
          job.status !== 'invalid',
      )
      .map((job: Record<string, unknown>) => ({
        job_id: job.job_id,
        status: label(job.status, 'attention_required'),
        updated_at: label(job.updated_at),
        character_id: label(job.character_id),
        character_name: label(job.character_name),
        action_id: label(job.action_id),
        action_name: label(job.action_name),
        open_work_id: label(job.open_work_id),
      }));
    const motion = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/open-motion`, {
      cache: 'no-store', signal: AbortSignal.timeout(3500),
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    }).then(async r => r.ok ? await r.json() as { works?: Record<string,unknown>[] } : null).catch(() => null);
    const works = Array.isArray(motion?.works) ? motion.works.filter(w => !w.diagnostic_only) : [];
    return Response.json(
      { jobs, works },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return Response.json({ error: '序列帧服务暂时无法连接' }, { status: 503 });
  }
}
