import { z } from 'zod';
export type Shape = {
  type: 'rectangle' | 'circle' | 'capsule';
  width: number;
  height: number;
  radius: number;
  offset: { x: number; y: number };
};
export type Appearance = {
  staticImage?: boolean;
  assetId: string;
  animation: string;
  visible: boolean;
  solidEnabled: boolean;
  tint: string;
};
export type Feedback =
  | { type: 'show_text'; pages: string[] }
  | { type: 'wait'; seconds: number }
  | { type: 'play_animation'; importedTransition?: true; animation: string; waitForEnd: boolean }
  | {
      type: 'play_audio';
      assetId: string;
      waitForEnd: boolean;
      volumeDb: number;
    };
export type Entry = {
  name: string;
  pages: string[];
  appearance: Appearance;
  feedback: Feedback[];
};
export type Kind = 'inspect' | 'toggle' | 'pickup' | 'sequence';
export type ExportProfile = 'generic';
export type Clip = {
  name: string;
  fps: number;
  loop: boolean;
  frames: {
    assetId: string;
    region?: { x: number; y: number; width: number; height: number };
    duration: number;
  }[];
};
export type Asset = { id: string; name: string; mime: string; source: string; generation?: { sourceTaskId: string; sha256: string } };
export type Interactable = {
  definitionId: string;
  displayName: string;
  visual: {
    assetId: string;
    width: number;
    height: number;
    offset: { x: number; y: number };
    scale: number;
    flipH: boolean;
    flipV: boolean;
    zIndex: number;
    visible: boolean;
    tint: string;
    idleAnimation: string;
    focusAnimation: string;
    float: boolean;
    dot: boolean;
    clips: Clip[];
  };
  detection: {
    shape: Shape;
    actorGroup: string;
    mask: number;
    priority: number;
  };
  pointer: Shape;
  solid: { enabled: boolean; shape: Shape; layer: number; mask: number };
  activation: {
    mode:
      | 'proximity_press'
      | 'pointer_click'
      | 'automatic_enter'
      | 'external_request';
    action: string;
    key: string;
    cancelOnExit: boolean;
    enabled: boolean;
  };
  content: {
    prompt: string;
    pages: string[];
    charactersPerSecond: number;
    promptOffset: { x: number; y: number };
  };
  behavior: {
    kind: Kind;
    repeat: boolean;
    initialToggle: boolean;
    states: Entry[];
    entries: Entry[];
    onEnd: 'stop' | 'loop' | 'stay_last';
  };
  feedback: Feedback[];
  cooldownSeconds: number;
  completion: 'remain' | 'hide' | 'free';
  memory: {
    scope: 'instance' | 'session' | 'persistent';
    namespace: string;
    slot: string;
  };
};
export type InteractableProject = {
  schemaVersion: 1;
  projectId: string;
  name: string;
  assets: Asset[];
  objects: Interactable[];
};
export const KIT_VERSION: string;
export const KINDS: Kind[];
export const KIND_LABELS: Record<Kind, string>;
export const TRIGGERS: Interactable['activation']['mode'][];
export const objectSchema: z.ZodType<Interactable>;
export const projectSchema: z.ZodType<InteractableProject>;
export const assetSchema: z.ZodType<Asset>;
export function makeId(prefix?: string): string;
export function createObject(kind?: Kind): Interactable;
export function createProject(): InteractableProject;
export function nextClipName(object: Interactable): string;
export function appearanceAnimation(appearance: Partial<Appearance>, visual: Interactable['visual']): string;
export function normalizeProject(input: unknown): InteractableProject;
export function selectedProject(
  input: unknown,
  ids?: string[],
): InteractableProject;
export function referencedAssets(p: InteractableProject): Asset[];
export function describeError(error: unknown): string;
