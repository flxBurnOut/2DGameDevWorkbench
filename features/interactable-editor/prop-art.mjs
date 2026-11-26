import { assetSchema, projectSchema } from './contract.mjs';
import { imageBytesDataUrl, imageBytesSha256, readImageAsset } from '../image-assets/browser-client.mjs';

export async function readImagePropAsset(taskId, request = fetch) {
  const image = await readImageAsset(taskId, 'prop', request);
  const originId = await imageBytesSha256(new TextEncoder().encode(taskId));
  return assetSchema.parse({
    id: `prop_${originId.slice(0, 32)}`,
    name: `${image.name}.png`,
    mime: 'image/png',
    source: imageBytesDataUrl(image.bytes),
    generation: image.generation,
  });
}

export async function propArtJson(url, init, request = fetch) {
  const response = await request(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(90000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      typeof value.error === 'string'
        ? value.error
        : '请求未完成，请稍后查看原任务。',
    );
  return value;
}

export function isPropArtTask(task) {
  return (
    task?.capabilityId === 'reference-art' &&
    ['generate', 'import', 'convert-prop'].includes(task.input?.operation) &&
    (task.input.subject === 'prop' || task.input.operation === 'convert-prop')
  );
}

export function propImagePath(task) {
  return task?.status === 'completed' && Array.isArray(task.outputs)
    ? task.outputs.find((p) => p.endsWith(`/${task.id}/reference.png`))
    : undefined;
}

// Re-read durable evidence on adoption; never copy a changed file using stale preview metadata.
export async function readPropArtAsset(taskId, request = fetch) {
  const { task } = await propArtJson(
    `/api/workbench/tasks/${encodeURIComponent(taskId)}`,
    undefined,
    request,
  );
  if (task.id !== taskId || !isPropArtTask(task) || !propImagePath(task))
    throw new Error('请选择已完成的物品原图。');
  const resultPath = task.outputs.find((p) =>
    p.endsWith(`/${task.id}/result.json`),
  );
  if (!resultPath) throw new Error('物品原图缺少结果记录。');
  const artifact = (p) =>
    `/api/workbench/artifacts?path=${encodeURIComponent(p)}`;
  const metadata = await propArtJson(artifact(resultPath), undefined, request);
  if (
    // Older results omit subject; the completed task above must explicitly say prop.
    (metadata.subject !== undefined && metadata.subject !== 'prop') ||
    metadata.width !== 128 ||
    metadata.height !== 128 ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    throw new Error('物品原图记录无效。');
  const response = await request(artifact(propImagePath(task)), {
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('物品图片无法读取，原物件未修改。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 2000000 || bytes.length < 24)
    throw new Error('物品图片大小无效。');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = Array.from(digest, (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (sha256 !== metadata.sha256)
    throw new Error('原图文件已变化，请使用原始生成产物。');
  const originDigest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(taskId)),
  );
  const originId = Array.from(originDigest, (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return assetSchema.parse({
    id: `prop_${originId.slice(0, 32)}`,
    name: `${String(task.input.name || '物品原图').slice(0, 80)}.png`,
    mime: 'image/png',
    source: `data:image/png;base64,${btoa(binary)}`,
    generation: { sourceTaskId: taskId, sha256 },
  });
}

export function applyPropArt(project, target, asset) {
  if (project.projectId !== target.projectId)
    throw new Error('当前项目已变化，请重新选择采用目标。');
  const next = projectSchema.parse(structuredClone(project));
  const object = next.objects.find(
    (o) => o.definitionId === target.definitionId,
  );
  if (!object) throw new Error('目标物件已删除，原图仍保存在制作记录中。');
  if (object.visual.assetId !== target.previousAssetId)
    throw new Error('物件图片已被修改，请确认当前图片后重新采用。');
  const incoming = assetSchema.parse(asset);
  const existing = next.assets.find((a) => a.id === incoming.id);
  if (existing && existing.source !== incoming.source)
    throw new Error('素材身份冲突，原物件未修改。');
  if (!existing) next.assets.push(incoming);
  object.visual.assetId = incoming.id;
  // Keep clips and behavior, but make the chosen default still visible instead of an old idle clip.
  object.visual.idleAnimation = '';
  object.visual.focusAnimation = '';
  return next;
}
