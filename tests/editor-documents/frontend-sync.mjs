import assert from 'node:assert/strict';
import { DocumentSyncController } from '../../features/editor-documents/sync-controller.mjs';

const clone = value => structuredClone(value);
function fixture(initial = { id: 'project_sync', name: 'local', version: 0 }) {
  let current = initial, remote = null, cache, revision = 0, busy = false, failAfterCommit = false, failBeforeCommit = false, readGate, localSaveGate, metadataGate;
  const calls = [], backups = [], localSaves = [], commands = new Map();
  const missing = () => { throw Object.assign(new Error('missing'), { status: 404 }); };
  const response = () => ({ document: { id: current.id, kind: 'interactable', revision, contentHash: `hash-${revision}`, content: clone(remote) } });
  const api = {
    read: async () => { if (readGate) await readGate; return remote ? response() : missing(); },
    metadata: async () => { if (metadataGate) await metadataGate; return remote ? response() : missing(); },
    create: async (_kind, content, commandId) => mutate(0, content, commandId),
    save: async (_id, expected, content, commandId) => mutate(expected, content, commandId),
  };
  const mutate = async (expected, content, commandId) => {
    calls.push({ expected, content: clone(content), commandId });
    if (commands.has(commandId)) return clone(commands.get(commandId));
    if (failBeforeCommit) throw new Error('network before commit');
    if (expected !== revision) throw Object.assign(new Error('conflict'), { status: 409 });
    remote = clone(content); revision++;
    const result = response(); commands.set(commandId, clone(result));
    if (failAfterCommit) { failAfterCommit = false; throw new Error('response lost'); }
    return result;
  };
  const make = () => new DocumentSyncController({
    id: current.id, kind: 'interactable', current: () => current, busy: () => busy,
    prepare: clone, saveLocal: async value => { localSaves.push(clone(value)); if (localSaveGate) await localSaveGate; },
    applyRemote: async value => { current = clone(value); },
    backupLocal: async value => { backups.push(clone(value)); return 'local backup'; },
    readCache: async () => cache, writeCache: async value => { cache = clone(value); }, api,
  });
  return {
    make, calls, backups, localSaves, current: () => current, remote: () => remote, cache: () => cache,
    edit: value => { current = { ...current, ...value }; },
    external: value => { remote = { ...remote, ...value }; revision++; },
    busy: value => { busy = value; }, failAfter: () => { failAfterCommit = true; }, failBefore: value => { failBeforeCommit = value; },
    gate: value => { readGate = value; },
    saveGate: value => { localSaveGate = value; },
    metadataGate: value => { metadataGate = value; },
    read: () => api.read(),
  };
}

const test = fixture(), sync = test.make();
const concurrent = fixture(), afterConflict = concurrent.make();
await afterConflict.sync();
concurrent.edit({ name: 'local', version: 1 });
concurrent.external({ name: 'remote' });
await afterConflict.sync();
assert.equal(afterConflict.getState().status, 'conflict');
await afterConflict.retry();
assert.equal(afterConflict.getState().revision, 2, 'Reconnect reads the new head and preserves both drafts');
assert.equal(concurrent.current().version, 1);
assert.equal(concurrent.remote().name, 'remote');
concurrent.external(concurrent.current());
await afterConflict.retry();
assert.equal(afterConflict.getState().status, 'synced', 'Converged drafts can resume without overwriting the remote');
await sync.sync();
assert.equal(sync.getState().status, 'synced');
assert.equal(test.calls.length, 1);
assert.equal(sync.getState().revision, 1);
test.edit({ name: 'human edit' });
await sync.sync();
assert.equal(test.remote().name, 'human edit');
assert.equal(test.calls[1].expected, 1);
test.external({ name: 'agent edit' });
await sync.poll();
assert.equal(test.current().name, 'agent edit', 'clean drafts follow a shared revision');
test.edit({ name: 'unsaved human' });
test.external({ name: 'other agent' });
await sync.poll();
assert.equal(sync.getState().conflict, true);
assert.equal(test.current().name, 'unsaved human', 'remote edits cannot replace a changed local draft');
await sync.reloadRemote();
assert.equal(test.backups[0].name, 'unsaved human');
assert.equal(test.current().name, 'other agent');
assert.equal(sync.getState().conflict, false);

test.edit({ name: 'uncertain' }); test.failAfter();
await sync.sync();
assert.equal(sync.getState().status, 'offline');
const lost = test.calls.at(-1);
await sync.retry();
assert.equal(test.calls.at(-1).commandId, lost.commandId, 'an uncertain response reuses its immutable command identity');
assert.deepEqual(test.calls.at(-1).content, lost.content);
assert.equal(sync.getState().status, 'synced');

test.edit({ name: 'persisted uncertain' }); test.failBefore(true);
await sync.sync();
const interrupted = test.calls.at(-1);
sync.dispose();
test.failBefore(false);
const resumed = test.make();
await resumed.sync();
assert.equal(test.calls.at(-1).commandId, interrupted.commandId, 'page reload reuses a pending command ID');
assert.equal(test.remote().name, 'persisted uncertain');

let release;
const gate = new Promise(resolve => { release = resolve; });
test.external({ name: 'read slowly' }); test.gate(gate);
const polling = resumed.poll();
await new Promise(resolve => setTimeout(resolve, 5));
test.edit({ name: 'human typed during read' }); release();
await polling;
assert.equal(test.current().name, 'human typed during read');
assert.equal(resumed.getState().conflict, true, 'late remote read cannot replace a newer local object');
test.gate(null);
await resumed.reloadRemote();
assert.equal(test.backups.at(-1).name, 'human typed during read');

test.busy(true); test.edit({ name: 'busy' });
const count = test.calls.length;
await resumed.sync(); assert.equal(test.calls.length, count);
test.busy(false); await resumed.sync(); assert.equal(test.remote().name, 'busy');

test.edit({ name: 'CAS local' }); test.external({ name: 'CAS remote' });
await resumed.sync();
assert.equal(resumed.getState().conflict, true);
assert.equal(test.current().name, 'CAS local');
assert.equal(test.remote().name, 'CAS remote');
resumed.dispose();

const serial = fixture(), serialSync = serial.make();
await serialSync.sync();
serial.external({ name: 'slow remote update' });
let releaseSerial;
serial.gate(new Promise(resolve => { releaseSerial = resolve; }));
const serialPoll = serialSync.poll();
await new Promise(resolve => setTimeout(resolve, 5));
serial.edit({ name: 'human during poll' });
await serialSync.sync();
assert.equal(serial.calls.length, 1, 'a pending reconciliation serializes autosave instead of issuing a stale CAS request');
releaseSerial(); await serialPoll;
assert.equal(serial.current().name, 'human during poll');
assert.equal(serial.remote().name, 'slow remote update');
assert.equal(serialSync.getState().conflict, true);
serialSync.dispose();

const deferred = fixture(), deferredSync = deferred.make();
await deferredSync.sync();
let releaseMetadata;
deferred.metadataGate(new Promise(resolve => { releaseMetadata = resolve; }));
const metadataPoll = deferredSync.poll();
await new Promise(resolve => setTimeout(resolve, 5));
deferred.edit({ name: 'edit during unchanged metadata poll' });
await deferredSync.sync();
assert.equal(deferred.calls.length, 1);
releaseMetadata(); await metadataPoll;
assert.equal(deferred.remote().name, 'edit during unchanged metadata poll', 'a poll without remote changes must resume a deferred local autosave');
deferredSync.dispose();

const busyPolling = fixture(), busyPollingSync = busyPolling.make();
await busyPollingSync.sync();
busyPolling.external({ name: 'deferred remote' });
busyPolling.busy(true); await busyPollingSync.poll();
assert.equal(busyPollingSync.getState().conflict, false, 'a busy clean editor must defer polling instead of creating a conflict');
assert.equal(busyPolling.current().name, 'local');
busyPolling.busy(false); await busyPollingSync.poll();
assert.equal(busyPolling.current().name, 'deferred remote');
let releaseBusy;
busyPolling.external({ name: 'remote read while busy starts' });
busyPolling.gate(new Promise(resolve => { releaseBusy = resolve; }));
const busyPoll = busyPollingSync.poll();
await new Promise(resolve => setTimeout(resolve, 5));
busyPolling.busy(true); releaseBusy(); await busyPoll;
assert.equal(busyPollingSync.getState().conflict, false, 'busy state is checked again after a delayed read');
assert.equal(busyPolling.current().name, 'deferred remote');
busyPolling.gate(null); busyPolling.busy(false); await busyPollingSync.poll();
assert.equal(busyPolling.current().name, 'remote read while busy starts');
busyPollingSync.dispose();

const departing = fixture(), departingSync = departing.make();
await departingSync.sync();
departing.edit({ name: 'departure draft' });
let releaseSave;
departing.saveGate(new Promise(resolve => { releaseSave = resolve; }));
const departingSave = departingSync.sync();
await new Promise(resolve => setTimeout(resolve, 5));
departingSync.dispose(); releaseSave(); await departingSave;
assert.equal(departing.calls.length, 1, 'disposing during local persistence cannot submit a stale background mutation');
assert.equal(departing.remote().name, 'local');
assert.equal(departing.localSaves.at(-1).name, 'departure draft');
const flushing = fixture(), flushingSync = flushing.make();
await flushingSync.sync();
flushing.edit({ name: 'first saving draft' });
let releaseFlush;
flushing.saveGate(new Promise(resolve => { releaseFlush = resolve; }));
const priorSave = flushingSync.sync();
await new Promise(resolve => setTimeout(resolve, 5));
let flushed = false;
const flush = flushingSync.flushSaved().then(value => { flushed = true; return value; });
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(flushed, false, 'flush waits for an already running save');
flushing.edit({ name: 'latest draft during save' });
releaseFlush(); await priorSave;
const firstGuard = await flush;
assert.equal(firstGuard.document.content.name, 'latest draft during save', 'flush drains edits made during the preceding save');
assert.equal(firstGuard.document.revision, 3);
assert.equal(firstGuard.document.contentHash, 'hash-3', 'flush returns the exact durable server version and hash');

flushing.external({ asset: 'adopted-one' });
const firstAdopted = (await flushing.read()).document;
flushing.busy(true);
const secondGuard = await flushingSync.acceptAdopted(firstAdopted, firstGuard);
assert.deepEqual(await flushingSync.acceptAdopted(firstAdopted, secondGuard), secondGuard, 'a lost workspace refresh can replay the already coordinated adoption');
flushing.busy(false);
const afterAdoptWrites = flushing.calls.length;
await flushingSync.sync();
assert.equal(flushing.calls.length, afterAdoptWrites, 'accepting a server adoption coordinates the baseline without autosaving the old image');
assert.equal(flushing.current().asset, 'adopted-one');
flushing.external({ asset: 'adopted-two' });
await flushingSync.acceptAdopted((await flushing.read()).document, secondGuard);
await flushingSync.sync();
assert.equal(flushing.calls.length, afterAdoptWrites, 'the updated guard supports another adoption without remounting the host');
assert.equal(flushing.current().asset, 'adopted-two');

const dirtyGuard = await flushingSync.flushSaved();
flushing.edit({ name: 'local edit must survive' });
flushing.external({ asset: 'adopted-but-not-loaded' });
await assert.rejects(flushingSync.acceptAdopted((await flushing.read()).document, dirtyGuard), /本机工程/);
assert.equal(flushing.current().name, 'local edit must survive');
assert.equal(flushing.current().asset, 'adopted-two');
await flushingSync.sync();
assert.equal(flushing.remote().asset, 'adopted-but-not-loaded', 'a failed adoption reconciliation blocks stale local autosave');
assert.equal(flushingSync.getState().conflict, true);
await assert.rejects(flushingSync.flushSaved(), /本机工程/);
flushingSync.dispose();

const newerHead = fixture(), newerHeadSync = newerHead.make();
const headGuard = await newerHeadSync.flushSaved();
newerHead.external({ asset: 'adopted' });
const historicalAdoption = (await newerHead.read()).document;
newerHead.external({ name: 'newer remote content' });
await assert.rejects(newerHeadSync.acceptAdopted(historicalAdoption, headGuard), /已有更新/);
assert.equal(newerHead.current().name, 'local', 'an adoption read cannot install a stale historical head');
assert.equal(newerHeadSync.getState().conflict, true);
newerHeadSync.dispose();
console.log('Shared document frontend: persistence, CAS, polling and retry guards; flush waits and drains changing drafts with exact server hashes; repeated adoption coordinates the baseline; dirty drafts and newer heads block stale autosave.');
