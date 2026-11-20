import assert from 'node:assert/strict';

export function verifyMotionObjects(model) {
  const { blankSpec, motionObjectId, motionObjectType, motionReferenceObjects, motionSpecWithDefaults, selectMotionObject, motionSpecsEqual } = model;
  const legacy = { ...blankSpec, character_id: 'test_hero', description: 'Inspect the glove.', visual_structure: { analysis_id: 'a'.repeat(32), token: 'b'.repeat(64) } };
  delete legacy.object_id;
  delete legacy.object_type;
  delete legacy.review_protocol;
  assert.equal(motionObjectId(legacy), 'test_hero');
  assert.equal(motionObjectType(legacy), 'character');
  const restored = motionSpecWithDefaults(legacy);
  assert.equal('object_id' in restored, false, 'Loading a historical draft does not rewrite its identity.');
  assert.equal('object_type' in restored, false);
  assert.equal(restored.review_protocol, undefined, 'Historical drafts retain their baseline review protocol.');
  assert.ok(motionSpecsEqual(legacy, restored));
  assert.deepEqual(selectMotionObject(restored, 'test_hero', 'character'), restored, 'Reselecting a historical identity preserves the pending request payload.');
  const modern = { ...restored, object_id: 'test_hero', object_type: 'character' };
  delete modern.character_id;
  assert.equal(modern.character_id, undefined);
  assert.deepEqual(modern.visual_structure, legacy.visual_structure);
  assert.ok(motionSpecsEqual(legacy, modern), 'An alias-only change is not a reason to spend on another plan.');
  assert.ok(motionSpecsEqual(modern, { ...modern, object_type: undefined }));
  const interactable = selectMotionObject(modern, 'fixture_door', 'interactable');
  assert.equal(motionObjectId(interactable), 'fixture_door');
  assert.equal(motionObjectType(interactable), 'interactable');
  assert.equal(interactable.visual_structure, null, 'A new object cannot inherit another object’s structure.');
  assert.equal(motionSpecsEqual(modern, interactable), false);
  assert.equal(selectMotionObject(modern, 'test_hero', 'interactable').visual_structure, null, 'Changing type also invalidates old structure.');
  const character = { id: 'test_hero', name: 'Hero', width: 128, facing: 'right', valid: true };
  const door = { id: 'fixture_door', name: 'Door', width: 128, valid: true, object_type: 'interactable' };
  assert.deepEqual(motionReferenceObjects({ characters: [character] }), [{ ...character, object_type: 'character' }]);
  assert.deepEqual(motionReferenceObjects({ objects: [door], characters: [character] }), [door]);
  assert.deepEqual(motionReferenceObjects({ objects: [], characters: [character] }), [], 'An explicit object inventory is authoritative.');
  assert.equal(character.object_type, undefined, 'Inventory normalization never mutates the server response.');
}
