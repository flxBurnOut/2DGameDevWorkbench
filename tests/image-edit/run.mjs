import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import { createProject, createObject } from '../../features/interactable-editor/contract.mjs';
import { createDocument, getDocument, applyDocumentCommands } from '../../lib/workbench/editor-documents.mjs';
import { imageEditRequest } from '../../lib/workbench/image-edits.mjs';
import { loadManifest, persistTask, readTask, repositoryRoot } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest();
for (const key of ['taskDirectory', 'documentDirectory', 'imageEditDirectory', 'outputDirectory']) assert.ok(manifest.workspace[key].includes('/test-runs/') && manifest.workspace[key].split('/').includes(process.env.WORKBENCH_TEST_RUN), `Unsafe test namespace: ${key}`);
const request = (operation, input = {}) => imageEditRequest(repositoryRoot, manifest, operation, input);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const width = 64, height = 32;
const taskDirectory = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
const taskCount = async () => (await readdir(taskDirectory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => name.endsWith('.json')).length;
const guards = target => ({ targetId: target.targetId, expectedRevision: target.revision, expectedSha256: target.sha256 });
const editDirectory = path.resolve(repositoryRoot, manifest.workspace.imageEditDirectory);
const ledgerFile = commandId => path.join(editDirectory, 'commands', `${sha(commandId)}.json`);
const sessionFile = editId => path.join(editDirectory, 'sessions', `${sha(editId)}.json`);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value));
const decode = async encoded => sharp(Buffer.from(encoded, 'base64')).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const pixel = (bytes, x, y) => [...bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const previousFetch = globalThis.fetch;
const previousKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;
let networkRequests = 0, checks = 0;
globalThis.fetch = () => { networkRequests++; throw new Error('The local integration suite blocks all provider/network requests.'); };
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const reject = async (promise, code) => { await assert.rejects(promise, error => !code || (Array.isArray(code) ? code.includes(error.code) : error.code === code)); checks++; };

async function fixture(name, opaque = false) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) rgba.set([31, 41, 51, opaque ? 255 : 0], index * 4);
  for (let y = 8; y < 16; y++) for (let x = 12; x < 20; x++) rgba.set([100, 80, 60, 255], (y * width + x) * 4);
  if (!opaque) { rgba.set([100, 80, 60, 1], (8 * width + 11) * 4); rgba.set([180, 10, 20, 1], (20 * width + 40) * 4); }
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png({ palette: false }).toBuffer();
  const other = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff8800' } }).png().toBuffer();
  const project = createProject(); project.name = name;
  project.assets = [
    { id: 'original-art', name: 'original.png', mime: 'image/png', source: `data:image/png;base64,${png.toString('base64')}` },
    { id: 'untouched-art', name: 'other.png', mime: 'image/png', source: `data:image/png;base64,${other.toString('base64')}` },
  ];
  const object = createObject('toggle'); object.definitionId = 'editable-prop'; object.displayName = 'Editable prop';
  object.visual.assetId = 'original-art'; object.visual.width = width; object.visual.height = height;
  object.behavior.states[1].appearance.assetId = 'untouched-art';
  const untouched = createObject('inspect'); untouched.definitionId = 'untouched-object'; untouched.visual.assetId = 'original-art';
  project.objects = [object, untouched];
  const { document } = await createDocument(repositoryRoot, manifest, { kind: 'interactable', documentId: project.projectId, commandId: 'create-' + name, content: project });
  const target = { kind: 'interactable', documentId: document.id, definitionId: object.definitionId, slot: 'visual' };
  const inspected = await request('image-inspect', { target, view: 'source', includePixels: true });
  check(Buffer.from(inspected.rgbaBase64, 'base64'), rgba, 'Inspect must preserve straight RGBA, including alpha0 RGB');
  check(inspected.rgbaSha256, sha(rgba));
  check(inspected.target.sha256, sha(png));
  return { document, rgba, png, target: inspected.target };
}
async function candidate(result) {
  check(result.status, 'completed', `Candidate ${result.taskId} must complete locally`);
  assert.ok(result.taskId); assert.ok(result.edit.editId);
  const task = await readTask(manifest, result.taskId);
  check(task.input.operation, 'process-image'); check(task.status, 'completed');
  check(task.adapter.provider, 'local');
  const view = await request('image-inspect', { targetId: result.edit.target.targetId, view: 'candidate', editId: result.edit.editId, candidateVersion: result.candidateVersion, includePixels: true });
  const pixels = Buffer.from(view.rgbaBase64, 'base64');
  check(await decode(view.imageBase64), pixels);
  check(view.rgbaSha256, sha(pixels));
  const diff = await request('image-inspect', { targetId: result.edit.target.targetId, view: 'diff', editId: result.edit.editId, candidateVersion: result.candidateVersion });
  check(diff.diff.changedOutsideRegion, 0);
  return { task, view, pixels, diff: diff.diff };
}
function protectedPixels(base, actual, mask) {
  check(actual.length, base.length);
  for (let index = 0; index < mask.length; index++) if (!mask[index]) assert.ok(base.subarray(index * 4, index * 4 + 4).equals(actual.subarray(index * 4, index * 4 + 4)), `Protected pixel ${index} changed`);
  checks++;
}
async function child(operation, input) {
  const source = 'globalThis.fetch=()=>{throw new Error("network forbidden")}; const {loadManifest,repositoryRoot}=await import("./lib/workbench/runtime.mjs"); const {imageEditRequest}=await import("./lib/workbench/image-edits.mjs"); const value=await imageEditRequest(repositoryRoot,await loadManifest(),process.argv[1],JSON.parse(process.argv[2]));console.log(JSON.stringify(value));';
  return new Promise((resolve, fail) => {
    const processChild = spawn(process.execPath, ['--input-type=module', '-e', source, operation, JSON.stringify(input)], { cwd: repositoryRoot, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    processChild.stdout.on('data', bytes => { output += bytes; }); processChild.stderr.on('data', bytes => { errors += bytes; });
    processChild.on('error', fail);
    processChild.on('close', code => { if (code !== 0) fail(new Error(errors)); else { try { resolve(JSON.parse(output)); } catch (error) { fail(error); } } });
  });
}

try {
  const initial = await fixture('local-prop');
  const listed = await request('image-inspect', { scope: { kind: 'interactable', documentId: initial.document.id }, limit: 1 });
  check(listed.targets.length, 1); assert.ok(listed.total >= 4); assert.ok(listed.nextOffset);
  const resolvedInput = { ...guards(initial.target), region: { type: 'rectangle', x: 8, y: 6, width: 16, height: 14 }, saveAs: 'Gem region', commandId: 'name-gem' };
  const named = await request('image-resolve', resolvedInput);
  check(named.count, 224); check(named.bounds, { x: 8, y: 6, width: 16, height: 14 });
  check((await request('image-resolve', resolvedInput)).replayed, true);
  check((await request('image-resolve', { ...guards(initial.target), region: { type: 'named', regionId: named.regionId } })).regionRef, named.regionRef);
  const mask = await readFile(path.resolve(repositoryRoot, named.mask.file));
  check(mask.reduce((sum, value) => sum + value, 0), 224);

  const cleanInput = { ...guards(initial.target), regionRef: named.regionRef, operation: { type: 'clean-alpha', threshold: 1 }, commandId: 'clean-concurrent' };
  const beforeTasks = await taskCount();
  const [clean, cleanReplay] = await Promise.all([request('image-edit', cleanInput), request('image-edit', cleanInput)]);
  check(clean.taskId, cleanReplay.taskId); check([clean.replayed, cleanReplay.replayed].sort((a, b) => Number(a) - Number(b)), [false, true]); check(await taskCount(), beforeTasks + 1);
  const cleaned = await candidate(clean);
  check(cleaned.diff.changedPixelCount, 1); check(pixel(cleaned.pixels, 11, 8), [0, 0, 0, 0]); check(pixel(cleaned.pixels, 40, 20), [180, 10, 20, 1]);
  protectedPixels(initial.rgba, cleaned.pixels, mask);
  check((await getDocument(repositoryRoot, manifest, { documentId: initial.document.id })).document.revision, 1, 'Candidates must not adopt automatically');
  const editId = clean.edit.editId;
  const failCount = await taskCount();
  await reject(request('image-edit', { ...cleanInput, commandId: 'existing-no-cas', editId }), 'IMAGE_EDIT_CONFLICT');
  await reject(request('image-edit', { ...cleanInput, commandId: 'existing-no-base', editId, expectedEditRevision: clean.edit.revision }), 'IMAGE_EDIT_CONFLICT');
  await reject(request('image-edit', { ...cleanInput, commandId: 'existing-stale-cas', editId, expectedEditRevision: 1, baseCandidateVersion: 'source' }), 'IMAGE_EDIT_CONFLICT');
  check(await taskCount(), failCount);
  await reject(request('image-edit', { ...cleanInput, operation: { type: 'erase' } }), 'COMMAND_ID_REUSED');

  const replaceInput = { ...guards(initial.target), editId, expectedEditRevision: clean.edit.revision, baseCandidateVersion: clean.candidateVersion, regionRef: named.regionRef, operation: { type: 'replace-color', from: '#64503c', to: '#1f9fca' }, constraints: { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: true }, commandId: 'replace-colour' };
  const replaced = await request('image-edit', replaceInput), recoloured = await candidate(replaced);
  check(recoloured.diff.changedPixelCount, 64); check(recoloured.diff.alphaChangedPixelCount, 0); check(pixel(recoloured.pixels, 12, 8), [31, 159, 202, 255]);
  protectedPixels(cleaned.pixels, recoloured.pixels, mask);
  const fill = await request('image-edit', { ...guards(initial.target), regionRef: named.regionRef, operation: { type: 'fill', x: 12, y: 8, rgba: [90, 100, 110, 128] }, commandId: 'fill-local' });
  const filled = await candidate(fill); check(filled.diff.changedPixelCount, 64); check(pixel(filled.pixels, 12, 8), [90, 100, 110, 128]); protectedPixels(initial.rgba, filled.pixels, mask);
  const erased = await candidate(await request('image-edit', { ...guards(initial.target), regionRef: named.regionRef, operation: { type: 'erase' }, commandId: 'erase-local' }));
  check(pixel(erased.pixels, 12, 8), [0, 0, 0, 0]); protectedPixels(initial.rgba, erased.pixels, mask);
  const moved = await candidate(await request('image-edit', { ...guards(initial.target), regionRef: named.regionRef, operation: { type: 'translate', dx: 3, dy: 1 }, commandId: 'translate-local' }));
  const moveMask = Buffer.from(mask);
  for (let y = 7; y < 21; y++) moveMask.fill(1, y * width + 11, y * width + 27);
  protectedPixels(initial.rgba, moved.pixels, moveMask); check(pixel(moved.pixels, 15, 9), pixel(initial.rgba, 12, 8));

  const restore = await request('image-edit', { ...guards(initial.target), editId, expectedEditRevision: replaced.edit.revision, baseCandidateVersion: replaced.candidateVersion, regionRef: named.regionRef, operation: { type: 'restore-region', candidateVersion: 'source' }, commandId: 'restore-source-region' });
  check((await candidate(restore)).pixels, initial.rgba);
  const patchOffset = (6 * width + 8) * 4;
  const patchInput = { ...guards(initial.target), editId, expectedEditRevision: restore.edit.revision, baseCandidateVersion: restore.candidateVersion, regionRef: named.regionRef, operation: { type: 'pixel-patch', baseRgbaSha256: sha(initial.rgba), spans: [{ startPixel: patchOffset / 4, beforeRgbaBase64: initial.rgba.subarray(patchOffset, patchOffset + 4).toString('base64'), afterRgbaBase64: Buffer.from([210, 220, 230, 0]).toString('base64') }] }, constraints: { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: true }, commandId: 'manual-hidden-rgb' };
  const patch = await request('image-edit', patchInput), patched = await candidate(patch);
  check(patched.diff.changedPixelCount, 1); check(pixel(patched.pixels, 8, 6), [210, 220, 230, 0]); protectedPixels(initial.rgba, patched.pixels, mask);
  const noSubmit = await taskCount();
  await reject(request('image-edit', { ...patchInput, commandId: 'wrong-rgba-base', expectedEditRevision: patch.edit.revision, operation: { ...patchInput.operation, baseRgbaSha256: '0'.repeat(64) } }), 'IMAGE_PIXEL_CONFLICT');
  await reject(request('image-edit', { ...guards(initial.target), regionRef: named.regionRef, operation: { type: 'clean-alpha', threshold: 1 }, constraints: { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: true }, commandId: 'invalid-preserve-alpha' }), 'IMAGE_CONSTRAINT_FAILED');
  check(await taskCount(), noSubmit);

  const applied = await request('image-apply', { editId, candidateVersion: replaced.candidateVersion, expectedRevision: initial.target.revision, expectedSha256: initial.target.sha256, commandId: 'apply-recolour' });
  check(applied.revision, 2); check(applied.adoption.sourceTaskId, replaced.taskId);
  check((await request('image-apply', { editId, candidateVersion: replaced.candidateVersion, expectedRevision: initial.target.revision, expectedSha256: initial.target.sha256, commandId: 'apply-recolour' })).replayed, true);
  const saved = (await getDocument(repositoryRoot, manifest, { documentId: initial.document.id })).document;
  check(saved.content.assets.find(asset => asset.id === 'untouched-art'), initial.document.content.assets.find(asset => asset.id === 'untouched-art'));
  check(saved.content.assets.find(asset => asset.id === 'original-art'), initial.document.content.assets.find(asset => asset.id === 'original-art'));
  check(saved.content.objects[0].behavior, initial.document.content.objects[0].behavior); check(saved.content.objects[0].solid, initial.document.content.objects[0].solid);
  check(saved.content.objects[1], initial.document.content.objects[1]); check(saved.content.objects[0].behavior.states[1].appearance.assetId, 'untouched-art');
  const selectedAsset = saved.content.assets.find(asset => asset.id === saved.content.objects[0].visual.assetId);
  check(await decode(selectedAsset.source.split(',')[1]), recoloured.pixels);
  check(selectedAsset.generation, { sourceTaskId: replaced.taskId, sha256: recoloured.view.sha256 });
  await reject(request('image-apply', { editId, candidateVersion: patch.candidateVersion, expectedRevision: 1, expectedSha256: initial.target.sha256, commandId: 'stale-apply' }), ['REVISION_CONFLICT', 'IMAGE_TARGET_CONFLICT']);
  const current = await request('image-inspect', { targetId: initial.target.targetId });
  await reject(request('image-resolve', { ...guards(current.target), region: { type: 'named', regionId: named.regionId } }), 'IMAGE_REGION_STALE');
  await reject(request('image-edit', { ...cleanInput, commandId: 'stale-edit' }), 'IMAGE_SOURCE_CONFLICT');
  await reject(request('image-apply', { editId, candidateVersion: patch.candidateVersion, expectedRevision: 1, expectedSha256: initial.target.sha256, commandId: 'apply-recolour' }), 'COMMAND_ID_REUSED');

  const restartCount = await taskCount();
  const recovered = await child('image-session-get', { editId, includePixels: true });
  check(recovered.edit.candidates.find(item => item.version === replaced.candidateVersion).taskId, replaced.taskId);
  const restartedReplay = await child('image-edit', cleanInput); check(restartedReplay.taskId, clean.taskId); check(restartedReplay.replayed, true);
  check(await taskCount(), restartCount);

  // One canonical Bridge owns writes, matching document/map storage. Concurrent
  // transport requests are tested through that Bridge; restart checks above
  // only inspect or replay already committed commands, never start two writers.

  const allRegion = await request('image-resolve', { ...guards(current.target), region: { type: 'all' } });
  const cleared = await candidate(await request('image-edit', { ...guards(current.target), regionRef: allRegion.regionRef, operation: { type: 'erase' }, commandId: 'erase-entire-prop' }));
  check(cleared.pixels, Buffer.alloc(width * height * 4), 'Explicit local erase can produce a fully transparent PNG');
  const opaque = await fixture('opaque-prop', true);
  check(opaque.target.hasTransparency, false);
  const opaqueRegion = await request('image-resolve', { ...guards(opaque.target), region: { type: 'all' } });
  const opaqueEdit = await candidate(await request('image-edit', { ...guards(opaque.target), regionRef: opaqueRegion.regionRef, operation: { type: 'replace-color', from: '#64503c', to: '#aabbcc' }, commandId: 'opaque-recolour' }));
  check(pixel(opaqueEdit.pixels, 12, 8), [170, 187, 204, 255]); check(opaqueEdit.diff.alphaChangedPixelCount, 0);
  const unchanged = (await getDocument(repositoryRoot, manifest, { documentId: opaque.document.id })).document;
  await applyDocumentCommands(repositoryRoot, manifest, { documentId: opaque.document.id, expectedRevision: unchanged.revision, commandId: 'unrelated-behavior', commands: [{ type: 'set-content', definitionId: 'editable-prop', content: { prompt: 'A concurrent legitimate behavior edit' } }] });
  await reject(request('image-apply', { editId: opaqueEdit.view.editId, candidateVersion: opaqueEdit.view.candidateVersion, expectedRevision: opaque.target.revision, expectedSha256: opaque.target.sha256, commandId: 'guard-unrelated-revision' }), ['REVISION_CONFLICT', 'IMAGE_TARGET_CONFLICT']);

  // Fault injection stays inside this test run: lose only a command's response,
  // retaining its durable session/task identity as after a disconnected client.
  const lostResult = await readJson(ledgerFile(replaceInput.commandId));
  delete lostResult.result; delete lostResult.taskId;
  await writeJson(ledgerFile(replaceInput.commandId), lostResult);
  const recoveryTaskCount = await taskCount();
  const replayedResult = await request('image-edit', replaceInput);
  check(replayedResult.replayed, true); check(replayedResult.taskId, replaced.taskId);
  check(await taskCount(), recoveryTaskCount);

  const unknownInput = { ...guards(current.target), regionRef: allRegion.regionRef, operation: { type: 'clean-alpha', threshold: 1 }, constraints: { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: true }, commandId: 'ledger-started-without-task' };
  await reject(request('image-edit', unknownInput), 'IMAGE_CONSTRAINT_FAILED');
  const interruptedLedger = await readJson(ledgerFile(unknownInput.commandId));
  assert.ok(interruptedLedger.startedAt); assert.ok(interruptedLedger.editId);
  check(interruptedLedger.taskId, undefined); check(interruptedLedger.result, undefined);
  await reject(request('image-edit', unknownInput), 'IMAGE_SUBMISSION_UNKNOWN');
  check(await taskCount(), recoveryTaskCount, 'Unknown submissions must never create another local or paid task');

  // The document committed before the image-command response was written.
  // Reconstructing the exact adoption must return its original document receipt.
  const applyInput = { editId, candidateVersion: replaced.candidateVersion, expectedRevision: initial.target.revision, expectedSha256: initial.target.sha256, commandId: 'apply-recolour' };
  const applyLedger = await readJson(ledgerFile(applyInput.commandId)); delete applyLedger.result;
  await writeJson(ledgerFile(applyInput.commandId), applyLedger);
  const revisionBeforeReplay = (await getDocument(repositoryRoot, manifest, { documentId: initial.document.id })).document.revision;
  const adoptionsBeforeReplay = (await request('image-session-get', { editId })).edit.adoptions.length;
  const appliedReplay = await request('image-apply', applyInput);
  check(appliedReplay.replayed, true); check(appliedReplay.adoption, applied.adoption);
  check((await getDocument(repositoryRoot, manifest, { documentId: initial.document.id })).document.revision, revisionBeforeReplay);
  check((await request('image-session-get', { editId })).edit.adoptions.length, adoptionsBeforeReplay);
  check(await taskCount(), recoveryTaskCount);

  // A non-owner poll may temporarily derive attention_required. A later owner
  // completion remains recoverable from the very same task, without resubmission.
  const originalTask = await readTask(manifest, replaced.taskId);
  const waitingSession = await readJson(sessionFile(editId));
  const waitingCandidate = waitingSession.candidates.find(value => value.version === replaced.candidateVersion);
  waitingCandidate.status = 'running'; waitingCandidate.derivedState = false;
  await writeJson(sessionFile(editId), waitingSession);
  await persistTask(manifest, { ...originalTask, status: 'running', adapter: { ...originalTask.adapter, backgroundExecution: true, backgroundPid: process.pid, backgroundExpiresAt: 0, backgroundToken: 'interrupted-test-worker' } });
  const attention = (await request('image-session-get', { editId })).edit.candidates.find(value => value.version === replaced.candidateVersion);
  check(attention.status, 'attention_required'); check(attention.derivedState, true);
  check((await readTask(manifest, replaced.taskId)).status, 'running');
  await persistTask(manifest, originalTask);
  const laterCompletion = (await request('image-session-get', { editId })).edit.candidates.find(value => value.version === replaced.candidateVersion);
  check(laterCompletion.status, 'completed'); check(laterCompletion.derivedState, false);
  check(laterCompletion.error, undefined, 'Recovered completion must clear stale attention diagnostics');
  check(laterCompletion.taskId, replaced.taskId); check(await taskCount(), recoveryTaskCount);

  const latestSource = await request('image-inspect', { targetId: current.target.targetId, view: 'source', includePixels: true });
  const beforeBytes = Buffer.from(latestSource.rgbaBase64, 'base64'), afterBytes = Buffer.from(beforeBytes);
  for (let index = 0; index < width * height; index++) afterBytes[index * 4] = (afterBytes[index * 4] + 1) % 256;
  const largePatch = { ...guards(latestSource.target), regionRef: allRegion.regionRef, operation: { type: 'pixel-patch', baseRgbaSha256: latestSource.rgbaSha256, spans: [{ startPixel: 0, beforeRgbaBase64: beforeBytes.toString('base64'), afterRgbaBase64: afterBytes.toString('base64') }] }, commandId: 'compact-patch-history' };
  const jsonBlobs = async () => (await readdir(path.join(editDirectory, 'blobs'))).filter(name => name.endsWith('.json'));
  const recipesBefore = (await jsonBlobs()).length;
  const patchedLarge = await request('image-edit', largePatch);
  const history = await request('image-session-get', { editId: patchedLarge.edit.editId });
  const stored = await readJson(sessionFile(patchedLarge.edit.editId));
  const recipe = stored.candidates[0].recipe;
  check((await readJson(path.resolve(repositoryRoot, recipe.file))).operation, largePatch.operation);
  check((await jsonBlobs()).length, recipesBefore + 1);
  for (const object of [patchedLarge, history, await readJson(ledgerFile(largePatch.commandId))]) {
    const serialized = JSON.stringify(object);
    check(serialized.includes('beforeRgbaBase64'), false); check(serialized.includes('afterRgbaBase64'), false);
    check(serialized.includes(largePatch.operation.spans[0].afterRgbaBase64), false);
  }
  const compactLedger = await readJson(ledgerFile(largePatch.commandId));
  check(compactLedger.result.edit, undefined, 'Ledger stores identities, not another history snapshot');
  assert.ok(JSON.stringify(compactLedger).length < 4096);
  const recipeTasks = await taskCount();
  check((await request('image-edit', largePatch)).taskId, patchedLarge.taskId);
  check((await jsonBlobs()).length, recipesBefore + 1); check(await taskCount(), recipeTasks);
  check(networkRequests, 0);
  console.log(JSON.stringify({ localIntegration: 'passed', checks, taskCount: await taskCount(), networkRequests, namespace: process.env.WORKBENCH_TEST_RUN, hiddenRgbaProtection: true, persistentReplay: true, fullEraseAndOpaqueProp: true }, null, 2));
} finally {
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousKey;
}
