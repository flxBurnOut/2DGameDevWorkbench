import type { PixelBounds, RegionSpec, RgbaPixels } from './core.mjs';
export interface MetalPanelOperation {
  type: 'metal-panel'; frame: PixelBounds; color: string; position: number;
  angle: number; bandWidth: number; strength: number; cellSize: number;
}
export interface PanelCrop { frame: PixelBounds; rgba: Uint8ClampedArray; allowed: Uint8Array }
export interface PanelSeam { top: number; bottom: number }
export const PANEL_MAX_EDGE: number;
export const metalPanelOperationSchema: import('zod/v4').ZodType<MetalPanelOperation>;
export function cropPanel(pixels: RgbaPixels, mask: Uint8Array, width: number, height: number): PanelCrop;
export function panelRegion(mask: Uint8Array, frame: PixelBounds, sourceWidth: number): RegionSpec;
export function tracePanelSeam(crop: PanelCrop, hint: number, cellSize: number): PanelSeam | null;
export function snapPanelMask(selected: Uint8Array, allowed: Uint8Array, frame: PixelBounds, cellSize: number): Uint8Array;
export function paintMetalPanel(output: Uint8ClampedArray, width: number, mask: Uint8Array, operation: MetalPanelOperation, origin?: { x: number; y: number }): void;
