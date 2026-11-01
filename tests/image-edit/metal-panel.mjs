import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createObject, createProject } from '../../features/interactable-editor/contract.mjs';
import { cropPanel, paintMetalPanel, panelRegion, snapPanelMask, tracePanelSeam } from '../../features/image-edit/metal-panel.mjs';
import { applyLocalOperation, resolveRegion } from '../../features/image-edit/core.mjs';
import { createDocument, getDocument } from '../../lib/workbench/editor-documents.mjs';
import { imageEditRequest } from '../../lib/workbench/image-edits.mjs';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';

// Horizontal seams and grain are intentionally the same colour. The isolated
// fixture also has an occluding strap, hidden RGB and semi-transparent wood.
const width = 92, height = 66, rgba = Buffer.alloc(width * height * 4);
const area = { type: 'rectangle', x: 7, y: 11, width: 78, height: 44 };
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  let color = [23, 21, 18, 0];
  if (x >= 4 && x < 88 && y >= 6 && y < 60) color = [153, 97, 56, 255];
  if ([25, 26, 40, 41].includes(y) || (x % 34 < 16 && y === 16 + Math.round(Math.sin(x / 4)))) color = [64, 43, 32, 255];
  if (x >= 42 && x < 49) color = [109, 128, 141, 255];
  rgba.set(color, 4 * (width * y + x));
}
rgba.set([91, 40, 7, 0], 4 * (width * 21 + 20));
rgba[4 * (width * 22 + 20) + 3] = 118;
const { mask: initial } = resolveRegion(rgba, width, height, area);
const crop = cropPanel(rgba, initial, width, height);
const seams = [16, 28].map(y => tracePanelSeam(crop, y, 1));
assert.deepEqual(seams, [{ top: 14, bottom: 15 }, { top: 29, bottom: 30 }]);
assert.equal(tracePanelSeam(crop, 6, 1), null, 'Short grain must not be proposed as a seam.');
assert.deepEqual([...snapPanelMask(Uint8Array.of(1, 0, 1, 0, 1, 0), Uint8Array.of(1, 0, 1, 1, 1, 1),
  { x: 1, y: 0, width: 3, height: 2 }, 2)], [0, 0, 1, 0, 1, 1], 'Align to source grid; preserve ties and holes outside the authorised mask.');
const editMask = crop.allowed.slice();
for (let y = 0; y < crop.frame.height; y++) for (let x = 0; x < crop.frame.width; x++) {
  if ((x >= 35 && x < 42) || seams.some(s => y >= s.top && y <= s.bottom)) editMask[y * crop.frame.width + x] = 0;
}
const region = panelRegion(editMask, crop.frame, width);
const op = { type: 'metal-panel', frame: crop.frame, color: '#596571', angle: 0, position: 30, bandWidth: 16, strength: 72, cellSize: 2 };
const preview = crop.rgba.slice();
paintMetalPanel(preview, crop.frame.width, editMask, op, crop.frame);
const narrow = crop.rgba.slice();
paintMetalPanel(narrow, crop.frame.width, editMask, { ...op, bandWidth: 3 }, crop.frame);
assert.ok(preview[(5 * crop.frame.width + 18) * 4] > narrow[(5 * crop.frame.width + 18) * 4] + 10, 'Narrowing the band reduces off-centre light.');
assert.throws(() => applyLocalOperation({ pixels: rgba, mask: initial, width, height, operation: { ...op, frame: { ...op.frame, width: 10 } } }), /超出/);

const manifest = await loadManifest();
for (const key of ['imageEditDirectory', 'documentDirectory', 'outputDirectory', 'taskDirectory']) assert.ok(manifest.workspace[key].includes('/test-runs/'));
const request = (operation, input) => imageEditRequest(repositoryRoot, manifest, operation, input);
const encoded = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
const project = createProject(), prop = createObject('inspect');
project.name = '规则木板试件'; prop.visual.assetId = 'planks'; project.objects = [prop];
project.assets = [{ id: 'planks', name: 'planks.png', mime: 'image/png', source: 'data:image/png;base64,' + encoded.toString('base64') }];
const { document } = await createDocument(repositoryRoot, manifest, { kind: 'interactable', documentId: project.projectId, content: project, commandId: 'board-document' });
const { target } = await request('image-inspect', { target: { kind: 'interactable', documentId: document.id, definitionId: prop.definitionId } });
assert.ok(target.supportedOperations.includes('metal-panel'));
const guard = { targetId: target.targetId, expectedRevision: target.revision, expectedSha256: target.sha256 };
const { edit } = await request('image-session-create', { ...guard, commandId: 'open-board' });
const session = { ...guard, editId: edit.editId, expectedEditRevision: edit.revision, baseCandidateVersion: 'source' };
const initialRegion = await request('image-resolve', { ...guard, region: area });
const suggest = { ...session, regionRef: initialRegion.regionRef, splitRows: [14, 29],
  points: [7, 22, 37].flatMap(y => [{ x: 15, y, include: true }, { x: 61, y, include: true }, { x: 38, y, include: false }]) };
await assert.rejects(request('image-panel-suggest', { ...suggest, expectedEditRevision: edit.revision + 1 }), { code: 'IMAGE_EDIT_CONFLICT' });
await assert.rejects(request('image-panel-suggest', { ...suggest, splitRows: [1000] }), /超出/);
const executeSam = process.argv.includes('--sam');
if (executeSam) {
  const suggestion = await request('image-panel-suggest', suggest);
  assert.equal(suggestion.baseRgbaSha256, target.rgbaSha256);
  const suggested = resolveRegion(rgba, width, height, suggestion.region);
  assert.ok(suggested.count > 0);
  for (let i = 0; i < initial.length; i++) if (suggested.mask[i]) assert.ok(initial[i] && rgba[4 * i + 3]);
} else {
  const old = process.env.FORGE_STRUCTURE_PYTHON;
  process.env.FORGE_STRUCTURE_PYTHON = '/missing/forge-panel-test/python';
  try { await assert.rejects(request('image-panel-suggest', suggest), { code: 'PANEL_SAM_UNAVAILABLE' }); }
  finally { if (old === undefined) delete process.env.FORGE_STRUCTURE_PYTHON; else process.env.FORGE_STRUCTURE_PYTHON = old; }
}
const confirmed = await request('image-resolve', { ...guard, region });
const input = { ...session, regionRef: confirmed.regionRef, operation: op, constraints: { preserveAlpha: true }, commandId: 'save-board-candidate' };
const saved = await request('image-edit', input);
assert.equal(saved.status, 'completed');
const candidate = saved.edit.candidates.find(c => c.version === saved.candidateVersion);
assert.equal(candidate.diffFromBase.changedOutsideRegion, 0);
assert.equal(candidate.diffFromBase.alphaChangedPixelCount, 0);
const view = await request('image-inspect', { targetId: target.targetId, view: 'candidate', includePixels: true, editId: edit.editId, candidateVersion: candidate.version });
const expected = Buffer.from(rgba);
for (let y = 0; y < area.height; y++) expected.set(preview.subarray(y * area.width * 4, (y + 1) * area.width * 4), ((area.y + y) * width + area.x) * 4);
assert.deepEqual(Buffer.from(view.rgbaBase64, 'base64'), expected, 'Server result matches the exact preview, including nonzero origin, protected seams, strap and hidden RGB.');
assert.equal((await request('image-edit', input)).taskId, saved.taskId);
assert.equal((await getDocument(repositoryRoot, manifest, { documentId: document.id })).document.revision, document.revision);
const adopted = await request('image-apply', { expectedRevision: target.revision, expectedSha256: target.sha256, editId: edit.editId, candidateVersion: candidate.version, commandId: 'adopt-board' });
assert.equal(adopted.revision, document.revision + 1);
console.log(`Metal panel: seam tracing, reflection, preview parity, protection, precise adoption, replay and ${executeSam ? 'installed SAM' : 'manual fallback'} passed.`);
