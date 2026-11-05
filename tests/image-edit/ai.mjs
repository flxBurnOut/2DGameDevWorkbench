import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createProject, createObject } from '../../features/interactable-editor/contract.mjs';
import { createDocument, getDocument, applyDocumentCommands } from '../../lib/workbench/editor-documents.mjs';
import { imageEditRequest } from '../../lib/workbench/image-edits.mjs';
import { findCapability, loadManifest, readTask, repositoryRoot, runConnector } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest();
for (const key of ['taskDirectory', 'documentDirectory', 'imageEditDirectory', 'outputDirectory']) assert.ok(manifest.workspace[key].includes('/test-runs/') && manifest.workspace[key].split('/').includes(process.env.WORKBENCH_TEST_RUN), `Unsafe ${key}`);
const request = (operation, input = {}) => imageEditRequest(repositoryRoot, manifest, operation, input);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const guard = target => ({ targetId: target.targetId, expectedRevision: target.revision, expectedSha256: target.sha256 });
const directory = path.resolve(repositoryRoot, manifest.workspace.imageEditDirectory);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const countTasks = async () => (await readdir(path.resolve(repositoryRoot, manifest.workspace.taskDirectory)).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause; })).filter(name => name.endsWith('.json')).length;
const data = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const encode = (pixels, width, height) => sharp(pixels, { raw: { width, height, channels: 4 } }).png({ palette: false }).toBuffer();
const decode = bytes => sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
let checks = 0, mode = 'drift', release;
const calls = [];
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const reject = async (promise, code) => { await assert.rejects(promise, cause => cause.code === code); checks++; };
const previousFetch = globalThis.fetch;
const environment = Object.fromEntries(['OPENAI_API_KEY', 'MAP_STITCHER_OPENAI_API_URL'].map(key => [key, process.env[key]]));
process.env.OPENAI_API_KEY = 'test-image-ai-only';
process.env.MAP_STITCHER_OPENAI_API_URL = 'http://127.0.0.1:9012/v1/images/edits';
globalThis.fetch = async (url, options) => {
  assert.ok(typeof url === 'string' && ['http://127.0.0.1:9012/v1/images/edits', 'http://127.0.0.1:9012/v1/images/generations'].includes(url), 'Every provider call is intercepted; no real URL is reachable.');
  const form = options.body instanceof FormData ? options.body : new Map(Object.entries(JSON.parse(options.body)));
  const images = form instanceof FormData ? await Promise.all(form.getAll('image[]').map(async image => Buffer.from(await image.arrayBuffer()))) : [];
  const mask = form.get('mask');
  const call = { images, mask: mask ? Buffer.from(await mask.arrayBuffer()) : null,
    model: form.get('model'), size: form.get('size'), background: form.get('background'), prompt: form.get('prompt'), mode };
  calls.push(call);
  if (release) await new Promise(resolve => { release.resolve = resolve; });
  if (call.mode === 'unknown') return new Response('test provider secret', { status: 503 });
  const [width, height] = call.size.split('x').map(Number);
  const pixels = Buffer.alloc(width * height * 4);
  const rgba = call.mode === 'branch' ? [81, 140, 221, 255] : [210, 80, 45, 255];
  for (let index = 0; index < width * height; index++) pixels.set(rgba, index * 4);
  if (call.mask && call.mode !== 'opaque') {
    const maskPixels = await decode(call.mask);
    for (let index = 0; index < width * height; index++) if (!maskPixels[index * 4 + 3]) { pixels.set([150, 160, 170, 1], index * 4); break; }
  }
  const bytes = await encode(pixels, width, height);
  return Response.json({ data: [{ b64_json: bytes.toString('base64') }], usage: { input_tokens: 12, output_tokens: 14, total_tokens: 26 } }, { headers: { 'x-request-id': 'req_ai_fixture' } });
};

async function fixture(name, width = 1024, height = 1024, opaque = false) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) pixels.set([19, 31, 47, opaque ? 255 : 0], index * 4);
  for (let y = Math.floor(height / 4); y < Math.floor(height * .75); y++) for (let x = Math.floor(width / 4); x < Math.floor(width * .75); x++) pixels.set([100, 120, 140, 255], (y * width + x) * 4);
  if (!opaque) { pixels.set([71, 72, 73, 1], (2 * width + 2) * 4); pixels.set([91, 92, 93, 128], (3 * width + 3) * 4); }
  const png = await encode(pixels, width, height);
  const project = createProject(); project.name = name;
  const object = createObject('toggle'); object.definitionId = 'primary'; object.visual.assetId = 'original'; object.visual.width = Math.min(width, 1024); object.visual.height = Math.min(height, 1024);
  const other = createObject('inspect'); other.definitionId = 'other'; other.visual.assetId = 'original';
  project.objects = [object, other]; project.assets = [{ id: 'original', name: 'original.png', mime: 'image/png', source: data(png) }];
  const { document } = await createDocument(repositoryRoot, manifest, { kind: 'interactable', documentId: project.projectId, commandId: 'create-' + name, content: project });
  const targetRef = { kind: 'interactable', documentId: document.id, definitionId: 'primary', slot: 'visual' };
  const inspection = await request('image-inspect', { target: targetRef });
  const region = await request('image-resolve', { ...guard(inspection.target), region: { type: 'all' } });
  return { document, pixels, png, target: inspection.target, region, targetRef };
}
async function wait(result) {
  for (let index = 0; index < 100; index++) {
    const { edit } = await request('image-session-get', { editId: result.edit.editId });
    const candidate = edit.candidates.find(candidate => candidate.version === result.candidateVersion);
    if (!['running', 'preparing'].includes(candidate.status)) return { edit, candidate };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Mock candidate did not finish.');
}
async function pixels(editId, version) {
  const result = await request('image-session-get', { editId, candidateVersion: version, includePixels: true });
  check(result.edit.pixels.rgbaSha256, sha(Buffer.from(result.edit.pixels.rgbaBase64, 'base64')));
  return Buffer.from(result.edit.pixels.rgbaBase64, 'base64');
}
function protectedEqual(actual, expected, width, region) {
  for (let index = 0; index < actual.length / 4; index++) {
    const x = index % width, y = Math.floor(index / width);
    if (x < region.x || x >= region.x + region.width || y < region.y || y >= region.y + region.height) assert.ok(actual.subarray(index * 4, index * 4 + 4).equals(expected.subarray(index * 4, index * 4 + 4)), `Protected RGBA ${x},${y} changed`);
  }
  checks++;
}
try {
  for (const [width, height] of [[64, 32], [1000, 1000], [3072, 768]]) {
    const small = await fixture(`invalid-${width}-${height}`, width, height);
    check(small.target.aiEdit.supported, false); check(small.target.aiEdit.code, 'IMAGE_AI_SIZE_UNSUPPORTED');
    check(small.target.supportedOperations.includes('ai-edit'), false); check(small.target.supportedOperations.includes('erase'), true);
    const before = await countTasks();
    await reject(request('image-edit', { ...guard(small.target), regionRef: small.region.regionRef, operation: { type: 'ai-edit', prompt: 'No resize' }, commandId: `size-${width}-${height}` }), 'IMAGE_AI_SIZE_UNSUPPORTED');
    check(await countTasks(), before);
  }
  check(calls.length, 0);
  const original = await fixture('manual-then-ai');
  check(original.target.aiEdit.supported, true); check(original.target.aiEdit.model, 'gpt-image-2.6-sunburst');
  check(original.target.aiEdit.constraints.preserveAlpha, true); check(original.target.operationConstraints['pixel-patch'].preserveAlpha, true);
  check(original.target.aiEdit.alphaPreservation, 'copy-edit-base-alpha');
  const beforeInvalid = await countTasks();
  for (const references of [['https://example.invalid/image.png'], ['../outside.png'], ['data:image/png;base64,aGVsbG8=']]) await assert.rejects(request('image-edit', { ...guard(original.target), regionRef: original.region.regionRef, operation: { type: 'ai-edit', prompt: 'Bad reference', references }, commandId: 'bad-' + sha(JSON.stringify(references)).slice(0, 12) }));
  checks += 3;
  await assert.rejects(request('image-edit', { ...guard(original.target), regionRef: original.region.regionRef, operation: { type: 'ai-edit', prompt: 'Too many refs', references: Array(9).fill(data(original.png)) }, commandId: 'too-many-refs' })); checks++;
  check(await countTasks(), beforeInvalid); check(calls.length, 0);
  const manualOffset = (10 * 1024 + 10) * 4;
  const manual = await request('image-edit', { ...guard(original.target), regionRef: original.region.regionRef,
    operation: { type: 'pixel-patch', baseRgbaSha256: sha(original.pixels), spans: [{ startPixel: manualOffset / 4, beforeRgbaBase64: original.pixels.subarray(manualOffset, manualOffset + 4).toString('base64'), afterRgbaBase64: Buffer.from([11, 22, 33, 0]).toString('base64') }] }, commandId: 'manual-first' });
  check(manual.status, 'completed'); check(calls.length, 0);
  const manualPixels = await pixels(manual.edit.editId, manual.candidateVersion);
  const rectangle = { type: 'rectangle', x: 400, y: 400, width: 64, height: 64 };
  await reject(request('image-resolve', { ...guard(original.target), region: { type: 'mask-runs', spans: [] } }), 'EMPTY_IMAGE_REGION');
  const brushSpec = { type: 'mask-runs', spans: Array.from({ length: rectangle.height }, (_, row) => ({ startPixel: (rectangle.y + row) * 1024 + rectangle.x, length: rectangle.width })) };
  const selected = await request('image-resolve', { ...guard(original.target), region: brushSpec, saveAs: 'Gemstone', commandId: 'named-ai-region' });
  check((await request('image-resolve', { ...guard(original.target), region: { type: 'named', regionId: selected.regionId } })).spec, brushSpec);
  const referenceBytes = await encode(Buffer.from([40, 50, 60, 255]), 1, 1);
  const referenceFile = path.join(directory, 'reference.png'); await mkdir(directory, { recursive: true }); await writeFile(referenceFile, referenceBytes);
  const references = [path.relative(repositoryRoot, referenceFile).replaceAll('\\', '/'), ...Array(7).fill(data(referenceBytes))];
  const input = { ...guard(original.target), editId: manual.edit.editId, expectedEditRevision: manual.edit.revision, baseCandidateVersion: manual.candidateVersion,
    regionRef: selected.regionRef, operation: { type: 'ai-edit', prompt: 'Change only the selected gemstone material', references }, commandId: 'ai-frozen-manual' };
  release = {};
  const beforeAi = await countTasks();
  const [submitted, replay] = await Promise.all([request('image-edit', input), request('image-edit', input)]);
  check(submitted.status, 'running'); check(replay.taskId, submitted.taskId); check(replay.replayed, true); check(await countTasks(), beforeAi + 1);
  const persisted = await readTask(manifest, submitted.taskId);
  check(persisted.input.operation, 'edit-image'); check(persisted.input.width, 1024); check(persisted.input.height, 1024);
  check(persisted.input.references.length, 8); check(persisted.input.references.every(reference => !reference.startsWith('data:')), true);
  check(persisted.imageEditContext, { editId: manual.edit.editId, candidateVersion: submitted.candidateVersion, target: original.target.targetRef });
  check((await getDocument(repositoryRoot, manifest, { documentId: original.document.id })).document.revision, 1, 'Starting AI does not adopt any image.');
  while (!release.resolve) await new Promise(resolve => setTimeout(resolve, 5));
  check(calls.length, 1); check(calls[0].model, 'gpt-image-2.6-sunburst'); check(calls[0].images.length, 9);
  check(sha(calls[0].images[0]), sha(await readFile(path.resolve(repositoryRoot, persisted.input.image))));
  check(await decode(calls[0].images[0]), manualPixels, 'The provider base is the manual candidate, not the original source.');
  const maskPixels = await decode(calls[0].mask);
  check(calls[0].prompt.includes('x=400..463, y=400..463'), true, 'Frozen request includes precise bounds, not a painted overlay.');
  check(calls[0].prompt.includes('fully transparent mask pixels are the region to reconstruct'), true);
  check(maskPixels[(400 * 1024 + 400) * 4 + 3], 0); check(maskPixels[manualOffset + 3], 255);
  await writeFile(referenceFile, await encode(Buffer.from([1, 2, 3, 255]), 1, 1));
  check(await readFile(path.resolve(repositoryRoot, persisted.input.references[0])), referenceBytes, 'A later source-file change cannot alter the frozen reference.');
  check(calls[0].images.slice(1).every(bytes => bytes.equals(referenceBytes)), true);
  const publicCandidate = submitted.edit.candidates.find(candidate => candidate.version === submitted.candidateVersion);
  check(publicCandidate.operation.referenceCount, 8); check(JSON.stringify(publicCandidate).includes('data:image/'), false);
  const recipe = await json(path.resolve(repositoryRoot, publicCandidate.recipe.file));
  check(JSON.stringify(recipe).includes('data:image/'), false); check(new Set(recipe.operation.references.map(reference => reference.file)).size, 1, 'Repeated reference payloads share one immutable blob.');
  const ledger = path.join(directory, 'commands', `${sha(input.commandId)}.json`);
  check((await readFile(ledger, 'utf8')).includes(referenceBytes.toString('base64')), false);
  const gate = release; release = null; gate.resolve();
  const completed = await wait(submitted);
  check(completed.candidate.status, 'completed'); check(completed.candidate.diff, completed.candidate.diffFromBase);
  check(completed.candidate.diffFromBase.changedOutsideRegion, 0); check(completed.candidate.diffFromSource.changedOutsideRegion, 1);
  const output = await pixels(submitted.edit.editId, submitted.candidateVersion);
  protectedEqual(output, manualPixels, 1024, rectangle);
  check([...output.subarray((400 * 1024 + 400) * 4, (400 * 1024 + 400) * 4 + 4)], [0, 0, 0, 0], 'Prop alpha1 cleanup is confined to the editable region.');
  check([...output.subarray(manualOffset, manualOffset + 4)], [11, 22, 33, 0]);
  check(completed.candidate.evidence.baseRgbaSha256, sha(manualPixels)); check(completed.candidate.evidence.sourceRgbaSha256, sha(original.pixels));
  check(completed.candidate.evidence.preservation.changedOutsideMaskPixels, 0); check(completed.candidate.evidence.alphaCleanup.threshold, 1);
  assert.notEqual(completed.candidate.evidence.rawSha256, completed.candidate.evidence.sha256); checks++;
  check(completed.candidate.evidence.processingEvidence.endsWith('/processing-report.json'), true); check(completed.candidate.evidence.usageEvidence.endsWith('/provider-usage.json'), true);
  check(await pixels(submitted.edit.editId, 'source'), original.pixels);
  const lostResult = await json(ledger); delete lostResult.result; await writeFile(ledger, JSON.stringify(lostResult));
  const resumed = await request('image-edit', input); check(resumed.taskId, submitted.taskId); check(resumed.status, 'completed'); check(calls.length, 1);
  await reject(request('image-edit', { ...input, operation: { ...input.operation, prompt: 'Different request' } }), 'COMMAND_ID_REUSED');
  mode = 'branch';
  const branch = await request('image-edit', { ...input, operation: { type: 'ai-edit', prompt: 'Branch from the earlier manual candidate' }, expectedEditRevision: completed.edit.revision, commandId: 'ai-old-parent' });
  const branched = await wait(branch); check(branched.candidate.status, 'completed'); check(calls.length, 2);
  check(await decode(calls[1].images[0]), manualPixels, 'A later branch explicitly uses the chosen older candidate.');
  const branchPixels = await pixels(branch.edit.editId, branch.candidateVersion); protectedEqual(branchPixels, manualPixels, 1024, rectangle);
  assert.notDeepEqual(branchPixels, output); checks++;
  const alphaFixture = await fixture('alpha-preserving-ai');
  const alphaOffset = (8 * 1024 + 8) * 4;
  const alphaBase = await request('image-edit', { ...guard(alphaFixture.target), regionRef: alphaFixture.region.regionRef, commandId: 'alpha-manual-base', operation: { type: 'pixel-patch', baseRgbaSha256: sha(alphaFixture.pixels), spans: [{ startPixel: alphaOffset / 4, beforeRgbaBase64: alphaFixture.pixels.subarray(alphaOffset, alphaOffset + 4).toString('base64'), afterRgbaBase64: Buffer.from([61, 62, 63, 64]).toString('base64') }] } });
  const alphaBasePixels = await pixels(alphaBase.edit.editId, alphaBase.candidateVersion);
  const alphaRect = { type: 'rectangle', x: 0, y: 0, width: 512, height: 512 };
  const alphaRegion = await request('image-resolve', { ...guard(alphaFixture.target), region: alphaRect });
  const alphaInput = { ...guard(alphaFixture.target), editId: alphaBase.edit.editId, expectedEditRevision: alphaBase.edit.revision, baseCandidateVersion: alphaBase.candidateVersion, regionRef: alphaRegion.regionRef, operation: { type: 'ai-edit', prompt: 'Keep the selected base transparency exactly' }, constraints: { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: true }, commandId: 'keep-alpha-ai' };
  const alphaCalls = calls.length;
  const alphaStarted = await request('image-edit', alphaInput), alphaDone = await wait(alphaStarted);
  check(alphaDone.candidate.status, 'completed'); check(calls.length, alphaCalls + 1);
  const alphaResult = await pixels(alphaStarted.edit.editId, alphaStarted.candidateVersion);
  protectedEqual(alphaResult, alphaBasePixels, 1024, alphaRect);
  check(alphaResult.filter((_, index) => index % 4 === 3), alphaBasePixels.filter((_, index) => index % 4 === 3));
  check(alphaResult[alphaOffset + 3], 64, 'Use the selected manual candidate Alpha, not the session-original Alpha=0.');
  check(alphaResult[(2 * 1024 + 2) * 4 + 3], 1); check(alphaResult[(3 * 1024 + 3) * 4 + 3], 128);
  check([...alphaResult.subarray(0, 4)], [150, 160, 170, 0], 'Cleanup is skipped before restoring the exact source Alpha.');
  check(alphaDone.candidate.diff.alphaChangedPixelCount, 0); check(alphaDone.candidate.diffFromSource.alphaChangedPixelCount, 1);
  check(alphaDone.candidate.evidence.alphaPreservation.changedAlphaPixels, 0);
  check(alphaDone.candidate.evidence.alphaPreservation.expectedAlphaSha256, alphaDone.candidate.evidence.alphaPreservation.actualAlphaSha256);
  check(alphaDone.candidate.evidence.alphaCleanup.threshold, 0);
  check((await readTask(manifest, alphaStarted.taskId)).input.preserveAlpha, true);
  check((await json(path.resolve(repositoryRoot, alphaDone.candidate.recipe.file))).constraints.preserveAlpha, true);
  check((await request('image-edit', alphaInput)).taskId, alphaStarted.taskId); check(calls.length, alphaCalls + 1);
  await reject(request('image-edit', { ...alphaInput, constraints: { ...alphaInput.constraints, preserveAlpha: false } }), 'COMMAND_ID_REUSED');
  const alphaOff = await request('image-edit', { ...alphaInput, commandId: 'allow-alpha-ai', expectedEditRevision: alphaDone.edit.revision, constraints: { ...alphaInput.constraints, preserveAlpha: false } });
  const alphaOffDone = await wait(alphaOff);
  check(alphaOffDone.candidate.status, 'completed'); check(alphaOffDone.candidate.diff.alphaChangedPixelCount > 0, true);
  check(alphaOffDone.candidate.evidence.alphaPreservation, null); check(alphaOffDone.candidate.evidence.alphaCleanup.threshold, 1);
  const adoptedAlpha = await request('image-apply', { editId: alphaStarted.edit.editId, candidateVersion: alphaStarted.candidateVersion, expectedRevision: alphaFixture.target.revision, expectedSha256: alphaFixture.target.sha256, commandId: 'adopt-preserved-alpha' });
  const adoptedImage = await request('image-inspect', { target: alphaFixture.targetRef, view: 'source', includePixels: true });
  check(Buffer.from(adoptedImage.rgbaBase64, 'base64'), alphaResult);
  await request('image-apply', { editId: alphaStarted.edit.editId, candidateVersion: 'source', expectedRevision: adoptedAlpha.target.revision, expectedSha256: adoptedAlpha.target.sha256, commandId: 'restore-after-alpha-ai' });
  check(Buffer.from((await request('image-inspect', { target: alphaFixture.targetRef, view: 'source', includePixels: true })).rgbaBase64, 'base64'), alphaFixture.pixels);
  check(calls.length, alphaCalls + 2, 'Adoption and restoration do not submit a provider request.');
  const opaque = await fixture('opaque-ai', 1024, 1024, true); mode = 'opaque';
  const opaqueEdit = await request('image-edit', { ...guard(opaque.target), regionRef: opaque.region.regionRef, operation: { type: 'ai-edit', prompt: 'Recolor this opaque appearance' }, commandId: 'opaque-ai-edit' });
  check((await wait(opaqueEdit)).candidate.status, 'completed'); check(calls.at(-1).background, 'opaque');
  check((await request('image-session-get', { editId: opaqueEdit.edit.editId, candidateVersion: opaqueEdit.candidateVersion, includePixels: true })).edit.pixels.rgbaBase64.length > 0, true);
  const generation = await runConnector(manifest, findCapability(manifest, 'image-assets'), { operation: 'generate-prop', prompt: 'Generation still requires transparency' });
  for (let index = 0; index < 100 && (await readTask(manifest, generation.task.id)).status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 10));
  check((await readTask(manifest, generation.task.id)).status, 'failed'); check(calls.at(-1).background, 'transparent');
  const countBeforeMissing = calls.length; delete process.env.OPENAI_API_KEY;
  const missingInput = { ...guard(opaque.target), editId: opaqueEdit.edit.editId, expectedEditRevision: (await request('image-session-get', { editId: opaqueEdit.edit.editId })).edit.revision, baseCandidateVersion: 'source', regionRef: opaque.region.regionRef, operation: { type: 'ai-edit', prompt: 'Await configuration' }, commandId: 'no-key-ai' };
  const missing = await request('image-edit', missingInput); check(missing.status, 'awaiting_configuration');
  process.env.OPENAI_API_KEY = 'test-image-ai-only'; check((await request('image-edit', missingInput)).taskId, missing.taskId); check(calls.length, countBeforeMissing, 'Configuration changes never resubmit an existing task.');
  mode = 'unknown';
  const unknownInput = { ...missingInput, expectedEditRevision: missing.edit.revision, commandId: 'unknown-ai' };
  const unknown = await request('image-edit', unknownInput); check((await wait(unknown)).candidate.status, 'attention_required');
  const countBeforeUnknownRetry = calls.length; check((await request('image-edit', unknownInput)).taskId, unknown.taskId); check(calls.length, countBeforeUnknownRetry);
  check(JSON.stringify(await request('image-session-get', { editId: unknown.edit.editId })).includes('test provider secret'), false);
  const current = (await getDocument(repositoryRoot, manifest, { documentId: original.document.id })).document;
  await applyDocumentCommands(repositoryRoot, manifest, { documentId: current.id, expectedRevision: current.revision, commandId: 'external-source-binding', commands: [{ type: 'add-asset', asset: { id: 'external-art', name: 'external.png', mime: 'image/png', source: data(await encode(Buffer.from([1, 2, 3, 255]), 1, 1)) } }, { type: 'bind-asset', definitionId: 'primary', assetId: 'external-art', target: 'visual' }] });
  await reject(request('image-apply', { editId: branch.edit.editId, candidateVersion: branch.candidateVersion, expectedRevision: original.target.revision, expectedSha256: original.target.sha256, commandId: 'stale-adopt' }), 'IMAGE_TARGET_CONFLICT');
  const changed = await request('image-inspect', { target: original.targetRef });
  await reject(request('image-apply', { editId: branch.edit.editId, candidateVersion: branch.candidateVersion, expectedRevision: changed.target.revision, expectedSha256: changed.target.sha256, commandId: 'unknown-binding-adopt' }), 'IMAGE_TARGET_CONFLICT');
  check((await getDocument(repositoryRoot, manifest, { documentId: original.document.id })).document.content.objects[0].visual.assetId, 'external-art');
  console.log(JSON.stringify({ aiIntegration: 'passed', checks, mockedProviderRequests: calls.length, realProviderRequests: 0, namespace: process.env.WORKBENCH_TEST_RUN, exactRgbaProtection: true, frozenReferences: true, explicitBranches: true }, null, 2));
} finally {
  if (release?.resolve) release.resolve();
  globalThis.fetch = previousFetch;
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
