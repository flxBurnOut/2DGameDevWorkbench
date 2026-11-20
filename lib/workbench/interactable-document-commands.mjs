import { createObject, normalizeProject } from '../../features/interactable-editor/contract.mjs';
import { interactableCommandSchema } from './interactable-document-contract.mjs';
import { fail, selected } from './document-command-utils.mjs';

export async function applyInteractableCommands(input, commands, manifest) {
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
    } else if (c.type === 'import-motion-asset') {
      const { readConfirmedMotionAsset } = await import('./asset-catalog.mjs');
      const { bindMotionAsset } = await import('./interactable-motion-import.mjs');
      results.push(bindMotionAsset(project, c, await readConfirmedMotionAsset(manifest, c)));
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
