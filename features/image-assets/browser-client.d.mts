import type { StoredTask } from '../../lib/workbench/work-items';
export type ImageAssetKind = 'background' | 'prop';
export type ImageGeneration = { sourceTaskId: string; sha256: string };
export type VerifiedImageAsset = {
  task: StoredTask; imagePath: string; bytes: Uint8Array; width: number; height: number;
  kind: ImageAssetKind; generation: ImageGeneration; provider?: string; model?: string; name: string;
};
export const IMAGE_ASSET_MAX_BYTES: number;
export function imageArtifactUrl(path: string): string;
export function imageAssetJson<T>(url: string, init?: RequestInit, request?: typeof fetch): Promise<T>;
export function imageAssetKind(task: unknown): ImageAssetKind | undefined;
export function imageAssetPath(task: StoredTask | null): string | undefined;
export function imageBytesSha256(bytes: Uint8Array): Promise<string>;
export function imageBytesDataUrl(bytes: Uint8Array, mime?: string): string;
export function readImageAsset(taskId: string, kind: ImageAssetKind, request?: typeof fetch): Promise<VerifiedImageAsset>;
export function imageReferenceUpload(file: File): Promise<string>;
export function storeTaskImageReference(file: File, request?: typeof fetch): Promise<string>;
export function storeInlineTaskImages(input: Record<string, unknown>, request?: typeof fetch): Promise<Record<string, unknown>>;
