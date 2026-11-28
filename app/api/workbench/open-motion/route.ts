import manifest from '@/workbench/manifest.json';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';
import { endpointUrl } from '@/lib/workbench/adapters/http.mjs';
import { isPaidMotionPath } from '@/lib/workbench/paid-operations.mjs';

// Deliberately bounded proxy: no arbitrary URL, path, header or method passthrough.
const work = '[0-9a-f]{32}';
const job = '[a-zA-Z0-9_]{1,200}';
const workPath = `open-motion/${work}`;
const segment = `${workPath}/candidates/[1-8]/stages/[0-3]`;
const indexedFrame = 'frames/[0-9]{1,2}';
const stageFrame = new RegExp(`^${segment}/${indexedFrame}$`);
const workReference = new RegExp(`^${workPath}/reference$`);
const progressImage = new RegExp(`^${workPath}/progress-image$`);
const tokenMedia = new RegExp(`^(?:${segment}/(?:repairs/[0-1]/)?${indexedFrame}|${workPath}/adjustments/${work}/(?:source|proposed)/[0-9]{1,2})$`);
const editSource = new RegExp(`^${workPath}/edit-source/[0-9]{1,2}$`);
const interactionFrame = new RegExp(`^${workPath}/interaction/frames/[0-9]{1,3}$`);
const hashMedia = new RegExp(`^(?:jobs/${job}/(?:candidates/[1-8]/${indexedFrame}/image|exports/(?:sheet|preview|godot))|${segment}/state-image|${workPath}/(?:reference|targets/[0-3]|derived/${work}/${indexedFrame}))$`);
const sha256 = /^[0-9a-f]{64}$/;
const positiveRevision = /^[1-9][0-9]{0,14}$/;
const structureRead = new RegExp(`^open-motion/(?:structure-runtime|references/[a-z0-9_]+/structure|structures/${work}(?:/source|/masks/[a-z][a-z0-9_-]{0,63})?)$`);
const propReferenceWrite = 'open-motion/references/from-prop';
const structureWrite = new RegExp(`^open-motion/structures(?:/${work}/corrections)?$`);
const temporalRead = new RegExp(`^open-motion/(?:${work}/(?:temporal|interaction(?:/frames/[0-9]{1,3})?)|temporal-structures/${work}(?:/frames/[0-9]{1,3}(?:/parts/[a-z][a-z0-9_-]{0,63})?)?)$`);
const temporalWrite = new RegExp(`^open-motion/(?:${work}/(?:temporal|interaction)|temporal-structures/${work}/(?:corrections|review))$`);
const read = new RegExp(
  `^(?:open-motion(?:/(?:settings|references(?:/[a-z0-9_]+)?|${work}(?:/reference|/targets/[0-3]|/progress-image|/adjustments(?:/${work}(?:/(?:source|proposed)/[0-9]{1,2})?)?|/edit-source/[0-9]{1,2}|/derived(?:/${work}/frames/[0-9]{1,2})?|/candidates/[1-8]/stages/[0-3](?:/state-image|/frames/[0-9]{1,2}|/repairs/[0-1]/frames/[0-9]{1,2})?)?))?|jobs/${job}(?:/candidates/[1-8]/frames/[0-9]{1,2}/image|/exports/(?:sheet|preview|godot))?)$`,
);
const write = new RegExp(
  `^open-motion(?:/(?:settings|references|${work}/(?:revise|generate|pause|resume|review|review-stage|target|repair-stage|review-repair|export|recover|local-frame-edits|adjustments(?:/${work}/decision)?|derived(?:/${work}/decision)?)))?$`,
);

async function proxy(request: Request) {
  const denied = trustedRequest(request, { json: request.method !== 'GET' });
  if (denied) return denied;
  const url = new URL(request.url);
  const requested = url.searchParams.get('path') || 'open-motion';
  const paired = requested.startsWith('paired/');
  const path = paired ? requested.slice('paired/'.length) : requested;
  const probe = request.method === 'GET' && path === 'workspace-identity';
  const planningReceipt = paired && /^open-motion\/(?:[0-9a-f]{32}\/)?requests\/[A-Za-z0-9._:-]{8,128}$/.test(path);
  if (!(request.method === 'GET' ? probe || planningReceipt || read.test(path) || structureRead.test(path) || temporalRead.test(path) : write.test(path) || path === propReferenceWrite || structureWrite.test(path) || temporalWrite.test(path)))
    return Response.json({ error: '不支持的工作区操作' }, { status: 400 });
  const workspaceId = request.headers.get('x-forge-workspace') || '';
  if ((paired && !sha256.test(workspaceId)) || (!paired && request.method === 'POST' && isPaidMotionPath(path)))
    return Response.json({ error: '请刷新页面，在原动画工作区恢复请求。', code: 'WORKSPACE_REQUIRED' }, { status: 409 });
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
  const target = new URL(endpointUrl(base, `${paired ? '/paired/v1' : ''}/v1/${path}`));
  const legacyVersion = url.searchParams.get('v');
  const legacyWorkRevision = workReference.test(path) && legacyVersion !== null && positiveRevision.test(legacyVersion) ? legacyVersion : null;
  const revision = url.searchParams.get('revision') ?? legacyWorkRevision;
  if (revision !== null) {
    if ((!positiveRevision.test(revision) && !(revision === '0' && path.startsWith('jobs/')))
        || (legacyWorkRevision !== null && legacyWorkRevision !== revision))
      return Response.json({ error: '版本号无效' }, { status: 400 });
    target.searchParams.set('revision', revision);
  }
  const legacyJobRevision = progressImage.test(path) ? legacyVersion : null;
  const jobRevision = url.searchParams.get('job_revision') ?? legacyJobRevision;
  if (jobRevision !== null) {
    if (!progressImage.test(path) || !(jobRevision === '0' || positiveRevision.test(jobRevision))
        || (legacyJobRevision !== null && legacyJobRevision !== jobRevision))
      return Response.json({ error: 'Job 版本号无效' }, { status: 400 });
    target.searchParams.set('job_revision', jobRevision);
  }
  // Older callers overloaded v with different identities. Each media route binds
  // the identity it previously displayed, including the stage adjustment token.
  const legacyHash = hashMedia.test(path) && legacyWorkRevision === null ? legacyVersion : null;
  const expectedSha = url.searchParams.get('expected_sha256') ?? legacyHash;
  if (expectedSha !== null) {
    if (!(hashMedia.test(path) || tokenMedia.test(path)) || !sha256.test(expectedSha) || (legacyHash !== null && legacyHash !== expectedSha))
      return Response.json({ error: '图片哈希无效' }, { status: 400 });
    target.searchParams.set('expected_sha256', expectedSha);
  }
  const candidate = url.searchParams.get('candidate');
  if (candidate && /^[1-8]$/.test(candidate))
    target.searchParams.set('candidate', candidate);
  const frameToken = url.searchParams.get('token');
  const legacyToken = tokenMedia.test(path) ? legacyVersion : null;
  const previewToken = frameToken ?? legacyToken;
  if (previewToken !== null) {
    if (!(tokenMedia.test(path) || editSource.test(path) || interactionFrame.test(path)) || !sha256.test(previewToken)
        || (legacyToken !== null && legacyToken !== previewToken))
      return Response.json({ error: '帧来源标识无效' }, { status: 400 });
    target.searchParams.set(frameToken === null && stageFrame.test(path) ? 'legacy_token' : 'token', previewToken);
  }
  const stage = url.searchParams.get('stage');
  if (stage !== null) {
    if (!/^[0-3]$/.test(stage)) return Response.json({error:'片段编号无效'},{status:400});
    target.searchParams.set('stage',stage);
  }
  try {
    if (probe || paired) {
      const health = await fetch(endpointUrl(base, '/health'), { cache: 'no-store', redirect: 'manual',
        signal: AbortSignal.timeout(5000), headers: { 'x-forge-motion-identity': '1', ...(token && { authorization: `Bearer ${token}` }) } });
      const healthBody = health.ok ? await health.json() as { motion_workspace_id?: unknown } | null : null;
      const id = healthBody?.motion_workspace_id;
      if (typeof id !== 'string' || !sha256.test(id) || (paired && id !== workspaceId))
        return Response.json({ code: 'WORKSPACE_MISMATCH', error: '动画工作区或服务版本不匹配。请切回原工作区恢复。' }, { status: 409 });
      if (probe) return Response.json({ workspaceId: id }, { headers: { 'cache-control': 'no-store' } });
    }
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && Buffer.byteLength(body) > 2_100_000)
      return Response.json(
        { error: '请求过大，请使用 64 或 128 像素 PNG' },
        { status: 413 },
      );
    const response = await fetch(target, {
      method: request.method,
      ...(paired && { redirect: 'manual' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
      body,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(paired ? { 'x-forge-workspace': workspaceId } : {}),
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
