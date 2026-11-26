export const DOCUMENT_MEDIA_PREFIX = '/api/workbench/document-media/';
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'application/zip': 'zip' };
const mimes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg', zip: 'application/zip' };
export function documentMediaReference(sha256, mime) {
  const extension = extensions[mime];
  if (!/^[a-f0-9]{64}$/.test(sha256) || !extension) throw new Error('媒体哈希或类型无效。');
  return `${DOCUMENT_MEDIA_PREFIX}${sha256}.${extension}`;
}
export function parseDocumentMediaReference(source) {
  if (typeof source !== 'string' || !source.startsWith(DOCUMENT_MEDIA_PREFIX)) return null;
  const key = source.slice(DOCUMENT_MEDIA_PREFIX.length);
  const match = /^([a-f0-9]{64})\.(png|jpg|webp|wav|ogg|mp3|zip)$/.exec(key);
  return match ? { key, sha256: match[1], mime: mimes[match[2]], extension: match[2] } : null;
}
export function mediaTypeMatches(reference, mime) {
  const parsed = parseDocumentMediaReference(reference);
  return Boolean(parsed && extensions[mime] === parsed.extension);
}

// Consumers mutate only the returned owner/key slots on a clone.
export function documentMediaReferences(kind, content) {
  const refs = [], seen = new WeakMap();
  const add = (owner, key, mime, name = '媒体', dimensions) => {
    if (!owner || typeof owner[key] !== 'string') return;
    const keys = seen.get(owner) || new Set();
    if (keys.has(key)) return;
    keys.add(key); seen.set(owner, keys);
    refs.push({ owner, key, mime, name, ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}) });
  };
  if (kind !== 'interactable') throw new Error('Unsupported document kind.');
  for (const asset of content.assets) add(asset, 'source', asset.mime, asset.name);
  return refs;
}
