export function requestSceneSplit<T = Record<string, unknown>>(
  operation: string,
  input: unknown,
  fetcher?: typeof fetch,
): Promise<T>;
export function splitPreviewUrl(image: {
  mimeType?: string;
  data?: string;
}): string;
export function parseSplitSpecDraft(text: string): Record<string, unknown>[];
export function watchSceneSplit(
  query: () => Promise<string | undefined>,
  onError: (error: unknown, stopped: boolean) => void,
  options?: { delay?: number; maxFailures?: number },
): () => void;
export { splitCollisionTransfer } from '@/features/scene-composer/map-split.mjs';
