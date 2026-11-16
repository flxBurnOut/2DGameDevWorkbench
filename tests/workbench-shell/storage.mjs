import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createTestViteServer } from '../helpers/vite-server.mjs';

// Every database below belongs to this in-memory factory, never the user's browser.
const factory = new IDBFactory();
const preferences = new Map();
globalThis.indexedDB = factory;
globalThis.window = {
  localStorage: {
    getItem: key => preferences.get(key) ?? null,
    setItem: (key, value) => preferences.set(key, String(value)),
  },
  dispatchEvent: () => true,
};
const options = { configFile: false, appType: 'custom', logLevel: 'error', resolve: { alias: { '@': process.cwd() } }, server: { middlewareMode: true, ws: false } };
const currentPage = await createTestViteServer(options);
const oldPage = await createTestViteServer(options);
const open = (name, upgrade) => new Promise((resolve, reject) => {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => upgrade?.(request.result);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const complete = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
});
const count = async (name, store) => {
  const db = await open(name);
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
};
const draft = key => ({ key, editId: 'edit-storage', owner: 'storage-test', baseVersion: 'source', baseHash: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), updatedAt: 1, patch: { type: 'pixel-patch', baseRgbaSha256: 'a'.repeat(64), spans: [{ startPixel: 0, beforeRgbaBase64: 'AAAAAA==', afterRgbaBase64: 'AQIDBA==' }] } });
function delayDatabaseOpen(databaseName) {
  let release, entered;
  const opened = new Promise(resolve => { entered = resolve; });
  let delayNext = true;
  globalThis.indexedDB = { open(name, ...args) {
    const request = factory.open(name, ...args);
    if (name !== databaseName || !delayNext) return request;
    delayNext = false;
    const deferred = { get result() { return request.result; }, get error() { return request.error; } };
    request.onupgradeneeded = event => deferred.onupgradeneeded?.(event);
    request.onerror = event => deferred.onerror?.(event);
    request.onsuccess = event => { release = () => deferred.onsuccess?.(event); entered(); };
    return deferred;
  } };
  return { opened, release: () => release() };
}

try {
  const storage = await currentPage.ssrLoadModule('/lib/workbench/browser-store.ts');
  const pixels = await currentPage.ssrLoadModule('/features/image-edit/client.ts');
  await storage.clearLocalProjects();
  assert.deepEqual(await factory.databases(), [], 'Clearing a fresh origin does not create databases with incomplete schemas');
  await pixels.saveImagePixelDraft(draft('first'), 'first');
  assert.equal((await pixels.listImagePixelDrafts('edit-storage')).length, 1, 'First save after clearing creates the real key path and editId index');
  const oldPixels = await oldPage.ssrLoadModule('/features/image-edit/client.ts');

  await storage.saveWorkspaceDraft('local-project', { name: 'local draft' }, []);
  for (const name of ['workbench-interactable-editor', 'unrelated-app']) {
    const db = await open(name, database => database.createObjectStore('drafts'));
    const transaction = db.transaction('drafts', 'readwrite');
    const done = complete(transaction);
    transaction.objectStore('drafts').put('keep-or-clear', 'draft');
    await done;
    db.close();
  }
  const before = await factory.databases();
  await storage.clearLocalProjects();
  assert.deepEqual(await factory.databases(), before, 'Clearing preserves database versions and schemas');
  for (const name of ['workbench-production-v1', 'workbench-interactable-editor', 'forge-image-edit-drafts'])
    assert.equal(await count(name, 'drafts'), 0, name);
  assert.equal(await count('unrelated-app', 'drafts'), 1, 'Other applications are outside the deletion scope');
  await assert.rejects(oldPixels.saveImagePixelDraft(draft('old-tab'), 'old-tab'), /历史已清空/);
  await assert.rejects(oldPixels.saveImagePixelDraft(null, 'first'), /历史已清空/, 'Old tabs cannot delete a new tab’s replacement draft either');
  await pixels.saveImagePixelDraft(draft('after-clear'), 'after-clear');

  // A write queued before the synchronous reset marker cannot run afterwards.
  const queued = pixels.saveImagePixelDraft(draft('queued'), 'queued');
  const queuedCheck = assert.rejects(queued, /历史已清空/);
  await storage.clearLocalProjects();
  await queuedCheck;
  assert.equal(await count('forge-image-edit-drafts', 'drafts'), 0);

  // Delay a real database open past completion of the clear, when this page's
  // current generation has advanced. The write must retain its original guard.
  const pixelOpen = delayDatabaseOpen('forge-image-edit-drafts');
  const delayed = pixels.saveImagePixelDraft(draft('delayed-open'), 'delayed-open');
  const delayedCheck = assert.rejects(delayed, /历史已清空/);
  const behind = pixels.saveImagePixelDraft(draft('behind-delayed-open'), 'delayed-open');
  const behindCheck = assert.rejects(behind, /历史已清空/);
  await pixelOpen.opened;
  await storage.clearLocalProjects();
  pixelOpen.release();
  await Promise.all([delayedCheck, behindCheck]);
  globalThis.indexedDB = factory;
  assert.equal(await count('forge-image-edit-drafts', 'drafts'), 0, 'Neither an open already in flight nor its queued successor can resurrect deleted strokes');

  for (const write of [
    () => storage.saveWorkspaceDraft('delayed-workspace', { name: 'old project' }, []),
    () => storage.updateWorkspaceDraft('delayed-workspace', () => ({ name: 'old request' })),
  ]) {
    const workspaceOpen = delayDatabaseOpen('workbench-production-v1');
    const pending = write();
    const rejected = assert.rejects(pending, /历史已清空/);
    await workspaceOpen.opened;
    await storage.clearLocalProjects();
    workspaceOpen.release();
    await rejected;
    globalThis.indexedDB = factory;
    assert.equal(await storage.readWorkspaceDraft('delayed-workspace'), undefined, 'Workspace saves and atomic updates retain their pre-clear generation across a delayed open');
  }

  // Existing per-session draft limits and cleanup order still apply.
  for (let index = 0; index < 12; index++) await pixels.saveImagePixelDraft(draft(`limit-${index}`), `limit-${index}`);
  await assert.rejects(pixels.saveImagePixelDraft(draft('overflow'), 'overflow'), /12 份/);
  await pixels.saveImagePixelDraft(draft('limit-0'), 'limit-0');
  await pixels.saveImagePixelDraft(null, 'limit-0');
  await pixels.saveImagePixelDraft(draft('replacement'), 'replacement');
  assert.equal((await pixels.listImagePixelDrafts('edit-storage')).length, 12);
  await storage.clearLocalProjects();
  assert.equal(await count('forge-image-edit-drafts', 'drafts'), 0);
  const concurrent = await Promise.allSettled(Array.from({ length: 13 }, (_, index) => pixels.saveImagePixelDraft(draft(`parallel-${index}`), `parallel-${index}`)));
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 12);
  const failures = concurrent.filter(result => result.status === 'rejected');
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason.message, /12 份/);
  assert.equal((await pixels.listImagePixelDrafts('edit-storage')).length, 12, 'Concurrent writes across different keys still enforce the database-wide cap');
  await storage.clearLocalProjects();
  console.log('Browser draft cleanup passed: all three databases, fresh schemas, unrelated data, stale tabs, queued and delayed writes, draft limits and recovery reads; in-memory IndexedDB only.');
} finally {
  await Promise.all([currentPage.close(), oldPage.close()]);
  delete globalThis.indexedDB;
  delete globalThis.window;
}
