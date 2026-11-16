import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createProject, normalizeProject } from '../../features/interactable-editor/contract.mjs';
import { buildGodotPackage } from '../../features/interactable-editor/godot-builder.mjs';
import { readSourcePackage } from '../../features/interactable-editor/source-package.mjs';
import { documentMediaReferences, parseDocumentMediaReference, documentMediaReference } from '../../features/editor-documents/media-references.mjs';
import { DocumentMediaCache } from '../../features/editor-documents/media-cache.mjs';
import { DocumentSyncController } from '../../features/editor-documents/sync-controller.mjs';
import { RequestJournal } from '../../features/editor-documents/request-journal.mjs';
import { applyDocumentCommands, createDocument, saveDocument, getDocument, restoreDocument, readDocumentMedia, uploadDocumentMedia, documentDirectory } from '../../lib/workbench/editor-documents.mjs';
import { loadManifest, repositoryRoot as root } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest(), directory = documentDirectory(root, manifest);
assert.ok(directory.includes(process.env.WORKBENCH_TEST_RUN));
const hash = value => createHash('sha256').update(value).digest('hex');
const embedded = (bytes, mime) => `data:${mime};base64,${bytes.toString('base64')}`;
const png = await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
const project = createProject(); project.name = 'Media references'; project.projectId = 'media-reference-project';
const thumbnail = await sharp({ create: { width: 8, height: 12, channels: 4, background: '#abcdef' } }).png().toBuffer();
project.assets = ['first', 'same-pixels', 'thumbnail'].map((id, index) => ({ id, name: `${id}.png`, mime: 'image/png', source: embedded(index === 2 ? thumbnail : png, 'image/png') }));
project.objects[0].visual.assetId = 'first';
project.objects[0].behavior.states[0].appearance.assetId = 'same-pixels';
project.objects[0].behavior.states[1].appearance.assetId = 'thumbnail';
const initialRequest = { kind: 'interactable', content: project, commandId: 'media-create' };
const original = await createDocument(root, manifest, initialRequest);
const compact = (await getDocument(root, manifest, { documentId: project.projectId }, { media: 'references' })).document;
const references = documentMediaReferences('interactable', compact.content).map(slot => slot.owner[slot.key]);
assert.ok(references.every(parseDocumentMediaReference));
assert.equal(references[0], references[1], 'duplicate asset bytes have one immutable identity');
assert.equal(compact.contentHash, hash(JSON.stringify(compact.content)));
assert.ok(JSON.stringify(compact.content).length < 4000, 'large image bytes stay outside the editing document');
const mediaDirectory = path.join(directory, 'media');
const files = await readdir(mediaDirectory);
assert.equal(files.length, 2);
const imageKey = parseDocumentMediaReference(references[0]).key, imageFile = path.join(mediaDirectory, imageKey);
const before = await stat(imageFile, { bigint: true });
let current = compact;
for (let index = 0; index < 8; index++) {
  const request = { documentId: project.projectId, expectedRevision: current.revision, commandId: `media-move-${index}`, content: { ...current.content, name: `Metadata edit ${index}` } };
  const result = await saveDocument(root, manifest, request, { media: 'references' });
  assert.equal((await saveDocument(root, manifest, request, { media: 'references' })).replayed, true);
  current = result.document;
}
assert.equal((await stat(imageFile, { bigint: true })).mtimeNs, before.mtimeNs, 'metadata edits never rewrite an immutable image');
assert.deepEqual(await readdir(mediaDirectory), files);
const documentPath = path.join(directory, `document-${hash(project.projectId).slice(0, 40)}`);
const head = JSON.parse(await readFile(path.join(documentPath, 'head.json'), 'utf8'));
for (const version of head.versions) assert.ok((await stat(path.join(documentPath, version.file))).size < 5000);
assert.deepEqual((await getDocument(root, manifest, { documentId: project.projectId, revision: 1 })).document, original.document);
await assert.rejects(() => saveDocument(root, manifest, { documentId: project.projectId, expectedRevision: 1, commandId: 'media-stale', content: compact.content }), { code: 'REVISION_CONFLICT' });
const restored = await restoreDocument(root, manifest, { documentId: project.projectId, expectedRevision: current.revision, commandId: 'media-restore', revision: 1 });
assert.deepEqual(restored.document.content.assets, original.document.content.assets);
assert.deepEqual((await readSourcePackage((await buildGodotPackage({ project: restored.document.content }, { repositoryRoot: root })).bytes)).assets, project.assets);

const invalidProvenance = structuredClone(current.content); invalidProvenance.assets[0].generation = { sourceTaskId: 'source-task', sha256: '0'.repeat(64) };
await assert.rejects(() => saveDocument(root, manifest, { documentId: project.projectId, expectedRevision: restored.document.revision, commandId: 'wrong-provenance', content: invalidProvenance }), /hash/);
await assert.rejects(() => uploadDocumentMedia(root, manifest, `${'f'.repeat(64)}.png`, 'image/png', png), /哈希/);
await assert.rejects(() => uploadDocumentMedia(root, manifest, `${hash(png)}.jpg`, 'image/jpeg', png), /format/);
await writeFile(imageFile, Buffer.alloc(png.length, 9));
await assert.rejects(() => readDocumentMedia(root, manifest, imageKey), { code: 'CORRUPT_DOCUMENT_MEDIA' });
await assert.rejects(() => getDocument(root, manifest, { documentId: project.projectId }, { media: 'references' }), { code: 'CORRUPT_DOCUMENT_MEDIA' });
await writeFile(imageFile, png); // Test-only corruption is restored before further checks.
assert.deepEqual((await readDocumentMedia(root, manifest, imageKey)).bytes, png);

// Full replacement can recover from media belonging only to the broken head.
// Each case owns its blob namespace so corruption cannot affect other fixtures.
for (const damage of ['missing', 'corrupt']) for (const operation of ['restore', 'save']) {
  const recoveryManifest = { ...manifest, workspace: { ...manifest.workspace, documentDirectory: `${manifest.workspace.documentDirectory}/recovery-${damage}-${operation}` } };
  const clean = createProject(); clean.projectId = `recover-${damage}-${operation}`;
  await createDocument(root, recoveryManifest, { kind: 'interactable', commandId: 'recovery-create', content: clean });
  const withMedia = structuredClone(clean);
  withMedia.assets = [{ id: 'head-only-image', name: 'head-only.png', mime: 'image/png', source: embedded(thumbnail, 'image/png') }];
  withMedia.objects[0].visual.assetId = 'head-only-image';
  const broken = (await saveDocument(root, recoveryManifest, { documentId: clean.projectId, expectedRevision: 1, commandId: 'add-head-media', content: withMedia }, { media: 'references' })).document;
  const media = parseDocumentMediaReference(broken.content.assets[0].source);
  const file = path.join(documentDirectory(root, recoveryManifest), 'media', media.key);
  if (damage === 'missing') await unlink(file);
  else await writeFile(file, Buffer.alloc(thumbnail.length, 9));
  const mediaCode = damage === 'missing' ? 'DOCUMENT_MEDIA_NOT_FOUND' : 'CORRUPT_DOCUMENT_MEDIA';
  assert.deepEqual((await getDocument(root, recoveryManifest, { documentId: clean.projectId, revision: 1 })).document.content, clean);
  await assert.rejects(() => applyDocumentCommands(root, recoveryManifest, { documentId: clean.projectId, expectedRevision: 2, commandId: 'incremental-with-bad-media', commands: [{ type: 'rename', name: 'Keep the broken asset' }] }), { code: mediaCode });
  const request = { documentId: clean.projectId, expectedRevision: 2, commandId: 'recover-clean-content',
    ...(operation === 'restore' ? { revision: 1 } : { content: { ...clean, name: 'Clean replacement' } }) };
  const recover = operation === 'restore' ? restoreDocument : saveDocument;
  const result = await recover(root, recoveryManifest, request);
  assert.equal(result.document.revision, 3);
  assert.equal(result.document.content.assets.length, 0);
  assert.equal(result.document.contentHash, hash(JSON.stringify(result.document.content)));
  if (operation === 'restore') assert.equal(result.document.restoredFrom, 1);
  await assert.rejects(() => recover(root, recoveryManifest, { ...request, commandId: 'stale-recovery' }), { code: 'REVISION_CONFLICT' });
  await saveDocument(root, recoveryManifest, { documentId: clean.projectId, expectedRevision: 3, commandId: 'after-recovery', content: { ...result.document.content, name: 'Later clean edit' } });
  const replay = await recover(root, recoveryManifest, request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.currentRevision, 4);
  assert.deepEqual(replay.document, result.document, 'recovery replays its original snapshot even after a later edit');
  const reused = operation === 'restore' ? { ...request, revision: 2 } : { ...request, content: { ...clean, name: 'Changed request' } };
  await assert.rejects(() => recover(root, recoveryManifest, reused), { code: 'COMMAND_ID_REUSED' });
  await assert.rejects(() => restoreDocument(root, recoveryManifest, { documentId: clean.projectId, expectedRevision: 4, commandId: 'restore-bad-target', revision: 2 }), { code: mediaCode });
  await assert.rejects(() => saveDocument(root, recoveryManifest, { documentId: clean.projectId, expectedRevision: 4, commandId: 'save-bad-content', content: broken.content }), { code: mediaCode });
  await assert.rejects(() => saveDocument(root, recoveryManifest, { documentId: clean.projectId, expectedRevision: 4, commandId: 'save-wrong-identity', content: { ...clean, projectId: 'different-project' } }), /identity/);
  assert.equal((await getDocument(root, recoveryManifest, { documentId: clean.projectId, metadataOnly: true })).document.revision, 4, 'rejected recovery targets cannot advance the head');
}

// Replacement still reads and verifies the current immutable snapshot, even
// when its media is no longer needed. Rehashing the envelope cannot bypass its
// document identity or contentHash checks.
for (const damagedField of ['id', 'contentHash']) {
  const clean = createProject(); clean.projectId = `replacement-snapshot-${damagedField}`;
  await createDocument(root, manifest, { kind: 'interactable', commandId: 'snapshot-create', content: clean });
  await saveDocument(root, manifest, { documentId: clean.projectId, expectedRevision: 1, commandId: 'snapshot-edit', content: { ...clean, name: 'Current snapshot' } });
  const snapshotDirectory = path.join(directory, `document-${hash(clean.projectId).slice(0, 40)}`);
  const headPath = path.join(snapshotDirectory, 'head.json'), head = JSON.parse(await readFile(headPath, 'utf8'));
  const snapshot = JSON.parse(await readFile(path.join(snapshotDirectory, head.versions[1].file), 'utf8'));
  snapshot[damagedField] = damagedField === 'id' ? 'another-document' : '0'.repeat(64);
  const bytes = JSON.stringify(snapshot) + '\n', sha256 = hash(bytes), file = `versions/2-${sha256}.json`;
  await writeFile(path.join(snapshotDirectory, file), bytes);
  Object.assign(head.versions[1], { file, sha256 });
  await writeFile(headPath, JSON.stringify(head));
  await assert.rejects(() => restoreDocument(root, manifest, { documentId: clean.projectId, expectedRevision: 2, commandId: 'restore-corrupt-head', revision: 1 }), { code: 'CORRUPT_DOCUMENT' });
  await assert.rejects(() => saveDocument(root, manifest, { documentId: clean.projectId, expectedRevision: 2, commandId: 'save-over-corrupt-head', content: clean }), { code: 'CORRUPT_DOCUMENT' });
}

// Private candidates use a separate blob namespace, including their previews.
const privateManifest = { ...manifest, workspace: { ...manifest.workspace, documentDirectory: `${manifest.workspace.documentDirectory}/private-candidate` } };
const privateProject = createProject(); privateProject.projectId = 'media-private-project';
const privatePng = await sharp({ create: { width: 3, height: 4, channels: 4, background: '#aabbcc' } }).png().toBuffer();
privateProject.assets = [{ id: 'private-art', name: 'private.png', mime: 'image/png', source: embedded(privatePng, 'image/png') }];
privateProject.objects[0].visual.assetId = 'private-art';
const privateSaved = await createDocument(root, privateManifest, { kind: 'interactable', content: privateProject, commandId: 'private-create' }, { media: 'references' });
const privateSource = privateSaved.document.content.assets[0].source;
assert.ok(parseDocumentMediaReference(privateSource));
await assert.rejects(() => readDocumentMedia(root, manifest, parseDocumentMediaReference(privateSource).key), { code: 'DOCUMENT_MEDIA_NOT_FOUND' });
const materialized = (await getDocument(root, privateManifest, { documentId: privateProject.projectId })).document.content;
assert.deepEqual((await readSourcePackage((await buildGodotPackage({ project: materialized }, { repositoryRoot: root })).bytes)).assets, privateProject.assets);

// Simulate a pre-migration immutable v1 history without rewriting it on read.
const legacy = structuredClone(project); legacy.name = 'Legacy'; legacy.projectId = 'legacy-inline-media';
const legacyInput = { kind: 'interactable', content: legacy, commandId: 'legacy-original-command' };
const { document: legacyDocument } = await createDocument(root, manifest, legacyInput);
const legacyDirectory = path.join(directory, `document-${hash(legacy.projectId).slice(0, 40)}`), legacyHeadPath = path.join(legacyDirectory, 'head.json');
const legacyHead = JSON.parse(await readFile(legacyHeadPath, 'utf8'));
const inlineVersion = { ...legacyDocument, schemaVersion: 1, contentHash: hash(JSON.stringify(legacyDocument.content)) };
const legacyBytes = JSON.stringify(inlineVersion) + '\n', legacyFile = `versions/1-${hash(legacyBytes)}.json`;
await writeFile(path.join(legacyDirectory, legacyFile), legacyBytes);
Object.assign(legacyHead.versions[0], { file: legacyFile, sha256: hash(legacyBytes), contentHash: inlineVersion.contentHash });
legacyHead.contentHash = inlineVersion.contentHash;
await writeFile(legacyHeadPath, JSON.stringify(legacyHead));
assert.deepEqual((await createDocument(root, manifest, legacyInput)).document, inlineVersion, 'legacy exact command replay retains the historical identity');
const legacyCompact = (await getDocument(root, manifest, { documentId: legacy.projectId }, { media: 'references' })).document;
assert.equal(legacyCompact.contentHash, inlineVersion.contentHash, 'materialization never relabels the original version hash');
assert.equal(await readFile(path.join(legacyDirectory, legacyFile), 'utf8'), legacyBytes);
await saveDocument(root, manifest, { documentId: legacy.projectId, expectedRevision: 1, commandId: 'legacy-next', content: { ...legacyCompact.content, name: 'Compact next version' } });
assert.equal((await getDocument(root, manifest, { documentId: legacy.projectId, revision: 1 })).document.schemaVersion, 1);

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
const browserProject = await browser.compact('interactable', project);
assert.equal(writes, 2); assert.equal(requests.length, 0);
assert.deepEqual(browserProject.assets, compact.content.assets);
for (let index = 0; index < 8; index++) await browser.compact('interactable', { ...browserProject, name: `Move ${index}` });
assert.equal(writes, 2); assert.equal(requests.length, 0);
browser.retain('interactable', [{ kind: 'interactable', content: browserProject }]); browser.release('interactable');
offline = true; browser = makeCache();
const reloaded = await browser.compact('interactable', browserProject);
assert.ok(browser.url(reloaded.assets[0].source).startsWith('blob:test-'));
assert.deepEqual((await browser.hydrate('interactable', reloaded)).assets, project.assets);
assert.equal(requests.length, 0, 'offline reload and history load read local blobs');
const key = parseDocumentMediaReference(browserProject.assets[0].source).key;
blobs.set(key, new Blob(['corrupt'], { type: 'image/png' }));
await assert.rejects(() => makeCache().compact('interactable', browserProject), /哈希/);
blobs.set(key, new Blob([png], { type: 'image/png' }));
offline = false;
const fresh = await sharp({ create: { width: 5, height: 6, channels: 4, background: '#123456' } }).png().toBuffer();
const freshReference = await browser.put(new Blob([fresh], { type: 'image/png' }), 'image/png');
await browser.publish('interactable', { assets: [{ source: freshReference, mime: 'image/png' }] });
assert.deepEqual(requests.slice(-2).map(item => item.method), ['HEAD', 'PUT']);
assert.deepEqual((await readDocumentMedia(root, manifest, parseDocumentMediaReference(freshReference).key)).bytes, fresh);
const missing = structuredClone(browserProject); missing.assets[0].source = documentMediaReference('e'.repeat(64), 'image/png');
await assert.rejects(() => browser.compact('interactable', missing), /无法读取/);
const failedStore = new DocumentMediaCache({ store: { read: async () => undefined, write: async () => { throw new Error('quota'); } } });
await assert.rejects(() => failedStore.compact('interactable', project), /quota/);

const rows = new Map(), journal = new RequestJournal({ scope: 'document-sync:interactable', documentId: project.projectId, store: {
  read: async key => rows.get(key), update: async (key, modify) => { const value = modify(rows.get(key)); rows.set(key, structuredClone(value)); return value; },
} });
const oldBody = normalizeProject(project);
await journal.begin({ operation: 'save', input: { documentId: project.projectId, kind: 'interactable', commandId: 'legacy-save-body', expectedRevision: restored.document.revision, content: oldBody } });
let sent, syncCache;
const controller = new DocumentSyncController({ id: project.projectId, kind: 'interactable', journal, current: () => browserProject, busy: () => false,
  prepare: async value => normalizeProject(await browser.compact('interactable', value)), saveLocal: async () => {}, applyRemote: async () => {}, backupLocal: async () => 'backup',
  readCache: async () => syncCache, writeCache: async value => { syncCache = value; }, api: {
    read: () => getDocument(root, manifest, { documentId: project.projectId }, { media: 'references' }),
    metadata: () => getDocument(root, manifest, { documentId: project.projectId, metadataOnly: true }),
    save: async (documentId, expectedRevision, content, commandId) => { sent = { content, commandId }; return saveDocument(root, manifest, { documentId, expectedRevision, content, commandId }, { media: 'references' }); },
    create: async () => { throw new Error('unexpected create'); },
  },
});
await controller.sync();
assert.equal(controller.getState().status, 'synced');
assert.equal(sent.commandId, 'legacy-save-body'); assert.deepEqual(sent.content, oldBody);
assert.equal(await journal.pending(), null);
controller.dispose();
console.log('Document media passed: compact histories, blob reuse, integrity, provenance, bad-head recovery with strict replacement validation, private candidates, old snapshots/replay, self-contained packages, offline browser drafts and original pending bodies.');
