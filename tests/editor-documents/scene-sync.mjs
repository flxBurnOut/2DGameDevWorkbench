import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createScene } from '../../features/scene-composer/model.mjs';
import { sharedSceneContent, sceneWithLocalView } from '../../features/scene-composer/shared-content.mjs';
import { DocumentSyncController } from '../../features/editor-documents/sync-controller.mjs';
import { createDocument, getDocument, saveDocument } from '../../lib/workbench/editor-documents.mjs';
import { loadManifest, repositoryRoot as root } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest();
let current = createScene('Personal view'), cache, readGate, metadataGate, loseResponse = false;
current.id = 'scene-personal-view';
const calls = [], backups = [];
const read = () => getDocument(root, manifest, { documentId: current.id });
const persist = async (expectedRevision, content, commandId) => {
  calls.push({ commandId, content: structuredClone(content) });
  const result = expectedRevision
    ? await saveDocument(root, manifest, { documentId: current.id, expectedRevision, content, commandId })
    : await createDocument(root, manifest, { kind: 'scene', content, commandId });
  if (loseResponse) { loseResponse = false; throw new Error('response lost'); }
  return result;
};
const make = () => new DocumentSyncController({
  id: current.id, kind: 'scene', current: () => current, busy: () => false,
  prepare: sharedSceneContent, saveLocal: async () => {},
  applyRemote: async value => { current = sceneWithLocalView(value, current); },
  backupLocal: async value => { backups.push(structuredClone(value)); return 'backup'; },
  readCache: async () => cache, writeCache: async value => { cache = structuredClone(value); },
  api: {
    read: async () => { if (readGate) await readGate; return read(); },
    metadata: async () => { if (metadataGate) await metadataGate; return getDocument(root, manifest, { documentId: current.id, metadataOnly: true }); },
    create: (_kind, content, commandId) => persist(0, content, commandId),
    save: (_id, revision, content, commandId) => persist(revision, content, commandId),
  },
});
const changeView = zoom => { current = { ...current, revision: current.revision + 1, view: { ...current.view, x: zoom * 7, y: zoom * -3, zoom, showGrid: false } }; };
const editName = name => { current = { ...current, revision: current.revision + 1, name }; };
const external = async name => {
  const { document } = await read();
  return saveDocument(root, manifest, { documentId: current.id, expectedRevision: document.revision, commandId: `remote-${document.revision}`, content: { ...document.content, name } });
};
const sync = make();
await sync.sync();
const original = (await read()).document;
changeView(2); await sync.sync();
assert.equal(calls.length, 1);
assert.deepEqual((await read()).document, original, 'personal view leaves shared revision and contentHash unchanged');
const localView = structuredClone(current.view);
await external('Agent content'); await sync.poll();
assert.equal(current.name, 'Agent content'); assert.deepEqual(current.view, localView);

// A camera change during a slow remote read is not a content conflict.
await external('Later agent content');
let release; readGate = new Promise(resolve => { release = resolve; });
const polling = sync.poll();
await new Promise(resolve => setTimeout(resolve, 20));
changeView(3); release(); await polling; readGate = null;
assert.equal(sync.getState().conflict, false); assert.equal(current.name, 'Later agent content'); assert.equal(current.view.zoom, 3);

// A completed but lost save is replayed with the same ID/body despite camera edits.
editName('Uncertain content'); loseResponse = true; await sync.sync();
assert.equal(sync.getState().status, 'offline');
const pending = calls.at(-1); const committedRevision = (await read()).document.revision;
changeView(4); await sync.retry();
assert.deepEqual(calls.at(-1), pending); assert.equal((await read()).document.revision, committedRevision);
assert.equal(sync.getState().status, 'synced');
sync.dispose();
const reopened = make(); await reopened.sync();
assert.equal(reopened.getState().status, 'synced'); assert.equal(current.view.zoom, 4);

const guard = await reopened.flushSaved();
changeView(5); await reopened.sync();
assert.equal((await read()).document.revision, guard.document.revision);
const adoption = await external('Adopted candidate');
metadataGate = new Promise(resolve => { release = resolve; });
const accepting = reopened.acceptAdopted(adoption.document, guard);
await new Promise(resolve => setTimeout(resolve, 20));
changeView(6); release(); await accepting; metadataGate = null;
assert.equal(current.name, 'Adopted candidate'); assert.equal(current.view.zoom, 6);
assert.equal(reopened.getState().conflict, false);

// Content edits, including those during reads, still preserve the local draft.
await external('Concurrent content');
readGate = new Promise(resolve => { release = resolve; });
const conflicting = reopened.poll();
await new Promise(resolve => setTimeout(resolve, 20));
editName('Keep my draft'); release(); await conflicting; readGate = null;
assert.equal(reopened.getState().conflict, true); assert.equal(current.name, 'Keep my draft');
assert.equal((await read()).document.name, 'Concurrent content');
await reopened.reloadRemote();
assert.equal(backups.at(-1).name, 'Keep my draft'); assert.equal(current.view.zoom, 6);
assert.equal(current.name, 'Concurrent content');
reopened.dispose();
console.log('Scene sync passed: local views, unchanged shared identities, delayed reads, lost response replay, adoption and real content conflicts.');
