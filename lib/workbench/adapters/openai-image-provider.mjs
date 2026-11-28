import { Blob } from 'node:buffer';
import { MAX_IMAGE_BYTES } from './image-assets-source.mjs';

export class ImageProviderError extends Error {
  constructor(message, { submissionUnknown = false } = {}) {
    super(message);
    this.name = 'ImageProviderError';
    this.submissionUnknown = submissionUnknown;
  }
}

/** One paid submission only; errors never include provider bodies, endpoints or credentials. */
export async function requestOpenAIImage(provider, { prompt, dimensions, sources = [], mask, background = 'opaque', onResponseMetadata }) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const responseMetadata = { httpStatus: null, requestId: null, usage: null, returnedQuality: null };
  const fields = { model: provider.model, prompt, n: 1, size: dimensions.size, output_format: 'png', background };
  let body;
  const headers = { accept: 'application/json', authorization: `Bearer ${provider.apiKey}` };
  if (sources.length) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
    sources.forEach((source, index) => body.append('image[]', new Blob([source.buffer], { type: source.mimeType }), source.name ?? `image-${index}.${source.format === 'jpeg' ? 'jpg' : source.format}`));
    if (mask) body.append('mask', new Blob([mask.buffer], { type: 'image/png' }), 'mask.png');
  } else {
    body = JSON.stringify(fields);
    headers['content-type'] = 'application/json';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  let result;
  let requestError;
  try {
    const response = await fetch(provider.endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
    const requestId = response.headers.get('x-request-id');
    responseMetadata.httpStatus = response.status;
    responseMetadata.requestId = typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(requestId) ? requestId : null;
    if (!response.ok) throw new ImageProviderError(`图片 API 返回 HTTP ${response.status}；没有自动重试，请检查已有任务后再决定是否重新生成。`, { submissionUnknown: response.status >= 500 || response.status === 408 });
    if (!response.body) throw new ImageProviderError('图片 API 没有返回数据。');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024) {
        controller.abort();
        throw new ImageProviderError('图片 API 返回数据超过大小限制。');
      }
      chunks.push(Buffer.from(chunk));
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ImageProviderError('图片 API 返回的 JSON 无效。'); }
    responseMetadata.usage = imageUsageEvidence(payload?.usage);
    responseMetadata.returnedQuality = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(payload?.quality) ? payload.quality : null;
    const encoded = payload?.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded))
      throw new ImageProviderError('GPT Image did not return valid b64_json image data.');
    result = Buffer.from(encoded, 'base64');
    if (result.toString('base64') !== encoded) throw new ImageProviderError('图片 API 返回的图片编码无效。');
  } catch (error) {
    if (error instanceof ImageProviderError) requestError = error;
    else if (controller.signal.aborted) requestError = new ImageProviderError('图片请求超时，提交结果可能未知。没有自动重试，请先检查服务商记录。', { submissionUnknown: true });
    else requestError = new ImageProviderError('图片 API 连接中断，提交结果可能未知。没有自动重试，请先检查服务商记录。', { submissionUnknown: true });
  } finally {
    clearTimeout(timer);
  }
  if (onResponseMetadata) {
    try {
      await onResponseMetadata({ schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...responseMetadata, requestedQuality: 'auto', billingAmount: null });
    } catch {
      throw new ImageProviderError('图片请求的用量证据保存失败；请检查原任务，不要自动重新提交。', { submissionUnknown: true });
    }
  }
  if (requestError) throw requestError;
  return result;
}

/** Preserve documented numeric counters only; never copy arbitrary provider fields. */
export function imageUsageEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const counters = (source, keys) => Object.fromEntries(keys.filter(key => Number.isSafeInteger(source?.[key]) && source[key] >= 0).map(key => [key, source[key]]));
  const result = counters(value, ['input_tokens', 'output_tokens', 'total_tokens']);
  for (const key of ['input_tokens_details', 'output_tokens_details']) {
    const details = counters(value[key], ['text_tokens', 'image_tokens', 'cached_tokens']);
    const cached = counters(value[key]?.cached_tokens_details, ['text_tokens', 'image_tokens']);
    if (Object.keys(cached).length) details.cached_tokens_details = cached;
    if (Object.keys(details).length) result[key] = details;
  }
  return Object.keys(result).length ? result : null;
}
