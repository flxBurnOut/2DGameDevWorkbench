export const DOCUMENT_MEDIA_PREFIX: string;
export type DocumentMediaReference = { key: string; sha256: string; mime: string; extension: string };
export type DocumentMediaSlot = { owner: Record<string, unknown>; key: string; mime: string; name: string; width?: number; height?: number };
export function documentMediaReference(sha256: string, mime: string): string;
export function parseDocumentMediaReference(source: unknown): DocumentMediaReference | null;
export function mediaTypeMatches(reference: string, mime: string): boolean;
export function documentMediaReferences(kind: string, content: unknown): DocumentMediaSlot[];
