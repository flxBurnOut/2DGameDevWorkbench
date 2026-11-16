// Invoked by the archived-lamp pytest with a temporary SpritePipeline API.
import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { listAssets, getAsset } from '../../lib/workbench/asset-catalog.mjs';
import { createDocument, applyDocumentCommands, getDocument, getMotionBindings } from '../../lib/workbench/editor-documents.mjs';
import { createObject, createProject } from '../../features/interactable-editor/contract.mjs';
import { InteractionSimulation, stateAppearance } from '../../features/interactable-editor/simulator.mjs';

const archive = new URL('../../examples/n2-pilot-20261110/lamp/seed-2202/', import.meta.url);
const png = async n => readFile(new URL('f' + String(n).padStart(2, '0') + '.png', archive));
const manifest = await loadManifest();
const project = createProject();
project.objects = [createObject('toggle'), createObject('sequence')];
const [toggle, sequence] = project.objects;
const idleSource = 'data:image/png;base64,' + (await png(1)).toString('base64');
project.assets.push({ id: 'idle-frame', name: 'idle.png', mime: 'image/png', source: idleSource });
for (const object of project.objects) {
  object.visual.assetId = 'idle-frame';
  object.visual.clips.push({ name: 'idle', fps: 6, loop: true, frames: [{ assetId: 'idle-frame', duration: 1 }] });
  object.visual.idleAnimation = 'idle';
}
const documentId = project.projectId;
const apply = input => applyDocumentCommands(repositoryRoot, manifest, { documentId, ...input });
const read = () => getDocument(repositoryRoot, manifest, { documentId });
await createDocument(repositoryRoot, manifest, { kind: 'interactable', commandId: 'create-lamp', content: project });

const command = async (motionSource, stageIndex, object, index) => {
  const { assets } = await listAssets(manifest, { motionSource, purposes: motionSource === 'state' ? 'image' : 'animation' });
  assert.ok(assets.every(row => row.motionSource === motionSource));
  const row = assets.find(a => a.stageIndex === stageIndex && !a.derivation);
  assert.ok(row);
  const { asset } = await getAsset(manifest, { assetId: row.id });
  return {
    type: 'import-motion-asset', definitionId: object.definitionId,
    target: object === toggle ? 'toggle-state' : 'sequence-entry', index,
    assetId: asset.id, assetRevision: asset.revision,
  };
};
const commands = [
  await command('state', 0, toggle, 1), await command('transition', 0, toggle, 1),
  await command('state', 1, sequence, 0), await command('transition', 1, sequence, 0),
];
const request = { expectedRevision: 1, commandId: 'import-archive', commands };
const [first, second] = await Promise.all([apply(request), apply(request)]);
assert.deepEqual(new Set([first.replayed, second.replayed]), new Set([false, true]));
const { document } = first;
assert.equal(document.revision, 2);
assert.deepEqual(document, second.document);
const data = id => Buffer.from(document.content.assets.find(a => a.id === id).source.split(',')[1], 'base64');
for (const [position, endpoint, range] of [[0, 4, [2, 3, 4]], [1, 8, [5, 6, 7, 8, 8, 8]]]) {
  const object = document.content.objects[position];
  const entry = position === 0 ? object.behavior.states[1] : object.behavior.entries[0];
  assert.equal(entry.appearance.staticImage, true);
  assert.deepEqual(data(entry.appearance.assetId), await png(endpoint));
  assert.equal(object.visual.idleAnimation, 'idle');
  assert.deepEqual(object.visual.clips[0], toggle.visual.clips[0]);
  const clip = object.visual.clips[1];
  assert.deepEqual(entry.feedback, [{ type: 'play_animation', animation: clip.name, waitForEnd: true, importedTransition: true }]);
  assert.equal(clip.loop, false);
  assert.equal(clip.frames.length, range.length);
  const expected = await Promise.all(range.map(png));
  for (const [i, f] of clip.frames.entries()) {
    assert.deepEqual(data(f.assetId), expected[i]);
    assert.equal(f.duration, 1);
  }
  const receipt = document.commandResults[position * 2 + 1];
  const detail = (await getAsset(manifest, { assetId: receipt.assetId })).asset;
  assert.equal(receipt.workRevision, detail.workRevision);
  assert.equal(receipt.stageIndex, position);
  assert.equal(receipt.checkpointToken, detail.checkpointToken);
  assert.equal(clip.fps, detail.fps);
  assert.deepEqual(receipt.frameHashes, expected.map(bytes => createHash('sha256').update(bytes).digest('hex')));
  const sim = new InteractionSimulation([object]);
  assert.ok(sim.request());
  while (sim.waiting?.type === 'show_text') sim.advanceText();
  assert.equal(sim.objects[0].animation.name, clip.name);
  assert.equal(sim.waiting.remaining, range.length / clip.fps);
  sim.tick(range.length / clip.fps);
  assert.equal(sim.active, null);
  assert.equal(sim.objects[0].animation, null);
  assert.equal(stateAppearance(object, sim.objects[0].state).assetId, entry.appearance.assetId);
}
assert.deepEqual(document.content.objects[0].behavior.states[0], toggle.behavior.states[0]);
const head = (await read()).document;
await assert.rejects(apply({ ...request, commandId: 'stale' }), { code: 'REVISION_CONFLICT' });
await assert.rejects(apply({ ...request, commands: commands.slice(1) }), { code: 'COMMAND_ID_REUSED' });
const bad = { ...commands[1], assetRevision: '0'.repeat(64) };
await assert.rejects(apply({ expectedRevision: 2, commandId: 'bad-source', commands: [commands[0], bad] }), { code: 'ASSET_REVISION_CONFLICT' });
assert.deepEqual((await read()).document, head);
const applied = await apply({ ...request, expectedRevision: 2, commandId: 'explicit-rebind' });
assert.deepEqual(applied.document.content, head.content);
assert.equal((await apply(request)).currentRevision, 3);

// B4: the read-only binding view reports what each slot last received and whether it is still in place.
const bindings = async () => (await getMotionBindings(repositoryRoot, manifest, { documentId })).objects;
let [toggleSlots, sequenceSlots] = await bindings();
assert.equal(toggleSlots.target, 'toggle-state');
assert.equal(toggleSlots.slots[1].state.current, true);
assert.equal(toggleSlots.slots[1].transition.current, true);
assert.equal(toggleSlots.slots[1].transition.stageIndex, 0);
assert.equal(toggleSlots.slots[0].state, null);
assert.equal(sequenceSlots.slots[0].transition.frameHashes.length, 6);

// T6/T7: per-frame durations and ping-pong playback are writeback settings; source frames stay as they are.
const durations = [1, 1, 1, 1, 2, 3];
const paced = { ...commands[3], durations, playback: 'ping_pong' };
const pacedResult = await apply({ expectedRevision: 3, commandId: 'paced-transition', commands: [paced] });
const pacedObject = pacedResult.document.content.objects[1];
const pacedStep = pacedObject.behavior.entries[0].feedback.find(step => step.importedTransition);
const pacedClip = pacedObject.visual.clips.find(clip => clip.name === pacedStep.animation);
assert.equal(pacedClip.frames.length, 10);
assert.deepEqual(pacedClip.frames.map(f => f.duration), [...durations, 2, 1, 1, 1]);
assert.equal(pacedClip.frames[6].assetId, pacedClip.frames[4].assetId);
assert.equal(pacedResult.document.commandResults[0].playback, 'ping_pong');
sequenceSlots = (await bindings())[1];
assert.equal(sequenceSlots.slots[0].transition.current, true);
assert.equal(sequenceSlots.slots[0].transition.playback, 'ping_pong');
await assert.rejects(apply({ expectedRevision: 4, commandId: 'bad-durations', commands: [{ ...commands[3], durations: [1, 2] }] }), /逐帧时长/);
await assert.rejects(apply({ expectedRevision: 4, commandId: 'state-durations', commands: [{ ...commands[0], durations: [2] }] }), /静态图片/);

// A derived reverse transition (B2), accepted after review, binds to the return transition of the toggle.
const { assets: derived } = await listAssets(manifest, { motionSource: 'transition', purposes: 'animation' });
const reverse = derived.find(row => row.derivation === 'reverse');
assert.ok(reverse, 'accepted derived transition is listed');
const { asset: reverseDetail } = await getAsset(manifest, { assetId: reverse.id });
const back = { type: 'import-motion-asset', definitionId: toggle.definitionId, target: 'toggle-state', index: 0, assetId: reverse.id, assetRevision: reverseDetail.revision };
const backResult = await apply({ expectedRevision: 4, commandId: 'derived-return', commands: [back] });
assert.equal(backResult.document.commandResults[0].derivation, 'reverse');
toggleSlots = (await bindings())[0];
assert.equal(toggleSlots.slots[0].transition.derivation, 'reverse');
assert.equal(toggleSlots.slots[0].transition.current, true);
assert.deepEqual(toggleSlots.slots[0].transition.frameHashes, [...toggleSlots.slots[1].transition.frameHashes].reverse());

// Replacing the state image elsewhere keeps the record but marks it as no longer in place.
await apply({ expectedRevision: 5, commandId: 'manual-image', commands: [{ type: 'bind-asset', definitionId: toggle.definitionId, assetId: 'idle-frame', target: 'toggle-state', index: 1 }] });
toggleSlots = (await bindings())[0];
assert.equal(toggleSlots.slots[1].state.current, false);
console.log('Verified both destinations, archived pixels and playback, atomic conflicts, concurrent replay, rebinding, slot bindings, writeback rhythm and derived transitions.');
