import type { RegionSpec } from './core.mjs';
import type { PixelSpan } from './pixel-controller.mjs';
import type { Interactable } from '../interactable-editor/contract.mjs';

export type ImageTargetRef =
  | { kind: 'map-layer'; projectId: string; tileKey: string; layer: 'overall' | 'surface' | 'object' | 'black' | 'white' }
  | { kind: 'interactable'; documentId: string; definitionId: string; slot?: 'visual' | 'toggle-state' | 'sequence-entry'; index?: number }
  | { kind: 'image-task'; taskId: string }
  | { kind: 'scene-layer'; documentId: string; layerId: string }
  | { kind: 'scene-instance'; documentId: string; instanceId: string; slot?: 'visual' | 'toggle-state' | 'sequence-entry'; index?: number };
export interface ImageTargetInfo {
  targetId: string; targetRef: ImageTargetRef; revision: number | string; sha256: string; rgbaSha256: string;
  width: number; height: number; editable: boolean; locked: boolean; kind: 'prop' | 'background'; name: string;
  placement?: { width: number; height: number; x: number; y: number; flipH: boolean; flipV: boolean };
  slotFingerprint?: string; readOnlyReason?: string; source?: Record<string, unknown>; willStopDefaultAnimations?: boolean;
  scope?: 'single-instance' | 'scene-snapshot-layer'; affectedInstanceIds?: string[]; sharedInstanceCount?: number;
  sourceEntry?: { kind?: string; documentId?: string; layerId?: string; sourceField?: string; filename?: string; format?: string; sha256?: string; viewPath?: string; action?: string };
  aiEdit?: { supported: boolean; reason?: string; code?: string; provider: string; model?: string; width: number; height: number; minPixels: number; maxPixels: number; maxEdge: number; dimensionStep: number; maxAspectRatio: number; maxReferences: number; maxImageBytes: number; maxTotalImageBytes: number; constraints: { preserveOutsideRegion: true; preserveDimensions: true; preserveAlpha: boolean }; alphaPreservation?: 'copy-edit-base-alpha' };
}
export interface ImageAdoptionReceipt {
  target: ImageTargetInfo; revision: number | string; currentRevision: number | string; replayed?: boolean;
  adoption: { status: 'adopted' | 'saved_variant'; targetId?: string; sourceTaskId?: string; sha256: string; revision?: number | string; commandId: string; documentId?: string; definitionId?: string; slot?: string; index?: number; assetId?: string; sourceChanged?: boolean; previewInvalidated?: boolean; scope?: 'single-instance' | 'scene-snapshot-layer'; affectedInstanceIds?: string[]; sharedInstanceCount?: number };
}
export interface ImageEditContextLayer { id?: string; url: string; x?: number; y?: number; width: number; height: number; opacity?: number; target?: boolean }
export interface ImagePixels {
  imageBase64: string; imageMimeType: string; width: number; height: number; sha256: string;
  rgbaSha256: string; rgbaBase64: string; rgbaByteLength: number; pixelFormat: string;
}
export interface ImageCandidate {
  version: string; taskId?: string; status: string; createdAt: string; error?: string; derivedState?: boolean;
  operation: { type: string }; sha256?: string; rgbaSha256?: string; baseCandidateVersion?: string; previewPath?: string;
  constraints?: { preserveOutsideRegion: boolean; preserveDimensions: boolean; preserveAlpha: boolean };
  diff?: ImageCandidateDiff; diffFromBase?: ImageCandidateDiff; diffFromSource?: ImageCandidateDiff;
  evidence?: { sourceRgbaSha256?: string; baseRgbaSha256?: string; maskSha256?: string; rawSha256?: string; sha256?: string; processingEvidence?: string; usageEvidence?: string; provider?: string; model?: string; preservation?: { changedOutsideMaskPixels?: number; protectedPixels?: number; editablePixels?: number }; alphaPreservation?: { changedAlphaPixels: number; expectedAlphaSha256: string; actualAlphaSha256: string } | null; alphaCleanup?: { threshold?: number } };
}
export interface ImageCandidateDiff { changedPixelCount: number; changedOutsideRegion: number; alphaChangedPixelCount: number }
export interface ImageEditSession {
  editId: string; revision: number; target: ImageTargetInfo; source: { sha256: string; rgbaSha256: string };
  comparison?: { editId: string; baseCandidateVersion: string; candidateVersion: string; targetRevision: number | string;
    baseSha256: string; candidateSha256: string; width: number; height: number; viewport: { x: number; y: number; width: number; height: number };
    beforePng: string; afterPng: string };
  candidates: ImageCandidate[]; adoptions: unknown[]; selectedVersion?: string; pixels?: ImagePixels;
}
export interface NamedImageRegion { regionId: string; name: string; spec: RegionSpec; stale?: boolean }
export type ImageRelatedKind = 'namedRegions' | 'sessions';
export interface ImageRelatedPage { total: number; nextOffset: number | null }
export interface ImageInspection extends Partial<ImagePixels> {
  target: ImageTargetInfo; namedRegions?: NamedImageRegion[];
  sessions?: { editId: string; revision: number; createdAt: string; canContinue?: boolean; stale?: boolean }[];
  relatedPagination?: { limit: number; offset: number; namedRegions: ImageRelatedPage; sessions: ImageRelatedPage };
  historyOnly?: boolean;
}
export type ImageLocalOperation =
  | import('./metal-panel.mjs').MetalPanelOperation
  | { type: 'clean-alpha'; threshold: number }
  | { type: 'palette-map'; pairs: { from: string; to: string }[] }
  | { type: 'replace-color'; from: string; to: string }
  | { type: 'fill'; x: number; y: number; rgba: [number, number, number, number] }
  | { type: 'erase' }
  | { type: 'translate'; dx: number; dy: number }
  | { type: 'restore-region'; candidateVersion: string }
  | { type: 'pixel-patch'; baseRgbaSha256: string; spans: { startPixel: number; beforeRgbaBase64: string; afterRgbaBase64: string }[] };
export type ImageAiOperation = { type: 'ai-edit'; prompt: string; references?: string[] };
export type ImageEditOperation = ImageLocalOperation | ImageAiOperation;
export interface ImageAiReference { id: string; name: string; source: string; bytes: number }
export const IMAGE_AI_REFERENCE_LIMITS = Object.freeze({ count: 8, perImageBytes: 30 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
export class ImageEditClientError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'ImageEditClientError'; }
}
export async function imageEditRequest<T>(operation: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/workbench/image-edit/${operation}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
  });
  const value = await response.json() as { error?: unknown; code?: string };
  if (!response.ok) throw new ImageEditClientError(typeof value.error === 'string' ? value.error : '局部调整请求未完成。', response.status, value.code);
  return value as T;
}
export const imageGuards = (target: ImageTargetInfo) => ({ targetId: target.targetId, expectedRevision: target.revision, expectedSha256: target.sha256 });
export const imageInspectInput = (target: ImageTargetRef, offset = 0) => ({ target, view: 'metadata' as const, includePixels: false, offset });
export const imageSessionInput = (target: ImageTargetInfo, commandId: string) => ({ ...imageGuards(target), commandId });
export const imageResolveInput = (target: ImageTargetInfo, region: RegionSpec | { type: 'named'; regionId: string }, saveAs?: string, commandId?: string) => ({ ...imageGuards(target), region, ...(saveAs ? { saveAs, commandId } : {}) });
export function imageEditInput(target: ImageTargetInfo, edit: ImageEditSession, baseCandidateVersion: string, regionRef: string, operation: ImageEditOperation, preserveAlpha: boolean, commandId: string) {
  return { ...imageGuards(target), editId: edit.editId, expectedEditRevision: edit.revision, baseCandidateVersion, regionRef, operation, constraints: { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha }, commandId };
}
export function imageAiEditInput(target: ImageTargetInfo, edit: ImageEditSession, baseCandidateVersion: string, regionRef: string, prompt: string, references: readonly ImageAiReference[], hasUnsavedPixels: boolean, commandId: string, preserveAlpha = true) {
  if (hasUnsavedPixels) throw new Error('请先保存未保存笔划，再生成 AI 候选。');
  if (!target.aiEdit?.supported) throw new Error(target.aiEdit?.reason || '尚未取得 AI 编辑可用性；请刷新目标状态，本地精修仍可使用。');
  if (!prompt.trim() || prompt.trim().length > 12000) throw new Error('请填写 1–12000 字的修改描述。');
  validateAiReferences(references);
  const operation: ImageAiOperation = { type: 'ai-edit', prompt: prompt.trim(), ...(references.length ? { references: references.map(reference => reference.source) } : {}) };
  if (operation.references) Object.freeze(operation.references);
  Object.freeze(operation);
  const input = imageEditInput(target, edit, baseCandidateVersion, regionRef, operation, preserveAlpha, commandId);
  Object.freeze(input.constraints);
  return Object.freeze(input);
}
export function validateAiReferences(references: readonly ImageAiReference[]) {
  if (references.length > IMAGE_AI_REFERENCE_LIMITS.count) throw new Error('最多选择 8 张参考图。');
  if (references.some(reference => reference.bytes < 1 || reference.bytes > IMAGE_AI_REFERENCE_LIMITS.perImageBytes)) throw new Error('每张参考图须大于 0 且不超过 30 MiB。');
  if (references.reduce((sum, reference) => sum + reference.bytes, 0) > IMAGE_AI_REFERENCE_LIMITS.totalBytes) throw new Error('参考图合计最多 32 MiB；还需为基准图片与蒙版保留空间。');
}
export async function readImageAiReference(file: File): Promise<ImageAiReference> {
  if (file.size < 1 || file.size > IMAGE_AI_REFERENCE_LIMITS.perImageBytes) throw new Error('每张参考图须大于 0 且不超过 30 MiB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP' ? 'image/webp' : null;
  if (!mime) throw new Error('参考图须为实际 PNG、JPEG 或 WebP；服务端还会验证完整图片。');
  return Object.freeze({ id: crypto.randomUUID(), name: file.name, bytes: bytes.byteLength, source: `data:${mime};base64,${bytesToBase64(bytes)}` });
}
export function imageCandidateBase(session: ImageEditSession, requestedVersion?: string) {
  if (!requestedVersion) return { baseVersion: session.candidates.filter(candidate => candidate.status === 'completed').at(-1)?.version || 'source' };
  if (requestedVersion === 'source') return { baseVersion: 'source' };
  const requested = session.candidates.find(candidate => candidate.version === requestedVersion);
  if (!requested) throw new Error('指定候选不存在，未切换到其他版本。');
  if (requested.status === 'completed') return { baseVersion: requestedVersion };
  const baseVersion = requested.baseCandidateVersion || 'source';
  if (baseVersion !== 'source' && !session.candidates.some(candidate => candidate.version === baseVersion && candidate.status === 'completed')) return { baseVersion: 'source', followVersion: requestedVersion };
  return { baseVersion, followVersion: requestedVersion };
}
export function imageSessionNeedsPolling(session: ImageEditSession, followVersion?: string) {
  return !!followVersion || session.candidates.some(candidate => ['running', 'preparing'].includes(candidate.status) || candidate.derivedState);
}
export function imageCandidateFollowState(session: ImageEditSession, followVersion: string | undefined, hasUnsavedPixels: boolean) {
  const candidate = session.candidates.find(item => item.version === followVersion);
  if (!candidate) return { state: 'none' as const, candidate };
  if (candidate.status === 'completed') return { state: hasUnsavedPixels ? 'preserve-draft' as const : 'select' as const, candidate };
  if (!candidate.derivedState && ['failed', 'attention_required', 'awaiting_configuration'].includes(candidate.status)) return { state: 'stopped' as const, candidate };
  return { state: 'waiting' as const, candidate };
}
// Apply is session-bound. It intentionally has no targetId/target field.
export const imageApplyInput = (target: ImageTargetInfo, editId: string, candidateVersion: string, commandId: string) => ({ editId, candidateVersion, expectedRevision: target.revision, expectedSha256: target.sha256, commandId });
export const imageReadInput = (editId: string, candidateVersion?: string, includePixels = false) => ({ editId, includePixels, ...(candidateVersion ? { candidateVersion } : {}) });
export const inspectImage = (target: ImageTargetRef, offset = 0) => imageEditRequest<ImageInspection>('inspect', imageInspectInput(target, offset));
export const readImageEdit = (editId: string, candidateVersion?: string, includePixels = false, signal?: AbortSignal) => imageEditRequest<{ edit: ImageEditSession }>('session-get', imageReadInput(editId, candidateVersion, includePixels), signal);
export const imageInspectionMetadata = (value: ImageInspection): ImageInspection => ({ target: value.target, namedRegions: value.namedRegions, sessions: value.sessions, relatedPagination: value.relatedPagination, historyOnly: value.historyOnly });
export function mergeImageInspectionPage(current: ImageInspection, page: ImageInspection, kind: ImageRelatedKind): ImageInspection {
  if (page.target.targetId !== current.target.targetId || page.target.revision !== current.target.revision || page.target.sha256 !== current.target.sha256) throw new Error('翻页期间目标版本已变，请刷新目标状态；当前笔划保留。');
  const pagination = current.relatedPagination && page.relatedPagination ? { ...current.relatedPagination, [kind]: page.relatedPagination[kind] } : page.relatedPagination;
  if (kind === 'namedRegions') return { ...current, namedRegions: [...new Map([...(current.namedRegions || []), ...(page.namedRegions || [])].map(item => [item.regionId, item])).values()], relatedPagination: pagination };
  return { ...current, sessions: [...new Map([...(current.sessions || []), ...(page.sessions || [])].map(item => [item.editId, item])).values()], relatedPagination: pagination };
}
export interface ImageWorkspaceSnapshot<TController> { metadata: ImageInspection; session: ImageEditSession; controller: TController; baseVersion: string; baseHash: string }
export function mergeImageWorkspaceRefresh<TController>(current: ImageWorkspaceSnapshot<TController>, metadata: ImageInspection, session: ImageEditSession): ImageWorkspaceSnapshot<TController> {
  if (session.editId !== current.session.editId || session.target.targetId !== current.session.target.targetId || metadata.target.targetId !== current.metadata.target.targetId) throw new Error('刷新返回了另一份编辑会话，当前笔划保留。');
  const { pixels: _pixels, ...plain } = session;
  return { ...current, metadata: imageInspectionMetadata(metadata), session: session.revision >= current.session.revision ? plain : current.session };
}
export interface ImageSessionBootstrap { commandId: string; createInput?: ReturnType<typeof imageSessionInput>; editId?: string }
export function imageTargetEquals(left: ImageTargetRef, right: ImageTargetRef) {
  const normalize = (ref: ImageTargetRef) => JSON.stringify(Object.entries(['interactable', 'scene-instance'].includes(ref.kind) ? { ...ref, slot: 'slot' in ref ? ref.slot || 'visual' : 'visual' } : ref).filter(([, value]) => value !== undefined).sort(([first], [second]) => first.localeCompare(second)));
  return normalize(left) === normalize(right);
}
export function imageSlotChoices(object: Interactable, scene = false) {
  const choices: { value: string; slot: 'visual' | 'toggle-state' | 'sequence-entry'; index?: number; label: string; available: boolean; reason?: string }[] = [{ value: 'visual', slot: 'visual', label: '默认图片', available: !!object.visual.assetId && !(scene && (object.visual.idleAnimation || object.visual.focusAnimation)), reason: !object.visual.assetId ? '没有静态源图片' : scene && (object.visual.idleAnimation || object.visual.focusAnimation) ? '场景默认外观使用动画，只读' : undefined }];
  const entries = object.behavior.kind === 'toggle' ? object.behavior.states : object.behavior.kind === 'sequence' ? object.behavior.entries : [];
  entries.forEach((entry, index) => {
    const slot = object.behavior.kind === 'toggle' ? 'toggle-state' : 'sequence-entry';
    const hasImage = !!(entry.appearance.assetId || object.visual.assetId), animated = !!(entry.appearance.animation || object.visual.idleAnimation);
    choices.push({ value: `${slot}:${index}`, slot, index, label: `${slot === 'toggle-state' ? `${index ? 'B' : 'A'} 状态` : `第 ${index + 1} 步`} · ${entry.name}${entry.appearance.assetId ? '' : '（继承默认图）'}`, available: hasImage && !animated, reason: animated ? '此状态使用动画，只读' : !hasImage ? '没有静态源图片' : undefined });
  });
  return choices;
}
export function validateSceneImageReceipt(target: ImageTargetRef, receipt: ImageAdoptionReceipt) {
  if (!['scene-instance', 'scene-layer'].includes(target.kind) || !imageTargetEquals(target, receipt.target.targetRef) || typeof receipt.revision !== 'number' || receipt.currentRevision !== receipt.revision) throw new Error('已采用结果与选中的场景图片或共享版本不匹配。');
  if (target.kind === 'scene-instance' && (receipt.adoption.scope !== 'single-instance' || receipt.adoption.affectedInstanceIds?.length !== 1 || receipt.adoption.affectedInstanceIds[0] !== target.instanceId)) throw new Error('实例采用作用域不匹配，未替换本机场景。');
}
export interface ImageSourceActionState { busy: boolean; pending: boolean; pixelDirty: boolean; aiDraftDirty: boolean; referencesLoading: boolean }
export function imageSourceActionBlockReason(state: ImageSourceActionState, opensEditor: boolean) {
  if (state.busy || state.pending || state.referencesLoading) return '请等待当前请求或参考图读取完成，再打开或下载源包。';
  if (opensEditor && (state.pixelDirty || state.aiDraftDirty)) return '请先保存笔划并提交 AI 草稿，或关闭调整窗口并确认舍弃未保存内容，再打开源包。';
  return '';
}
export async function performImageSourceAction(target: ImageTargetInfo, state: ImageSourceActionState, opensEditor: boolean, action: (target: ImageTargetInfo) => void | Promise<void>) {
  const reason = imageSourceActionBlockReason(state, opensEditor);
  if (reason) throw new Error(reason);
  await action(target);
}
/** Verify the exact snapshot bytes that will be handed off, rather than a newer metadata label. */
export async function verifiedSceneImageSource(target: ImageTargetInfo, snapshot: { id: string; revision: number | string; content: { map: { source: string; layers: { id: string }[] } | null } }) {
  const ref = target.targetRef, entry = target.sourceEntry, map = snapshot.content.map;
  if (ref.kind !== 'scene-layer' || !map || ref.documentId !== snapshot.id || entry?.documentId !== snapshot.id || entry.layerId !== ref.layerId || entry.kind !== 'embedded-map-source' || entry.sourceField !== 'map.source' || !map.layers.some(layer => layer.id === ref.layerId)) throw new Error('源包所属场景或图层不匹配；请关闭调整窗口并刷新宿主场景。');
  if (target.revision !== snapshot.revision || !entry.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('源包版本与当前宿主场景不一致；请关闭调整窗口并刷新宿主场景。');
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(map.source);
  if (!match) throw new Error('宿主未持有可验证的嵌入源包；请刷新宿主场景。');
  const binary = atob(match[2]), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (await rgbaHash(bytes) !== entry.sha256) throw new Error('嵌入源包内容已变化，与当前图片来源证据不一致；请关闭调整窗口并刷新宿主场景。');
  return { source: map.source, blob: new Blob([bytes], { type: match[1] }) };
}
export async function openImageSession(target: ImageTargetRef, attempt: ImageSessionBootstrap) {
  if (attempt.editId) {
    const { edit } = await readImageEdit(attempt.editId);
    if (!imageTargetEquals(target, edit.target.targetRef)) throw new Error('会话属于另一图片目标，未打开历史。');
    try { return { inspection: await inspectImage(target), edit }; }
    catch (cause) {
      const reason = cause instanceof Error ? cause.message : '当前来源不可读取。';
      return { inspection: { target: { ...edit.target, editable: false, locked: true, readOnlyReason: `当前目标不可读取；只读历史候选。${reason}` }, historyOnly: true }, edit };
    }
  }
  const inspection = await inspectImage(target);
  attempt.createInput ||= imageSessionInput(inspection.target, attempt.commandId);
  const { edit } = await imageEditRequest<{ edit: ImageEditSession }>('session-create', attempt.createInput);
  attempt.editId = edit.editId;
  return { inspection, edit };
}
export function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return btoa(binary);
}
export function base64ToBytes(encoded: string, maximumLength = 45_000_000) {
  if (typeof encoded !== 'string' || encoded.length > maximumLength || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error('RGBA 编码无效或过大。');
  const padding = encoded.indexOf('=');
  if (padding !== -1 && (padding < encoded.length - 2 || !/^={1,2}$/.test(encoded.slice(padding)))) throw new Error('RGBA 编码无效。');
  const binary = atob(encoded), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
export async function rgbaHash(pixels: Uint8Array | Uint8ClampedArray) {
  const bytes = new Uint8Array(pixels);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function verifiedImagePixels(value: Partial<ImagePixels>) {
  const { width, height, rgbaBase64, rgbaSha256, rgbaByteLength, pixelFormat } = value;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !width || !height || width < 1 || height < 1 || width > 3840 || height > 3840 || width * height > 8294400 || pixelFormat !== 'sRGB-RGBA8-straight' || !rgbaBase64 || rgbaByteLength !== width * height * 4 || !rgbaSha256 || !/^[a-f0-9]{64}$/.test(rgbaSha256)) throw new Error('服务端 RGBA 描述不完整，未打开编辑。');
  const pixels = await decodeImageBytes(rgbaBase64);
  if (pixels.byteLength !== rgbaByteLength || await rgbaHash(pixels) !== rgbaSha256) throw new Error('RGBA 字节或 SHA-256 不符，未打开编辑。');
  let previewSource: string | undefined;
  if (value.imageBase64 !== undefined) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(value.imageMimeType || '') || !value.sha256 || await rgbaHash(await decodeImageBytes(value.imageBase64, 56_000_000)) !== value.sha256) throw new Error('预览图片字节或 SHA-256 不符，未打开编辑。');
    // Display saved bytes immediately on selection/restore. Only unsaved strokes need Canvas encoding.
    previewSource = `data:${value.imageMimeType};base64,${value.imageBase64}`;
  }
  return { pixels, width, height, rgbaSha256, previewSource };
}
// Bounded chunks let the browser paint/cancel between decoding large buffers.
async function decodeImageBytes(encoded: string, maximumLength = 45_000_000) {
  if (typeof encoded !== 'string' || encoded.length > maximumLength || encoded.length % 4) throw new Error('RGBA 编码无效或过大。');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const output = new Uint8Array(encoded.length / 4 * 3 - padding), chunkSize = 262144;
  for (let start = 0; start < encoded.length; start += chunkSize) {
    const chunk = encoded.slice(start, start + chunkSize);
    if (start + chunkSize < encoded.length && chunk.includes('=')) throw new Error('RGBA 编码无效。');
    output.set(base64ToBytes(chunk), start / 4 * 3);
    if (start + chunkSize < encoded.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return output;
}
export function encodePixelPatch(spans: PixelSpan[], baseRgbaSha256: string): ImageLocalOperation {
  if (!spans.length || spans.reduce((total, span) => total + span.before.byteLength + span.after.byteLength, 0) > 524288) throw new Error('像素补丁为空或超过 512 KiB，请分次保存笔划。');
  return { type: 'pixel-patch', baseRgbaSha256, spans: spans.map(span => ({ startPixel: span.startPixel, beforeRgbaBase64: bytesToBase64(span.before), afterRgbaBase64: bytesToBase64(span.after) })) };
}

export interface ImagePixelDraft {
  key: string; editId: string; owner: string; baseVersion: string; baseHash: string; sourceSha256: string; updatedAt: number;
  patch: Extract<ImageLocalOperation, { type: 'pixel-patch' }>;
}
async function draftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('forge-image-edit-drafts', 1);
    request.onupgradeneeded = () => { const store = request.result.createObjectStore('drafts', { keyPath: 'key' }); store.createIndex('editId', 'editId'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('本机草稿缓存不可用；请先保存笔划为候选。'));
  });
}
export async function listImagePixelDrafts(editId: string) {
  const database = await draftDatabase();
  try { return await new Promise<ImagePixelDraft[]>((resolve, reject) => {
    const request = database.transaction('drafts').objectStore('drafts').index('editId').getAll(editId);
    request.onsuccess = () => resolve(request.result as ImagePixelDraft[]); request.onerror = () => reject(request.error);
  }); } finally { database.close(); }
}
const draftWrites = new Map<string, Promise<void>>();
async function writeImagePixelDraft(draft: ImagePixelDraft | null, key: string) {
  if (draft && new TextEncoder().encode(JSON.stringify(draft)).byteLength > 2 * 1024 * 1024) throw new Error('本机草稿超过 2 MiB；请先保存笔划为候选。');
  const database = await draftDatabase();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('drafts', 'readwrite');
    const store = transaction.objectStore('drafts');
    if (draft) {
      const read = store.getAllKeys();
      read.onsuccess = () => {
        if (read.result.length >= 12 && !read.result.includes(key)) { transaction.abort(); reject(new Error('本机已保留 12 份笔划草稿；请先保存或明确删除旧草稿。')); }
        else store.put(draft);
      };
    } else store.delete(key);
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
  }); } finally { database.close(); }
}
/** Serialize cleanup behind prior writes so a late draft cannot resurrect after saving. */
export async function saveImagePixelDraft(draft: ImagePixelDraft | null, key: string) {
  const previous = draftWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => writeImagePixelDraft(draft, key));
  draftWrites.set(key, pending);
  try { await pending; } finally { if (draftWrites.get(key) === pending) draftWrites.delete(key); }
}
