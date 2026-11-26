import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import * as z from 'zod/v4';
import { inspectImageBytes } from './adapters/image-assets-source.mjs';
import { imageTargetRefSchema } from './image-edit-contract.mjs';

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
export const taskId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
export const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = value => hash(JSON.stringify(canonical(value)));
export const failure = (message, status = 400, code = 'INVALID_IMAGE_TARGET', details = {}) => Object.assign(new Error(message), { status, code, ...details });
export function checkTarget(target, input, editable = false) {
  if (target.revision !== input.expectedRevision || target.sha256 !== input.expectedSha256) throw failure('Source changed. Inspect and resolve the region again before editing.', 409, 'IMAGE_SOURCE_CONFLICT', { currentRevision: target.revision, expectedRevision: input.expectedRevision });
  if (editable && (!target.editable || target.locked)) throw failure(target.locked ? 'This image layer is locked.' : 'This target is read-only.', 409, 'IMAGE_TARGET_READ_ONLY');
}
export const inside = (base, filename) => { const relative = path.relative(base, filename); return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const normalizeRef = ref => {
  const value = imageTargetRefSchema.parse(ref);
  if (value.slot !== undefined && ((value.slot === 'visual') !== (value.index === undefined))) throw failure('默认图不接受 index；状态或序列图片需要明确 index。');
  return value;
};
export function encodeImageTarget(ref) {
  return `imgtarget:v1:${Buffer.from(JSON.stringify(canonical(normalizeRef(ref)))).toString('base64url')}`;
}
export function decodeImageTarget(targetId) {
  if (typeof targetId !== 'string' || targetId.length > 2048 || !/^imgtarget:v1:[a-zA-Z0-9_-]+$/.test(targetId)) throw failure('图片目标身份无效。');
  let ref;
  try { ref = normalizeRef(JSON.parse(Buffer.from(targetId.slice('imgtarget:v1:'.length), 'base64url').toString('utf8'))); }
  catch { throw failure('图片目标身份无法解析。'); }
  if (encodeImageTarget(ref) !== targetId) throw failure('图片目标身份不是规范编码。');
  return ref;
}
export const refFor = value => typeof value === 'string' ? decodeImageTarget(value) : normalizeRef(value);
export const publicTarget = ({ bytes: _bytes, ...target }) => target;

export async function confinedRead(root, directory, filename, maxBytes) {
  const actualRoot = await realpath(root);
  const base = await realpath(directory);
  const file = await realpath(filename);
  if (!inside(actualRoot, base) || !inside(base, file)) throw failure('图片来源路径超出允许的目录。', 400, 'UNSAFE_IMAGE_TARGET_PATH');
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes) throw failure('图片来源文件无效或过大。');
  return readFile(file);
}
export async function pixels(bytes, expected = {}) {
  const info = await inspectImageBytes(bytes);
  if ((expected.width !== undefined && info.width !== expected.width) || (expected.height !== undefined && info.height !== expected.height) || (expected.mime && info.mimeType !== expected.mime) || (expected.sha256 && info.sha256 !== expected.sha256)) throw failure('图片真实哈希、尺寸或格式与来源声明不符。', 409, 'IMAGE_SOURCE_CHANGED');
  const rgba = await sharp(bytes, { limitInputPixels: 64_000_000 }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  return { ...info, byteLength: bytes.length, rgbaSha256: hash(rgba) };
}

export function summary(ref, info, extra) {
  return { targetId: encodeImageTarget(ref), targetRef: ref, sha256: info.sha256, rgbaSha256: info.rgbaSha256, width: info.width, height: info.height, mimeType: info.mimeType, hasAlpha: info.hasAlpha, hasTransparency: info.hasTransparency, ...extra };
}

export function checkSource(source, input, candidate) {
  if (source.revision !== input.expectedRevision || source.sha256 !== input.expectedSha256 || (input.expectedSlotFingerprint !== undefined && source.slotFingerprint !== input.expectedSlotFingerprint)) throw failure('图片目标版本、源哈希或槽位绑定已变化，请保留候选并重新读取。', 409, 'IMAGE_TARGET_CONFLICT', { currentRevision: source.revision });
  if (source.locked) throw failure('目标图片已锁定。', 409, 'IMAGE_TARGET_LOCKED');
  if (!source.editable) throw failure(source.readOnlyReason || '该图片目标目前只读。', 400, 'IMAGE_TARGET_READ_ONLY');
  if (source.width !== candidate.info.width || source.height !== candidate.info.height) throw failure('局部调整不能改变源图尺寸。', 400, 'IMAGE_DIMENSIONS_CHANGED');
}
