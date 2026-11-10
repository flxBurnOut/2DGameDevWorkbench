import { inflateRawSync } from 'node:zlib';
import { ASSET_PACKAGE_LIMITS as limits } from './asset-package-contract.mjs';

// Read the central directory ourselves. JSZip normalizes traversal paths and
// discards duplicate entries before callers can inspect them.
export function safeAssetPackagePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\:]/.test(value) || Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)).some(code => code < 32 || code === 127) || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)))
    throw new Error('素材包包含无效或越界路径。');
  return value;
}
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
export function readBoundedAssetZip(input, { depth = 0, budget = { bytes: 0, files: 0 } } = {}) {
  const bytes = Buffer.from(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength ?? input.length);
  if (depth > limits.nesting || bytes.length > limits.uploadBytes || bytes.length < 22) throw new Error('素材包大小或嵌套层级超过限制。');
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw new Error('ZIP 目录缺失或文件不完整。');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || start === 0xffffffff || count > limits.files || start + size !== end)
    throw new Error('不支持分卷、ZIP64 或损坏的 ZIP 目录。');
  const descriptors = [], names = new Set(), fileNames = new Set(), spans = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let at = start, declared = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('ZIP 条目目录损坏。');
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16), compressed = bytes.readUInt32LE(at + 20), expanded = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42);
    if (at + 46 + nameLength + extraLength + commentLength > end || flags & ~0x080e || ![0, 8].includes(method) || bytes.readUInt16LE(at + 34) || expanded > limits.memberBytes || compressed === 0xffffffff || local === 0xffffffff)
      throw new Error('ZIP 包含加密、过大或不支持的文件。');
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    let name;
    try { name = decoder.decode(rawName); } catch { throw new Error('ZIP 文件名编码无效。'); }
    const directory = name.endsWith('/');
    safeAssetPackagePath(directory ? name.slice(0, -1) : name);
    const key = name.normalize('NFC').toLowerCase().replace(/\/$/, '');
    if (names.has(key) || ((bytes.readUInt32LE(at + 38) >>> 16) & 0o170000) === 0o120000) throw new Error('ZIP 包含重名条目或符号链接。');
    names.add(key);
    if (!directory) fileNames.add(key);
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw new Error('ZIP 文件头与目录不一致。');
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28), offset = local + 30 + localNameLength + localExtraLength;
    if (!rawName.equals(bytes.subarray(local + 30, local + 30 + localNameLength)) || offset + compressed > start) throw new Error('ZIP 文件内容越界。');
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== expanded)) throw new Error('ZIP 文件长度不一致。');
    spans.push([local, offset + compressed]);
    if (!directory) {
      declared += expanded;
      if (declared > limits.containerExpandedBytes || declared + budget.bytes > limits.expandedBytes || ++budget.files > limits.files) throw new Error('素材包单容器或累计解压大小、文件数超过限制。');
      descriptors.push({ name, method, crc, compressed, expanded, offset });
    } else if (expanded || compressed) throw new Error('ZIP 目录包含文件内容。');
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== end) throw new Error('ZIP 目录长度不一致。');
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (fileNames.has(parts.slice(0, i).join('/'))) throw new Error('ZIP 文件与目录路径冲突。');
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.some((span, i) => i && span[0] < spans[i - 1][1])) throw new Error('ZIP 文件内容相互重叠。');
  const files = new Map();
  for (const entry of descriptors) {
    const encoded = bytes.subarray(entry.offset, entry.offset + entry.compressed);
    let data;
    try { data = entry.method === 0 ? encoded : inflateRawSync(encoded, { maxOutputLength: Math.max(1, entry.expanded) }); } catch { throw new Error(`ZIP 文件解压失败：${entry.name}`); }
    if (data.length !== entry.expanded || crc32(data) !== entry.crc) throw new Error(`ZIP 文件校验失败：${entry.name}`);
    budget.bytes += data.length;
    files.set(entry.name, data);
  }
  if (!files.size) throw new Error('素材包为空。');
  return files;
}
