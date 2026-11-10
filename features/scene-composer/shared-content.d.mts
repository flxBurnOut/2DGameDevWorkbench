import type { Scene } from './model.mjs';
export function sharedSceneContent(input: Scene): Scene;
export function sameSceneContent(left: Scene, right: Scene): boolean;
export function sceneWithLocalView(incoming: Scene, local?: Scene): Scene;
