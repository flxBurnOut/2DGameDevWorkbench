import { documentMediaReference, parseDocumentMediaReference, mediaTypeMatches, documentMediaReferences } from './media-references.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
function inlineBlob(source, mime) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
  if (!match || match[2].length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('内嵌媒体格式或大小无效。');
  if (match[1] !== mime && ![match[1], mime].every(type => ['audio/wav', 'audio/x-wav'].includes(type))) throw new Error('媒体类型与声明不匹配。');
  return new Blob([Uint8Array.from(atob(match[2]), value => value.charCodeAt(0))], { type: mime });
}
async function blobDataUrl(blob, mime) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), chunks = [];
  for (let index = 0; index < bytes.length; index += 32768) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
  return `data:${mime};base64,${btoa(chunks.join(''))}`;
}

// Only boundary operations touch bytes. Document edits, history and fingerprints
// carry stable references; durable blobs also make local drafts usable offline.
export class DocumentMediaCache {
  constructor({ store, fetch: request = globalThis.fetch, createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url) }) {
    this.store = store; this.request = request.bind(globalThis); this.createObjectURL = createObjectURL; this.revokeObjectURL = revokeObjectURL;
    this.entries = new Map(); this.loading = new Map(); this.scopes = new Map();
  }
  url(source) { return this.entries.get(source)?.url || source; }
  async verify(blob, reference) {
    const ref = parseDocumentMediaReference(reference);
    if (!ref || !blob?.size || blob.size > MAX_BYTES || !mediaTypeMatches(reference, blob.type)) throw new Error('本机媒体类型或大小无效。');
    const bytes = await blob.arrayBuffer();
    if (await digest(bytes) !== ref.sha256) throw new Error('媒体哈希校验失败，未使用损坏的缓存。');
    let dimensions = {};
    if (ref.mime === 'image/png') {
      const view = new DataView(bytes);
      if (bytes.byteLength < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(12) !== 0x49484452) throw new Error('PNG 媒体格式无效。');
      dimensions = { width: view.getUint32(16), height: view.getUint32(20) };
    }
    return { blob, ...dimensions };
  }
  async get(reference) {
    if (this.entries.has(reference)) return this.entries.get(reference);
    if (this.loading.has(reference)) return this.loading.get(reference);
    const pending = (async () => {
      const ref = parseDocumentMediaReference(reference);
      if (!ref) throw new Error('媒体引用无效。');
      let blob = await this.store.read(ref.key), downloaded = false;
      if (!blob) {
        const response = await this.request(reference, { cache: 'force-cache' });
        if (!response.ok) throw new Error('媒体未缓存且无法读取共享原件，请恢复连接后重试。');
        blob = await response.blob(); downloaded = true;
      }
      const entry = await this.verify(blob, reference);
      if (downloaded) await this.store.write(ref.key, blob);
      const result = { ...entry, url: this.createObjectURL(blob) };
      this.entries.set(reference, result);
      return result;
    })();
    this.loading.set(reference, pending);
    try { return await pending; } finally { this.loading.delete(reference); }
  }
  async put(blob, mime) {
    const reference = documentMediaReference(await digest(await blob.arrayBuffer()), mime);
    if (!this.entries.has(reference)) {
      const entry = await this.verify(blob, reference);
      // Persist before exposing the reference to a document or request journal.
      await this.store.write(parseDocumentMediaReference(reference).key, blob);
      this.entries.set(reference, { ...entry, url: this.createObjectURL(blob) });
    }
    return reference;
  }
  async compact(kind, content) {
    const next = structuredClone(content), converted = new Map(), counted = new Set();
    let total = 0;
    for (const slot of documentMediaReferences(kind, next)) {
      const source = slot.owner[slot.key];
      let reference = parseDocumentMediaReference(source) ? source : converted.get(source);
      if (!reference) {
        reference = await this.put(inlineBlob(source, slot.mime), slot.mime);
        converted.set(source, reference);
      }
      if (!mediaTypeMatches(reference, slot.mime)) throw new Error('媒体引用类型与声明不匹配。');
      const entry = await this.get(reference);
      if (slot.width && (slot.width !== entry.width || slot.height !== entry.height)) throw new Error('媒体尺寸与文档声明不匹配。');
      if (slot.owner.generation && parseDocumentMediaReference(reference).sha256 !== slot.owner.generation.sha256) throw new Error('生成素材的来源哈希不匹配。');
      if (!counted.has(reference)) { total += entry.blob.size; counted.add(reference); }
      if (total > MAX_BYTES) throw new Error('文档媒体超过 256 MB。');
      slot.owner[slot.key] = reference;
    }
    return next;
  }
  async dataUrl(source, mime) {
    if (!parseDocumentMediaReference(source)) return source;
    if (!mediaTypeMatches(source, mime)) throw new Error('媒体类型不匹配。');
    return blobDataUrl((await this.get(source)).blob, mime);
  }
  async hydrate(kind, content) {
    const next = structuredClone(content), converted = new Map();
    for (const slot of documentMediaReferences(kind, next)) {
      const source = slot.owner[slot.key];
      if (typeof source !== 'string') throw new Error('媒体来源无效。');
      const key = `${slot.mime}:${source}`;
      if (!converted.has(key)) converted.set(key, await this.dataUrl(source, slot.mime));
      slot.owner[slot.key] = converted.get(key);
    }
    return next;
  }
  async publish(kind, content) {
    const references = new Set(documentMediaReferences(kind, content).map(slot => slot.owner[slot.key]).filter(parseDocumentMediaReference));
    for (const reference of references) {
      const response = await this.request(reference, { method: 'HEAD', cache: 'no-store' });
      if (response.ok) continue;
      if (response.status !== 404) throw new Error('无法确认共享媒体，原保存请求已保留。');
      const entry = await this.get(reference), ref = parseDocumentMediaReference(reference);
      const uploaded = await this.request(reference, { method: 'PUT', headers: { 'content-type': ref.mime }, body: entry.blob });
      if (!uploaded.ok) throw new Error('共享媒体上传未完成，原保存请求已保留。');
      const result = await uploaded.json();
      if (result.media?.reference !== reference || result.media?.sha256 !== ref.sha256) throw new Error('媒体上传回执身份不匹配。');
    }
  }
  retain(scope, documents) {
    const previous = this.scopes.get(scope) || new Set(), references = new Set();
    for (const { kind, content } of documents) for (const slot of documentMediaReferences(kind, content)) references.add(slot.owner[slot.key]);
    this.scopes.set(scope, references);
    for (const reference of previous) if (![...this.scopes.values()].some(values => values.has(reference))) {
      const entry = this.entries.get(reference);
      if (entry) { this.revokeObjectURL(entry.url); this.entries.delete(reference); }
    }
  }
  release(scope) { this.retain(scope, []); this.scopes.delete(scope); }
}
