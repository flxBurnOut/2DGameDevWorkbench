import manifest from '@/workbench/manifest.json';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

// Deliberately bounded proxy: no arbitrary URL, path, header or method passthrough.
const work = '[0-9a-f]{32}';
const job = '[a-zA-Z0-9_]{1,200}';
const structureRead = new RegExp(`^open-motion/(?:structure-runtime|references/[a-z0-9_]+/structure|structures/${work}(?:/source|/masks/[a-z][a-z0-9_-]{0,63})?)$`);
const structureWrite = new RegExp(`^open-motion/structures(?:/${work}/corrections)?$`);
const temporalRead = new RegExp(`^open-motion/(?:${work}/temporal|temporal-structures/${work}(?:/frames/[0-9]{1,3}(?:/parts/[a-z][a-z0-9_-]{0,63})?)?)$`);
const temporalWrite = new RegExp(`^open-motion/(?:${work}/temporal|temporal-structures/${work}/(?:corrections|review))$`);
const read = new RegExp(
  `^(?:open-motion(?:/(?:settings|references(?:/[a-z0-9_]+)?|${work}(?:/reference|/targets/[0-3]|/progress-image|/adjustments(?:/${work}(?:/(?:source|proposed)/[0-9]{1,2})?)?|/candidates/[1-8]/stages/[0-3](?:/state-image|/frames/[0-9]{1,2}|/repairs/[0-1]/frames/[0-9]{1,2})?)?))?|jobs/${job}(?:/candidates/[1-8]/frames/[0-9]{1,2}/image|/exports/(?:sheet|preview|godot))?)$`,
);
const write = new RegExp(
  `^open-motion(?:/(?:settings|references|${work}/(?:revise|generate|pause|resume|review|review-stage|target|repair-stage|review-repair|export|recover|local-frame-edits|adjustments(?:/${work}/decision)?)))?$`,
);

async function proxy(request: Request) {
  const denied = trustedRequest(request, { json: request.method !== 'GET' });
  if (denied) return denied;
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || 'open-motion';
  if (!(request.method === 'GET' ? read.test(path) || structureRead.test(path) || temporalRead.test(path) : write.test(path) || structureWrite.test(path) || temporalWrite.test(path)))
    return Response.json({ error: '不支持的工作区操作' }, { status: 400 });
  const connector = manifest.capabilities.find(
    (c) => c.id === 'sprite-generator',
  )!.connector;
  const base =
    (connector.urlEnv && process.env[connector.urlEnv]) || connector.defaultUrl;
  const token = connector.tokenEnv
    ? process.env[connector.tokenEnv]
    : undefined;
  if (!base)
    return Response.json({ error: '序列帧服务未配置' }, { status: 503 });
  const target = new URL(`/v1/${path}`, base);
  const revision = url.searchParams.get('revision');
  if (revision) {
    if (!/^[1-9][0-9]{0,3}$/.test(revision))
      return Response.json({ error: '版本号无效' }, { status: 400 });
    target.searchParams.set('revision', revision);
  }
  const candidate = url.searchParams.get('candidate');
  if (candidate && /^[1-8]$/.test(candidate))
    target.searchParams.set('candidate', candidate);
  const stage = url.searchParams.get('stage');
  if (stage !== null) {
    if (!/^[0-3]$/.test(stage)) return Response.json({error:'片段编号无效'},{status:400});
    target.searchParams.set('stage',stage);
  }
  try {
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && Buffer.byteLength(body) > 2_100_000)
      return Response.json(
        { error: '请求过大，请使用 64 或 128 像素 PNG' },
        { status: 413 },
      );
    const response = await fetch(target, {
      method: request.method,
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
      body,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const headers = new Headers({ 'cache-control': 'no-store' });
    for (const name of ['content-type', 'content-disposition']) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return Response.json(
      {
        error:
          '角色服务暂时无法连接。已保存的任务会保留；请恢复服务后查询原任务。',
      },
      { status: 503 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
