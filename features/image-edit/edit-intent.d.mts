export const MAX_PALETTE_PAIRS: number;
export type PalettePair = { from: string; to: string };
export function planImageIntent(description: string, hasReferences?: boolean):
  | { route: 'empty'; operation?: undefined }
  | { route: 'invalid'; reason: string; operation?: undefined }
  | { route: 'local'; operation: { type: 'erase' } | { type: 'translate'; dx: number; dy: number } | { type: 'replace-color'; from: string; to: string } | { type: 'palette-map'; pairs: PalettePair[] } }
  | { route: 'ai'; operation: { type: 'ai-edit'; prompt: string } };
