import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { RequestJournal } from '../../features/editor-documents/request-journal.mjs';
import { DocumentSyncController } from '../../features/editor-documents/sync-controller.mjs';
import { createScene } from '../../features/scene-composer/model.mjs';
import { sharedSceneContent } from '../../features/scene-composer/shared-content.mjs';
import { createDocument, saveDocument, getDocument } from '../../lib/workbench/editor-documents.mjs';
import { loadManifest, repositoryRoot as root } from '../../lib/workbench/runtime.mjs';

const rows = new Map();
let queue = Promise.resolve(), storageFailure = false;
const store = {
  read: async key => structuredClone(rows.get(key)),
  update: (key, modify) => {
    const work = queue.catch(() => {}).then(() => {
      if (storageFailure) throw new Error('storage unavailable');
      const next = modify(structuredClone(rows.get(key)));
      rows.set(key, structuredClone(next));
      return structuredClone(next);
    });
    queue = work;
    return work;
  },
};
const journal = (scope = 'scene-workflow', documentId = 'journal-scene') => new RequestJournal({ scope, documentId, store });
const first = { operation: 'adopt', input: { commandId: 'first', workId: 'work', expectedRevision: 4, candidateRevision: 2, candidateHash: 'a'.repeat(64) } };
const second = { operation: 'adopt', input: { ...first.input, commandId: 'second' } };
const a = journal(), b = journal();
const starts = await Promise.allSettled([a.begin(first), b.begin(second)]);
assert.equal(starts[0].status, 'fulfilled');
assert.equal(starts[1].status, 'rejected');
const original = structuredClone(first);
first.input.candidateRevision = 99;
assert.deepEqual((await b.pending()).request, original, 'caller mutations never change a persisted body');
await assert.rejects(() => b.begin(first), /原请求/);
await a.respond(original, { revision: 8, contentHash: 'b'.repeat(64) });
const reopened = journal();
assert.deepEqual((await reopened.pending()).response, { revision: 8, contentHash: 'b'.repeat(64) });
assert.deepEqual((await reopened.begin(original)).request, original);
await reopened.complete(original);
await b.begin(second);
await assert.rejects(() => a.complete(original), /已变化/);
assert.deepEqual((await a.pending()).request, second, 'late completion cannot erase the next request');
await b.complete(second, 'rejected');
await assert.rejects(() => a.begin(first), /不同的请求/);
assert.equal(await journal('scene-split').pending(), null, 'operation families retain independent identities');

// The same durable log restores an uncertain save even after a newer local edit
// and a new controller instance. Both commits retain their own CAS identities.
const manifest = await loadManifest();
let current = createScene('Journal sync'), cache, loseReply = false;
current.id = 'journal-document';
const calls = [];
const api = {
  read: () => getDocument(root, manifest, { documentId: current.id }),
  metadata: () => getDocument(root, manifest, { documentId: current.id, metadataOnly: true }),
  create: async (kind, content, commandId) => {
    calls.push({ commandId, content: structuredClone(content), expectedRevision: 0 });
    return createDocument(root, manifest, { kind, content, commandId });
  },
  save: async (documentId, expectedRevision, content, commandId) => {
    calls.push({ commandId, content: structuredClone(content), expectedRevision });
    const result = await saveDocument(root, manifest, { documentId, expectedRevision, content, commandId });
    if (loseReply) { loseReply = false; throw new Error('reply lost'); }
    return result;
  },
};
const make = () => new DocumentSyncController({
  id: current.id, kind: 'scene', current: () => current, busy: () => false,
  journal: journal('document-sync:scene', current.id),
  prepare: sharedSceneContent, saveLocal: async () => {}, applyRemote: async next => { current = next; },
  backupLocal: async () => 'backup', readCache: async () => cache, writeCache: async value => { cache = structuredClone(value); }, api,
});
let controller = make();
await controller.sync();
current = { ...current, name: 'Original uncertain body' }; loseReply = true;
await controller.sync();
assert.equal(controller.getState().status, 'offline');
const pending = structuredClone(calls.at(-1));
current = { ...current, name: 'New local draft' };
controller.dispose(); controller = make();
await controller.sync();
assert.deepEqual(calls.at(-2), pending, 'restart replays the original ID, expected revision and exact content');
assert.notEqual(calls.at(-1).commandId, pending.commandId);
assert.equal(calls.at(-1).expectedRevision, 2);
assert.equal((await api.read()).document.content.name, 'New local draft');
assert.equal((await api.read()).document.revision, 3);
assert.equal(await journal('document-sync:scene', current.id).pending(), null);

current = { ...current, name: 'Must persist before sending' };
storageFailure = true;
const before = calls.length;
await controller.sync();
assert.equal(calls.length, before);
assert.equal(controller.getState().status, 'offline');
storageFailure = false;
await controller.retry();
assert.equal((await api.read()).document.content.name, 'Must persist before sending');
controller.dispose();

// Losing the local rejection receipt must not throw from an autosave timer or
// discard the identity needed to confirm that same rejected request.
current = { ...current, name: 'Rejected request receipt' };
let rejectReceipt = true;
const rejectionJournal = journal('rejected-sync', current.id);
const rejectionController = new DocumentSyncController({
  id: current.id, kind: 'scene', current: () => current, busy: () => false,
  prepare: sharedSceneContent, saveLocal: async () => {}, applyRemote: async () => {}, backupLocal: async () => 'backup',
  readCache: async () => cache, writeCache: async value => { cache = value; },
  journal: { pending: () => rejectionJournal.pending(), begin: request => rejectionJournal.begin(request), respond: (request, result) => rejectionJournal.respond(request, result),
    complete: async (...args) => { if (rejectReceipt) throw new Error('receipt quota'); return rejectionJournal.complete(...args); } },
  api: { ...api, save: async () => { throw Object.assign(new Error('changed elsewhere'), { status: 409 }); } },
});
await rejectionController.sync();
assert.equal(rejectionController.getState().status, 'offline');
const rejection = (await rejectionJournal.pending()).request;
rejectReceipt = false;
await rejectionController.retry();
assert.equal(rejectionController.getState().status, 'conflict');
assert.equal(await rejectionJournal.pending(), null);
assert.equal(rows.get(rejectionJournal.key).history.at(-1).request.input.commandId, rejection.input.commandId);
rejectionController.dispose();
console.log('Durable request journal passed: tab races, immutable bodies, receipts, stale completion, restart replay, CAS and persistence-before-send.');
