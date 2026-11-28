import type { PixelBounds, PixelPoint, RegionSpec, RgbaPixels } from './core.mjs';
export type PixelSpan = { startPixel: number; before: Uint8Array; after: Uint8Array };
export function compactPixelChanges(changes: Iterable<{ offset: number; before: number[]; after: number[] }>): PixelSpan[];
export class PixelController {
  constructor(source: RgbaPixels, width: number, height: number, base?: RgbaPixels, historyBudget?: number);
  readonly width: number; readonly height: number;
  readonly sourcePixels: Uint8ClampedArray; readonly basePixels: Uint8ClampedArray; readonly pixels: Uint8ClampedArray;
  mask: Uint8Array; region: RegionSpec | null; selectionCount: number; maskRevision: number;
  readonly dirty: boolean; readonly dirtyPixelCount: number;
  readonly canUndoPixels: boolean; readonly canRedoPixels: boolean; readonly canUndoMask: boolean; readonly canRedoMask: boolean;
  readonly maskStrokeActive: boolean;
  takeDirtyBounds(): PixelBounds | null;
  takeMaskDirtyBounds(): PixelBounds | null;
  setBase(base: RgbaPixels): void;
  beginMaskStroke(mode?: 'add' | 'replace'): void; maskStroke(point: PixelPoint, mode: 'add' | 'erase', size?: number): void; endMaskStroke(): void; cancelMaskStroke(): void;
  beginStroke(): void;
  stroke(point: PixelPoint, tool: 'pencil' | 'eraser', rgba: number[], size?: number): void;
  endStroke(): void; cancelStroke(): void;
  undoPixels(): void; redoPixels(): void; undoMask(): void; redoMask(): void;
  /** One undo order across strokes and selection changes. */
  readonly canUndo: boolean; readonly canRedo: boolean;
  undo(): 'pixel' | 'mask' | null; redo(): 'pixel' | 'mask' | null;
  /** Pixels of the current/last stroke written, and those dropped outside the selection. */
  readonly strokeWritten: number; readonly strokeBlocked: number;
  selectRegion(spec: RegionSpec | null, remember?: boolean): void;
  combineRegion(spec: RegionSpec, mode?: 'replace' | 'add' | 'subtract'): void;
  selectRectangle(from: PixelPoint, to: PixelPoint, mode?: 'replace' | 'add' | 'subtract'): void;
  patch(): PixelSpan[];
  restorePatch(spans: PixelSpan[]): void;
  discardPixels(): void;
}
