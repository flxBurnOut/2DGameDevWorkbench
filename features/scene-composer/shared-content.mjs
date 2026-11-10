import { createScene, validateScene } from './model.mjs';

const defaultView = createScene().view;

// Keep the portable Scene format, but never publish a browser's personal camera
// or display preferences as shared edits. Historical snapshots remain readable.
export function sharedSceneContent(input) {
  return { ...validateScene(input), revision: 0, view: { ...defaultView } };
}

export function sameSceneContent(left, right) {
  return JSON.stringify(sharedSceneContent(left)) === JSON.stringify(sharedSceneContent(right));
}

export function sceneWithLocalView(incoming, local) {
  const scene = validateScene(incoming);
  if (local?.id === scene.id) scene.view = { ...local.view };
  return scene;
}
