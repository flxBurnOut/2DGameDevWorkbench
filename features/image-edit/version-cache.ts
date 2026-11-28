import { bytesToBase64, readImageEdit, rgbaHash, verifiedImagePixels, type ImageEditSession } from './client';

export type VerifiedPixels = Awaited<ReturnType<typeof verifiedImagePixels>>;

async function readMediaBytes(response: Response, limit: number, exactSize?: number) {
  const header = response.headers.get('content-length');
  const declared = header !== null && !response.headers.get('content-encoding') ? Number(header) : undefined;
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 1 || declared > limit ||
      (exactSize !== undefined && declared !== exactSize))) throw new Error('图像字节数无效。');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('图像响应为空。');
  const size = exactSize ?? declared;
  const target = size === undefined ? undefined : new Uint8Array(size);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > (size ?? limit)) {
        await reader.cancel();
        throw new Error('图像字节数超限。');
      }
      if (target) target.set(value, offset);
      else chunks.push(value);
      offset += value.length;
    }
  } finally { reader.releaseLock(); }
  if (!offset || (size !== undefined && size !== offset)) throw new Error('图像字节数不符。');
  if (target) return target;
  const bytes = new Uint8Array(offset);
  offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function versionMedia(edit: ImageEditSession, version: string, signal?: AbortSignal): Promise<VerifiedPixels> {
  const selected = version === 'source' ? edit.source : edit.candidates.find(item => item.version === version && item.status === 'completed');
  const { width, height } = edit.target;
  if (!selected?.sha256 || !selected.rgbaSha256 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width > 3840 || height > 3840 || width * height > 8294400) throw new Error('版本或像素尺寸无效。');
  const params = new URLSearchParams({ editId: edit.editId, version, sha256: selected.sha256 });
  const read = async (kind: string, expected: string, limit: number) => {
    const response = await fetch('/api/workbench/image-edit/media?' + params + '&representation=' + kind, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取指定版本的图像。');
    const data = await readMediaBytes(response, limit, kind === 'rgba' ? limit : undefined);
    if (await rgbaHash(data) !== expected) throw new Error('图像字节或 SHA-256 不符。');
    return { data, mime: response.headers.get('content-type') };
  };
  const [rgba, preview] = await Promise.all([read('rgba', selected.rgbaSha256, width * height * 4), read('preview', selected.sha256, 40 * 1024 * 1024)]);
  if (rgba.data.length !== width * height * 4 || rgba.mime !== 'application/octet-stream' || !['image/png', 'image/jpeg', 'image/webp'].includes(preview.mime || '')) throw new Error('预览格式或 RGBA 字节数不符。');
  return { pixels: rgba.data, width, height, rgbaSha256: selected.rgbaSha256, previewSource: `data:${preview.mime};base64,${bytesToBase64(preview.data)}` };
}

/** Session versions are immutable. Cache only verified data, with a byte bound. */
export class ImageVersionCache {
  private entries = new Map<string, VerifiedPixels>();
  constructor(private readonly budget = 96 * 1024 * 1024) {}
  peek(editId: string, version: string) { return this.entries.get(`${editId}:${version}`); }
  put(editId: string, version: string, pixels: VerifiedPixels) {
    const key = `${editId}:${version}`;
    this.entries.delete(key); this.entries.set(key, pixels);
    let bytes = [...this.entries.values()].reduce((total, item) => total + item.pixels.byteLength + (item.previewSource?.length || 0) * 2, 0);
    for (const [old, item] of this.entries) {
      if (bytes <= this.budget) break;
      this.entries.delete(old); bytes -= item.pixels.byteLength + (item.previewSource?.length || 0) * 2;
    }
    return pixels;
  }
  async load(editId: string, version: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const cached = this.peek(editId, version);
    if (cached) { this.entries.delete(`${editId}:${version}`); this.entries.set(`${editId}:${version}`, cached); return cached; }
    const metadata = (await readImageEdit(editId, version, false, signal)).edit;
    if (metadata.editId !== editId) throw new Error('返回的图片会话与所选会话不一致。');
    if (metadata.mediaProtocol === 1) {
      const pixels = await versionMedia(metadata, version, signal);
      signal?.throwIfAborted();
      return this.put(editId, version, pixels);
    }
    const { edit } = await readImageEdit(editId, version, true, signal);
    if (edit.editId !== editId || edit.selectedVersion !== version || !edit.pixels) throw new Error('返回的图片版本与所选版本不一致。');
    const pixels = await verifiedImagePixels(edit.pixels);
    signal?.throwIfAborted();
    return this.put(editId, version, pixels);
  }
}

/** Last intent wins, including when an old fetch ignores cancellation. */
export class ImageViewRequest {
  private current?: AbortController;
  begin() { this.cancel(); this.current = new AbortController(); return this.current.signal; }
  cancel() { this.current?.abort(); this.current = undefined; }
}
