import type { Asset, InteractableProject } from './contract.mjs';
import type { StoredTask } from '../../lib/workbench/work-items';
export type PropArtTarget = {
  projectId: string;
  definitionId: string;
  previousAssetId: string;
};
export function propArtJson<T>(
  url: string,
  init?: RequestInit,
  request?: typeof fetch,
): Promise<T>;
export function isPropArtTask(task: unknown): boolean;
export function propImagePath(task: StoredTask | null): string | undefined;
export function readPropArtAsset(
  taskId: string,
  request?: typeof fetch,
): Promise<Asset>;
export function readImagePropAsset(taskId: string, request?: typeof fetch): Promise<Asset>;
export function applyPropArt(
  project: InteractableProject,
  target: PropArtTarget,
  asset: Asset,
): InteractableProject;
