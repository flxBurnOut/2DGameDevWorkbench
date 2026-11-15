const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
export const IMAGE_ASSET_MAX_BYTES = 40 * 1024 * 1024;

export const imageArtifactUrl = (path) =>
  `/api/workbench/artifacts?path=${encodeURIComponent(path)}`;

export async function imageAssetJson(url, init, request = fetch) {
  const response = await request(url, {
    ...init,
    cache: 'no-store',
    signal: init?.signal || AbortSignal.timeout(init?.method === 'POST' ? 600000 : 30000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(`${typeof value.error === 'string' ? value.error : '请求未完成，请查看原任务。'}${typeof value.taskId === 'string' ? ` 任务：${value.taskId}` : ''}`);
  return value;
}

export function imageAssetKind(task) {
  if (task?.capabilityId !== 'image-assets') return undefined;
  if (task.input?.operation === 'generate-prop') return 'prop';
  if (['edit-image', 'process-image'].includes(task.input?.operation))
    return task.input.kind === 'prop' ? 'prop' : 'background';
  return undefined;
}

export function imageAssetPath(task) {
  return task?.status === 'completed' && imageAssetKind(task) && Array.isArray(task.outputs)
    ? task.outputs.find((path) => path.endsWith(`/${task.id}/image.png`))
    : undefined;
}

export async function imageBytesSha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function imageBytesDataUrl(bytes, mime = 'image/png') {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768)
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return `data:${mime};base64,${btoa(binary)}`;
}

// Adoption always re-reads the durable task, result and exact PNG bytes.
export async function readImageAsset(taskId, kind, request = fetch) {
  const { task } = await imageAssetJson(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, undefined, request);
  const imagePath = imageAssetPath(task);
  if (task?.id !== taskId || imageAssetKind(task) !== kind || !imagePath)
    throw new Error('请选择已完成且类型正确的图片任务。');
  const resultPath = task.outputs.find((path) => path.endsWith(`/${taskId}/result.json`));
  if (!resultPath) throw new Error('图片任务缺少结果记录，当前内容未修改。');
  const result = await imageAssetJson(imageArtifactUrl(resultPath), undefined, request);
  if (
    result.image !== 'image.png' || result.kind !== kind ||
    !Number.isInteger(result.width) || !Number.isInteger(result.height) ||
    result.width < 1 || result.height < 1 || result.width > 32768 || result.height > 32768 ||
    !/^[a-f0-9]{64}$/.test(result.sha256) ||
    (kind === 'prop' && (result.hasAlpha !== true || result.hasTransparency !== true))
  ) throw new Error('图片结果记录无效，或物件没有透明背景。');
  const response = await request(imageArtifactUrl(imagePath), {
    cache: 'no-store', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('无法读取图片，请稍后重新采用；无需重新生成。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes.length < 33 || bytes.length > IMAGE_ASSET_MAX_BYTES ||
    !pngSignature.every((value, index) => bytes[index] === value) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR'
  ) throw new Error('生成图片不是有效的 PNG。');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(16) !== result.width || header.getUint32(20) !== result.height)
    throw new Error('图片尺寸与结果记录不符，当前内容未修改。');
  const sha256 = await imageBytesSha256(bytes);
  if (sha256 !== result.sha256)
    throw new Error('图片文件已变化，请采用原始任务产物。');
  return {
    task, imagePath, bytes, width: result.width, height: result.height,
    kind, generation: { sourceTaskId: taskId, sha256 },
    provider: result.provider, model: result.model,
    name: String(task.input?.name || (kind === 'prop' ? '透明物件' : '参考图片')).slice(0, 80),
  };
}

export async function imageReferenceUpload(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('参考图仅支持 PNG、JPEG 和 WebP。');
  if (!file.size || file.size > 30 * 1024 * 1024)
    throw new Error('每张参考图必须小于 30 MB。');
  return imageBytesDataUrl(new Uint8Array(await file.arrayBuffer()), file.type);
}
