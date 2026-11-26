import { Buffer } from 'node:buffer';

export class AdapterHttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'AdapterHttpError';
    this.status = status;
    this.body = body;
  }
}

export { endpointUrl } from '../service-endpoints.mjs';

export async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal ?? controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text ? { text } : null;
    }
    if (!response.ok) {
      const detail = body?.error?.message ?? body?.error ?? response.statusText;
      throw new AdapterHttpError(
        `Adapter returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        { status: response.status, body },
      );
    }
    if (body && body.ok === false) {
      throw new AdapterHttpError(body.error?.message ?? 'Adapter rejected the request.', {
        status: response.status,
        body,
      });
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Adapter request timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestBinary(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const maxBytes = options.maxBytes ?? 40 * 1024 * 1024;
  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal ?? controller.signal,
    });
    if (!response.ok) {
      throw new AdapterHttpError(
        `Adapter artifact returned HTTP ${response.status}: ${response.statusText}`,
        { status: response.status },
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Adapter artifact exceeds the ${maxBytes} byte limit.`);
    }
    if (!response.body) throw new Error('Adapter artifact response did not contain a body.');

    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        await response.body.cancel().catch(() => undefined);
        throw new Error(`Adapter artifact exceeds the ${maxBytes} byte limit.`);
      }
      chunks.push(buffer);
    }
    return {
      buffer: Buffer.concat(chunks, total),
      contentType: response.headers.get('content-type') ?? '',
      finalUrl: response.url,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Adapter artifact request timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function bearerHeaders(token) {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
