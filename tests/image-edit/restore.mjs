import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createObject, createProject } from '../../features/interactable-editor/contract.mjs';
import { createDocument, getDocument, applyDocumentCommands, saveDocument } from '../../lib/workbench/editor-documents.mjs';
import { imageEditRequest } from '../../lib/workbench/image-edits.mjs';
import { loadManifest, readTask, repositoryRoot } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest();
for (const name of ['taskDirectory', 'documentDirectory', 'imageEditDirectory', 'outputDirectory']) assert.ok(manifest.workspace[name].split('/').includes(process.env.WORKBENCH_TEST_RUN));
const request = (operation, input = {}) => imageEditRequest(repositoryRoot, manifest, operation, input);
const hash = value => createHash('sha256').update(value).digest('hex');
const directory = path.resolve(repositoryRoot, manifest.workspace.imageEditDirectory);
const ledger = id => path.join(directory, 'commands', `${hash(id)}.json`);
const sessionPath = id => path.join(directory, 'sessions', `${hash(id)}.json`);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = (file, value) => writeFile(file, JSON.stringify(value));
const tasks = async () => (await readdir(path.resolve(repositoryRoot, manifest.workspace.taskDirectory)).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => name.endsWith('.json')).length;
const guard = target => ({ expectedRevision: target.revision, expectedSha256: target.sha256 });
let checks = 0, networkRequests = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const reject = async (promise, code) => { await assert.rejects(promise, error => error.code === code); checks++; };
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { networkRequests++; throw new Error('Paid/network operations are forbidden in local restore tests.'); };
const rgba = Buffer.alloc(16 * 16 * 4);
for (let i = 0; i < 256; i++) rgba.set([17, 29, 41, 0], i * 4);
for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) rgba.set([80, 100, 120, 255], (y * 16 + x) * 4);
rgba.set([71, 72, 73, 1], (4 * 16 + 3) * 4);
const png = await sharp(rgba, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
const data = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
async function documentFixture(name = 'restore-default') {
  const project = createProject(); project.name = name;
  const object = createObject('toggle'); object.definitionId = 'primary'; object.visual.assetId = 'base'; object.visual.width = 16; object.visual.height = 16;
  object.behavior.states.forEach(state => { state.appearance.assetId = 'base'; });
  const other = createObject('inspect'); other.definitionId = 'other'; other.visual.assetId = 'base';
  project.objects = [object, other]; project.assets = [{ id: 'base', name: 'original.png', mime: 'image/png', source: data(png) }];
  const { document } = await createDocument(repositoryRoot, manifest, { kind: 'interactable', documentId: project.projectId, commandId: 'create-' + name, content: project });
  return { document, target: { kind: 'interactable', documentId: document.id, definitionId: 'primary', slot: 'visual' } };
}
async function inspect(target) { return request('image-inspect', { ...(typeof target === 'string' ? { targetId: target } : { target }), view: 'source', includePixels: true, limit: 100 }); }
try {
  const { document, target } = await documentFixture();
  const original = await inspect(target);
  const namedInputs = [0, 1].map(index => ({ targetId: original.target.targetId, ...guard(original.target), region: { type: 'rectangle', x: 3 + index, y: 4, width: 8, height: 8 }, saveAs: 'Same display name', commandId: 'name-' + index }));
  const named = await Promise.all(namedInputs.map(input => request('image-resolve', input)));
  const beforeEdit = await request('image-session-create', { targetId: original.target.targetId, ...guard(original.target), commandId: 'create-session' });
  const editId = beforeEdit.edit.editId;
  let metadata = await request('image-inspect', { targetId: original.target.targetId, limit: 100 });
  check(metadata.namedRegions.length, 2); check(metadata.namedRegions.map(value => value.name), ['Same display name', 'Same display name']);
  assert.notEqual(metadata.namedRegions[0].regionId, metadata.namedRegions[1].regionId);
  check(metadata.sessions.find(value => value.editId === editId).canContinue, true);
  check(metadata.sessions.find(value => value.editId === editId).canRestoreSource, true);
  const page = await request('image-inspect', { targetId: original.target.targetId, limit: 1 });
  check(page.namedRegions.length, 1); check(page.relatedPagination.namedRegions.total, 2); check(page.relatedPagination.namedRegions.nextOffset, 1);
  const region = await request('image-resolve', { targetId: original.target.targetId, ...guard(original.target), region: { type: 'all' } });
  const edited = await request('image-edit', { targetId: original.target.targetId, ...guard(original.target), editId, expectedEditRevision: 1, baseCandidateVersion: 'source', regionRef: region.regionRef, operation: { type: 'replace-color', from: '#506478', to: '#cc6600' }, commandId: 'change-default' });
  check(edited.status, 'completed');
  const selected = await request('image-session-get', { editId, includePixels: true, candidateVersion: edited.candidateVersion });
  check(selected.edit.selectedVersion, edited.candidateVersion);
  assert.notEqual(selected.edit.pixels.rgbaSha256, original.rgbaSha256);
  check((await request('image-session-get', { editId, includePixels: true, candidateVersion: 'source' })).edit.pixels.rgbaSha256, hash(rgba));
  await reject(request('image-session-get', { editId, includePixels: true, candidateVersion: 'missing' }), 'IMAGE_CANDIDATE_NOT_FOUND');
  let applied = await request('image-apply', { editId, candidateVersion: edited.candidateVersion, ...guard(original.target), commandId: 'adopt-default' });
  check(applied.revision, 2);
  metadata = await request('image-inspect', { targetId: original.target.targetId, limit: 100 });
  check(metadata.namedRegions.every(value => value.stale), true); check(metadata.sessions.find(value => value.editId === editId).canContinue, false); check(metadata.sessions.find(value => value.editId === editId).canRestoreSource, true);
  check((await request('image-session-get', { editId, includePixels: true, candidateVersion: 'source' })).edit.pixels.rgbaSha256, hash(rgba), 'Session source stays original after adoption');

  await applyDocumentCommands(repositoryRoot, manifest, { documentId: document.id, expectedRevision: applied.revision, commandId: 'unrelated-edits', commands: [
    { type: 'set-visual', definitionId: 'primary', visual: { offset: { x: 11, y: -7 }, width: 40, height: 30 } },
    { type: 'set-content', definitionId: 'primary', content: { prompt: 'Keep this new behavior text' } },
    { type: 'set-behavior', definitionId: 'other', behavior: { repeat: false } },
  ] });
  let current = await inspect(original.target.targetId);
  assert.notEqual(current.target.slotFingerprint, applied.target.slotFingerprint);
  check(current.target.imageBindingFingerprint, applied.target.imageBindingFingerprint);
  const restoreInput = { editId, candidateVersion: 'source', ...guard(current.target), commandId: 'restore-default-original' };
  const beforeRestoreTasks = await tasks();
  const restored = await Promise.all([request('image-apply', restoreInput), request('image-apply', restoreInput)]);
  check(restored[0].sourceRestore.taskId, restored[1].sourceRestore.taskId); check(restored.map(value => value.replayed).sort((a, b) => Number(a) - Number(b)), [false, true]);
  check(await tasks(), beforeRestoreTasks + 1);
  check((await readTask(manifest, restored[0].sourceRestore.taskId)).input.operation, 'process-image');
  current = await inspect(original.target.targetId); check(Buffer.from(current.rgbaBase64, 'base64'), rgba);
  const kept = (await getDocument(repositoryRoot, manifest, { documentId: document.id })).document;
  check(kept.content.objects[0].visual.offset, { x: 11, y: -7 }); check(kept.content.objects[0].visual.width, 40); check(kept.content.objects[0].visual.height, 30);
  check(kept.content.objects[0].content.prompt, 'Keep this new behavior text'); check(kept.content.objects[1].behavior.repeat, false); check(kept.content.objects[1].visual.assetId, 'base');
  check(kept.content.objects[0].behavior.states, document.content.objects[0].behavior.states);
  const beforeHistory = await tasks();
  applied = await request('image-apply', { editId, candidateVersion: edited.candidateVersion, ...guard(current.target), commandId: 'reapply-historical-candidate' });
  check(await tasks(), beforeHistory); check((await inspect(original.target.targetId)).rgbaSha256, selected.edit.pixels.rgbaSha256);

  current = await inspect(original.target.targetId);
  const lossInput = { editId, candidateVersion: 'source', ...guard(current.target), commandId: 'restore-response-lost' };
  const committed = await request('image-apply', lossInput);
  const intent = await json(ledger(lossInput.commandId));
  check(intent.applyIntent.binding.slotFingerprint, current.target.slotFingerprint); check(intent.taskId, committed.sourceRestore.taskId);
  delete intent.result; await saveJson(ledger(lossInput.commandId), intent);
  const pendingSession = await json(sessionPath(editId)); pendingSession.adoptions = pendingSession.adoptions.filter(value => value.commandId !== lossInput.commandId); await saveJson(sessionPath(editId), pendingSession);
  await applyDocumentCommands(repositoryRoot, manifest, { documentId: document.id, expectedRevision: committed.revision, commandId: 'later-unrelated-edit', commands: [{ type: 'set-content', definitionId: 'other', content: { prompt: 'Later document version must survive replay' } }] });
  const beforeReplay = await tasks(), beforeReplayDoc = (await getDocument(repositoryRoot, manifest, { documentId: document.id })).document;
  const replay = await request('image-apply', lossInput);
  check(replay.replayed, true); check(replay.sourceRestore.taskId, committed.sourceRestore.taskId); check(replay.revision, committed.revision); check(replay.currentRevision, beforeReplayDoc.revision);
  check(await tasks(), beforeReplay); check((await getDocument(repositoryRoot, manifest, { documentId: document.id })).document.content, beforeReplayDoc.content);

  // Same image bytes with a new externally bound asset are not a known session binding.
  const beforeAlias = (await getDocument(repositoryRoot, manifest, { documentId: document.id })).document;
  await applyDocumentCommands(repositoryRoot, manifest, { documentId: document.id, expectedRevision: beforeAlias.revision, commandId: 'external-alias', commands: [
    { type: 'add-asset', asset: { id: 'external-same-pixels', name: 'external.png', mime: 'image/png', source: data(png) } },
    { type: 'bind-asset', definitionId: 'primary', assetId: 'external-same-pixels', target: 'visual' },
  ] });
  current = await inspect(original.target.targetId);
  check(current.target.sha256, original.target.sha256);
  const blockedTasks = await tasks();
  await reject(request('image-apply', { editId, candidateVersion: 'source', ...guard(current.target), commandId: 'reject-external-binding' }), 'IMAGE_TARGET_CONFLICT'); check(await tasks(), blockedTasks);
  check(current.sessions.find(value => value.editId === editId).canRestoreSource, false);
  check((await request('image-session-get', { editId, includePixels: true, candidateVersion: 'source' })).edit.pixels.rgbaSha256, hash(rgba));
  await reject(request('image-resolve', { targetId: current.target.targetId, ...guard(current.target), region: { type: 'named', regionId: named[0].regionId } }), 'IMAGE_REGION_STALE');

  const stateFixture = await documentFixture('state-restore-guard');
  const stateTarget = { ...stateFixture.target, slot: 'toggle-state', index: 0 };
  const stateSource = await inspect(stateTarget);
  const stateSession = await request('image-session-create', { targetId: stateSource.target.targetId, ...guard(stateSource.target), commandId: 'create-state-session' });
  const stateDoc = structuredClone(stateFixture.document.content); stateDoc.objects[0].behavior.states.reverse();
  await saveDocument(repositoryRoot, manifest, { documentId: stateFixture.document.id, expectedRevision: 1, commandId: 'reorder-state-slots', content: stateDoc });
  const reordered = await inspect(stateTarget);
  check(reordered.target.sha256, stateSource.target.sha256);
  await reject(request('image-apply', { editId: stateSession.edit.editId, candidateVersion: 'source', ...guard(reordered.target), commandId: 'reject-reordered-slot' }), 'IMAGE_TARGET_CONFLICT'); check(await tasks(), blockedTasks);

  check(networkRequests, 0);
  console.log(JSON.stringify({ restoreIntegration: 'passed', checks, tasks: await tasks(), networkRequests, namespace: process.env.WORKBENCH_TEST_RUN }, null, 2));
} finally { globalThis.fetch = originalFetch; }
