export function isPaidTask(capabilityId, operation) {
  if (capabilityId === 'reference-art') return operation === 'generate';
  if (capabilityId === 'image-assets') return ['generate-prop', 'edit-image'].includes(operation);
  return capabilityId === 'sprite-generator' && ['create-and-generate', 'generate-existing', 'plan-motion', 'revise-motion',
    'generate-motion', 'review-motion-stage', 'repair-motion-stage', 'create-motion-adjustment', 'resume-motion', 'recover'].includes(operation);
}

export function isPaidMotionPath(path) {
  return path === 'open-motion' || /^open-motion\/[a-f0-9]{32}\/(?:revise|generate|resume|recover|review-stage|repair-stage|adjustments|temporal)$/.test(path) ||
    path === 'open-motion/structures' || /^open-motion\/temporal-structures\/[a-f0-9]{32}\/review$/.test(path);
}
