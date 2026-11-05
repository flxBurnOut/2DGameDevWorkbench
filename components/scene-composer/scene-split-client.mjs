/** One HTTP attempt. Keep a mutation's original body for recovery; get/inspect
 * are reads, and never start another generation or model request. */
export async function requestSceneSplit(
  operation,
  input,
  fetcher = globalThis.fetch,
) {
  if (
    !['prepare', 'get', 'revise', 'inspect', 'adopt', 'patch'].includes(
      operation,
    )
  )
    throw new Error('未知地图分层操作。');
  const response = await fetcher(`/api/workbench/scene-split/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    cache: 'no-store',
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof result.error === 'string'
          ? result.error
          : result.error?.message || '地图分层请求未完成。',
      ),
      { code: result.code, status: response.status },
    );
  return result;
}
export function splitPreviewUrl(image) {
  if (
    !image ||
    image.mimeType !== 'image/png' ||
    typeof image.data !== 'string' ||
    !/^[A-Za-z0-9+/]+=*$/.test(image.data)
  )
    throw new Error('分层预览不是有效 PNG。');
  return `data:image/png;base64,${image.data}`;
}
export function parseSplitSpecDraft(text) {
  const value = JSON.parse(text),
    specs = Array.isArray(value) ? value : [value];
  if (
    !specs.length ||
    specs.some(
      (spec) =>
        !spec ||
        typeof spec !== 'object' ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(spec.id ?? '') ||
        !spec.name ||
        !['object', 'background', 'surface'].includes(spec.kind) ||
        !Array.isArray(spec.parts) ||
        !spec.parts.length,
    )
  )
    throw new Error(
      '请填写含 id、name、kind 和非空 parts 的原像素对象 JSON；服务器会继续校验选区与范围。',
    );
  return specs;
}

export { splitCollisionTransfer } from '../../features/scene-composer/map-split.mjs';

/** Retry status reads with bounded backoff; never replay a mutation here. */
export function watchSceneSplit(
  query,
  onError,
  {
    delay = 1800,
    maxFailures = 5,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {},
) {
  let stopped = false,
    timer,
    failures = 0;
  const tick = async () => {
    try {
      const status = await query();
      if (stopped || status !== 'running') return;
      failures = 0;
    } catch (error) {
      if (stopped) return;
      failures++;
      onError(error, failures === maxFailures);
      if (failures >= maxFailures) return;
    }
    if (!stopped)
      timer = schedule(
        () => void tick(),
        Math.min(delay * 2 ** failures, 15000),
      );
  };
  timer = schedule(() => void tick(), delay);
  return () => {
    stopped = true;
    cancel(timer);
  };
}
