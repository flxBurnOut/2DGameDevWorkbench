import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { SceneEditSession } from '../../features/scene-composer/edit-session.mjs';
import { DocumentSyncController, documentFingerprint } from '../../features/editor-documents/sync-controller.mjs';
import { createScene } from '../../features/scene-composer/model.mjs';
import { sharedSceneContent, sceneWithLocalView } from '../../features/scene-composer/shared-content.mjs';
import { createDocument, saveDocument, getDocument } from '../../lib/workbench/editor-documents.mjs';
import { loadManifest, repositoryRoot as root } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest();
let current = createScene('Session baseline'), cache, gate, reached;
current.id = 'scene-session-regression';
const read = () => getDocument(root, manifest, { documentId: current.id });
const external = async name => {
  const { document } = await read();
  return (await saveDocument(root, manifest, { documentId: current.id, expectedRevision: document.revision,
    commandId: `external-${document.revision}`, content: { ...document.content, name } })).document;
};
const session = new SceneEditSession({
  current: () => current, fingerprint: value => documentFingerprint(sharedSceneContent(value)),
  saveLocal: async () => {}, flushSaved: () => sync.flushSaved(),
  readDocument: (documentId, revision) => getDocument(root, manifest, { documentId, revision }),
  acceptAdopted: (document, guard) => sync.acceptAdopted(document, guard),
});
const sync = new DocumentSyncController({
  id: current.id, kind: 'scene', current: () => current, busy: () => session.blocksSync,
  prepare: sharedSceneContent, saveLocal: async () => {},
  applyRemote: async (value, context) => {
    if (context.reason === 'adopt') session.record(current, { revision: context.document.revision, contentHash: context.document.contentHash });
    else session.clearHistory();
    current = sceneWithLocalView(value, current);
  },
  backupLocal: async () => 'backup', readCache: async () => cache, writeCache: async value => { cache = structuredClone(value); },
  api: {
    read: async () => { reached?.(); if (gate) await gate; return read(); },
    metadata: () => getDocument(root, manifest, { documentId: current.id, metadataOnly: true }),
    create: (kind, content, commandId) => createDocument(root, manifest, { kind, content, commandId }),
    save: (documentId, expectedRevision, content, commandId) => saveDocument(root, manifest, { documentId, expectedRevision, content, commandId }),
  },
});
await sync.sync();
session.preview(true);
await external('Remote during preview');
await sync.poll();
assert.equal(current.name, 'Session baseline');
assert.equal(session.blocksSync, true);
await assert.rejects(() => session.open('split'), /预览/);
session.preview(false); await sync.poll();
assert.equal(current.name, 'Remote during preview');

await external('Remote read already in flight');
let release;
gate = new Promise(resolve => { release = resolve; });
const reading = new Promise(resolve => { reached = resolve; });
const polling = sync.poll(); await reading;
session.preview(true); release(); await polling; gate = null; reached = null;
assert.equal(current.name, 'Remote during preview', 'preview also blocks a poll started earlier');
session.preview(false); await sync.poll();
assert.equal(current.name, 'Remote read already in flight');

const beforeAdoption = current;
const guard = await session.open('workflow');
await assert.rejects(() => session.open('image'), /当前场景/);
const adopted = await external('Adopted candidate');
current = { ...current, view: { ...current.view, zoom: 2 } };
const receipt = { documentId: adopted.id, revision: adopted.revision, contentHash: adopted.contentHash };
await session.accept(receipt);
assert.equal(current.name, 'Adopted candidate');
assert.equal(current.view.zoom, 2);
assert.equal(session.getState().canUndo, true);
assert.equal(session.guard.document.revision, guard.document.revision + 1);
await session.accept(receipt);
session.close();
const travel = direction => session.travel(direction, value => { current = sceneWithLocalView(value, current); });
await travel('undo');
assert.equal(current.name, beforeAdoption.name);
assert.equal((await read()).document.revision, adopted.revision + 1);
assert.equal(session.getState().canUndo, false, 'duplicate adoption adds no duplicate undo entry');
assert.equal(session.getState().canRedo, true);
await travel('redo');
assert.equal(current.name, 'Adopted candidate');
assert.equal((await read()).document.revision, adopted.revision + 2);
assert.equal(current.view.zoom, 2);

await external('Newer shared edit');
await assert.rejects(() => travel('undo'), /新内容/);
assert.equal(current.name, 'Newer shared edit');
assert.equal((await read()).document.content.name, 'Newer shared edit');
assert.equal(session.getState().phase, 'editing');

await session.open('split');
const invalid = await external('Candidate with exact hash');
await assert.rejects(() => session.accept({ documentId: invalid.id, revision: invalid.revision, contentHash: 'f'.repeat(64) }), /哈希/);
assert.equal(current.name, 'Newer shared edit');
assert.equal(session.getState().phase, 'candidate');
session.close();
sync.dispose();
console.log('Scene session passed: preview poll barriers, exclusive candidate guards, exact adoption, CAS undo/redo, duplicate receipts and concurrent remote edits.');
