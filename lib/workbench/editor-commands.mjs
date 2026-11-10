import { createObject, normalizeProject } from '../../features/interactable-editor/contract.mjs';
import { addMaterial, addInstance, changeAnchor, reorder, replaceInstances, replaceMap, validateScene, removeInstances, sceneMaterialProject } from '../../features/scene-composer/model.mjs';
import { sceneCommandSchema, interactableCommandSchema } from './document-contract.mjs';
import { updateSplitSourceState } from '../../features/scene-composer/map-split-source.mjs';
import { updateMapCollisionOverride } from '../../features/scene-composer/map-collisions.mjs';
import { assertEditableSceneNodes, assertSceneMutationLocks } from '../../features/scene-composer/mutation-policy.mjs';

const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_COMMAND' }); };
function selected(collection, ids, key = 'id') {
  const result = ids.map(id => collection.find(value => value[key] === id));
  if (result.some(value => !value)) fail('A selected node does not exist. Refresh the document before editing.');
  return result;
}
function editable(nodes) {
  try { assertEditableSceneNodes(nodes); } catch (error) { fail(error.message); }
  return nodes;
}
export function applySceneCommands(input, commands) {
  const scene = validateScene(input);
  const results = [];
  for (const raw of commands) {
    const c = sceneCommandSchema.parse(raw);
    const before = structuredClone(scene);
    const instances = () => selected(scene.instances, c.ids || [c.instanceId]);
    const nodes = (ids = c.ids) => selected([...(scene.map?.layers || []), ...scene.instances, ...(scene.mapSplit?.elements || [])], ids);
    if (c.type === 'rename') scene.name = c.name;
    else if (c.type === 'set-view') Object.assign(scene.view, c.view);
    else if (c.type === 'import-material') {
      if (c.materialId && scene.materials.some(m => m.id === c.materialId)) fail('Material ID already exists.');
      const material = addMaterial(scene, c.project, c.definitionId, c.materialId);
      results.push({ type: c.type, materialId: material.id });
    } else if (c.type === 'replace-material') {
      const material = selected(scene.materials, [c.materialId])[0];
      material.project = sceneMaterialProject(c.project, c.definitionId);
      material.name = material.project.objects[0].displayName;
      // Existing instances preserve their placement/anchor until explicitly changed.
    } else if (c.type === 'add-instance') {
      if (c.instanceId && scene.order.includes(c.instanceId)) fail('Instance ID already exists.');
      const instance = addInstance(scene, c.materialId, c.x, c.y, c.instanceId);
      results.push({ type: c.type, instanceId: instance.id });
    } else if (c.type === 'move-instances') {
      const relative = c.dx !== undefined || c.dy !== undefined;
      const absolute = c.x !== undefined || c.y !== undefined;
      if (relative === absolute) fail('Use either dx/dy or x/y for a move.');
      for (const i of editable(instances())) {
        i.x = relative ? i.x + (c.dx || 0) : (c.x ?? i.x);
        i.y = relative ? i.y + (c.dy || 0) : (c.y ?? i.y);
      }
    } else if (c.type === 'scale-instances') for (const i of editable(instances())) i.scale = c.scale;
    else if (c.type === 'flip-instances') for (const i of editable(instances())) i.flipH = c.flipH;
    else if (c.type === 'set-node-flags') {
      if ([c.locked, c.hidden, c.included].every(v => v === undefined)) fail('Provide at least one node flag.');
      for (const node of nodes()) for (const flag of ['locked', 'hidden', 'included']) if (c[flag] !== undefined) node[flag] = c[flag];
    } else if (c.type === 'reorder') {
      for (const id of c.ids) if (!scene.order.includes(id)) fail('Order includes an unknown node.');
      editable(nodes(c.ids.filter(id => id !== 'actor')));
      if (['before', 'after'].includes(c.action) && !scene.order.includes(c.target)) fail('Order target does not exist.');
      if (c.action === 'index' && typeof c.target !== 'number') fail('Index ordering requires a numeric target.');
      reorder(scene, c.ids, c.action, c.target);
    } else if (c.type === 'replace-instances') { editable(instances()); replaceInstances(scene, c.ids, c.materialId); }
    else if (c.type === 'remove-instances') {
      editable(instances());
      results.push({ type: c.type, removedInstanceIds: c.ids, removedLinkIds: removeInstances(scene, c.ids) });
    } else if (c.type === 'set-links') scene.links = c.links;
    else if (c.type === 'add-link') {
      if (scene.links.some(link => link.id === c.link.id)) fail('Link ID already exists.');
      scene.links.push(c.link);
    } else if (c.type === 'update-link') Object.assign(selected(scene.links, [c.linkId])[0], c.patch);
    else if (c.type === 'remove-links') {
      selected(scene.links, c.ids);
      scene.links = scene.links.filter(link => !c.ids.includes(link.id));
    } else if (c.type === 'replace-map') replaceMap(scene, c.map);
    else if (c.type === 'set-map-collisions') {
      if (!scene.map) fail('The scene has no map.');
      scene.map.collisions = c.collisions;
    }
    else if (c.type === 'move-map') {
      if (!scene.map) fail('The scene has no map.');
      if (!scene.map.layers.some(layer => !layer.locked)) fail('请先解锁至少一个地图层再移动地图。');
      scene.map.offset = { x: c.x, y: c.y };
    } else if (c.type === 'set-anchor') changeAnchor(editable(instances())[0], c.anchor);
    updateMapCollisionOverride(before, scene);
    updateSplitSourceState(input,scene);
    validateScene(scene);
    assertSceneMutationLocks(before, scene, { command: c });
  }
  return { content: validateScene(scene), commandResults: results };
}

export function applyInteractableCommands(input, commands) {
  // Validate the final transaction too; temporarily unbound references can be
  // introduced and resolved by a subsequent command in the same transaction.
  const project = normalizeProject(input);
  const results = [];
  for (const raw of commands) {
    const c = interactableCommandSchema.parse(raw);
    const object = () => selected(project.objects, [c.definitionId], 'definitionId')[0];
    if (c.type === 'rename') project.name = c.name;
    else if (c.type === 'add-object') {
      const o = createObject(c.kind);
      if (c.definitionId) o.definitionId = c.definitionId;
      if (project.objects.some(existing => existing.definitionId === o.definitionId)) fail('Object ID already exists.');
      if (c.name) o.displayName = c.name;
      project.objects.push(o);
      results.push({ type: c.type, definitionId: o.definitionId });
    } else if (c.type === 'remove-object') {
      object();
      if (project.objects.length === 1) fail('An interactable project must keep at least one object.');
      project.objects = project.objects.filter(o => o.definitionId !== c.definitionId);
    } else if (c.type === 'rename-object') object().displayName = c.name;
    else if (c.type === 'add-asset') {
      if (project.assets.some(a => a.id === c.asset.id)) fail('Asset ID already exists. Import changed artwork as a new asset and bind it explicitly.');
      project.assets.push(c.asset);
      results.push({ type: c.type, assetId: c.asset.id });
    } else if (c.type === 'bind-asset') {
      const o = object();
      const a = selected(project.assets, [c.assetId])[0];
      if (!a.mime.startsWith('image/')) fail('The selected visual asset is not an image.');
      if (c.target === 'visual') {
        if (c.index !== undefined) fail('A default visual has no state index.');
        o.visual.assetId = a.id;
      } else {
        const expectedKind = c.target === 'toggle-state' ? 'toggle' : 'sequence';
        if (o.behavior.kind !== expectedKind) fail('The selected behavior does not have this appearance target.');
        const entries = c.target === 'toggle-state' ? o.behavior.states : o.behavior.entries;
        if (!Number.isInteger(c.index) || !entries[c.index]) fail('Provide an existing state or sequence index.');
        entries[c.index].appearance.assetId = a.id;
      }
    } else if (c.type === 'set-visual') Object.assign(object().visual, c.visual);
    else if (c.type === 'set-shape') {
      const o = object();
      const target = c.target === 'pointer' ? o.pointer : o[c.target].shape;
      Object.assign(target, c.shape);
      if (c.enabled !== undefined) {
        if (c.target !== 'solid') fail('enabled only applies to the solid shape.');
        o.solid.enabled = c.enabled;
      }
    } else if (c.type === 'set-activation') Object.assign(object().activation, c.activation);
    else if (c.type === 'set-content') Object.assign(object().content, c.content);
    else if (c.type === 'set-behavior') Object.assign(object().behavior, c.behavior);
    else if (c.type === 'set-feedback') object().feedback = c.feedback;
    else if (c.type === 'set-completion') {
      const o = object(); o.completion = c.completion;
      if (c.cooldownSeconds !== undefined) o.cooldownSeconds = c.cooldownSeconds;
    }
  }
  return { content: normalizeProject(project), commandResults: results };
}
