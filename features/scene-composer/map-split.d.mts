import type { Scene, Point, Flags } from './model.mjs';
export type MapSplitPart = {
  id: string;
  role: 'art' | 'effect';
  plane: 'back' | 'front';
  x: number;
  y: number;
  width: number;
  height: number;
  source: string;
  mask?: string;
  enabled: boolean;
};
export type MapSplitElement = Flags & {
  id: string;
  name: string;
  kind: 'object' | 'background' | 'surface';
  x: number;
  y: number;
  positionMode: 'relative' | 'world';
  parts: MapSplitPart[];
  collision: { enabled: boolean; polygons: Point[][]; mapIndices: number[] };
  sourceKey?: string;
};
export type MapSplitConflict = {
  id: string;
  elementId: string;
  field: string;
  reason: string;
  baseline?: unknown;
  current?: unknown;
  incoming?: unknown;
  candidates?: string[];
  resolution?: 'current' | 'incoming' | 'delete';
};
export type MapSplitMatch = { oldId: string; newId: string; evidence?: string };
export type MapSplitResolution = {
  conflictId: string;
  choice: 'current' | 'incoming' | 'delete';
};
export type MapSplit = {
  version: 1;
  candidateId: string;
  candidateRevision?: number;
  sourceHash: string;
  origin: Point;
  review: 'unverified' | 'reviewed';
  stale: boolean;
  baseline: MapSplitElement[];
  elements: MapSplitElement[];
  conflicts: MapSplitConflict[];
  tombstones?: string[];
  matches?: (MapSplitMatch & { evidence: string })[];
  deletedMapCollisions?: { elementId: string; mapIndices: number[] }[];
  resolutions?: MapSplitResolution[];
};
export const mapSplitPartSchema: import('zod').ZodTypeAny;
export const mapSplitElementSchema: import('zod').ZodTypeAny;
export const mapSplitSchema: import('zod').ZodTypeAny;
export function validateMapSplit(
  input: unknown,
  options?: { allowPackageReferences?: boolean; mapCollisionCount?: number },
): MapSplit;
export type MapSplitMergeOptions = {
  origin?: Point;
  matches?: MapSplitMatch[];
  resolutions?: MapSplitResolution[];
  referencedIds?: string[];
};
export function mergeMapSplit(
  previous: MapSplit,
  candidate: MapSplit,
  options?: MapSplitMergeOptions,
): MapSplit;
export function applyMapSplit(
  scene: Scene,
  candidate: MapSplit,
  options?: MapSplitMergeOptions,
): MapSplit;
export function installMapSplit(scene: Scene, split: MapSplit): MapSplit;
export function mapSplitDeletedCollisionOwners(
  split: MapSplit | null | undefined,
): { elementId: string; mapIndices: number[] }[];
export function mapSplitCollisionOwner(
  scene: Scene,
  index: number,
): { elementId: string; name: string; deleted: boolean } | undefined;
export function splitCollisionTransfer(
  scene: Scene,
  elementId: string,
  indices: number[],
  replacementPolygons?: MapSplitElement['collision']['polygons'],
): MapSplitElement['collision'];
export function removeMapSplitElements(scene: Scene, ids: string[]): string[];
