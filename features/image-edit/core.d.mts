export type RgbaPixels = Uint8Array | Uint8ClampedArray;
export type PixelPoint = { x: number; y: number };
export type PixelBounds = { x: number; y: number; width: number; height: number };
export type RgbaChange = { offset: number; before: number[]; after: number[] };
export type RegionSpec =
  | { type: 'all' }
  | ({ type: 'rectangle' } & PixelBounds)
  | { type: 'polygon'; points: PixelPoint[] }
  | { type: 'mask-runs'; spans: { startPixel: number; length: number }[] }
  | { type: 'alpha-bounds'; threshold?: number }
  | { type: 'alpha-selection'; minAlpha?: number; maxAlpha?: number }
  | { type: 'connected-color'; x: number; y: number; tolerance?: number };
export type LocalOperation =
  | { type: 'clean-alpha'; threshold?: number }
  | { type: 'palette-map'; pairs: { from: string; to: string }[] }
  | { type: 'replace-color'; from: string; to: string; match?: 'exact-rgb' }
  | { type: 'fill'; x: number; y: number; rgba: [number, number, number, number] }
  | { type: 'erase' }
  | { type: 'translate'; dx: number; dy: number }
  | { type: 'restore-region' }
  | { type: 'pixel-patch'; spans: { startPixel: number; before: RgbaPixels; after: RgbaPixels }[] };
export const LOCAL_EDIT_LIMITS: Readonly<{ maxEdge: 3840; maxPixels: 8294400; maxPolygonPoints: 1024; maxMaskRuns: 65536; sharedChangeListPixels: 65536; maxPatchBytes: 524288 }>;
/** mask: 1 editable / 0 protected. Bounds describe selected pixel coverage. */
export function resolveRegion(pixels: RgbaPixels, width: number, height: number, spec: RegionSpec): { mask: Uint8Array; count: number; bounds: PixelBounds | null };
export function maskSummary(mask: Uint8Array, width: number, height: number): { mask: Uint8Array; count: number; bounds: PixelBounds | null };
/** bounds describe actual four-channel changes; effectiveMask expands for translate. */
export function applyLocalOperation(input: {
  pixels: RgbaPixels; width: number; height: number; mask: Uint8Array;
  operation: LocalOperation; restorePixels?: RgbaPixels;
}): {
  pixels: Uint8ClampedArray;
  effectiveMask: Uint8Array;
  changedPixelCount: number;
  bounds: PixelBounds | null;
  alphaPreserved: boolean;
  supportedConstraints: { preserveDimensions: true; preserveOutsideEffectiveMask: true; preserveAlpha: boolean; regionScope: 'source-and-destination' | 'selected-region' };
};

// Original character-editor primitives, re-exported without copying algorithms.
export function screenToPixel(input: { screenX: number; screenY: number; originX: number; originY: number; zoom: number; width: number; height: number }): PixelPoint | null;
export function rasterIntegerLine(from: PixelPoint, to: PixelPoint): PixelPoint[];
export function applyRgbaChanges(buffer: RgbaPixels, changes: RgbaChange[], direction: 'undo' | 'redo'): void;
export function stampSquareRgba(buffer: RgbaPixels, width: number, height: number, center: PixelPoint, size: number, rgba: number[]): RgbaChange[];
export function normalizeSelection(from: PixelPoint, to: PixelPoint, width: number, height: number): PixelBounds | null;
export function opaqueBoundsRgba(buffer: RgbaPixels, width: number, height: number, alphaThreshold?: number): PixelBounds | null;
export function alphaGeometryRgba(buffer: RgbaPixels, width: number, height: number, alphaThreshold?: number): { visible: number; centroid: PixelPoint; bbox: PixelBounds } | null;
export function floodFillRgba(buffer: RgbaPixels, width: number, height: number, start: PixelPoint, replacement: number[]): RgbaChange[];
export function clearSelectionRgba(buffer: RgbaPixels, width: number, height: number, selection: PixelBounds): RgbaChange[];
export function translateSelectionRgba(buffer: RgbaPixels, width: number, height: number, selection: PixelBounds, dx: number, dy: number): { changes: RgbaChange[]; selection: PixelBounds; blocked: boolean };
export function diffRgbaSummary(buffer: RgbaPixels, baseBuffer: RgbaPixels, width: number, height: number): { count: number; bbox: PixelBounds | null };
export function threeWayMergeRgba(baseBuffer: RgbaPixels, draftBuffer: RgbaPixels, currentBuffer: RgbaPixels, width: number, height: number): {
  pixels: Uint8ClampedArray; changes: RgbaChange[]; userChangeCount: number; recoveredCount: number; conflictCount: number; conflictBbox: PixelBounds | null;
} | null;
