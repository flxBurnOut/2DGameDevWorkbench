import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PixelController, compactPixelChanges } from '../../features/image-edit/pixel-controller.mjs';
import { applyLocalOperation, resolveRegion, screenToPixel } from '../../features/image-edit/core.mjs';
import { createTestViteServer } from '../helpers/vite-server.mjs';
import { imageEditInputs } from '../../lib/workbench/image-edit-contract.mjs';

let checks = 0;
const check = (actual, expected, note) => { assert.deepEqual(actual, expected, note); checks++; };
const width = 8, height = 4, source = new Uint8Array(width * height * 4);
for (let index = 0; index < width * height; index++) source.set([21, 32, 43, index % 4 ? 255 : 0], index * 4);
const model = new PixelController(source, width, height);
const original = new Uint8Array(source);
model.takeDirtyBounds();
model.beginStroke(); model.stroke({ x: 0, y: 0 }, 'pencil', [100, 20, 30, 0]); model.stroke({ x: 2, y: 0 }, 'pencil', [120, 40, 50, 0]); model.endStroke();
check(model.dirtyPixelCount, 3, 'line interpolation changes the same original pixels at every zoom');
check(source, original, 'the authoritative immutable source is never mutated');
check([...model.pixels.subarray(0, 4)], [120, 40, 50, 0], 'alpha0 RGB remains editable and is not premultiplied');
check(model.takeDirtyBounds(), { x: 0, y: 0, width: 3, height: 1 });
const patch = model.patch();
check(patch.length, 1, 'adjacent history entries use one compact span');
const applied = applyLocalOperation({ pixels: source, width, height, mask: model.mask, operation: { type: 'pixel-patch', spans: patch } });
check(applied.pixels, model.pixels, 'the frontend patch replays exactly through the shared server core');
model.undoPixels(); check(model.dirty, false); check([...model.pixels], [...source]);
model.redoPixels(); check(model.dirtyPixelCount, 3);
assert.throws(() => model.selectRegion({ type: 'rectangle', x: 4, y: 2, width: 2, height: 1 }), /未保存笔划/); checks++;
model.discardPixels();
model.selectRegion({ type: 'rectangle', x: 4, y: 2, width: 2, height: 1 });
model.beginStroke(); model.stroke({ x: 3, y: 2 }, 'eraser', [0, 0, 0, 0], 3); model.endStroke();
check([...model.pixels.subarray((2 * width + 3) * 4, (2 * width + 3) * 4 + 4)], [...source.subarray((2 * width + 3) * 4, (2 * width + 3) * 4 + 4)], 'brush stamps cannot change masked protected neighbors');
check(model.dirtyPixelCount, 1);
model.undoPixels();
model.undoMask(); check(model.selectionCount, width * height, 'mask undo is independent from pixel undo');
model.redoMask(); check(model.selectionCount, 2);
model.selectRegion({ type: 'rectangle', x: 0, y: 0, width: 1, height: 1 });
assert.throws(() => model.redoPixels(), /先选整图/); checks++;
check(model.canRedoPixels, true, 'blocked redo does not discard its history');
model.selectRegion({ type: 'all' }); model.redoPixels(); check(model.dirtyPixelCount, 1);
model.discardPixels(); model.beginStroke(); model.stroke({ x: 6, y: 3 }, 'pencil', [1, 2, 3, 4]); model.cancelStroke();
check([...model.pixels], [...source], 'cancelled pointer strokes restore all four channels');
const restored = new PixelController(source, width, height); restored.restorePatch(patch);
check(restored.pixels, applied.pixels); restored.undoPixels(); check([...restored.pixels], [...source]);
const invalid = patch.map(span => ({ ...span, before: new Uint8Array(span.before) })); invalid[0].before[0]++;
assert.throws(() => restored.restorePatch(invalid), /before/); checks++;
check([...restored.pixels], [...source], 'invalid recovered patches fail atomically');
check(screenToPixel({ screenX: 120.75, screenY: 70.5, originX: 120, originY: 70, zoom: .25, width, height }), { x: 3, y: 2 });
check(screenToPixel({ screenX: 119.99, screenY: 70, originX: 120, originY: 70, zoom: .25, width, height }), null);
check(compactPixelChanges([{ offset: 4, before: [1, 2, 3, 0], after: [1, 2, 3, 0] }]), [], 'no-op transparent RGB does not grow history');

const bounded = new PixelController(new Uint8Array(300 * 300 * 4), 300, 300);
bounded.beginStroke();
assert.throws(() => { for (let y = 0; y < 300; y += 25) { bounded.stroke({ x: 0, y }, 'pencil', [1, 2, 3, 255], 32); bounded.stroke({ x: 299, y }, 'pencil', [1, 2, 3, 255], 32); } }, /65,536/); checks++;
check(bounded.dirty, false, 'an oversized stroke is fully rolled back before the user checkpoints it');

const maskBrush = new PixelController(source, width, height); maskBrush.selectRegion(null);
maskBrush.beginMaskStroke(); maskBrush.maskStroke({ x: 0, y: 0 }, 'add'); maskBrush.maskStroke({ x: 3, y: 0 }, 'add'); maskBrush.endMaskStroke();
check(maskBrush.selectionCount, 4); check(maskBrush.region, { type: 'mask-runs', spans: [{ startPixel: 0, length: 4 }] });
check(maskBrush.pixels, new Uint8ClampedArray(source), 'AI selection brush never touches RGBA, including alpha0 RGB');
check(resolveRegion(source, width, height, maskBrush.region).mask, maskBrush.mask, 'serialized brush regions replay through the exact shared core');
maskBrush.undoMask(); check(maskBrush.selectionCount, 0); check(maskBrush.canUndoPixels, false);
maskBrush.redoMask(); check(maskBrush.selectionCount, 4);
maskBrush.beginMaskStroke(); maskBrush.maskStroke({ x: 1, y: 0 }, 'erase'); maskBrush.endMaskStroke();
check(maskBrush.region.spans, [{ startPixel: 0, length: 1 }, { startPixel: 2, length: 2 }]);
maskBrush.undoMask(); check(maskBrush.selectionCount, 4);
maskBrush.beginMaskStroke(); maskBrush.maskStroke({ x: 7, y: 3 }, 'add'); maskBrush.cancelMaskStroke(); check(maskBrush.selectionCount, 4);
maskBrush.selectRegion({ type: 'all' }); maskBrush.beginStroke(); maskBrush.stroke({ x: 1, y: 1 }, 'pencil', [1, 2, 3, 4]); maskBrush.endStroke();
maskBrush.beginMaskStroke(); assert.throws(() => maskBrush.maskStroke({ x: 1, y: 1 }, 'erase'), /未保存笔划/); checks++;
check(maskBrush.selectionCount, width * height); check(maskBrush.dirtyPixelCount, 1, 'blocked selection erasure preserves the pending pixel stroke');
const maskBudget = new PixelController(new Uint8Array(3840 * 8 * 4), 3840, 8); maskBudget.selectRegion(null);
const beforeMaskHistory = JSON.stringify(maskBudget.maskUndo);
maskBudget.beginMaskStroke();
for (let x = 0, column = 0; x < 3840; x += 3, column++) { maskBudget.maskStroke({ x, y: column % 2 ? 7 : 0 }, 'add'); maskBudget.maskStroke({ x, y: column % 2 ? 0 : 7 }, 'add'); }
assert.throws(() => maskBudget.endMaskStroke(), /256 KiB/); checks++;
check(maskBudget.selectionCount, 0); check(maskBudget.region, null); check(JSON.stringify(maskBudget.maskUndo), beforeMaskHistory, 'mask history budget failure rolls back the whole gesture and does not leave an unreplayable recipe');

// Browsing must not reset selection; an explicit new editing base preserves it too.
const versions = new PixelController(source, width, height);
versions.selectRegion(null); versions.setBase(new Uint8Array(source));
check(versions.selectionCount, 0, 'empty selection survives editing-base change');
versions.undoMask(); check(versions.selectionCount, width * height);
versions.selectRegion(null);
versions.selectRectangle({ x: 1, y: 1 }, { x: 2, y: 2 });
versions.selectRectangle({ x: 2, y: 1 }, { x: 3, y: 2 }, 'add');
check(versions.selectionCount, 6);
versions.selectRectangle({ x: 2, y: 1 }, { x: 2, y: 2 }, 'subtract');
check(versions.selectionCount, 4);
versions.setBase(new Uint8Array(source)); versions.undoMask(); check(versions.selectionCount, 6, 'base change preserves selection history');
versions.beginMaskStroke('replace'); versions.maskStroke({ x: 7, y: 3 }, 'add'); versions.endMaskStroke();
check(versions.selectionCount, 1); versions.undoMask(); check(versions.selectionCount, 6, 'new brush selection is one undo step');
versions.beginMaskStroke('replace'); versions.maskStroke({ x: 0, y: 0 }, 'add'); versions.cancelMaskStroke(); check(versions.selectionCount, 6);

const vite = await createTestViteServer({ configFile: false, appType: 'custom', resolve: { alias: { '@': process.cwd() } }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, logLevel: 'error' });
try {
  const client = await vite.ssrLoadModule('/features/image-edit/client.ts');
  const {CandidateCheck}=await vite.ssrLoadModule('/components/image-edit/candidate-check.tsx');
  const criticMarkup=canEdit=>renderToStaticMarkup(createElement(CandidateCheck,{editId:'fixture',candidate:{version:'v',visualReviewRefs:['existing']},disabled:false,canEdit,onAction:()=>{}}));
  check(criticMarkup(false).includes('查询原复核记录'),true);
  check(criticMarkup(false).includes('准备成品复核'),false);
  check(criticMarkup(true).includes('准备成品复核'),true);
  const { ImageVersionCache, ImageViewRequest } = await vite.ssrLoadModule('/features/image-edit/version-cache.ts');
  const lastView = new ImageViewRequest(); const firstView = lastView.begin(); const secondView = lastView.begin(); check(firstView.aborted, true); check(secondView.aborted, false); lastView.cancel(); check(secondView.aborted, true);
  const cache = new ImageVersionCache(200);
  const cached = { pixels: source, width, height, rgbaSha256: 'fixture' };
  cache.put('edit', 'source', cached); check(await cache.load('edit', 'source'), cached, 'cached versions do not fetch');
  cache.put('edit', 'other', { ...cached, pixels: new Uint8Array(source) }); check(cache.peek('edit', 'source'), undefined, 'LRU byte budget is enforced');
  const hash = createHash('sha256').update(source).digest('hex');
  const value = { width, height, rgbaBase64: Buffer.from(source).toString('base64'), rgbaSha256: hash, rgbaByteLength: source.length, pixelFormat: 'sRGB-RGBA8-straight' };
  check((await client.verifiedImagePixels(value)).pixels, source);
  const previewPng = await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const savedImage = { ...value, imageBase64: previewPng.toString('base64'), imageMimeType: 'image/png', sha256: createHash('sha256').update(previewPng).digest('hex') };
  check((await client.verifiedImagePixels(savedImage)).previewSource, `data:image/png;base64,${savedImage.imageBase64}`, 'Saved preview uses the verified original encoded image without an asynchronous Canvas round-trip.');
  await assert.rejects(client.verifiedImagePixels({ ...savedImage, sha256: '0'.repeat(64) }), /预览图片/); checks++;
  await assert.rejects(client.verifiedImagePixels({ ...value, rgbaSha256: '0'.repeat(64) }), /SHA/); checks++;
  await assert.rejects(client.verifiedImagePixels({ ...value, rgbaByteLength: source.length - 4 }), /描述/); checks++;
  await assert.rejects(client.verifiedImagePixels({ ...value, pixelFormat: 'premultiplied' }), /描述/); checks++;
  const wire = client.encodePixelPatch(patch, hash);
  check(wire.baseRgbaSha256, hash); check(Buffer.from(wire.spans[0].beforeRgbaBase64, 'base64'), Buffer.from(patch[0].before));
  assert.throws(() => client.encodePixelPatch([{ startPixel: 0, before: new Uint8Array(262148), after: new Uint8Array(262148) }], hash), /512/); checks++;
  const targetRef = { kind: 'interactable', documentId: 'fixture-doc', definitionId: 'fixture-object', slot: 'visual' };
  const target = { targetId: 'imgtarget:fixture', targetRef, revision: 3, sha256: hash, rgbaSha256: hash, width, height, editable: true, locked: false, kind: 'prop', name: 'fixture' };
  const session = { editId: 'edit-fixture', revision: 4, target, candidates: [], source: { sha256: hash, rgbaSha256: hash }, adoptions: [] };
  const actualRequests = [
    ['image-inspect', client.imageInspectInput(targetRef)],
    ['image-session-create', client.imageSessionInput(target, 'create-fixed')],
    ['image-session-get', client.imageReadInput(session.editId, 'source', true)],
    ['image-session-get', client.imageReadInput(session.editId, 'candidate-fixed', true)],
    ['image-resolve', client.imageResolveInput(target, { type: 'rectangle', x: 0, y: 0, width: 3, height: 1 })],
    ['image-resolve', client.imageResolveInput(target, { type: 'all' }, 'named area', 'region-fixed')],
    ['image-resolve', client.imageResolveInput(target, { type: 'named', regionId: 'region-fixed' })],
    ['image-edit', client.imageEditInput(target, session, 'source', 'region-fixed', wire, false, 'edit-fixed')],
    ['image-edit', client.imageEditInput(target, session, 'candidate-fixed', 'region-fixed', { type: 'restore-region', candidateVersion: 'source' }, true, 'restore-region-fixed')],
    ['image-apply', client.imageApplyInput(target, session.editId, 'candidate-fixed', 'apply-fixed')],
    ['image-apply', client.imageApplyInput(target, session.editId, 'source', 'restore-fixed')],
  ];
  for (const [operation, input] of actualRequests) { imageEditInputs[operation].parse(input); checks++; }
  assert.throws(() => imageEditInputs['image-apply'].parse({ ...client.imageApplyInput(target, session.editId, 'source', 'bad-apply'), targetId: target.targetId }), /Unrecognized key/); checks++;
  const large = new Uint8Array(1536 * 1024 * 4); large[3] = 1; large[4096] = 125;
  const largeHash = createHash('sha256').update(large).digest('hex');
  const start = performance.now();
  check((await client.verifiedImagePixels({ width: 1536, height: 1024, rgbaBase64: Buffer.from(large).toString('base64'), rgbaSha256: largeHash, rgbaByteLength: large.length, pixelFormat: 'sRGB-RGBA8-straight' })).pixels[4096], 125, 'native-size RGBA base64 decoding remains exact');
  console.log(`1536x1024 RGBA verify: ${Math.round(performance.now() - start)}ms (Node sample, not browser FPS).`);
  let requests = 0; const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { requests++; const input = JSON.parse(options.body); return Response.json({ commandId: input.commandId, replayed: requests > 1 }); };
  try {
    const payload = { commandId: 'stable-retry', editId: 'edit-1', candidateVersion: 'source' };
    const first = await client.imageEditRequest('apply', payload), second = await client.imageEditRequest('apply', payload);
    check(first.commandId, second.commandId); check(second.replayed, true);
  } finally { globalThis.fetch = oldFetch; }
  await aiClientRegression(client);
  await navigationRegression(vite);
  await referenceHostRegression(client, vite);
  await sharedSessionRecovery(client);
} finally { await vite.close(); }
console.log(`Image edit frontend: ${checks} checks; exact RGBA, shared patch replay, separate histories, protected pixels, bounded strokes, recovery validation and stable command payloads. Provider requests: 0.`);

async function aiClientRegression(client) {
  const hash = createHash('sha256').update(source).digest('hex');
  const ref = { kind: 'image-task', taskId: 'mock-ai-source' };
  const target = { targetId: 'imgtarget:ai-fixture', targetRef: ref, revision: hash, sha256: hash, rgbaSha256: hash, width: 1024, height: 1024, editable: true, locked: false, kind: 'prop', name: 'AI fixture', aiEdit: { supported: true, provider: 'fixture-mock', model: 'fixture-image-model', width: 1024, height: 1024 } };
  const older = { version: 'candidate-older', status: 'completed', operation: { type: 'pixel-patch' }, baseCandidateVersion: 'source' };
  const running = { version: 'candidate-requested', status: 'running', taskId: 'task-original', operation: { type: 'ai-edit' }, baseCandidateVersion: older.version };
  const unrelated = { version: 'candidate-unrelated', status: 'completed', operation: { type: 'erase' }, baseCandidateVersion: 'source' };
  const session = { editId: 'edit-ai-fixture', revision: 4, target, source: { sha256: hash, rgbaSha256: hash }, candidates: [older, running, unrelated], adoptions: [] };
  const png = await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const uploaded = await client.readImageAiReference(new File([png], 'reference.png', { type: 'image/png' }));
  check(Buffer.from(uploaded.source.split(',')[1], 'base64'), png, 'reference upload freezes original encoded bytes without Canvas');
  const chosenReference = { ...uploaded }, references = [chosenReference];
  const input = client.imageAiEditInput(target, session, older.version, 'region-brush', '  Original requested material  ', references, false, 'ai-fixed-command');
  imageEditInputs['image-edit'].parse(input); checks++;
  check(input.baseCandidateVersion, older.version); check(input.expectedEditRevision, 4); check(input.operation.prompt, 'Original requested material');
  check(input.constraints, { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: true });
  chosenReference.source = 'later reference'; references.push({ ...uploaded, id: 'another-selection' });
  check(input.operation.references, [uploaded.source], 'later reference selections cannot alter a submitted request');
  assert.throws(() => input.operation.references.push('mutate')); checks++;
  assert.throws(() => { input.constraints.preserveAlpha = false; }); checks++;
  const changedAlpha = client.imageAiEditInput(target, session, older.version, 'region', 'x', [], false, 'allow-alpha', false);
  check(changedAlpha.constraints.preserveAlpha, false); imageEditInputs['image-edit'].parse(changedAlpha); checks++;
  assert.throws(() => client.imageAiEditInput(target, session, older.version, 'region', 'x', [], true, 'dirty'), /未保存笔划/); checks++;
  assert.throws(() => client.imageAiEditInput({ ...target, aiEdit: { ...target.aiEdit, supported: false, reason: 'Small source remains local-only' } }, session, 'source', 'region', 'x', [], false, 'small'), /Small source/); checks++;
  assert.throws(() => client.validateAiReferences(Array.from({ length: 9 }, () => ({ ...uploaded, bytes: 1 }))), /8/); checks++;
  assert.throws(() => client.validateAiReferences([{ ...uploaded, bytes: 20 * 1024 * 1024 }, { ...uploaded, bytes: 20 * 1024 * 1024 }]), /32 MiB/); checks++;
  await assert.rejects(client.readImageAiReference(new File(['not a PNG'], 'fake.png', { type: 'image/png' })), /实际 PNG/); checks++;
  check(client.imageCandidateBase(session, running.version), { baseVersion: older.version, followVersion: running.version }, 'running deep-links show the declared parent, not the newest unrelated candidate');
  check(client.imageCandidateBase(session, older.version).baseVersion, older.version); check(client.imageCandidateBase(session, 'source').baseVersion, 'source');
  assert.throws(() => client.imageCandidateBase(session, 'missing-candidate'), /指定候选不存在/); checks++;
  check(client.imageCandidateFollowState(session, running.version, false).state, 'waiting');
  check(client.imageSessionNeedsPolling(session), true);
  const complete = { ...session, candidates: [older, { ...running, status: 'completed' }, unrelated] };
  check(client.imageCandidateFollowState(complete, running.version, false).state, 'select');
  check(client.imageCandidateFollowState(complete, running.version, true).state, 'preserve-draft', 'completion cannot silently replace later manual pixels');
  check(client.imageCandidateFollowState({ ...session, candidates: [{ ...running, status: 'attention_required', derivedState: true }] }, running.version, false).state, 'waiting');
  check(client.imageCandidateFollowState({ ...session, candidates: [{ ...running, status: 'attention_required', derivedState: false }] }, running.version, false).state, 'stopped');
  const originalFetch = globalThis.fetch, calls = []; let submitted = false, reads = 0;
  globalThis.fetch = async (url, options) => {
    if (typeof url !== 'string') throw new Error('Expected local frontend route.');
    const operation = `image-${url.split('/').at(-1)}`, body = JSON.parse(options.body);
    imageEditInputs[operation].parse(body); calls.push({ operation, body });
    if (operation === 'image-edit') { assert.equal(submitted, false); submitted = true; return Response.json({ edit: session, candidateVersion: running.version, taskId: running.taskId, status: 'running' }); }
    assert.equal(operation, 'image-session-get'); reads++;
    return Response.json({ edit: reads < 2 ? session : complete });
  };
  try {
    const started = await client.imageEditRequest('edit', input); check(started.taskId, running.taskId);
    check((await client.readImageEdit(session.editId)).edit.candidates[1].status, 'running');
    const reopened = (await client.readImageEdit(session.editId, running.version, true)).edit;
    check(client.imageCandidateFollowState(reopened, running.version, false).candidate.version, running.version);
    check(calls.map(call => call.operation), ['image-edit', 'image-session-get', 'image-session-get'], 'closing/reopening reads the original session without generation or adoption');
    check(calls[2].body.candidateVersion, running.version);
  } finally { globalThis.fetch = originalFetch; }
}

async function navigationRegression(vite) {
  const navigation = await vite.ssrLoadModule('/features/image-edit/navigation.ts');
  const initial = 'http://localhost:3000/tools/scene-composer?document=scene-copy&scene=scene-copy&imageEdit=edit-old&imageCandidate=candidate-old#gate';
  const next = navigation.imageEditNavigationUrl(initial, { editId: 'edit-new', candidateVersion: 'source' });
  const url = new URL(next);
  check(navigation.readImageEditNavigation(url.search), { editId: 'edit-new', candidateVersion: 'source' });
  check(url.searchParams.get('document'), 'scene-copy'); check(url.searchParams.get('scene'), 'scene-copy'); check(url.hash, '#gate');
  check(new URL(navigation.imageEditNavigationUrl(initial, { editId: 'edit-new' })).searchParams.get('imageCandidate'), 'source', 'A new session never retains an old candidate id.');
  assert.throws(() => navigation.imageEditNavigationUrl(initial, { editId: 'bad/id' }), /身份无效/); checks++;
  const previousWindow = globalThis.window, state = { preservedRouterState: true }, calls = [];
  globalThis.window = { location: { href: initial }, history: { state, replaceState(nextState, _title, href) { calls.push({ nextState, href }); globalThis.window.location.href = href; } } };
  try {
    navigation.writeImageEditNavigation({ editId: 'edit-new', candidateVersion: 'source' });
    navigation.writeImageEditNavigation({ editId: 'edit-new', candidateVersion: 'source' });
    check(calls.length, 1, 'Unchanged selections do not rewrite history.'); check(calls[0].nextState, state);
    navigation.writeImageEditNavigation({ editId: 'edit-new', candidateVersion: 'candidate-running' });
    check(navigation.readImageEditNavigation(new URL(globalThis.window.location.href).search).candidateVersion, 'candidate-running');
    navigation.clearImageEditNavigation();
    check(new URL(globalThis.window.location.href).searchParams.has('imageEdit'), false); check(new URL(globalThis.window.location.href).searchParams.get('document'), 'scene-copy');
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
}

async function referenceHostRegression(client, vite) {
  const { createObject, createProject } = await import('../../features/interactable-editor/contract.mjs');
  const { createScene, addMaterial, addInstance, validateScene } = await import('../../features/scene-composer/model.mjs');
  const { DocumentSyncController, documentFingerprint } = await import('../../features/editor-documents/sync-controller.mjs');
  const { objectRenderState } = await import('../../features/scene-composer/render-model.mjs');
  const hash = createHash('sha256').update(source).digest('hex');
  const project = createProject(), object = createObject('toggle');
  object.visual.assetId = 'original'; object.visual.width = 64; object.visual.height = 64;
  object.behavior.states[0].appearance.assetId = 'original'; object.behavior.states[1].appearance.assetId = '';
  const png = await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const originalSource = `data:image/png;base64,${png.toString('base64')}`;
  project.assets = [{ id: 'original', name: 'original.png', mime: 'image/png', source: originalSource }]; project.objects = [object];
  const choices = client.imageSlotChoices(object, true);
  check(choices.map(item => [item.slot, item.index]), [['visual', undefined], ['toggle-state', 0], ['toggle-state', 1]]);
  check(choices[2].available, true); assert.match(choices[2].label, /继承默认/); checks++;
  object.visual.focusAnimation = 'focus'; check(client.imageSlotChoices(object, true)[0].available, false); check(client.imageSlotChoices(object, false)[0].available, true);
  object.visual.focusAnimation = ''; object.behavior.states[0].appearance.animation = 'state_clip'; check(client.imageSlotChoices(object, true)[1].available, false);
  object.behavior.states[0].appearance.animation = '';
  const panels = await vite.ssrLoadModule('/components/interactable-editor/property-panels.tsx');
  const emitted = [];
  const findEntries = node => {
    const result = [];
    const visit = item => {
      if (Array.isArray(item)) { item.forEach(visit); return; }
      if (!isValidElement(item)) return;
      if (item.type === panels.EntryFields) result.push(item);
      visit(item.props.children);
    };
    visit(node); return result;
  };
  const togglePanel = panels.BehaviorPanel({ object, assets: project.assets, edit: () => {}, onEditImage: (slot, index) => emitted.push({ slot, index }) });
  findEntries(togglePanel).forEach(entry => entry.props.onEditImage());
  check(emitted, [{ slot: 'toggle-state', index: 0 }, { slot: 'toggle-state', index: 1 }], 'actual state-panel callbacks capture their own slot indexes');
  const sequence = createObject('sequence'); sequence.visual.assetId = 'original'; sequence.behavior.entries.push(structuredClone(sequence.behavior.entries[0]));
  emitted.length = 0;
  findEntries(panels.BehaviorPanel({ object: sequence, assets: project.assets, edit: () => {}, onEditImage: (slot, index) => emitted.push({ slot, index }) })).forEach(entry => entry.props.onEditImage());
  check(emitted, [{ slot: 'sequence-entry', index: 0 }, { slot: 'sequence-entry', index: 1 }]);
  const sequenceRef = { kind: 'interactable', documentId: project.projectId, definitionId: sequence.definitionId, slot: 'sequence-entry', index: 0 };
  check(client.imageTargetEquals(sequenceRef, { ...sequenceRef, index: 1 }), false, 'an index change cannot be mistaken for the original appearance slot');
  check(client.imageTargetEquals({ kind: 'scene-instance', documentId: 'scene', instanceId: 'selected' }, { kind: 'scene-instance', documentId: 'scene', instanceId: 'selected', slot: 'visual' }), true);
  const scene = createScene('Reference UI');
  scene.map = { name: 'map', origin: { x: 0, y: 0 }, offset: { x: 35, y: 20 }, layers: [{ id: 'map_overall', name: 'map', source: originalSource, width: 512, height: 256, locked: false, hidden: false, included: true }], collisions: [], source: 'data:application/zip;base64,UEs=', warnings: [] };
  scene.order.push('map_overall');
  const material = addMaterial(scene, project, object.definitionId);
  material.project.assets.push({ id: 'image_context_preview', name: 'existing preview-like id', mime: 'image/png', source: originalSource });
  const selected = addInstance(scene, material.id, 137, 93), sibling = addInstance(scene, material.id, 240, 120);
  selected.anchor = { x: 11, y: 55 };
  const targetRef = { kind: 'scene-instance', documentId: scene.id, instanceId: selected.id, slot: 'toggle-state', index: 0 };
  const target = { targetId: 'imgtarget:reference-ui', targetRef, revision: 1, sha256: hash, rgbaSha256: hash, width, height, editable: true, locked: false, kind: 'prop', name: 'reference', scope: 'single-instance', sharedInstanceCount: 2 };
  const receipt = { target, revision: 2, currentRevision: 2, adoption: { status: 'adopted', scope: 'single-instance', affectedInstanceIds: [selected.id], sharedInstanceCount: 2, sha256: hash, commandId: 'adopt-selected' } };
  client.validateSceneImageReceipt(targetRef, receipt); checks++;
  assert.throws(() => client.validateSceneImageReceipt(targetRef, { ...receipt, adoption: { ...receipt.adoption, affectedInstanceIds: [sibling.id] } }), /作用域/); checks++;
  assert.throws(() => client.validateSceneImageReceipt(targetRef, { ...receipt, adoption: { ...receipt.adoption, affectedInstanceIds: [selected.id, sibling.id] } }), /作用域/); checks++;
  assert.throws(() => client.validateSceneImageReceipt({ ...targetRef, index: 1 }, receipt), /不匹配/); checks++;
  assert.throws(() => client.validateSceneImageReceipt(targetRef, { ...receipt, currentRevision: 3 }), /不匹配/); checks++;
  imageEditInputs['image-inspect'].parse(client.imageInspectInput(targetRef)); checks++;
  imageEditInputs['image-apply'].parse(client.imageApplyInput(target, 'edit-reference', 'source', 'restore-selected')); checks++;
  const before = JSON.stringify(scene);
  const { SceneImagePreview } = await vite.ssrLoadModule('/components/scene-composer/scene-image-preview.tsx');
  const markup = renderToStaticMarkup(createElement(SceneImagePreview, { scene, target: targetRef, source: 'blob:isolated-candidate' }));
  check(JSON.stringify(scene), before, 'candidate context preserves materials, sibling art, anchor, map offset, order and source ZIP');
  check((markup.match(/href="blob:isolated-candidate"/g) || []).length, 1, 'candidate is overlaid on exactly one scene instance');
  assert(markup.includes(originalSource)); checks++;
  assert(markup.includes(objectRenderState(selected, material).outerTransform)); checks++;
  const mapMarkup = renderToStaticMarkup(createElement(SceneImagePreview, { scene, target: { kind: 'scene-layer', documentId: scene.id, layerId: 'map_overall' }, source: 'blob:isolated-layer' }));
  assert.match(mapMarkup, /href="blob:isolated-layer" x="35" y="20"/); checks++;
  check(JSON.stringify(scene), before);
  const offMap = structuredClone(scene); offMap.instances[0].x = 5000; offMap.instances[0].y = -1500; offMap.instances[0].scale = 2; offMap.instances[0].flipH = true;
  const { instanceRect } = await import('../../features/scene-composer/render-model.mjs');
  const offMapRect = instanceRect(offMap.instances[0], material);
  const offMapMarkup = renderToStaticMarkup(createElement(SceneImagePreview, { scene: offMap, target: targetRef, source: 'blob:off-map-candidate' }));
  const [left, top, viewWidth, viewHeight] = /viewBox="([^"]+)"/.exec(offMapMarkup)[1].split(' ').map(Number);
  check(left <= offMapRect.x && top <= offMapRect.y && left + viewWidth >= offMapRect.x + offMapRect.width && top + viewHeight >= offMapRect.y + offMapRect.height, true, 'off-map candidates remain fully inside the display-only view, including flipped/scaled geometry');
  check((offMapMarkup.match(/href="blob:off-map-candidate"/g) || []).length, 1, 'an existing image_context_preview asset ID cannot shadow the selected candidate');
  check(JSON.stringify(scene), before);
  await sceneSourceDeliveryRegression(client, scene);
  let local = scene, cache = { revision: 1, fingerprint: await documentFingerprint({ ...validateScene(scene), revision: 0 }) };
  const remote = { id: scene.id, kind: 'scene', revision: 1, content: structuredClone(scene) };
  const controller = new DocumentSyncController({ id: scene.id, kind: 'scene', current: () => local, busy: () => false, prepare: value => ({ ...validateScene(value), revision: 0 }), saveLocal: async () => {}, applyRemote: async value => { local = value; }, backupLocal: async () => 'backup', readCache: async () => cache, writeCache: async value => { cache = value; }, api: { read: async () => ({ document: remote }), metadata: async () => ({ document: remote }), create: async () => { throw new Error('No creation expected.'); }, save: async () => { throw new Error('No save expected.'); } } });
  const guard = await controller.flushSaved();
  local = structuredClone(scene); local.instances[1].x += 4;
  const human = JSON.stringify(local);
  await assert.rejects(controller.acceptAdopted({ ...remote, revision: 2 }, guard), /本机工程/); checks++;
  check(JSON.stringify(local), human, 'the same shared guard used by the scene host retains dirty human edits after a server adoption');
  controller.dispose();
}

async function sceneSourceDeliveryRegression(client, scene) {
  const bytes = Buffer.from(scene.map.source.split(',')[1], 'base64');
  const target = { targetRef: { kind: 'scene-layer', documentId: scene.id, layerId: 'map_overall' }, revision: 1, sourceEntry: { kind: 'embedded-map-source', documentId: scene.id, layerId: 'map_overall', sourceField: 'map.source', sha256: createHash('sha256').update(bytes).digest('hex') } };
  const snapshot = { id: scene.id, revision: 1, content: scene };
  const clean = { busy: false, pending: false, pixelDirty: false, aiDraftDirty: false, referencesLoading: false };
  let handoffs = 0, downloads = 0;
  const deliver = (metadata, document, opensEditor, state = clean) => client.performImageSourceAction(metadata, state, opensEditor, async received => {
    const payload = await client.verifiedSceneImageSource(received, document);
    check(Buffer.from(await payload.blob.arrayBuffer()), Buffer.from(document.content.map.source.split(',')[1], 'base64'), 'delivery bytes are the verified snapshot bytes');
    if (opensEditor) handoffs++; else downloads++;
  });
  await deliver(target, snapshot, true); await deliver(target, snapshot, false);
  check([handoffs, downloads], [1, 1]);
  const changedBytes = Buffer.from('different embedded ZIP');
  const newer = { ...target, revision: 2, sourceEntry: { ...target.sourceEntry, sha256: createHash('sha256').update(changedBytes).digest('hex') } };
  for (const opensEditor of [true, false]) {
    await assert.rejects(deliver(newer, snapshot, opensEditor), /版本/); checks++;
    await assert.rejects(deliver({ ...newer, revision: 1 }, snapshot, opensEditor), /内容已变化/); checks++;
    await assert.rejects(deliver({ ...target, targetRef: { ...target.targetRef, documentId: 'another-scene' } }, snapshot, opensEditor), /场景或图层/); checks++;
    await assert.rejects(deliver({ ...target, sourceEntry: { ...target.sourceEntry, layerId: 'another-layer' } }, snapshot, opensEditor), /场景或图层/); checks++;
  }
  const geometryOnly = { ...snapshot, revision: 2, content: structuredClone(scene) }; geometryOnly.content.instances[0].x++;
  await assert.rejects(deliver(target, geometryOnly, true), /版本/); checks++;
  for (const state of [{ ...clean, aiDraftDirty: true }, { ...clean, pixelDirty: true }, { ...clean, referencesLoading: true }, { ...clean, pending: true }, { ...clean, busy: true }]) {
    await assert.rejects(deliver(target, snapshot, true, state), /草稿|当前请求/); checks++;
  }
  check([handoffs, downloads], [1, 1], 'stale metadata and unsent AI/pixel drafts deliver no source package and never close the editor');
  const adopted = { ...snapshot, revision: 2, content: structuredClone(scene) };
  adopted.content.map.source = `data:application/zip;base64,${changedBytes.toString('base64')}`;
  await deliver(newer, adopted, true); await deliver(newer, adopted, false);
  check([handoffs, downloads], [2, 2], 'adopted metadata and exact refreshed host source can both open and download');
}

async function sharedSessionRecovery(client) {
  const { loadManifest, repositoryRoot } = await import('../../lib/workbench/runtime.mjs');
  const { imageEditRequest } = await import('../../lib/workbench/image-edits.mjs');
  const { createDocument, getDocument, saveDocument } = await import('../../lib/workbench/editor-documents.mjs');
  const { createObject, createProject } = await import('../../features/interactable-editor/contract.mjs');
  const manifest = await loadManifest();
  assert(manifest.workspace.imageEditDirectory.includes(`/test-runs/${process.env.WORKBENCH_TEST_RUN}/`));
  const request = (operation, input) => imageEditRequest(repositoryRoot, manifest, operation, input);
  const oldFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = () => { providerRequests++; throw new Error('Provider/network disabled for local frontend recovery regression.'); };
  try {
    const png = await sharp(source, { raw: { width, height, channels: 4 } }).png({ palette: false }).toBuffer();
    const project = createProject(); project.name = 'Frontend shared edit recovery';
    project.assets = [{ id: 'fixture-pixels', name: 'fixture.png', mime: 'image/png', source: `data:image/png;base64,${png.toString('base64')}` }];
    const object = createObject('toggle'); object.visual.assetId = 'fixture-pixels'; project.objects = [object];
    const created = await createDocument(repositoryRoot, manifest, { kind: 'interactable', content: project, commandId: 'frontend-create' });
    const ref = { kind: 'interactable', documentId: created.document.id, definitionId: object.definitionId, slot: 'visual' };
    const metadata = await request('image-inspect', { target: ref });
    const { edit } = await request('image-session-create', client.imageSessionInput(metadata.target, 'frontend-session'));
    const { regionRef } = await request('image-resolve', client.imageResolveInput(metadata.target, { type: 'all' }));
    const pixels = new PixelController(source, width, height);
    pixels.beginStroke(); pixels.stroke({ x: 0, y: 0 }, 'pencil', [220, 120, 20, 0]); pixels.endStroke();
    const baseHash = createHash('sha256').update(source).digest('hex');
    const current = { metadata, session: edit, controller: pixels, baseVersion: 'source', baseHash };
    const frozenPixels = new Uint8ClampedArray(pixels.pixels);
    const agentRegion = await request('image-resolve', client.imageResolveInput(metadata.target, { type: 'rectangle', x: 4, y: 2, width: 1, height: 1 }));
    const agent = await request('image-edit', client.imageEditInput(metadata.target, edit, 'source', agentRegion.regionRef, { type: 'replace-color', from: '#15202b', to: '#030405' }, true, 'agent-concurrent-edit'));
    check(agent.edit.revision, 2);
    const manual = client.encodePixelPatch(pixels.patch(), baseHash);
    await assert.rejects(request('image-edit', client.imageEditInput(metadata.target, current.session, current.baseVersion, regionRef, manual, false, 'stale-browser-save')), error => error.status === 409 && error.code === 'IMAGE_EDIT_CONFLICT'); checks++;
    const refreshed = client.mergeImageWorkspaceRefresh(current, await request('image-inspect', { target: ref }), (await request('image-session-get', { editId: edit.editId })).edit);
    check(refreshed.session.revision, 2);
    assert.equal(refreshed.controller, pixels); checks++;
    check(refreshed.controller.pixels, frozenPixels, 'metadata refresh preserves every unsaved pixel');
    check(refreshed.controller.dirty, true); check(refreshed.baseHash, baseHash); check(refreshed.baseVersion, 'source', 'refresh does not silently select the Agent candidate');
    const saved = await request('image-edit', client.imageEditInput(refreshed.metadata.target, refreshed.session, refreshed.baseVersion, regionRef, manual, false, 'browser-save-after-refresh'));
    check(saved.status, 'completed'); check(saved.edit.revision, 3);
    check(saved.edit.candidates.find(item => item.version === saved.candidateVersion).baseCandidateVersion, 'source');
    const result = await request('image-session-get', { editId: edit.editId, candidateVersion: saved.candidateVersion, includePixels: true });
    const actual = Buffer.from(result.edit.pixels.rgbaBase64, 'base64');
    check(actual, Buffer.from(frozenPixels), 'the new candidate uses the explicitly selected source base and exact retained browser patch');
    check([...actual.subarray((2 * width + 4) * 4, (2 * width + 4) * 4 + 4)], [...source.subarray((2 * width + 4) * 4, (2 * width + 4) * 4 + 4)], 'the unrelated Agent branch was not implicitly rebased');
    const adopted = await request('image-apply', client.imageApplyInput(metadata.target, edit.editId, saved.candidateVersion, 'browser-adopt-for-history'));
    for (let index = 0; index < 32; index++) {
      await request('image-session-create', client.imageSessionInput(adopted.target, `history-session-${index}`));
      await request('image-resolve', client.imageResolveInput(adopted.target, { type: 'rectangle', x: index % width, y: Math.floor(index / width), width: 1, height: 1 }, `区域 ${String(index).padStart(2, '0')}`, `history-region-${index}`));
    }
    let related = client.imageInspectionMetadata(await request('image-inspect', client.imageInspectInput(ref)));
    check(related.sessions.length, 30); check(related.namedRegions.length, 30);
    check(related.relatedPagination.sessions.nextOffset, 30); check(related.relatedPagination.namedRegions.nextOffset, 30);
    const secondPage = await request('image-inspect', client.imageInspectInput(ref, 30));
    related = client.mergeImageInspectionPage(related, secondPage, 'sessions');
    check(related.sessions.length, 33); check(related.namedRegions.length, 30, 'loading session history preserves the independently paged region list');
    check(related.sessions.find(item => item.editId === edit.editId).canRestoreSource, true, 'the oldest adopted source remains reachable after more than thirty sessions');
    related = client.mergeImageInspectionPage(related, secondPage, 'namedRegions');
    check(related.namedRegions.length, 32); check(related.relatedPagination.sessions.nextOffset, null); check(related.relatedPagination.namedRegions.nextOffset, null);
    related = client.mergeImageInspectionPage(related, secondPage, 'sessions');
    check(related.sessions.length, 33, 'reloading the same page does not duplicate history');

    const attempt = { commandId: 'frozen-bootstrap-retry' }, createPayloads = [];
    let loseResponse = true;
    globalThis.fetch = async (url, options) => {
      if (typeof url !== 'string') throw new Error('The frontend fixture only accepts its relative image-edit URLs.');
      assert(url.startsWith('/api/workbench/image-edit/'));
      const operation = `image-${url.split('/').at(-1)}`, input = JSON.parse(options.body);
      const value = await request(operation, input);
      if (operation === 'image-session-create') {
        createPayloads.push(JSON.stringify(input));
        if (loseResponse) { loseResponse = false; throw new TypeError('Response lost after durable session creation.'); }
      }
      return Response.json(value);
    };
    await assert.rejects(client.openImageSession(ref, attempt), /Response lost/); checks++;
    const before = (await getDocument(repositoryRoot, manifest, { documentId: ref.documentId })).document;
    await saveDocument(repositoryRoot, manifest, { documentId: before.id, expectedRevision: before.revision, content: { ...before.content, name: 'Another editor changed the project name' }, commandId: 'other-human-save' });
    const resumed = await client.openImageSession(ref, attempt);
    check(createPayloads.length, 2); check(createPayloads[0], createPayloads[1], 'bootstrap retries freeze the first create guards even after reinspection finds a newer target');
    check(resumed.inspection.target.revision, before.revision + 1); check(resumed.edit.target.revision, before.revision, 'replay returns the original session instead of inventing a second empty session');
    const onceMore = await client.openImageSession(ref, attempt);
    check(onceMore.edit.editId, resumed.edit.editId); check(createPayloads.length, 2, 'once its editId is known, a pixel-loading retry reads that exact session without another create');
    const routed = globalThis.fetch;
    globalThis.fetch = (url, options) => typeof url === 'string' && url.endsWith('/inspect') ? Promise.resolve(Response.json({ error: 'Current image source is no longer readable.' }, { status: 404 })) : routed(url, options);
    const history = await client.openImageSession(ref, { commandId: 'read-history-only', editId: resumed.edit.editId });
    check(history.inspection.historyOnly, true); check(history.inspection.target.editable, false); check(history.inspection.target.locked, true);
    check(history.edit.editId, resumed.edit.editId); check(createPayloads.length, 2, 'unreadable live sources still expose immutable session history without creating another session');
    const originalHistoryPixels = (await client.readImageEdit(history.edit.editId, 'source', true)).edit.pixels;
    check((await client.verifiedImagePixels(originalHistoryPixels)).rgbaSha256, history.edit.source.rgbaSha256);
    await assert.rejects(client.openImageSession({ ...ref, definitionId: 'different-object' }, { commandId: 'wrong-history', editId: history.edit.editId }), /另一图片目标/); checks++;
    check(providerRequests, 0);
  } finally { globalThis.fetch = oldFetch; }
}
