import type { Scene } from './model.mjs';
export const MAX_PACKAGE_BYTES: number;
export function createScenePackage(
  scene: Scene,
  options?: { provenance?: Record<string, unknown> },
): Promise<Uint8Array<ArrayBuffer>>;
export function readScenePackage(
  bytes: ArrayBuffer | Uint8Array,
): Promise<Scene>;
