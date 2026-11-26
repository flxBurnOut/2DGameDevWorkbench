export type DocumentKind = 'interactable';
export interface SharedDocument<T = unknown> {
  id: string;
  kind: DocumentKind;
  revision: number;
  name: string;
  content: T;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  viewPath: string;
}
export interface DocumentResult<T> {
  document: SharedDocument<T>;
  currentRevision?: number;
  replayed?: boolean;
}
export type SharedDocumentSummary = Pick<SharedDocument, 'id' | 'kind' | 'revision' | 'name' | 'createdAt' | 'updatedAt' | 'viewPath'>;
export interface SharedDocumentPage {
  documents: SharedDocumentSummary[];
  total: number;
  nextOffset?: number | null;
  issues?: Array<{ record: string; message: string }>;
}
export class DocumentClientError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'DocumentClientError';
  }
}
async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/workbench/documents${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
  });
  const value = await response.json() as { error?: unknown; code?: string };
  if (!response.ok) throw new DocumentClientError(typeof value.error === 'string' ? value.error : '共享工程请求未完成。', response.status, value.code);
  return value as T;
}
export type DocumentMediaOptions = { media?: 'references' | 'embedded' };
export function readDocument<T>(id: string, revision?: number, options: DocumentMediaOptions = {}) {
  const query = new URLSearchParams();
  if (revision !== undefined) query.set('revision', String(revision));
  if (options.media) query.set('media', options.media);
  return request<DocumentResult<T>>(`/${encodeURIComponent(id)}${query.size ? `?${query}` : ''}`);
}
export function readDocumentMetadata(id: string) {
  return request<DocumentResult<never>>(`/${encodeURIComponent(id)}?metadataOnly=true`);
}
export function listDocuments(kind?: DocumentKind, offset = 0, signal?: AbortSignal) {
  const query = new URLSearchParams({ offset: String(offset), limit: '100' });
  if (kind) query.set('kind', kind);
  return request<SharedDocumentPage>(`?${query}`, undefined, signal);
}
export function createDocument<T>(kind: DocumentKind, content: T, commandId = crypto.randomUUID(), options: DocumentMediaOptions = {}) {
  return request<DocumentResult<T>>(options.media ? `?media=${options.media}` : '', { kind, content, commandId });
}
export function saveDocument<T>(id: string, expectedRevision: number, content: T, commandId = crypto.randomUUID(), options: DocumentMediaOptions = {}) {
  return request<DocumentResult<T>>(`/${encodeURIComponent(id)}/save${options.media ? `?media=${options.media}` : ''}`, { expectedRevision, content, commandId });
}
export function applyDocument<T>(id: string, expectedRevision: number, commands: Array<Record<string, unknown>>, commandId: string = crypto.randomUUID()) {
  return request<DocumentResult<T>>(`/${encodeURIComponent(id)}/apply`, { expectedRevision, commands, commandId });
}

export type MotionSlotBinding = {
  assetId: string; assetRevision: string; workId: string; workRevision: number; candidateIndex: number; stageIndex: number | null;
  checkpointToken: string; frameHashes: string[]; documentRevision: number; current: boolean;
  derivation?: string; durations?: number[]; playback?: 'once' | 'ping_pong';
};
export type MotionBindings = {
  documentId: string; revision: number; contentHash: string;
  objects: { definitionId: string; name: string; kind: 'toggle' | 'sequence'; target: 'toggle-state' | 'sequence-entry'; initialToggle?: boolean;
    slots: { index: number; name: string; state: MotionSlotBinding | null; transition: MotionSlotBinding | null; otherImage: string | null }[] }[];
};
/** Read-only: motion assets bound to each toggle state or sequence entry. */
export function readMotionBindings(id: string, definitionId?: string) {
  const query = definitionId ? `?${new URLSearchParams({ definitionId })}` : '';
  return request<MotionBindings>(`/${encodeURIComponent(id)}/motion-bindings${query}`);
}
