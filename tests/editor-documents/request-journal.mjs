import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { RequestJournal } from '../../features/editor-documents/request-journal.mjs';
import { DocumentSyncController, documentFingerprint } from '../../features/editor-documents/sync-controller.mjs';
import { createProject, normalizeProject } from '../../features/interactable-editor/contract.mjs';
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
const journal = (scope = 'image-edit', documentId = 'journal-project') => new RequestJournal({ scope, documentId, store });
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
assert.equal(await journal('independent-operation').pending(), null, 'operation families retain independent identities');

// The same durable log restores an uncertain save even after a newer local edit
// and a new controller instance. Both commits retain their own CAS identities.
const manifest = await loadManifest();
let current = createProject(), cache, loseReply = false;
current.projectId = 'journal-document';
const calls = [];
const api = {
  read: () => getDocument(root, manifest, { documentId: current.projectId }),
  metadata: () => getDocument(root, manifest, { documentId: current.projectId, metadataOnly: true }),
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
  id: current.projectId, kind: 'interactable', current: () => current, busy: () => false,
  journal: journal('document-sync:interactable', current.projectId),
  prepare: normalizeProject, saveLocal: async () => {}, applyRemote: async next => { current = next; },
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
assert.equal(await journal('document-sync:interactable', current.projectId).pending(), null);

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

// A tab that was already connected must recover a different tab's durable
// command. Its own draft and baseline still govern whether it follows the head.
for (const dirty of [false, true]) {
  const project = createProject(); project.projectId = `existing-tabs-${dirty}`;
  const { document } = await createDocument(root, manifest, { kind: 'interactable', content: project, commandId: 'initial-create' });
  let firstDraft = structuredClone(document.content), secondDraft = structuredClone(document.content);
  let sharedCache = { revision: document.revision, fingerprint: await documentFingerprint(document.content) };
  let loseFirstReceipt = true;
  const sent = [];
  const makeTab = (tab, current, applyRemote) => new DocumentSyncController({
    id: project.projectId, kind: 'interactable', current, applyRemote, busy: () => false,
    journal: journal('existing-tab-sync', project.projectId), prepare: normalizeProject,
    saveLocal: async () => {}, backupLocal: async () => 'backup',
    readCache: async () => structuredClone(sharedCache), writeCache: async value => { sharedCache = structuredClone(value); },
    api: {
      read: () => getDocument(root, manifest, { documentId: project.projectId }),
      save: async (documentId, expectedRevision, content, commandId) => {
        const input = { documentId, expectedRevision, content, commandId };
        sent.push({ tab, input: structuredClone(input) });
        const result = await saveDocument(root, manifest, input);
        if (tab === 'first' && loseFirstReceipt) { loseFirstReceipt = false; throw new Error('reply lost'); }
        return result;
      },
    },
  });
  const firstTab = makeTab('first', () => firstDraft, next => { firstDraft = next; });
  const secondTab = makeTab('second', () => secondDraft, next => { secondDraft = next; });
  await firstTab.sync();
  await secondTab.sync();
  firstDraft = { ...firstDraft, name: 'First tab lost the receipt' };
  await firstTab.sync();
  assert.equal(firstTab.getState().status, 'offline');
  const pendingJournal = journal('existing-tab-sync', project.projectId);
  assert.ok(await pendingJournal.pending());
  if (dirty) {
    secondDraft = { ...secondDraft, name: 'Independent second-tab draft' };
    await secondTab.sync();
    assert.equal(secondTab.getState().status, 'offline');
    assert.equal(sharedCache.pending.commandId, sent[0].input.commandId, 'a rejected new request cannot replace the existing recovery hint');
  }

  const latest = (await saveDocument(root, manifest, { documentId: project.projectId,
    expectedRevision: 2, commandId: 'newer-shared-version', content: { ...firstDraft, name: 'Newer shared version' },
  })).document;
  await secondTab.retry();
  assert.deepEqual(sent, [{ tab: 'first', input: sent[0].input }, { tab: 'second', input: sent[0].input }]);
  assert.equal(await pendingJournal.pending(), null);
  assert.equal(secondTab.getState().revision, latest.revision);
  assert.equal(secondTab.getState().status, dirty ? 'conflict' : 'synced');
  assert.equal(secondDraft.name, dirty ? 'Independent second-tab draft' : latest.content.name);
  await firstTab.retry();
  assert.deepEqual(sent.at(-1), sent[0]);
  assert.equal(firstTab.getState().revision, latest.revision, 'an old replay receipt cannot regress the recovered head');
  assert.equal(firstDraft.name, latest.content.name);
  assert.equal((await getDocument(root, manifest, { documentId: project.projectId })).document.revision, latest.revision);
  firstTab.dispose(); secondTab.dispose();
}

// Losing the local rejection receipt must not throw from an autosave timer or
// discard the identity needed to confirm that same rejected request.
current = { ...current, name: 'Rejected request receipt' };
let rejectReceipt = true;
const rejectionJournal = journal('rejected-sync', current.projectId);
const rejectionController = new DocumentSyncController({
  id: current.projectId, kind: 'interactable', current: () => current, busy: () => false,
  prepare: normalizeProject, saveLocal: async () => {}, applyRemote: async () => {}, backupLocal: async () => 'backup',
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

// A transient initialization read must retry the baseline and original journal
// before comparing drafts or inventing another command identity.
for (const failedRead of ['cache', 'journal']) for (const scenario of ['local-edit', 'uncertain-save', 'remote-conflict']) {
  const project = createProject(); project.projectId = `initialization-${failedRead}-${scenario}`;
  const initial = (await createDocument(root, manifest, { kind: 'interactable', content: project, commandId: 'initial-create' })).document;
  const pendingJournal = journal('initialization-retry', project.projectId);
  let local = { ...initial.content, name: 'Latest local edit' };
  let baseline = { revision: 1, fingerprint: await documentFingerprint(initial.content) };
  let originalRequest;
  if (scenario === 'uncertain-save') {
    const content = { ...initial.content, name: 'Original uncertain edit' };
    originalRequest = { operation: 'save', input: { documentId: project.projectId, kind: 'interactable', expectedRevision: 1, commandId: 'original-uncertain-command', content } };
    await pendingJournal.begin(originalRequest);
    await saveDocument(root, manifest, { documentId: project.projectId, expectedRevision: 1, commandId: originalRequest.input.commandId, content });
    baseline.pending = { commandId: originalRequest.input.commandId, expectedRevision: 1, fingerprint: await documentFingerprint(content) };
  } else if (scenario === 'remote-conflict') {
    await saveDocument(root, manifest, { documentId: project.projectId, expectedRevision: 1, commandId: 'external-edit', content: { ...initial.content, name: 'Another editor changed the server' } });
  }
  const sent = [];
  let cacheReads = 0, journalReads = 0;
  let releaseCacheRead;
  const cacheReadGate = new Promise(resolve => { releaseCacheRead = resolve; });
  const recovering = new DocumentSyncController({
    id: project.projectId, kind: 'interactable', current: () => local, busy: () => false,
    prepare: normalizeProject, saveLocal: async () => {}, applyRemote: async next => { local = next; }, backupLocal: async () => 'backup',
    readCache: async () => {
      if (++cacheReads === 1 && failedRead === 'cache') throw new Error('transient cache read failure');
      if (cacheReads === 2) await cacheReadGate;
      return structuredClone(baseline);
    },
    writeCache: async next => { baseline = structuredClone(next); },
    journal: {
      pending: async () => {
        if (++journalReads === 1 && failedRead === 'journal') throw new Error('transient journal read failure');
        return pendingJournal.pending();
      },
      begin: request => pendingJournal.begin(request), respond: (request, result) => pendingJournal.respond(request, result),
      complete: (...args) => pendingJournal.complete(...args),
    },
    api: {
      read: () => getDocument(root, manifest, { documentId: project.projectId }),
      save: async (documentId, expectedRevision, content, commandId) => {
        sent.push({ documentId, expectedRevision, content: structuredClone(content), commandId });
        return saveDocument(root, manifest, { documentId, expectedRevision, content, commandId });
      },
      create: async () => { throw new Error('An existing document must not be recreated.'); },
    },
  });
  await recovering.sync();
  assert.equal(recovering.getState().status, 'offline');
  assert.equal(sent.length, 0, 'failed initialization cannot submit a request');
  const reconnect = recovering.retry();
  await recovering.sync();
  assert.equal(sent.length, 0, 'reconnect initialization serializes concurrent autosave');
  releaseCacheRead();
  await reconnect;
  assert.equal(cacheReads, 2, 'reconnect rereads the baseline after incomplete initialization');
  assert.equal(journalReads, failedRead === 'journal' ? 2 : 1, 'reconnect restores the durable request log');
  const remote = (await getDocument(root, manifest, { documentId: project.projectId })).document;
  assert.equal(local.name, 'Latest local edit');
  if (scenario === 'remote-conflict') {
    assert.equal(recovering.getState().status, 'conflict');
    assert.equal(remote.content.name, 'Another editor changed the server');
    assert.equal(sent.length, 0, 'recovering storage must not bypass a real remote conflict');
  } else {
    assert.equal(recovering.getState().status, 'synced');
    assert.equal(remote.content.name, 'Latest local edit');
    assert.equal(sent.at(-1).expectedRevision, scenario === 'uncertain-save' ? 2 : 1);
    if (originalRequest) {
      const { kind: _kind, ...originalInput } = originalRequest.input;
      assert.deepEqual(sent[0], originalInput, 'reconnect replays the original ID, CAS revision and exact body before the newer draft');
      assert.notEqual(sent[1].commandId, sent[0].commandId);
      assert.equal(remote.revision, 3, 'replaying a committed uncertain request cannot create an extra version');
    }
    assert.equal(await pendingJournal.pending(), null);
  }
  recovering.dispose();
}
console.log('Durable request journal passed: tab races, reconnect recovery, immutable bodies, receipts, stale completion, restart replay, CAS, persistence-before-send and initialization read recovery.');
