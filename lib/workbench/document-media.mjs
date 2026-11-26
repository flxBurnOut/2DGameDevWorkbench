import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { documentMediaReference, parseDocumentMediaReference, mediaTypeMatches } from '../../features/editor-documents/media-references.mjs';

export const MAX_DOCUMENT_MEDIA_BYTES = 256 * 1024 * 1024;
const inspected = new Map();
const writes = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

export function documentMediaStore(root, directory, safePath, fail) {
  const base = path.join(directory, 'media');
  const refFor = reference => {
    const ref = parseDocumentMediaReference(reference);
    if (!ref) throw fail('无效的共享媒体引用。');
    return ref;
  };
  const check = (metadata, slot) => {
    if (!mediaTypeMatches(metadata.reference, slot.mime)) throw fail('共享媒体类型与声明不匹配。');
    if (slot.width && (metadata.width !== slot.width || metadata.height !== slot.height)) throw fail('Media dimensions do not match the layer declaration.');
    if (slot.owner?.generation && metadata.sha256 !== slot.owner.generation.sha256) throw fail('Generated media hash does not match the selected original asset.');
    return metadata;
  };
  async function inspect(bytes, reference) {
    const ref = refFor(reference);
    if (!bytes.length || bytes.length > MAX_DOCUMENT_MEDIA_BYTES || hash(bytes) !== ref.sha256) throw fail('共享媒体内容缺失、过大或哈希不匹配。', 500, 'CORRUPT_DOCUMENT_MEDIA');
    let dimensions = {};
    if (ref.mime.startsWith('image/')) {
      const options = { limitInputPixels: 64 * 1024 * 1024 };
      const meta = await sharp(bytes, options).metadata();
      if (meta.format !== { png: 'png', jpg: 'jpeg', webp: 'webp' }[ref.extension] || (meta.pages || 1) !== 1)
        throw fail('Media format does not match its declaration.');
      await sharp(bytes, options).raw().toBuffer();
      dimensions = { width: meta.width, height: meta.height };
    }
    return { ...ref, reference, bytes: bytes.length, ...dimensions };
  }
  async function locate(reference) {
    const ref = refFor(reference), file = path.join(base, ref.key);
    await safePath(root, file);
    let info;
    try { info = await stat(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') throw fail('共享媒体不存在，请先同步原媒体。', 404, 'DOCUMENT_MEDIA_NOT_FOUND'); throw error; }
    if (!info.isFile() || info.size > BigInt(MAX_DOCUMENT_MEDIA_BYTES)) throw fail('共享媒体文件无效。', 500, 'CORRUPT_DOCUMENT_MEDIA');
    return { file, signature: signature(info) };
  }
  function cache(file, stamp, metadata) {
    if (inspected.size >= 1024) inspected.delete(inspected.keys().next().value);
    inspected.set(file, { signature: stamp, metadata });
  }
  async function metadata(reference, slot = { mime: refFor(reference).mime }) {
    const location = await locate(reference), entry = inspected.get(location.file);
    if (entry?.signature === location.signature) return check(entry.metadata, slot);
    const bytes = await readFile(location.file), result = await inspect(bytes, reference);
    cache(location.file, location.signature, result);
    return check(result, slot);
  }
  async function put(bytes, mime, expectedReference, slot = { mime }) {
    const reference = documentMediaReference(hash(bytes), mime);
    if (expectedReference && reference !== expectedReference) throw fail('上传媒体与请求哈希不匹配。');
    const ref = refFor(reference), file = path.join(base, ref.key);
    // The Bridge owns writes. Serialize identical blobs across document queues.
    const pending = (writes.get(file) || Promise.resolve()).catch(() => {}).then(() => commitBlob(bytes, reference, slot));
    writes.set(file, pending);
    try { return await pending; } finally { if (writes.get(file) === pending) writes.delete(file); }
  }
  async function commitBlob(bytes, reference, slot) {
    const ref = refFor(reference), file = path.join(base, ref.key);
    try { return { ...await metadata(reference, slot), created: false }; }
    catch (error) { if (error.code !== 'DOCUMENT_MEDIA_NOT_FOUND') throw error; }
    const info = check(await inspect(bytes, reference), slot);
    await safePath(root, base, true);
    await safePath(root, file);
    // A crash leaves an unreferenced temporary file, never a partial named blob.
    const temporary = path.join(base, `.${ref.key}.${randomUUID()}.tmp`);
    await safePath(root, temporary);
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes); await handle.sync(); await handle.close();
      await rename(temporary, file);
    } finally {
      await handle.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    cache(file, (await locate(reference)).signature, info);
    return { ...info, created: true };
  }
  async function read(reference) {
    const location = await locate(reference), bytes = await readFile(location.file);
    const entry = inspected.get(location.file);
    if (hash(bytes) !== refFor(reference).sha256) throw fail('共享媒体哈希不匹配。', 500, 'CORRUPT_DOCUMENT_MEDIA');
    const info = entry?.signature === location.signature ? entry.metadata : await inspect(bytes, reference);
    cache(location.file, location.signature, info);
    return { metadata: info, bytes };
  }
  return { put, metadata, read };
}
