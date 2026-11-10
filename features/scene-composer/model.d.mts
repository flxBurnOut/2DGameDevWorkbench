import type { InteractableProject } from '../interactable-editor/contract.mjs';
import type { SceneLink } from './links.mjs';
import type { MapSplit } from './map-split.mjs';
export type Point = { x: number; y: number };
export type Flags = { locked: boolean; hidden: boolean; included: boolean };
export type SceneLayer = Flags & {
  id: string;
  name: string;
  source: string;
  width: number;
  height: number;
};
export type SceneMap = {
  name: string;
  origin: Point;
  offset: Point;
  layers: SceneLayer[];
  collisions: Point[][];
  collisionOverride?: { sourceCollisions: Point[][] };
  source: string;
  warnings: string[];
};
export type Material = {
  id: string;
  name: string;
  project: InteractableProject;
};
export type Instance = Flags & {
  id: string;
  materialId: string;
  name: string;
  x: number;
  y: number;
  scale: number;
  flipH: boolean;
  anchor: Point;
};
export type Scene = {
  format: 'workbench-scene';
  version: 1;
  id: string;
  name: string;
  revision: number;
  map: SceneMap | null;
  mapSplit?: MapSplit;
  materials: Material[];
  instances: Instance[];
  order: string[];
  links: SceneLink[];
  view: {
    x: number;
    y: number;
    zoom: number;
    grid: number;
    aidsVersion: number;
    showGrid: boolean;
    showNames: boolean;
    showShapes: boolean;
    showActor: boolean;
  };
};
export function createScene(name?: string): Scene;
export const wholeMapSplitHint: string;
export function validateScene(input: unknown, options?: { allowPackageReferences?: boolean }): Scene;
export function materialFor(
  scene: Scene,
  instance: Instance,
): Material | undefined;
export function addMaterial(
  scene: Scene,
  project: InteractableProject,
  definitionId: string,
  materialId?: string,
): Material;
export function sceneMaterialProject(project: InteractableProject, definitionId: string): InteractableProject;
export function addInstance(
  scene: Scene,
  materialId: string,
  x: number,
  y: number,
  instanceId?: string,
): Instance;
export function reorder(
  scene: Scene,
  ids: string[],
  action: string,
  target?: string | number,
): void;
export function removeInstances(scene: Scene, ids: string[]): string[];
export function replaceInstances(
  scene: Scene,
  ids: string[],
  materialId: string,
): void;
export function replaceMap(scene: Scene, map: SceneMap): void;
export function instanceOrigin(instance: Instance): Point;
export function changeAnchor(instance: Instance, anchor: Point): void;
export function sceneBounds(scene: Scene): {
  x: number;
  y: number;
  width: number;
  height: number;
};
export function sceneWarnings(scene: Scene): string[];
