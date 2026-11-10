import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createScene, replaceMap } from '../../features/scene-composer/model.mjs';
import { createScenePackage, readScenePackage } from '../../features/scene-composer/package.mjs';
import { sharedSceneContent } from '../../features/scene-composer/shared-content.mjs';
import { documentMediaReferences, parseDocumentMediaReference, documentMediaReference } from '../../features/editor-documents/media-references.mjs';
import { DocumentMediaCache } from '../../features/editor-documents/media-cache.mjs';
import { DocumentSyncController } from '../../features/editor-documents/sync-controller.mjs';
import { RequestJournal } from '../../features/editor-documents/request-journal.mjs';
import { createDocument, saveDocument, getDocument, restoreDocument, readDocumentMedia, uploadDocumentMedia, documentDirectory } from '../../lib/workbench/editor-documents.mjs';
import { loadManifest, repositoryRoot as root } from '../../lib/workbench/runtime.mjs';
import { splitFixture } from '../scene-composer/map-split-fixture.mjs';

const manifest = await loadManifest(), directory = documentDirectory(root, manifest);
assert.ok(directory.includes(process.env.WORKBENCH_TEST_RUN));
const hash = value => createHash('sha256').update(value).digest('hex');
const embedded = (bytes, mime) => `data:${mime};base64,${bytes.toString('base64')}`;
const png = await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
const scene = createScene('Media references'); scene.id = 'media-reference-scene';
replaceMap(scene, { name: 'Map', origin: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, collisions: [], warnings: [],
  source: embedded(Buffer.from('PK\x05\x06' + '\0'.repeat(18)), 'application/zip'),
  layers: ['first', 'same-pixels'].map(id => ({ id, name: id, source: embedded(png, 'image/png'), width: 512, height: 512, locked: false, hidden: false, included: true })) });
const initialRequest = { kind: 'scene', content: scene, commandId: 'media-create' };
const original = await createDocument(root, manifest, initialRequest);
const compact = (await getDocument(root, manifest, { documentId: scene.id }, { media: 'references' })).document;
const references = documentMediaReferences('scene', compact.content).map(slot => slot.owner[slot.key]);
assert.ok(references.every(parseDocumentMediaReference));
assert.equal(references[1], references[2], 'duplicate layer bytes have one immutable identity');
assert.equal(compact.contentHash, hash(JSON.stringify(compact.content)));
assert.ok(JSON.stringify(compact.content).length < 4000, 'large image bytes stay outside the editing document');
const mediaDirectory = path.join(directory, 'media');
const files = await readdir(mediaDirectory);
assert.equal(files.length, 2);
const imageKey = parseDocumentMediaReference(references[1]).key, imageFile = path.join(mediaDirectory, imageKey);
const before = await stat(imageFile, { bigint: true });
let current = compact;
for (let index = 0; index < 8; index++) {
  const request = { documentId: scene.id, expectedRevision: current.revision, commandId: `media-move-${index}`, content: { ...current.content, map: { ...current.content.map, offset: { x: index + 1, y: 0 } } } };
  const result = await saveDocument(root, manifest, request, { media: 'references' });
  assert.equal((await saveDocument(root, manifest, request, { media: 'references' })).replayed, true);
  current = result.document;
}
assert.equal((await stat(imageFile, { bigint: true })).mtimeNs, before.mtimeNs, 'metadata edits never rewrite an immutable image');
assert.deepEqual(await readdir(mediaDirectory), files);
const documentPath = path.join(directory, `document-${hash(scene.id).slice(0, 40)}`);
const head = JSON.parse(await readFile(path.join(documentPath, 'head.json'), 'utf8'));
for (const version of head.versions) assert.ok((await stat(path.join(documentPath, version.file))).size < 5000);
assert.deepEqual((await getDocument(root, manifest, { documentId: scene.id, revision: 1 })).document, original.document);
await assert.rejects(() => saveDocument(root, manifest, { documentId: scene.id, expectedRevision: 1, commandId: 'media-stale', content: compact.content }), { code: 'REVISION_CONFLICT' });
const restored = await restoreDocument(root, manifest, { documentId: scene.id, expectedRevision: current.revision, commandId: 'media-restore', revision: 1 });
assert.deepEqual(restored.document.content.map, original.document.content.map);
assert.deepEqual((await readScenePackage(await createScenePackage(restored.document.content))).map, scene.map);

const invalidDimensions = structuredClone(current.content); invalidDimensions.map.layers[1].width++;
await assert.rejects(() => saveDocument(root, manifest, { documentId: scene.id, expectedRevision: restored.document.revision, commandId: 'wrong-dimensions', content: invalidDimensions }), /dimensions/);
await assert.rejects(() => uploadDocumentMedia(root, manifest, `${'f'.repeat(64)}.png`, 'image/png', png), /哈希/);
await assert.rejects(() => uploadDocumentMedia(root, manifest, `${hash(png)}.jpg`, 'image/jpeg', png), /format/);
await writeFile(imageFile, Buffer.alloc(png.length, 9));
await assert.rejects(() => readDocumentMedia(root, manifest, imageKey), { code: 'CORRUPT_DOCUMENT_MEDIA' });
await assert.rejects(() => getDocument(root, manifest, { documentId: scene.id }, { media: 'references' }), { code: 'CORRUPT_DOCUMENT_MEDIA' });
await writeFile(imageFile, png); // Test-only corruption is restored before further checks.
assert.deepEqual((await readDocumentMedia(root, manifest, imageKey)).bytes, png);

// Private candidates use a separate blob namespace, including their previews.
const privateManifest = { ...manifest, workspace: { ...manifest.workspace, documentDirectory: `${manifest.workspace.documentDirectory}/private-candidate` } };
const split = await splitFixture(); split.id = 'media-private-split';
split.mapSplit.conflicts = [{ id: 'pixels', elementId: 'split_tree', field: 'parts.art.source', reason: 'both_changed', baseline: split.mapSplit.baseline[1].parts[0].source, current: split.mapSplit.elements[1].parts[0].source, incoming: split.mapSplit.elements[1].parts[0].source }];
const privateSaved = await createDocument(root, privateManifest, { kind: 'scene', content: split, commandId: 'private-create' }, { media: 'references' });
const privateSource = privateSaved.document.content.mapSplit.conflicts[0].current;
assert.ok(parseDocumentMediaReference(privateSource));
await assert.rejects(() => readDocumentMedia(root, manifest, parseDocumentMediaReference(privateSource).key), { code: 'DOCUMENT_MEDIA_NOT_FOUND' });
const materialized = (await getDocument(root, privateManifest, { documentId: split.id })).document.content;
assert.deepEqual((await readScenePackage(await createScenePackage(materialized))).mapSplit.conflicts, split.mapSplit.conflicts);

// Simulate a pre-migration immutable v1 history without rewriting it on read.
const legacy = createScene('Legacy'); legacy.id = 'legacy-inline-media'; replaceMap(legacy, structuredClone(scene.map));
const legacyInput = { kind: 'scene', content: legacy, commandId: 'legacy-original-command' };
const { document: legacyDocument } = await createDocument(root, manifest, legacyInput);
const legacyDirectory = path.join(directory, `document-${hash(legacy.id).slice(0, 40)}`), legacyHeadPath = path.join(legacyDirectory, 'head.json');
const legacyHead = JSON.parse(await readFile(legacyHeadPath, 'utf8'));
const inlineVersion = { ...legacyDocument, schemaVersion: 1, contentHash: hash(JSON.stringify(legacyDocument.content)) };
const legacyBytes = JSON.stringify(inlineVersion) + '\n', legacyFile = `versions/1-${hash(legacyBytes)}.json`;
await writeFile(path.join(legacyDirectory, legacyFile), legacyBytes);
Object.assign(legacyHead.versions[0], { file: legacyFile, sha256: hash(legacyBytes), contentHash: inlineVersion.contentHash });
legacyHead.contentHash = inlineVersion.contentHash;
await writeFile(legacyHeadPath, JSON.stringify(legacyHead));
assert.deepEqual((await createDocument(root, manifest, legacyInput)).document, inlineVersion, 'legacy exact command replay retains the historical identity');
const legacyCompact = (await getDocument(root, manifest, { documentId: legacy.id }, { media: 'references' })).document;
assert.equal(legacyCompact.contentHash, inlineVersion.contentHash, 'materialization never relabels the original version hash');
assert.equal(await readFile(path.join(legacyDirectory, legacyFile), 'utf8'), legacyBytes);
await saveDocument(root, manifest, { documentId: legacy.id, expectedRevision: 1, commandId: 'legacy-next', content: { ...legacyCompact.content, name: 'Compact next version' } });
assert.equal((await getDocument(root, manifest, { documentId: legacy.id, revision: 1 })).document.schemaVersion, 1);

// Browser boundaries: one durable copy, offline reload/undo, verified download,
// publish-before-commit, and no changed request body during a legacy replay.
const blobs = new Map(), requests = []; let writes = 0, offline = false, objectUrls = 0;
const makeCache = () => new DocumentMediaCache({
  store: { read: async key => blobs.get(key), write: async (key, blob) => { writes++; blobs.set(key, blob); } },
  createObjectURL: () => `blob:test-${++objectUrls}`, revokeObjectURL: () => {},
  fetch: async function (reference, options = {}) {
    assert.equal(this, globalThis, 'browser fetch keeps its Window receiver');
    requests.push({ reference, method: options.method || 'GET' });
    if (offline) throw new Error('offline');
    const ref = parseDocumentMediaReference(reference);
    try {
      if (options.method === 'PUT') return Response.json({ media: await uploadDocumentMedia(root, manifest, ref.key, options.headers['content-type'], Buffer.from(await options.body.arrayBuffer())) });
      const result = await readDocumentMedia(root, manifest, ref.key, { metadataOnly: options.method === 'HEAD' });
      return new Response(result.bytes, { headers: { 'content-type': result.metadata.mime } });
    } catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }); }
  },
});
let browser = makeCache();
const browserScene = await browser.compact('scene', scene);
assert.equal(writes, 2); assert.equal(requests.length, 0);
assert.deepEqual(browserScene.map, compact.content.map);
for (let index = 0; index < 8; index++) await browser.compact('scene', { ...browserScene, name: `Move ${index}` });
assert.equal(writes, 2); assert.equal(requests.length, 0);
browser.retain('scene', [{ kind: 'scene', content: browserScene }]); browser.release('scene');
offline = true; browser = makeCache();
const reloaded = await browser.compact('scene', browserScene);
assert.ok(browser.url(reloaded.map.layers[0].source).startsWith('blob:test-'));
assert.deepEqual((await browser.hydrate('scene', reloaded)).map, scene.map);
assert.equal(requests.length, 0, 'offline reload and history load read local blobs');
const key = parseDocumentMediaReference(browserScene.map.layers[0].source).key;
blobs.set(key, new Blob(['corrupt'], { type: 'image/png' }));
await assert.rejects(() => makeCache().compact('scene', browserScene), /哈希/);
blobs.set(key, new Blob([png], { type: 'image/png' }));
offline = false;
const fresh = await sharp({ create: { width: 5, height: 6, channels: 4, background: '#123456' } }).png().toBuffer();
const freshReference = await browser.put(new Blob([fresh], { type: 'image/png' }), 'image/png');
await browser.publish('interactable', { assets: [{ source: freshReference, mime: 'image/png' }] });
assert.deepEqual(requests.slice(-2).map(item => item.method), ['HEAD', 'PUT']);
assert.deepEqual((await readDocumentMedia(root, manifest, parseDocumentMediaReference(freshReference).key)).bytes, fresh);
const missing = structuredClone(browserScene); missing.map.source = documentMediaReference('e'.repeat(64), 'application/zip');
await assert.rejects(() => browser.compact('scene', missing), /无法读取/);
const failedStore = new DocumentMediaCache({ store: { read: async () => undefined, write: async () => { throw new Error('quota'); } } });
await assert.rejects(() => failedStore.compact('scene', scene), /quota/);

const rows = new Map(), journal = new RequestJournal({ scope: 'document-sync:scene', documentId: scene.id, store: {
  read: async key => rows.get(key), update: async (key, modify) => { const value = modify(rows.get(key)); rows.set(key, structuredClone(value)); return value; },
} });
const oldBody = sharedSceneContent(scene);
await journal.begin({ operation: 'save', input: { documentId: scene.id, kind: 'scene', commandId: 'legacy-save-body', expectedRevision: restored.document.revision, content: oldBody } });
let sent, syncCache;
const controller = new DocumentSyncController({ id: scene.id, kind: 'scene', journal, current: () => browserScene, busy: () => false,
  prepare: async value => sharedSceneContent(await browser.compact('scene', value)), saveLocal: async () => {}, applyRemote: async () => {}, backupLocal: async () => 'backup',
  readCache: async () => syncCache, writeCache: async value => { syncCache = value; }, api: {
    read: () => getDocument(root, manifest, { documentId: scene.id }, { media: 'references' }),
    metadata: () => getDocument(root, manifest, { documentId: scene.id, metadataOnly: true }),
    save: async (documentId, expectedRevision, content, commandId) => { sent = { content, commandId }; return saveDocument(root, manifest, { documentId, expectedRevision, content, commandId }, { media: 'references' }); },
    create: async () => { throw new Error('unexpected create'); },
  },
});
await controller.sync();
assert.equal(controller.getState().status, 'synced');
assert.equal(sent.commandId, 'legacy-save-body'); assert.deepEqual(sent.content, oldBody);
assert.equal(await journal.pending(), null);
controller.dispose();
console.log('Document media passed: compact histories, blob reuse, integrity, dimensions, private candidates, old snapshots/replay, self-contained packages, offline browser drafts and original pending bodies.');
