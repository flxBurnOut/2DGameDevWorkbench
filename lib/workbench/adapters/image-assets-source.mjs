import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { parseDocumentMediaReference } from '../../../features/editor-documents/media-references.mjs';
import { readDocumentMedia } from '../editor-documents.mjs';
export { validateImageAssetDimensions } from '../image-dimensions.mjs';

export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;
const FORMATS = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

export const imageSha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function inspectImageBytes(buffer, { pngOnly = false, transparency = false } = {}) {
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 40 MiB 限制。');
  let metadata, decoded;
  try {
    metadata = await sharp(buffer, { limitInputPixels: 64_000_000, animated: false }).metadata();
    if (!FORMATS[metadata.format] || (pngOnly && metadata.format !== 'png') || (metadata.pages ?? 1) !== 1)
      throw new Error();
    decoded = await sharp(buffer, { limitInputPixels: 64_000_000 }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    throw new Error(pngOnly ? '图片必须为可完整解码的单帧 PNG。' : '图片必须为可完整解码的单帧 PNG、JPEG 或 WebP。');
  }
  let hasTransparency = false, hasFullyTransparentPixels = false, hasVisiblePixels = false;
  for (let offset = 3; offset < decoded.data.length; offset += 4) {
    if (decoded.data[offset] < 255) hasTransparency = true;
    if (decoded.data[offset] === 0) hasFullyTransparentPixels = true;
    if (decoded.data[offset] > 0) hasVisiblePixels = true;
    if (hasFullyTransparentPixels && hasVisiblePixels) break;
  }
  if (transparency && (!metadata.hasAlpha || !hasTransparency || !hasVisiblePixels))
    throw new Error('透明物件必须含真实透明像素与可见内容，不能是实色背景或全透明空图。');
  return {
    width: metadata.width, height: metadata.height, format: metadata.format,
    mimeType: FORMATS[metadata.format], hasAlpha: Boolean(metadata.hasAlpha), hasTransparency,
    hasFullyTransparentPixels, hasVisiblePixels, bytes: buffer.length, sha256: imageSha256(buffer),
  };
}

export async function readImageAssetSource(value, repositoryRoot, options = {}) {
  if (typeof value !== 'string' || !value) throw new Error('图片源必须是仓库内路径或 base64 data:image。');
  let buffer, source;
  const reference = parseDocumentMediaReference(value);
  if (reference && options.manifest) {
    if (!reference.mime.startsWith('image/')) throw new Error('共享媒体引用必须指向图片。');
    const media = await readDocumentMedia(repositoryRoot, options.manifest, reference.key);
    return { buffer: media.bytes, ...await inspectImageBytes(media.bytes, options), source: { type: 'shared-media', reference: value } };
  }
  if (value.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/]*={0,2})$/.exec(value);
    if (!match || !match[2] || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || match[2].length % 4 !== 0)
      throw new Error('图片数据必须是有效 PNG、JPEG 或 WebP base64 data:image，最多 40 MiB。');
    buffer = Buffer.from(match[2], 'base64');
    if (buffer.toString('base64') !== match[2]) throw new Error('图片 base64 数据无效。');
    source = { type: 'data-url' };
    const info = await inspectImageBytes(buffer, options);
    if (info.mimeType !== match[1]) throw new Error('图片数据格式与声明的 MIME 类型不一致。');
    return { buffer, ...info, source };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error('图片源不接受远程 URL。');
  if (!/\.(png|jpe?g|webp)$/i.test(value)) throw new Error('图片路径必须为 PNG、JPEG 或 WebP。');
  const root = await realpath(repositoryRoot);
  const resolved = await realpath(path.resolve(root, value)).catch(() => null);
  const relative = resolved ? path.relative(root, resolved) : '..';
  if (!resolved || relative.startsWith('..') || path.isAbsolute(relative) || !relative || relative.split(path.sep).some(part => ['.git', '.aws', '.codex'].includes(part)))
    throw new Error('图片路径必须解析到仓库内部的普通图片文件。');
  const info = await stat(resolved);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('图片必须是最多 40 MiB 的普通文件。');
  buffer = await readFile(resolved);
  source = { type: 'repository-file', path: relative.replaceAll('\\', '/') };
  return { buffer, ...await inspectImageBytes(buffer, options), source };
}
