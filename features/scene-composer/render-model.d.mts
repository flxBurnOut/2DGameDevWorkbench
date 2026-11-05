import type { Instance, Material, Scene, SceneLayer, Point } from './model.mjs';
import type { MapSplitElement, MapSplitPart } from './map-split.mjs';
import type { SimInstance } from '../interactable-editor/simulator.mjs';
import { stateAppearance } from '../interactable-editor/simulator.mjs';
type ObjectDefinition = Material['project']['objects'][number];
export type MapSplitRenderEntry = { key: string; id: string; kind: 'map-split-part'; element: MapSplitElement; part: MapSplitPart; rect: { x: number; y: number; width: number; height: number }; zIndex: number };
export type SceneDisplayEntry = MapSplitRenderEntry |
  { key: string; id: string; kind: 'actor'; zIndex: number } |
  { key: string; id: string; kind: 'layer'; layer: SceneLayer; zIndex: number } |
  { key: string; id: string; kind: 'instance'; instance: Instance; zIndex: number };
export function mapSplitElementOrigin(scene: Scene, element: MapSplitElement): Point;
export function mapSplitElementRect(scene: Scene, element: MapSplitElement): { x: number; y: number; width: number; height: number };
export function activeMapCollisions(scene: Scene): { index: number; points: Point[] }[];
export function sceneDisplayOrder(scene: Scene, options?: { includeDisabled?: boolean }): SceneDisplayEntry[];
export function mapSplitPartRenderEntries(scene: Scene, options?: { includeHidden?: boolean; includedOnly?: boolean }): MapSplitRenderEntry[];
export function instanceRect(instance: Instance, material: Material): { x: number; y: number; width: number; height: number };
export function objectRenderState(instance: Instance, material: Material, options?: { time?: number; simulated?: SimInstance; preview?: boolean }): {
  object: ObjectDefinition;
  visual: ObjectDefinition['visual'];
  appearance: ReturnType<typeof stateAppearance>;
  completedHidden: boolean;
  visible: boolean;
  enabled: boolean;
  frame: ObjectDefinition['visual']['clips'][number]['frames'][number] | undefined;
  assetId: string;
  asset: Material['project']['assets'][number] | undefined;
  origin: { x: number; y: number };
  renderRect: { x: number; y: number; width: number; height: number };
  opacity: number;
  outerTransform: string;
  innerTransform: string;
  rgb: number[];
  placeholderFill: string;
};
