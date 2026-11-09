import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { splitFixture } from '../scene-composer/map-split-fixture.mjs';
import { createScenePackage, readScenePackage } from '../../features/scene-composer/package.mjs';
import { createDocument, saveDocument } from '../../lib/workbench/editor-documents.mjs';
import { exportSceneDocument, exportSceneRequest } from '../../lib/workbench/scene-export.mjs';
import { loadManifest, repositoryRoot as root } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest(), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scene = await splitFixture(); scene.id = 'scene-export-identity';
const { document } = await createDocument(root, manifest, { kind: 'scene', content: scene, commandId: 'create' });
await saveDocument(root, manifest, { documentId: scene.id, expectedRevision: 1, commandId: 'later', content: { ...document.content, name: 'Later version' } });
const request = (body, type) => Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': type } });
const input = { documentId: document.id, revision: document.revision };
const web = await exportSceneRequest(request(JSON.stringify(input), 'application/json'), root, manifest);
const agent = await exportSceneDocument(root, manifest, input);
assert.deepEqual(web.source, agent.source, 'both entry points report the same immutable document identity');
assert.equal(web.source.documentRevision, 1);
assert.equal(web.source.documentContentHash, document.contentHash);
assert.equal(web.source.kind, 'shared-document');

async function checkArchive(record) {
  const sourceBytes = await readFile(path.join(root, record.outputs.find(file => file.endsWith('/scene-source.zip'))));
  const source = await readScenePackage(sourceBytes);
  assert.equal(sha(JSON.stringify(source)), record.source.snapshotHash);
  assert.equal(sha(sourceBytes), record.sourcePackageSha256);
  const sourceZip = await JSZip.loadAsync(sourceBytes);
  assert.deepEqual(JSON.parse(await sourceZip.file('scene-provenance.json').async('string')), record.source);
  const godotZip = await JSZip.loadAsync(await readFile(path.join(root, record.outputs.find(file => file.endsWith('/scene-godot.zip')))));
  const engineManifest = JSON.parse(await godotZip.file(`scenes/${source.id}/scene-manifest.json`).async('string'));
  assert.deepEqual(engineManifest.source, { ...record.source, sourcePackageSha256: record.sourcePackageSha256 });
  assert.deepEqual(await godotZip.file(`scenes/${source.id}/scene-source.zip`).async('nodebuffer'), sourceBytes);
  return source;
}
assert.equal((await checkArchive(web)).name, document.content.name);
await checkArchive(agent);
const draft = { ...scene, revision: 900, name: 'Unsaved draft' };
const local = await exportSceneRequest(request(await createScenePackage(draft), 'application/zip'), root, manifest);
assert.equal(local.source.kind, 'local-snapshot');
assert.equal(local.source.localRevision, 900);
assert.equal(local.source.documentRevision, undefined);
assert.equal((await checkArchive(local)).name, 'Unsaved draft');
await assert.rejects(() => exportSceneRequest(request(JSON.stringify({ ...input, documentContentHash: 'f'.repeat(64) }), 'application/json'), root, manifest));
console.log('Scene export identity passed: web/Agent parity, immutable saved versions, explicit drafts and matching source/Godot provenance hashes.');
