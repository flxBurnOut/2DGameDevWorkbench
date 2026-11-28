import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const server = await createTestViteServer({ root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'error', resolve: { alias: { '@': resolve(process.cwd()) } }, server: { middlewareMode: true } });
try {
  const { structureRestoreRequest } = await server.ssrLoadModule('/components/sprite-generator/motion-structure-history-model.ts');
  const { referenceIdentityDescription, referenceTransferInput, uploadedReferenceIdentity } = await server.ssrLoadModule('/components/sprite-generator/character-identity.ts');
  const current = { id: 'same-structure', revision: 4, source_current: true, document: { revision: 4, token: 'current-token-4' }, history: [1, 2, 3, 4].map(revision => ({ revision, note: 'saved' })) };
  const first = { ...current, document: { revision: 1, token: 'historical-token-1' } };
  const snapshot = structuredClone(current);
  const restore = structureRestoreRequest(current, first, 'stable-request');
  assert.equal(restore.restore_revision, 1, 'A version older than the preceding version can be selected directly');
  assert.equal(restore.expected_revision, 4);
  assert.equal(restore.token, 'current-token-4', 'Historical preview tokens never become a write baseline');
  assert.deepEqual(structureRestoreRequest(current, first, 'stable-request'), restore, 'An unconfirmed restore retains its original request identity');
  const restored = { ...current, revision: 5, document: { revision: 5, token: 'current-token-5' }, history: [...current.history, { revision: 5, note: 'restored v1' }] };
  const second = structureRestoreRequest(restored, { ...first, revision: 5, document: { revision: 2, token: 'historical-token-2' } }, 'next-request');
  assert.equal(second.restore_revision, 2, 'After a restore users can still choose an earlier version rather than toggling the last two');
  assert.equal(second.expected_revision, 5);
  assert.equal(second.token, 'current-token-5');
  assert.deepEqual(current, snapshot, 'Preview and request construction preserve the current editor state');
  for (const historical of [{ ...first, id: 'another-analysis' }, { ...first, revision: 6 }, { ...first, source_current: false }, { ...first, document: { revision: 99, token: 'wrong' } }]) assert.throws(() => structureRestoreRequest(current, historical, 'blocked'), /改变|历史版本/);
  assert.throws(() => structureRestoreRequest({ ...current, source_current: false }, first, 'blocked'), /源图片/);
  assert.throws(() => structureRestoreRequest(current, current, 'blocked'), /历史版本/);

  const transfer = (id, source, text, date, status = 'completed') => ({ id, capabilityId: 'reference-art', status, updatedAt: date, input: { operation: 'transfer', sourceTaskId: source, ...(text === undefined ? {} : { identityDescription: text }) } });
  const tasks = [transfer('a1', 'source-a', '蓝盔甲与长剑', '2026-10-01'), transfer('b', 'source-b', '红色斗篷', '2026-10-02'), transfer('a2', 'source-a', '蓝盔甲与金色长剑', '2026-10-03'), transfer('a-failed', 'source-a', '失败尝试不能恢复', '2026-10-04', 'failed')];
  assert.equal(referenceIdentityDescription(tasks, 'source-a', {}), '蓝盔甲与金色长剑');
  assert.equal(referenceIdentityDescription(tasks, 'source-b', {}), '红色斗篷', 'Choosing another source restores only that source’s identity');
  assert.equal(referenceIdentityDescription(tasks, 'new-source', {}), '', 'New sources do not inherit a previous character description');
  assert.equal(referenceIdentityDescription(tasks, 'source-a', { 'source-a': '', 'source-b': '未提交B草稿' }), '', 'An explicitly cleared optional field does not silently restore saved text');
  assert.deepEqual(referenceTransferInput('source-a', '  蓝盔甲  '), { operation: 'transfer', sourceTaskId: 'source-a', identityDescription: '蓝盔甲' });
  assert.deepEqual(referenceTransferInput('source-a', ''), { operation: 'transfer', sourceTaskId: 'source-a' }, 'Blank preserves the existing default transfer path');
  assert.equal(referenceTransferInput('source-a', '字'.repeat(300)).identityDescription.length, 300);
  assert.throws(() => referenceTransferInput('source-a', '字'.repeat(301)), /300/);
  assert.equal(uploadedReferenceIdentity('字'.repeat(1000)).length, 1000);
  assert.throws(() => uploadedReferenceIdentity('字'.repeat(1001)), /1000/);
  console.log('Authoring gaps: direct older-version restores, immutable current tokens, stable identities, source/conflict rejection, per-source character text and existing API limits passed.');
} finally { await server.close(); }
