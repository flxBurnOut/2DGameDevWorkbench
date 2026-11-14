import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { imageEditPresentation, imageEditViewPath, taskPresentation } from '../../lib/workbench/presentation.mjs';
import { previewPath } from '../../lib/workbench/preview-follow.mjs';
import { previewInputs } from '../../lib/workbench/preview-follow-contract.mjs';
const manifest = JSON.parse(await readFile(new URL('../../workbench/manifest.json', import.meta.url), 'utf8'));
const refs = [
  { kind: 'interactable', documentId: 'prop-a', definitionId: 'door-a', slot: 'visual' },
  { kind: 'image-task', taskId: 'source-a' },
  {kind:'motion-frame',workId:'a'.repeat(32),workRevision:2,candidateIndex:1,stageIndex:0,frameIndex:3},
];
for (const target of refs) {
  const view = imageEditViewPath(manifest, target, 'edit-a', '2');
  assert.equal(new URL(view, 'http://localhost').searchParams.get('imageEdit'), 'edit-a');
  assert.equal(new URL(view, 'http://localhost').searchParams.get('imageCandidate'), '2');
  assert.doesNotThrow(() => previewPath(manifest, view));
  const task = { id: 'output-a', capabilityId: 'image-assets', status: 'completed', input: { operation: 'edit-image', kind: 'prop' }, imageEditContext: { target, editId: 'edit-a', candidateVersion: '2' } };
  const shown = taskPresentation(manifest, task);
  assert.equal(shown.viewPath, view); assert.doesNotMatch(shown.viewPath, /imageTask=/);
  const edit = { editId: 'edit-a', target: { name: 'Exact image', targetRef: target }, candidates: [{ version: '1', status: 'completed' }, { version: '2', status: 'running' }, { version: '3', status: 'completed' }] };
  assert.equal(imageEditPresentation(manifest, edit, '2').state, 'running');
  assert.equal(imageEditPresentation(manifest, edit, 'source').state, 'editing');
  assert.equal(imageEditPresentation(manifest, edit, '1').viewPath, imageEditViewPath(manifest, target, 'edit-a', '1'));
}
assert.equal(new URL(imageEditViewPath(manifest, refs[0], 'edit-a'), 'http://localhost').searchParams.get('object'), 'door-a');
assert.equal(new URL(imageEditViewPath(manifest, refs[1], 'edit-a'), 'http://localhost').searchParams.get('asset'), 'image:source-a');
assert.equal(previewInputs.present.parse({ editId: 'edit-a', candidateVersion: 'source' }).candidateVersion, 'source');
assert.throws(() => previewInputs.present.parse({ editId: 'edit-a', candidateVersion: '../private' }));
console.log('Image-edit presentation: exact source/session/candidate for interactable slots and independent image tasks; task context preserved; 0 provider requests.');
