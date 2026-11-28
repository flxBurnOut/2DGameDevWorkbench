import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const root = process.cwd();
const vite = await createTestViteServer({ root, configFile: false, appType: 'custom', resolve: { alias: { '@': root, 'next/link': path.join(root, 'tests/helpers/next-link.tsx') } }, server: { middlewareMode: true }, logLevel: 'error' });
const originalFetch = globalThis.fetch;
try {
  const library = await vite.ssrLoadModule('/features/editor-documents/library.ts');
  const summaries = Array.from({ length: 238 }, (_, index) => ({ id: `project-${String(index).padStart(3, '0')}`, kind: 'interactable', revision: 1, name: `共享交互物 ${index}`, updatedAt: '2026-10-30T10:00:00Z', createdAt: '2026-10-29T10:00:00Z', viewPath: '/untrusted-unused-path' }));
  const offsets = [];
  globalThis.fetch = async (url, options) => {
    const query = new URL(url, 'http://fixture').searchParams;
    assert.equal(query.get('kind'), 'interactable'); assert.equal(query.get('limit'), '100');
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    const offset = Number(query.get('offset')); offsets.push(offset);
    return Response.json({ documents: summaries.slice(offset, offset + 100), total: summaries.length, nextOffset: offset + 100 < summaries.length ? offset + 100 : null });
  };
  const all = await library.readSharedDocumentLibrary('interactable', new AbortController().signal);
  assert.equal(all.documents.length, 238); assert.deepEqual(offsets, [0, 100, 200]);
  const lastPageMatch = library.sharedDocumentPage(all.documents, '共享交互物 237', 0);
  assert.equal(lastPageMatch.total, 1); assert.equal(lastPageMatch.documents[0].id, 'project-237');
  assert.equal(library.sharedDocumentPage(all.documents, '', 19).documents.length, 10);
  assert.equal(library.sharedDocumentPage(all.documents, 'project-237', 19).page, 0, 'search must clamp a stale later page');
  const duplicate = { ...summaries[0], revision: 3 };
  const deduplicated = await library.readSharedDocumentLibrary('interactable', new AbortController().signal, async (_kind, offset) => offset ? { documents: [duplicate], nextOffset: null } : { documents: [summaries[0]], nextOffset: 100 });
  assert.equal(deduplicated.documents.length, 1); assert.equal(deduplicated.documents[0].revision, 3);
  await assert.rejects(library.readSharedDocumentLibrary('interactable', new AbortController().signal, async () => ({ documents: [], nextOffset: 0 })), /分页/);
  globalThis.fetch = async () => Response.json({ error: 'Bridge unavailable' }, { status: 503 });
  await assert.rejects(library.readSharedDocumentLibrary('interactable', new AbortController().signal), /Bridge unavailable/);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(library.readSharedDocumentLibrary('interactable', controller.signal, async () => { calls++; controller.abort(); return { documents: [summaries[0]], nextOffset: 100 }; }), error => error.name === 'AbortError');
  assert.equal(calls, 1, 'closing a picker stops subsequent pages');
  assert.equal(library.sharedDocumentHref('/tools/project-composer', 'project-237'), '/tools/project-composer?document=project-237');
  assert.throws(() => library.sharedDocumentHref('https://outside.example', 'project-237'));

  console.log('Shared project discovery passed: all 238 server projects/search/pagination, duplicate and failure handling, cancellation and safe deep links.');
} finally { globalThis.fetch = originalFetch; await vite.close(); }
