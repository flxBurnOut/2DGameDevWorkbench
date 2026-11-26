import { createProject, normalizeProject } from '../../features/interactable-editor/contract.mjs';
import { createInteractableSimulation } from '../../features/editor-documents/simulation-replay.mjs';
import { applyInteractableCommands } from './interactable-document-commands.mjs';
import { interactableImageCommands } from './interactable-document-assets.mjs';

export const interactableDocuments = {
  identity: content => content.projectId,
  create(id) { const content = createProject(); content.projectId = id; return content; },
  normalize: normalizeProject,
  viewPath: '/tools/interactable-editor',
  applyCommands: applyInteractableCommands,
  diagnostics: () => [],
  counts: content => ({ objects: content.objects.length, assets: content.assets.length }),
  createSimulation: createInteractableSimulation,
  imageCommands: interactableImageCommands,
};
