import {
  executeSpritePipeline,
  refreshSpritePipeline,
  spritePipelineConfigured,
  validateSpritePipelineInput,
} from './sprite-pipeline.mjs';

import { executeInteractable, validateInteractableInput } from './interactable-editor.mjs';

import { executeReferenceArt, refreshReferenceArt, validateReferenceArtInput } from './reference-art.mjs';
import { executeImageAssets, imageAssetsConfigured, validateImageAssetsInput } from './image-assets.mjs';

const adapters = {
  'image-assets': { execute: executeImageAssets, configured: imageAssetsConfigured, validate: validateImageAssetsInput },
  'reference-art': { execute: executeReferenceArt, refresh: refreshReferenceArt, configured: () => true, validate: validateReferenceArtInput },
  'interactable-editor': {
    execute: executeInteractable,
    configured: () => true,
    validate: validateInteractableInput,
  },
  'sprite-pipeline': {
    execute: executeSpritePipeline,
    refresh: refreshSpritePipeline,
    configured: spritePipelineConfigured,
    validate: validateSpritePipelineInput,
  },
};

export function findAdapter(capability) {
  const adapterId = capability.connector?.adapter;
  const adapter = adapters[adapterId];
  if (!adapter) throw new Error(`Unknown local adapter: ${adapterId ?? '(missing)'}`);
  return { adapterId, ...adapter };
}

export function adapterConfigured(capability) {
  if (capability.connector?.type !== 'local-adapter') {
    return Boolean(process.env[capability.connector?.urlEnv]);
  }
  return findAdapter(capability).configured(capability.connector);
}

export function validateAdapterInput(capability, input) {
  if (capability.connector?.type !== 'local-adapter') return [];
  return findAdapter(capability).validate(input);
}

export async function executeAdapter(capability, context) {
  const adapter = findAdapter(capability);
  return adapter.execute({ ...context, capability });
}

export async function refreshAdapter(capability, context) {
  const adapter = findAdapter(capability);
  if (!adapter.refresh) return null;
  return adapter.refresh({ ...context, capability });
}
