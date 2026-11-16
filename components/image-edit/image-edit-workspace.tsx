'use client';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ImageAttributePlan } from './image-attribute-plan';
import { ImageAttributeReview } from './image-attribute-review';
import { CandidateCheck } from './candidate-check';
/* oxlint-disable next/no-img-element -- AI references preview the exact uploaded source bytes. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { PlacementComparison } from './placement-comparison';
import { MAX_PALETTE_PAIRS, planImageIntent, type PalettePair } from '@/features/image-edit/edit-intent.mjs';
import { Button } from '@/components/ui/button';
import { PixelController } from '@/features/image-edit/pixel-controller.mjs';
import { base64ToBytes, encodePixelPatch, imageAiEditInput, imageApplyInput, imageCandidateBase, imageCandidateFollowState, imageEditInput, imageEditRequest, imageInspectionMetadata, imageResolveInput, imageSessionNeedsPolling, ImageEditClientError, inspectImage, listImagePixelDrafts, mergeImageInspectionPage, mergeImageWorkspaceRefresh, openImageSession, readImageAiReference, readImageEdit, saveImagePixelDraft, validateAiReferences } from '@/features/image-edit/client';
import type { ImageAdoptionReceipt, ImageAiReference, ImageCandidate, ImageEditContextLayer, ImageEditOperation, ImageEditSession, ImageInspection, ImagePixelDraft, ImageRelatedKind, ImageSessionBootstrap, ImageTargetRef } from '@/features/image-edit/client';
import type { RegionSpec } from '@/features/image-edit/core.mjs';
import type { ImageEditNavigation } from '@/features/image-edit/navigation';
import { ImageEditCanvas } from './image-edit-canvas';
import type { ImagePixelTool, ImageViewMode } from './image-edit-canvas';
import { ImageVersionCache, ImageViewRequest } from '@/features/image-edit/version-cache';
import type { VerifiedPixels } from '@/features/image-edit/version-cache';
import { imageDarkeningWarning } from '@/features/image-edit/appearance-check.mjs';
import { browserRequestJournal } from '@/features/editor-documents/browser-journal';
import { journalRequestIdentity } from '@/features/editor-documents/request-journal.mjs';
import './image-edit.css';

export interface ImageEditWorkspaceProps {
  target: ImageTargetRef;
  initialEditId?: string;
  initialCandidateVersion?: string;
  readOnly?: boolean;
  contextLayers?: ImageEditContextLayer[];
  beforeApply?: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onAdopt: (receipt: ImageAdoptionReceipt) => Promise<void>;
  onClose: () => void;
  onNavigationChange?: (selection: ImageEditNavigation) => void;
  renderContext?: (previewSource: string) => ReactNode;
}
interface PendingCommand { label: string; operation: string; body: unknown; external?: boolean; complete: (value: unknown) => Promise<void> }
interface LoadedWorkspace { metadata: ImageInspection; session: ImageEditSession; controller: PixelController; baseVersion: string; baseHash: string; followVersion?: string; originalPreviewSource?: string; basePreviewSource?: string }
const plainSession = (value: ImageEditSession) => { const { pixels: _pixels, ...rest } = value; return rest; };
const metadataOnly = imageInspectionMetadata;
const operationNames: Record<string, string> = { 'recompose-ai': '修正合成区', 'color-map': '简单换色', 'palette-map': '多色替换', 'pixel-patch': '手工笔划', 'clean-alpha': '透明噪点清理', 'replace-color': '精确替色', fill: '连通填充', erase: '擦除', translate: '移动像素', 'restore-region': '恢复区域', 'source-restore': '恢复原图', 'ai-edit': 'AI 修改' };
const statusNames: Record<string, string> = { completed: '已完成', running: '处理中', preparing: '准备中', failed: '失败', attention_required: '需要检查', awaiting_configuration: '等待配置' };
const selectionTools: { id: ImagePixelTool; name: string }[] = [{ id: 'rectangle', name: '矩形选区' }, { id: 'mask-add', name: '涂选' }, { id: 'connected', name: '连通选区' }];
// Pixel tools write the image, so they exist only in local refinement.
const drawingTools: { id: ImagePixelTool; name: string }[] = [{ id: 'pencil', name: '画笔' }, { id: 'eraser', name: '橡皮' }, { id: 'fill', name: '填充' }, { id: 'move', name: '移动' }, { id: 'picker', name: '取色' }];
const drawingToolIds: ImagePixelTool[] = drawingTools.map(item => item.id);
const hexRgba = (hex: string, alpha: number): [number, number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha];
const message = (error: unknown) => error instanceof Error ? error.message : '局部调整未完成。';

async function loadWorkspace(cache: ImageVersionCache, target: ImageTargetRef, attempt: ImageSessionBootstrap, requestedVersion?: string): Promise<LoadedWorkspace> {
  const bootstrap = browserRequestJournal('image-bootstrap', journalRequestIdentity({ operation: 'image-target', input: { commandId: 'target', target } }));
  if (!attempt.editId) {
    const previous = await bootstrap.pending();
    if (previous) {
      if (previous.request.operation !== 'session-create') throw new Error('原图片会话请求无效，请保留记录后恢复。');
      attempt.createInput = previous.request.input as unknown as NonNullable<ImageSessionBootstrap['createInput']>;
      attempt.commandId = attempt.createInput.commandId;
    }
  }
  const { inspection, edit } = await openImageSession(target, attempt, async input => {
    const request = { operation: 'session-create', input };
    const saved = await bootstrap.begin(request);
    let awaitingResponse = false;
    try {
      awaitingResponse = !saved.response;
      const response = saved.response as { edit: ImageEditSession } | undefined || await imageEditRequest<{ edit: ImageEditSession }>('session-create', input);
      awaitingResponse = false;
      if (!response.edit?.editId || response.edit.target.targetId !== input.targetId) throw new Error('图片会话回执身份不匹配。');
      await bootstrap.respond(request, response); await bootstrap.complete(request);
      return response;
    } catch (cause) {
      if (awaitingResponse && cause instanceof ImageEditClientError && cause.status >= 400 && cause.status < 500 && cause.status !== 408)
        await bootstrap.complete(request, 'rejected');
      throw cause;
    }
  });
  if (edit.target.targetId !== inspection.target.targetId) throw new Error('编辑会话属于另一张图片，未打开。');
  const original = await cache.load(edit.editId, 'source');
  if (original.width !== edit.target.width || original.height !== edit.target.height) throw new Error('会话原始图尺寸与目标绑定不一致。');
  const selection = imageCandidateBase(edit, requestedVersion);
  const base = selection.baseVersion === 'source' ? original : await cache.load(edit.editId, selection.baseVersion);
  if (base.width !== original.width || base.height !== original.height) throw new Error('版本尺寸与打开时的图片不一致。');
  const controller = new PixelController(original.pixels, original.width, original.height, base.pixels);
  controller.selectRegion(null, false);
  return { metadata: metadataOnly(inspection), session: plainSession(edit), controller, ...selection, baseHash: base.rgbaSha256, originalPreviewSource: original.previewSource, basePreviewSource: base.previewSource };
}

export function ImageEditWorkspace({ target, initialEditId, initialCandidateVersion, readOnly = false, contextLayers = [], beforeApply, onBusyChange, onAdopt, onClose, onNavigationChange, renderContext }: ImageEditWorkspaceProps) {
  const adoptCallback = useRef(onAdopt);
  useEffect(() => { adoptCallback.current = onAdopt; }, [onAdopt]);
  const [loaded, setLoaded] = useState<LoadedWorkspace | null>(null), [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState<PendingCommand | null>(null);
  const [cache] = useState(() => new ImageVersionCache()), [viewRequest] = useState(() => new ImageViewRequest());
  const [preview, setPreview] = useState<{ editId: string; version: string; image: VerifiedPixels } | null>(null);
  const [viewLoading, setViewLoading] = useState('');
  const [comparison, setComparison] = useState<{ key: string; image: VerifiedPixels } | null>(null);
  const [selectionMode, setSelectionMode] = useState<'replace' | 'add' | 'subtract'>('replace');
  const [selectionVisible, setSelectionVisible] = useState(true);
  const [maskBrushSize, setMaskBrushSize] = useState(32);
  const [tool, setTool] = useState<ImagePixelTool>('rectangle'), [display, setDisplay] = useState<ImageViewMode>('candidate');
  const [color, setColor] = useState('#eebc52'), [alpha, setAlpha] = useState(255), [brushSize, setBrushSize] = useState(1), [tolerance, setTolerance] = useState(0);
  const [threshold, setThreshold] = useState(1), [replaceFrom, setReplaceFrom] = useState('#000000'), [replaceTo, setReplaceTo] = useState('#ffffff');
  const [regionName, setRegionName] = useState(''), [selectedNamed, setSelectedNamed] = useState(''), [restoreVersion, setRestoreVersion] = useState('source');
  const [preserveAlpha, setPreserveAlpha] = useState(false), [showContext, setShowContext] = useState(false), [leavePrompt, setLeavePrompt] = useState(false), [retryLoad, setRetryLoad] = useState(0);
  const [recoverableDraft, setRecoverableDraft] = useState<ImagePixelDraft | null>(null);
  const [sessionStartFailed, setSessionStartFailed] = useState(false);
  const [contextPreview, setContextPreview] = useState<{ controller: PixelController; version: number; display: ImageViewMode; url: string } | null>(null);
  const [aiPreserveAlpha, setAiPreserveAlpha] = useState(true);
  const [mode, setMode] = useState<'local' | 'ai'>(target.kind === 'motion-frame' ? 'local' : 'ai'), [aiPrompt, setAiPrompt] = useState(''), [aiReferences, setAiReferences] = useState<ImageAiReference[]>([]), [referencesLoading, setReferencesLoading] = useState(false), [savedAiDraft, setSavedAiDraft] = useState('');
  const [extraPairs, setExtraPairs] = useState<PalettePair[]>([]);
  const pairs = [{ from: replaceFrom, to: replaceTo }, ...extraPairs];
  const duplicateColor = new Set(pairs.map(pair => pair.from.toLowerCase())).size !== pairs.length;
  const intent = planImageIntent(aiPrompt, aiReferences.length > 0);
  const localIntent = intent.route === 'local';
  const exactColorIntent = intent.operation?.type === 'replace-color' || intent.operation?.type === 'palette-map';
  const keepsIntentAlpha = localIntent ? exactColorIntent : aiPreserveAlpha;
  const dialog = useRef<HTMLDialogElement>(null), busyRef = useRef(false), draftOwner = useRef('');
  const boot = useRef<{ key: string; attempt: ImageSessionBootstrap; promise: Promise<LoadedWorkspace> } | null>(null);
  const nextSession = useRef<ImageSessionBootstrap | null>(null);
  const loadedRef = useRef<LoadedWorkspace | null>(null);
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const key = JSON.stringify({ target, initialEditId, initialCandidateVersion });
  const aiDraftKey = JSON.stringify({ prompt: aiPrompt.trim(), references: aiReferences.map(reference => reference.id), region: loaded?.controller.region, preserveAlpha: aiPreserveAlpha });
  const aiDraftDirty = !!(aiPrompt.trim() || aiReferences.length) && aiDraftKey !== savedAiDraft;
  const changed = () => setVersion(value => value + 1);
  const view = preview?.editId === loaded?.session.editId ? preview : null;
  const viewedVersion = view?.version || loaded?.baseVersion;
  const viewedCandidate = loaded?.session.candidates.find(item => item.version === viewedVersion);
  const beforeVersion = viewedCandidate?.baseCandidateVersion || 'source';
  const comparisonEditId = loaded?.session.editId;
  const comparisonKey = `${comparisonEditId}:${beforeVersion}`;
  useEffect(() => {
    if (!comparisonEditId) return;
    const abort = new AbortController();
    void cache.load(comparisonEditId, beforeVersion, abort.signal).then(image => { if (!abort.signal.aborted) setComparison({ key: comparisonKey, image }); }).catch(cause => { if (!abort.signal.aborted) setError(message(cause)); });
    return () => abort.abort();
  }, [comparisonEditId, beforeVersion, display, comparisonKey, cache]);
  useEffect(() => { return () => viewRequest.cancel(); }, [viewRequest, key]);
  const beforeImage = comparison?.key === comparisonKey ? comparison.image : cache.peek(loaded?.session.editId || '', beforeVersion);
  const viewPixels = view?.image.pixels;
  const warningPixels = viewPixels || loaded?.controller.basePixels;
  const darkWarning = useMemo(() => beforeImage && warningPixels ? imageDarkeningWarning(beforeImage.pixels, warningPixels) : null, [beforeImage, warningPixels]);

  // Local refinement works on the whole image unless a range is chosen; AI needs an explicit range.
  const switchMode = (next: 'local' | 'ai') => {
    setMode(next); modeRef.current = next;
    if (next === 'ai' && drawingToolIds.includes(tool)) setTool('rectangle');
    const current = loadedRef.current;
    if (next === 'local' && current && !current.controller.selectionCount) {
      try { current.controller.selectRegion({ type: 'all' }); setSelectionVisible(true); changed(); } catch (cause) { setError(message(cause)); }
    }
  };
  const chooseTool = (next: ImagePixelTool) => { setTool(next); setSelectionVisible(true); };
  /** Mode and starting range for a freshly loaded session: AI only when this image supports it. */
  const targetKind = target.kind;
  const prepareLoaded = useCallback((value: LoadedWorkspace, decideMode: boolean) => {
    let next = modeRef.current;
    if (decideMode) {
      next = targetKind === 'motion-frame' || !value.metadata.target.aiEdit?.supported ? 'local' : 'ai';
      setMode(next); modeRef.current = next;
      if (next === 'ai') setTool(old => drawingToolIds.includes(old) ? 'rectangle' : old);
    }
    if (next === 'local') value.controller.selectRegion({ type: 'all' }, false);
    return value;
  }, [targetKind]);
  useEffect(() => { loadedRef.current = loaded; }, [loaded]);
  const navigationEditId = loaded?.session.editId, navigationVersion = loaded?.followVersion || viewedVersion;
  useEffect(() => {
    if (navigationEditId) onNavigationChange?.({ editId: navigationEditId, candidateVersion: navigationVersion });
  }, [navigationEditId, navigationVersion, onNavigationChange]);
  const previewController = loaded?.controller;
  const savedPreviewSource = display === 'source' ? beforeImage?.previewSource : view?.image.previewSource || (!previewController?.dirty ? loaded?.basePreviewSource : undefined);
  const contextPreviewUrl = savedPreviewSource || (contextPreview?.controller === previewController && contextPreview?.version === version && contextPreview?.display === display ? contextPreview.url : '');
  useEffect(() => {
    if (!showContext || !renderContext || !previewController || savedPreviewSource || (display === 'source' && !beforeImage)) return;
    let active = true, url = '';
    const canvas = document.createElement('canvas'); canvas.width = previewController.width; canvas.height = previewController.height;
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(display === 'source' ? beforeImage?.pixels || previewController.sourcePixels : viewPixels || previewController.pixels), canvas.width, canvas.height), 0, 0);
    // Canvas encoding is only for this read-only preview, never for edit/apply.
    canvas.toBlob(blob => { if (blob && active) { url = URL.createObjectURL(blob); setContextPreview({ controller: previewController, version, display, url }); } }, 'image/png');
    return () => { active = false; if (url) URL.revokeObjectURL(url); canvas.width = canvas.height = 0; };
  }, [showContext, renderContext, previewController, version, display, savedPreviewSource, beforeImage, viewPixels]);
  useEffect(() => {
    let alive = true;
    if (!draftOwner.current) draftOwner.current = crypto.randomUUID();
    const previous = document.activeElement;
    dialog.current?.focus();
    void Promise.resolve().then(() => { if (alive) { setBusy('正在读取并核验源像素'); setError(''); setLoaded(null); setPreview(null); setViewLoading(''); } });
    const attempt = boot.current?.key === key ? boot.current.attempt : { commandId: crypto.randomUUID(), editId: initialEditId };
    const selection = JSON.parse(key) as { target: ImageTargetRef; initialEditId?: string; initialCandidateVersion?: string };
    if (!boot.current || boot.current.key !== key || retryLoad) {
      boot.current = { key, attempt, promise: loadWorkspace(cache, selection.target, attempt, selection.initialCandidateVersion) };
    }
    void boot.current.promise.then(async value => {
      const original = await browserRequestJournal('image-edit', value.metadata.target.targetId).pending();
      if (alive) {
        setLoaded(prepareLoaded(value, true)); setPending(original ? {
          label: '恢复原图片请求', operation: original.request.operation, body: original.request.input, external: true,
          complete: async response => {
            const latest = loadedRef.current;
            if (!latest || latest.controller.dirty) throw new Error('请保留当前笔划后再恢复原请求结果。');
            if (original.request.operation === 'apply') await adoptCallback.current(response as ImageAdoptionReceipt);
            const result = response as { edit?: ImageEditSession; candidateVersion?: string };
            const editId = result.edit?.editId || (original.request.input.editId as string | undefined) || latest.session.editId;
            const next = prepareLoaded(await loadWorkspace(cache, selection.target, { commandId: crypto.randomUUID(), editId }, result.candidateVersion), false);
            loadedRef.current = next; setLoaded(next); setPreview(null); setNotice('上次的请求已确认，版本与应用记录已恢复。');
          },
        } : null); setBusy('');
      }
    }).catch(cause => { if (alive) { setError(message(cause)); setBusy(''); } });
    return () => { alive = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [key, retryLoad, initialEditId, cache, prepareLoaded]);
  useEffect(() => { onBusyChange?.(!!busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const dirty = !!loaded?.controller.dirty;
  const draftEditId = loaded?.session.editId, draftSourceSha = loaded?.session.source.sha256;
  useEffect(() => {
    if (!draftEditId || !draftSourceSha) return;
    let alive = true;
    void listImagePixelDrafts(draftEditId).then(drafts => {
      const draft = drafts.filter(item => item.owner !== draftOwner.current && item.sourceSha256 === draftSourceSha).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (alive) setRecoverableDraft(draft || null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [draftEditId, draftSourceSha]);
  useEffect(() => {
    if (!loaded) return;
    const current = loaded, owner = draftOwner.current, draftKey = `${current.session.editId}:${owner}`;
    const timer = setTimeout(() => {
      try {
        const patch = current.controller.dirty ? encodePixelPatch(current.controller.patch(), current.baseHash) : null;
        const draft = patch?.type === 'pixel-patch' ? { key: draftKey, editId: current.session.editId, owner, baseVersion: current.baseVersion, baseHash: current.baseHash, sourceSha256: current.session.source.sha256, patch, updatedAt: Date.now() } : null;
        void saveImagePixelDraft(draft, draftKey).catch(cause => setNotice(message(cause)));
      } catch (cause) { setNotice(message(cause)); }
    }, 600);
    return () => clearTimeout(timer);
  }, [loaded, version]);
  useEffect(() => {
    if (!dirty && !pending && !busy && !aiDraftDirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, pending, busy, aiDraftDirty]);
  const pollingEditId = loaded?.session.editId;
  const needsPolling = loaded ? imageSessionNeedsPolling(loaded.session, loaded.followVersion) : false;
  useEffect(() => {
    if (!pollingEditId || !needsPolling) return;
    let active = true, reading = false;
    const timer = setInterval(() => {
      if (busyRef.current || reading) return;
      reading = true;
      void (async () => {
        try {
          const { edit } = await readImageEdit(pollingEditId);
          if (!active) return;
          const current = loadedRef.current;
          if (!current || current.session.editId !== edit.editId) return;
          const following = imageCandidateFollowState(edit, current.followVersion, current.controller.dirty), requested = following.candidate;
          if (requested && ['select', 'preserve-draft'].includes(following.state) && !busyRef.current) {
            if (following.state === 'preserve-draft') {
              setLoaded(old => old?.session.editId === edit.editId ? { ...old, session: plainSession(edit), followVersion: undefined } : old);
              setNotice('请求的版本已完成；未保存笔划保留，请先保存，再在底部选择该版本。');
            } else {
              busyRef.current = true; setBusy('读取请求的候选');
              try {
                const pixels = await cache.load(edit.editId, requested.version);
                const latest = loadedRef.current;
                if (!active || !latest || latest.session.editId !== edit.editId || latest.followVersion !== requested.version) return;
                if (latest.controller.dirty) { setNotice('请求的版本已完成，未覆盖之后画的笔划。'); return; }
                const controller = latest.controller; controller.setBase(pixels.pixels);
                setLoaded({ ...latest, session: plainSession(edit), controller, baseVersion: requested.version, baseHash: pixels.rgbaSha256, basePreviewSource: pixels.previewSource, followVersion: undefined });
                setPreview(null); setSelectionVisible(false); changed(); setDisplay('candidate'); setNotice('AI 结果已生成，对比确认后再应用。');
              } finally { busyRef.current = false; if (active) setBusy(''); }
            }
          } else {
            const stopped = following.state === 'stopped';
            setLoaded(old => old?.session.editId === edit.editId && old.session.revision <= edit.revision ? { ...old, session: plainSession(edit), ...(stopped ? { followVersion: undefined } : {}) } : old);
            if (stopped) setError(requested?.error || '原任务需要检查，不会重新提交或自动应用。');
          }
        } catch (cause) { if (active) setError(message(cause)); }
        finally { reading = false; }
      })();
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [pollingEditId, needsPolling, cache]);

  const execute = async (command: PendingCommand) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(command.label); setError(''); setNotice(''); setPending(command);
    const input = command.body as Record<string, unknown>;
    // apply binds through editId and deliberately has no targetId in its body.
    const targetId = typeof input.targetId === 'string' ? input.targetId : loadedRef.current?.metadata.target.targetId;
    const journal = targetId ? browserRequestJournal('image-edit', targetId) : null;
    const request = { operation: command.operation, input };
    let submitted = false, awaitingResponse = false;
    try {
      if (!journal) throw new Error('图片目标尚未读取，未发送请求。');
      if (command.operation === 'apply') await beforeApply?.();
      const original = await journal.begin(request);
      submitted = true;
      awaitingResponse = !original.response;
      const value = original.response || await imageEditRequest<unknown>(command.operation, command.body);
      awaitingResponse = false;
      await journal.respond(request, value);
      await command.complete(value);
      await journal.complete(request); setPending(null);
    } catch (cause) {
      setError(message(cause));
      if (awaitingResponse && cause instanceof ImageEditClientError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && !['IMAGE_EDIT_BUSY', 'IMAGE_SUBMISSION_UNKNOWN'].includes(cause.code || '')) {
        try { await journal?.complete(request, 'rejected'); setPending(null); }
        catch (storageError) { setError(message(storageError)); }
      } else if (!submitted && !await journal?.pending().catch(() => true)) setPending(null);
    } finally { busyRef.current = false; setBusy(''); }
  };
  const local = (operation: () => void) => { try { operation(); setSelectionVisible(true); changed(); setError(''); } catch (cause) { setError(message(cause)); } };
  const forceReadOnly = readOnly || !!loaded?.metadata.historyOnly;
  const canContinue = !forceReadOnly && !!loaded && loaded.metadata.target.revision === loaded.session.target.revision && loaded.metadata.target.sha256 === loaded.session.target.sha256 && loaded.metadata.target.editable && !loaded.metadata.target.locked;
  const adoptionBlocked = forceReadOnly || !loaded?.metadata.target.editable || !!loaded?.metadata.target.locked;
  const blocked = !!busy || !!pending || !!view || !!viewLoading || showContext || !canContinue;
  const selectCandidate = async (candidateVersion: string) => {
    if (!loaded || busyRef.current || pending) return;
    const current = loaded, signal = viewRequest.begin();
    setViewLoading(candidateVersion); setError(''); setNotice('');
    setLoaded(old => old ? { ...old, followVersion: undefined } : old);
    try {
      if (candidateVersion === current.baseVersion) setPreview(null);
      else {
        const image = await cache.load(current.session.editId, candidateVersion, signal);
        if (signal.aborted || loadedRef.current?.session.editId !== current.session.editId) return;
        setPreview({ editId: current.session.editId, version: candidateVersion, image });
      }
      setDisplay('candidate');
    } catch (cause) { if (!signal.aborted) setError(message(cause)); }
    finally { if (!signal.aborted) setViewLoading(''); }
  };
  const cancelView = () => { viewRequest.cancel(); setViewLoading(''); };
  const returnToWorking = () => { cancelView(); setPreview(null); setDisplay('candidate'); };
  const editViewed = () => {
    if (!loaded || !view || busyRef.current || pending || !canContinue) return;
    try {
      loaded.controller.setBase(view.image.pixels);
      setLoaded({ ...loaded, baseVersion: view.version, baseHash: view.image.rgbaSha256, basePreviewSource: view.image.previewSource });
      setPreview(null); setDisplay('candidate'); setSelectionVisible(true); changed();
      setNotice(`已从${versionName(view.version)}继续修改，选区保留。`);
    } catch (cause) { setError(message(cause)); }
  };
  const runOperation = async (operation: ImageEditOperation, references: readonly ImageAiReference[] = [], fromDescription = false, planRef?: string) => {
    let current = loadedRef.current;
    if (!current || blocked || busyRef.current) return;
    if (!current.controller.region && !planRef) { setError(mode === 'ai' ? '请先在画布上框选要修改的范围。' : '请先选择修改范围。'); return; }
    if (current.controller.maskStrokeActive) { setError('请先结束当前选区笔划，再提交。'); return; }
    if (operation.type !== 'pixel-patch' && current.controller.dirty) {
      // Unsaved strokes become their own version first; the operation then builds on it.
      if (!await commitStrokes()) return;
      current = loadedRef.current;
      if (!current || current.controller.dirty) return;
    }
    const region = current.controller.region, commandId = crypto.randomUUID();
    const submittedAiKey = aiDraftKey, frozenReferences = references.slice(), external = operation.type === 'ai-edit';
    if (!region && !planRef) return;
    busyRef.current = true; setBusy('解析当前选区'); setError('');
    let body: ReturnType<typeof imageEditInput> & {planRef?:string};
    try {
      const prepared = planRef ? (await imageEditRequest<{plan:{regionRef:string;constraints:{preserveAlpha:boolean}}}>('plan-get',{planRef})).plan : null;
      if (!prepared && !region) throw new Error('请先选择编辑范围。');
      const { regionRef } = prepared || await imageEditRequest<{ regionRef: string }>('resolve', imageResolveInput(current.metadata.target, region!));
      if (operation.type === 'recompose-ai') {
        const original = current.session.candidates.find(item=>item.version===operation.candidateVersion);
        if (!original?.baseCandidateVersion) throw new Error('原版本的生成基准不可用。');
        body = imageEditInput(current.metadata.target,current.session,original.baseCandidateVersion,regionRef,operation,true,commandId);
      } else {
        body = operation.type === 'ai-edit' ? imageAiEditInput(current.metadata.target, current.session, current.baseVersion, regionRef, operation.prompt, frozenReferences, current.controller.dirty, commandId, prepared?.constraints.preserveAlpha??aiPreserveAlpha) : imageEditInput(current.metadata.target, current.session, current.baseVersion, regionRef, operation, prepared?.constraints.preserveAlpha??((fromDescription ? keepsIntentAlpha : preserveAlpha)), commandId);
      }
      if(planRef)body={...body,planRef};
    }
    catch (cause) { setError(message(cause)); busyRef.current = false; setBusy(''); return; }
    busyRef.current = false;
    const controller = current.controller;
    await execute({
      label: external ? '正在提交 AI 候选请求' : operation.type === 'pixel-patch' ? '正在把笔划存为新版本' : '正在执行本地操作', operation: 'edit', body, external,
      complete: async value => {
        const result = value as { edit: ImageEditSession; candidateVersion: string; status: string };
        if (external || fromDescription) setSavedAiDraft(submittedAiKey);
        const update = (patch: Partial<LoadedWorkspace>) => {
          const latest = loadedRef.current;
          if (latest?.session.editId !== result.edit.editId) return;
          const next = { ...latest, ...patch };
          loadedRef.current = next; setLoaded(next);
        };
        if (result.status !== 'completed') {
          const stopped = ['failed', 'attention_required', 'awaiting_configuration'].includes(result.status);
          update({ session: plainSession(result.edit), followVersion: stopped ? undefined : result.candidateVersion });
          if (stopped) setError(result.edit.candidates.find(item => item.version === result.candidateVersion)?.error || '这次处理未通过检查，原图与笔划保留；不会自动重新请求。');
          else setNotice('任务正在处理。关闭窗口不会取消；重开此会话可继续查看，不会重复提交或应用。');
          return;
        }
        const pixels = await cache.load(result.edit.editId, result.candidateVersion);
        controller.discardPixels(); controller.setBase(pixels.pixels);
        update({ session: plainSession(result.edit), controller, baseVersion: result.candidateVersion, baseHash: pixels.rgbaSha256, basePreviewSource: pixels.previewSource, followVersion: undefined });
        const created = `版本 ${result.edit.candidates.findIndex(item => item.version === result.candidateVersion) + 1}`;
        // AI results are inspected without the range overlay; local edits keep it so the next step stays visible.
        if (external) setSelectionVisible(false);
        setPreview(null); changed(); setDisplay('candidate');
        setNotice(external ? `AI 结果已存为${created}，对比确认后再应用。` : `已存为${created}，现在基于它继续修改。`);
      },
    });
  };
  /** Save unsaved strokes as a version; resolves true when nothing is left unsaved. */
  const commitStrokes = async () => {
    const current = loadedRef.current;
    if (!current?.controller.dirty) return true;
    let patch: ImageEditOperation;
    try { patch = encodePixelPatch(current.controller.patch(), current.baseHash); } catch (cause) { setError(message(cause)); return false; }
    await runOperation(patch);
    return !loadedRef.current?.controller.dirty;
  };
  const savePixels = () => { void commitStrokes(); };
  const fillAt = (point: { x: number; y: number }) => void runOperation({ type: 'fill', x: point.x, y: point.y, rgba: hexRgba(color, alpha) });
  /** Move the rectangle's pixels, then move the selection with them. */
  const moveSelection = async (dx: number, dy: number) => {
    const before = loadedRef.current, rect = before?.controller.region;
    if (!before || rect?.type !== 'rectangle') return;
    await runOperation({ type: 'translate', dx, dy });
    const after = loadedRef.current;
    if (!after || after.baseVersion === before.baseVersion) return;
    try { after.controller.selectRegion({ ...rect, x: rect.x + dx, y: rect.y + dy }); changed(); } catch { /* The moved pixels stay; the original range remains selected. */ }
  };
  const adopt = async (requestedVersion: string) => {
    let current = loadedRef.current, candidateVersion = requestedVersion;
    if (!current || busyRef.current || pending || forceReadOnly || !current.metadata.target.editable || current.metadata.target.locked) return;
    if (current.controller.dirty) {
      if (candidateVersion !== current.baseVersion) { setError('未保存笔划属于工作版本。请回到工作版本保存或舍弃笔划，再应用其他版本。'); return; }
      if (!await commitStrokes()) return;
      current = loadedRef.current;
      if (!current) return;
      candidateVersion = current.baseVersion;
    }
    const working = current;
    await execute({ label: target.kind==='motion-frame'?'保存为动画备选':candidateVersion === 'source' ? '恢复打开时的图片' : applyLabel, operation: 'apply', body: imageApplyInput(working.metadata.target, working.session.editId, candidateVersion, crypto.randomUUID()), complete: async value => {
      const receipt = value as ImageAdoptionReceipt;
      try { await onAdopt(receipt); }
      catch (cause) { throw new Error(`服务端已应用，本页尚未完成同步。请重试同一操作以重新读取：${message(cause)}`); }
      if(working.metadata.target.targetRef.kind==='motion-frame')return;
      const refreshed = await readImageEdit(working.session.editId);
      const selected = await cache.load(working.session.editId, candidateVersion);
      working.controller.setBase(selected.pixels); changed();
      const next = { ...working, metadata: { ...working.metadata, target: receipt.target }, session: plainSession(refreshed.edit), controller: working.controller, baseVersion: candidateVersion, baseHash: selected.rgbaSha256, basePreviewSource: selected.previewSource, followVersion: undefined };
      loadedRef.current = next; setLoaded(next);
      setPreview(null); setDisplay('candidate'); setNotice(candidateVersion === 'source' ? '已恢复打开时的图片，作为新的目标版本。其他源图和工程内容保留。' : `${applyDone}继续精修将基于应用结果创建新会话。`);
    } });
  };
  const startNewSession = async (reset = false) => {
    if (!loaded || busyRef.current || loaded.controller.dirty || forceReadOnly) return;
    busyRef.current = true; setBusy('基于当前目标新建编辑'); setError('');
    if (reset || !nextSession.current) nextSession.current = { commandId: crypto.randomUUID() };
    try { const next = prepareLoaded(await loadWorkspace(cache, target, nextSession.current), false); loadedRef.current = next; setLoaded(next); setPreview(null); setSelectionVisible(true); nextSession.current = null; setSessionStartFailed(false); setNotice('已基于当前图片打开新会话。'); }
    catch (cause) { setSessionStartFailed(true); setError(message(cause)); }
    finally { busyRef.current = false; setBusy(''); }
  };
  const saveNamedRegion = async () => {
    if (!loaded || !loaded.controller.region || !regionName.trim() || blocked) return;
    const current = loaded, region = current.controller.region;
    if (!region) return;
    await execute({ label: '保存命名区域', operation: 'resolve', body: imageResolveInput(current.metadata.target, region, regionName.trim(), crypto.randomUUID()), complete: async () => {
      const metadata = metadataOnly(await imageEditRequest<ImageInspection>('inspect', { target, view: 'metadata' }));
      setLoaded(old => old ? { ...old, metadata } : old); setNotice('区域名称已保存，其他客户端可读取同一区域。'); setRegionName('');
    } });
  };
  const loadNamedRegion = async () => {
    if (!loaded || !selectedNamed || blocked) return;
    busyRef.current = true; setBusy('读取命名区域'); setError('');
    try {
      const region = await imageEditRequest<{ spec: RegionSpec }>('resolve', imageResolveInput(loaded.metadata.target, { type: 'named', regionId: selectedNamed }));
      loaded.controller.selectRegion(region.spec); setSelectionVisible(true); changed();
    } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setBusy(''); }
  };
  const restoreDraft = async () => {
    if (!loaded || !recoverableDraft || busyRef.current || forceReadOnly) return;
    if (loaded.controller.dirty) { setError('请先保存或舍弃当前笔划，再恢复草稿。'); return; }
    busyRef.current = true; setBusy('恢复本机笔划');
    try {
      const base = await cache.load(loaded.session.editId, recoverableDraft.baseVersion);
      if (base.rgbaSha256 !== recoverableDraft.baseHash) throw new Error('草稿像素基准已变，保留草稿但未恢复。');
      const controller = new PixelController(loaded.controller.sourcePixels, base.width, base.height, base.pixels);
      controller.restorePatch(recoverableDraft.patch.spans.map(span => ({ startPixel: span.startPixel, before: base64ToBytes(span.beforeRgbaBase64), after: base64ToBytes(span.afterRgbaBase64) })));
      setLoaded({ ...loaded, controller, baseVersion: recoverableDraft.baseVersion, baseHash: base.rgbaSha256, basePreviewSource: base.previewSource }); setRecoverableDraft(null); setNotice('本机笔划已恢复，尚未存为版本。');
    } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setBusy(''); }
  };
  const selectSession = async (editId: string) => {
    if (!loaded || busyRef.current || !editId) return;
    if (loaded.controller.dirty) { setError('请先保存或舍弃当前笔划，再打开另一份会话。'); return; }
    busyRef.current = true; setBusy('打开已保存会话'); setError('');
    try { viewRequest.cancel(); setViewLoading(''); const next = prepareLoaded(await loadWorkspace(cache, target, { commandId: crypto.randomUUID(), editId }), false); loadedRef.current = next; setLoaded(next); setPreview(null); setSelectionVisible(true); setNotice('已打开所选的历史会话。'); }
    catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setBusy(''); }
  };
  const refreshTarget = async () => {
    if (!loaded || busyRef.current) return;
    busyRef.current = true; setBusy('核对当前目标'); setError('');
    try {
      const [metadata, refreshed] = await Promise.all([inspectImage(target), readImageEdit(loaded.session.editId)]);
      const merged = mergeImageWorkspaceRefresh(loaded, metadata, refreshed.edit);
      setLoaded(old => old?.session.editId === merged.session.editId ? { ...old, metadata: merged.metadata, session: old.session.revision > merged.session.revision ? old.session : merged.session } : old);
      setNotice('目标与会话已刷新；本机笔划、工作版本和各版本保留。');
    } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setBusy(''); }
  };
  const loadMoreRelated = async (kind: ImageRelatedKind) => {
    if (!loaded || busyRef.current) return;
    const offset = loaded.metadata.relatedPagination?.[kind].nextOffset;
    if (offset === null || offset === undefined) return;
    busyRef.current = true; setBusy(kind === 'sessions' ? '读取更多编辑会话' : '读取更多命名区域'); setError('');
    try {
      const page = await inspectImage(target, offset);
      const metadata = mergeImageInspectionPage(loaded.metadata, page, kind);
      setLoaded(old => old?.session.editId === loaded.session.editId && old.metadata.target.revision === metadata.target.revision ? { ...old, metadata } : old);
    } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setBusy(''); }
  };
  const addAiReferences = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = '';
    if (!files.length || referencesLoading) return;
    setError('');
    try {
      validateAiReferences([...aiReferences, ...files.map(file => ({ id: '', name: file.name, source: '', bytes: file.size }))]);
      setReferencesLoading(true);
      const references = await Promise.all(files.map(readImageAiReference));
      setAiReferences([...aiReferences, ...references]);
    } catch (cause) { setError(message(cause)); }
    finally { setReferencesLoading(false); }
  };
  const close = () => { cancelView(); if (loaded?.controller.dirty || pending || busy || aiDraftDirty) setLeavePrompt(true); else onClose(); };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); if (viewLoading) cancelView(); else close(); return; }
    if (event.key === 'Tab' && dialog.current) {
      const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')).filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || blocked || !loaded) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const shortcut = event.key.toLowerCase();
    if (shortcut === 'z' || shortcut === 'y') { event.preventDefault(); local(() => { if (shortcut === 'y' || event.shiftKey) loaded.controller.redo(); else loaded.controller.undo(); }); }
    else if (shortcut === 'a') { event.preventDefault(); local(() => loaded.controller.selectRegion({ type: 'all' })); }
    else if (shortcut === 'd') { event.preventDefault(); local(() => loaded.controller.selectRegion(null)); }
  };
  const controller = loaded?.controller;
  const candidate = viewedCandidate;
  const versionIndex = (id?: string) => (loaded?.session.candidates.findIndex(item => item.version === id) ?? -1) + 1;
  const versionName = (id?: string) => !id || id === 'source' ? '打开时的图片' : `版本 ${versionIndex(id)}`;
  const applyLabel = targetKind === 'motion-frame' ? '保存为动画备选' : targetKind === 'image-task' ? '另存为新素材' : '应用到交互物';
  const applyDone = targetKind === 'image-task' ? '已另存为新素材，原素材保留。' : '已应用到指定图片位置。';
  const lastAdoption = loaded?.session.adoptions.at(-1) as { candidateVersion?: string } | undefined;
  const appliedVersion = lastAdoption?.candidateVersion;
  const readOnlyText = readOnly ? '当前入口只读：可查看打开时的图片和各版本，不能修改或应用。' : loaded?.metadata.target.readOnlyReason || (loaded?.metadata.target.locked ? '此图片已锁定，只能查看。' : '此入口只读，可查看各版本。');
  // Every lock says why, in the place where the controls stopped working.
  const lockReason = !loaded ? '' : busy ? `${busy}…` : pending ? '上一次请求的结果还没确认：请用底部状态栏的按钮恢复或重试。'
    : view ? `正在查看${versionName(view.version)}（只读）。点「回到工作版本」或「从这里继续改」后再修改。`
    : showContext ? '正在预览摆放上下文（只读）。取消勾选「摆放上下文」后再修改。'
    : forceReadOnly ? readOnlyText : !canContinue ? '这份会话只能查看。要继续修改，请点底部的「基于当前图片继续精修」。' : '';
  const wholeImage = !!controller && controller.selectionCount === controller.width * controller.height;
  const rangeText = !controller ? '' : !controller.selectionCount ? '未选择' : wholeImage ? '整张图片' : `${controller.selectionCount.toLocaleString()} 像素`;
  const aiSupported = !!loaded?.metadata.target.aiEdit?.supported;
  const canApply = !adoptionBlocked && !busy && !pending && !viewLoading && (dirty && !view ? true : !!candidate && candidate.status === 'completed' && !controller?.dirty && appliedVersion !== candidate.version);
  const toolOptions = (() => {
    const colorField = <label key="color">颜色<input type="color" value={color} onChange={event => setColor(event.target.value)} /></label>;
    const alphaField = <label key="alpha">不透明度<input type="number" min={0} max={255} value={alpha} onChange={event => setAlpha(Math.max(0, Math.min(255, Number(event.target.value))))} /></label>;
    if (tool === 'pencil') return [colorField, alphaField, <label key="size">笔宽<input type="number" min={1} max={32} value={brushSize} onChange={event => setBrushSize(Math.max(1, Math.min(32, Number(event.target.value))))} /></label>];
    if (tool === 'eraser') return [<label key="size">笔宽<input type="number" min={1} max={32} value={brushSize} onChange={event => setBrushSize(Math.max(1, Math.min(32, Number(event.target.value))))} /></label>];
    if (tool === 'fill') return [colorField, alphaField];
    if (tool === 'picker') return [colorField];
    if (tool === 'connected') return [<label key="tolerance">连通容差<input type="number" min={0} max={255} value={tolerance} onChange={event => setTolerance(Math.max(0, Math.min(255, Number(event.target.value))))} /></label>];
    if (tool === 'mask-add') return [<label key="mask">涂选笔宽<input type="number" min={1} max={256} value={maskBrushSize} onChange={event => setMaskBrushSize(Math.max(1, Math.min(256, Number(event.target.value))))} /></label>];
    return [];
  })();
  const content = <div className="ie-backdrop"><dialog open ref={dialog} aria-modal="true" aria-labelledby="ie-title" tabIndex={-1} className="ie-image-edit" onKeyDown={keyDown}>
    <header className="ie-header">
      <div><h2 id="ie-title">局部调整</h2><p>{loaded?.metadata.target.name || '读取已有图片'}{loaded && ` · ${loaded.metadata.target.width} × ${loaded.metadata.target.height}`}</p></div>
      <div className="ie-header-actions">
        <span className="ie-local-badge">{mode === 'ai' && !localIntent ? 'AI · 会调用图片服务' : '本地处理 · 不调用模型'}</span>
        {loaded && <details className="ie-more"><summary>更多</summary><div className="ie-more-body">
          <span className="ie-label">编辑会话</span>
          <button type="button" aria-current="true" disabled>当前会话</button>
          {loaded.metadata.sessions?.filter(item => item.editId !== loaded.session.editId).map(item => <button type="button" key={item.editId} disabled={!!busy || !!pending} onClick={() => void selectSession(item.editId)}>{new Date(item.createdAt).toLocaleString()}{item.stale ? ' · 历史来源' : ''}</button>)}
          {loaded.metadata.relatedPagination?.sessions.nextOffset != null && <button type="button" disabled={!!busy || !!pending} onClick={() => void loadMoreRelated('sessions')}>加载更多会话（已显示 {loaded.metadata.sessions?.length || 0}/{loaded.metadata.relatedPagination.sessions.total}）</button>}
          <hr />
          <button type="button" disabled={!!busy} onClick={() => void refreshTarget()}>刷新目标状态</button>
        </div></details>}
        <Button variant="ghost" onClick={close}>关闭</Button>
      </div>
    </header>
    {!loaded && <div className="ie-loading"><p>{busy || error || '准备编辑工作区'}</p>{!busy && <><Button onClick={() => setRetryLoad(value => value + 1)}>重试同一次打开</Button><Button variant="ghost" onClick={() => { boot.current = null; setRetryLoad(value => value + 1); }}>按当前目标重新打开</Button></>}</div>}
    {loaded && controller && <>
      <div className="ie-main">
        <aside className="ie-tools" aria-label="画布工具">
          <span className="ie-label">选区</span>
          <div className="ie-tool-buttons">{selectionTools.map(item => <Button key={item.id} size="sm" variant={tool === item.id ? 'secondary' : 'ghost'} aria-pressed={tool === item.id} onClick={() => chooseTool(item.id)} disabled={blocked}>{item.name}</Button>)}</div>
          <div className="ie-selection-modes" aria-label="选区组合方式">{([{ id: 'replace', name: '新建' }, { id: 'add', name: '添加' }, { id: 'subtract', name: '减去' }] as const).map(item => <Button key={item.id} size="sm" variant={selectionMode === item.id ? 'secondary' : 'ghost'} aria-pressed={selectionMode === item.id} disabled={blocked} onClick={() => { setSelectionMode(item.id); setSelectionVisible(true); }}>{item.name}</Button>)}</div>
          <div className="ie-tool-buttons">
            <Button size="sm" variant="outline" disabled={blocked} title="Ctrl+A" onClick={() => local(() => controller.selectRegion({ type: 'all' }))}>选整图</Button>
            <Button size="sm" variant="outline" disabled={blocked || !controller.selectionCount} title="Ctrl+D" onClick={() => local(() => controller.selectRegion(null))}>清空选区</Button>
            <Button size="sm" variant="outline" disabled={blocked} onClick={() => local(() => controller.selectRegion({ type: 'alpha-selection', minAlpha: 1, maxAlpha: 255 }))}>可见像素</Button>
            <Button size="sm" variant="outline" disabled={blocked} onClick={() => local(() => controller.selectRegion({ type: 'alpha-bounds', threshold: 1 }))}>可见包围框</Button>
          </div>
          {mode === 'local' && <><span className="ie-label">绘制</span>
            <div className="ie-tool-buttons">{drawingTools.map(item => <Button key={item.id} size="sm" variant={tool === item.id ? 'secondary' : 'ghost'} aria-pressed={tool === item.id} onClick={() => chooseTool(item.id)} disabled={blocked}>{item.name}</Button>)}</div></>}
          <span className="ie-label">视图</span>
          <div className="ie-tool-buttons"><Button size="sm" variant={tool === 'pan' ? 'secondary' : 'ghost'} aria-pressed={tool === 'pan'} onClick={() => chooseTool('pan')}>平移</Button></div>
          {toolOptions.length > 0 && <div className="ie-tool-settings">{toolOptions}</div>}
          {/* Pinned to the bottom of the column: history and saving never need scrolling. */}
          <div className="ie-tools-footer">
            <span className="ie-label">历史</span>
            <div className="ie-tool-buttons">
              <Button size="sm" variant="outline" disabled={blocked || !controller.canUndo} title="Ctrl+Z" onClick={() => local(() => controller.undo())}>撤销</Button>
              <Button size="sm" variant="outline" disabled={blocked || !controller.canRedo} title="Ctrl+Shift+Z" onClick={() => local(() => controller.redo())}>重做</Button>
            </div>
            {controller.dirty && <>
              <p className="ie-hint" title="执行其他操作或应用时会自动存为新版本">未保存笔划 {controller.dirtyPixelCount.toLocaleString()} 像素</p>
              <div className="ie-tool-buttons">
                <Button size="sm" disabled={blocked} onClick={savePixels}>保存为新版本</Button>
                <Button size="sm" variant="ghost" disabled={!!busy || !!pending} onClick={() => local(() => controller.discardPixels())}>舍弃未保存笔划</Button>
              </div>
            </>}
          </div>
        </aside>
        <section className="ie-center">
          <div className="ie-modebar" role="tablist" aria-label="修改方式">
            <Button size="sm" role="tab" aria-selected={mode === 'local'} variant={mode === 'local' ? 'secondary' : 'ghost'} onClick={() => switchMode('local')}>本地精修</Button>
            <Button size="sm" role="tab" aria-selected={mode === 'ai'} variant={mode === 'ai' ? 'secondary' : 'ghost'} onClick={() => switchMode('ai')}>AI 局部修改{!aiSupported && '（此图不可用）'}</Button>
            <span>{mode === 'ai' ? '框选范围 → 描述修改 → 生成 → 对比后应用' : '选择范围 → 绘制或执行操作 → 对比后应用'}</span>
          </div>
          <div className="ie-compare" aria-label="图片对比">
            {([{ id: 'candidate', name: '修改后' }, { id: 'source', name: '修改前' }, { id: 'diff', name: '差异高亮' }] as const).map(item => <Button key={item.id} size="sm" variant={display === item.id ? 'secondary' : 'ghost'} aria-pressed={display === item.id} onClick={() => { setDisplay(item.id); if (item.id === 'diff' && renderContext) setShowContext(false); }}>{item.name}</Button>)}
            {(contextLayers.length > 0 || renderContext) && <label><input type="checkbox" checked={showContext} onChange={event => { setShowContext(event.target.checked); if (event.target.checked && display === 'diff' && renderContext) setDisplay('candidate'); }} />摆放上下文</label>}
          </div>
          <div className="ie-view-state" data-viewing={view ? 'other' : undefined}>
            {viewLoading ? <><output>正在读取{versionName(viewLoading)}，保留当前画面…</output><Button size="sm" variant="ghost" onClick={cancelView}>取消等待</Button></>
              : view ? <><strong>正在查看{versionName(view.version)}（只读）</strong>
                <Button size="sm" variant="outline" onClick={returnToWorking}>回到工作版本</Button>
                <Button size="sm" disabled={!!busy || !!pending || !canContinue || controller.dirty} onClick={editViewed}>从这里继续改</Button>
                {controller.dirty && <span>工作版本上有未保存笔划，先回去保存或舍弃，才能从这里继续。</span>}</>
              : <span>工作版本：{versionName(loaded.baseVersion)}{display !== 'candidate' && ` · 对比：${versionName(beforeVersion)}${beforeImage ? '' : '（读取中）'}`}{display !== 'candidate' && ' · 开始编辑会回到修改后'}</span>}
          </div>
          {showContext && renderContext && <div className="ie-context-preview">{contextPreviewUrl ? <div className="ie-context-image" key={contextPreviewUrl}>{renderContext(contextPreviewUrl)}</div> : <p>正在准备当前版本的只读上下文…</p>}<p className="ie-hint">仅预览所选图片的摆放位置；上下文不会上传。</p></div>}
          <div className="ie-source-pane" style={{ display: showContext && renderContext ? 'none' : undefined }}><ImageEditCanvas controller={controller} version={version} tool={tool} color={color} alpha={alpha} brushSize={tool === 'mask-add' ? maskBrushSize : brushSize} display={display} viewPixels={viewPixels} beforePixels={beforeImage?.pixels} selectionMode={selectionMode} selectionVisible={selectionVisible} onSelectionVisible={setSelectionVisible} disabled={blocked} tolerance={tolerance} contextLayers={contextLayers} showContext={showContext && !renderContext} onChange={() => { changed(); setNotice(''); }} onColor={(nextColor, nextAlpha) => { setColor(nextColor); setAlpha(nextAlpha); }} onError={setError} onNotice={text => { setError(''); setNotice(text); }} onEditView={() => setDisplay('candidate')} onFill={fillAt} onMove={(dx, dy) => void moveSelection(dx, dy)} /></div>
        </section>
        <aside className="ie-properties" aria-label="局部调整参数">
          {lockReason && <output className="ie-lock-reason">{lockReason}</output>}
          <section className="ie-panel-section"><h3>修改范围</h3>
            <p className="ie-range"><strong>{rangeText}</strong>{controller.selectionCount > 0 && !selectionVisible && <> · 已隐藏 <button type="button" className="ie-link" onClick={() => setSelectionVisible(true)}>显示</button></>}</p>
            <p className="ie-hint">{mode === 'ai' ? '只有蓝色范围内的像素会被替换，其余逐像素保持。' : '笔划、填充和下方操作只作用于蓝色范围。'}</p>
            <details className="ie-named-regions"><summary>命名区域</summary><fieldset disabled={blocked}>
              <label>区域名称<input value={regionName} maxLength={80} placeholder="例如：门框" onChange={event => setRegionName(event.target.value)} /></label>
              <Button size="sm" variant="outline" disabled={!regionName.trim() || !controller.selectionCount} onClick={() => void saveNamedRegion()}>把当前范围存为命名区域</Button>
              <NativeSelect aria-label="已保存区域" value={selectedNamed} onChange={event => setSelectedNamed(event.target.value)}><NativeSelectOption value="">选择已保存区域</NativeSelectOption>{loaded.metadata.namedRegions?.map(region => <NativeSelectOption key={region.regionId} value={region.regionId} disabled={region.stale}>{region.name}{region.stale ? '（来源已变）' : ''}</NativeSelectOption>)}</NativeSelect>
              <Button size="sm" variant="ghost" disabled={!selectedNamed} onClick={() => void loadNamedRegion()}>使用区域</Button>
              {loaded.metadata.relatedPagination?.namedRegions.nextOffset != null && <Button size="sm" variant="outline" onClick={() => void loadMoreRelated('namedRegions')}>加载更多区域（已显示 {loaded.metadata.namedRegions?.length || 0}/{loaded.metadata.relatedPagination.namedRegions.total}）</Button>}
            </fieldset></details>
          </section>
          {mode === 'local' && <fieldset className="ie-panel-section" disabled={blocked || !controller.selectionCount}><legend>对范围执行</legend>
            {!controller.selectionCount && !blocked && <p className="ie-lock-reason">先选择修改范围（或点左侧「选整图」）。</p>}
            <p className="ie-hint">每次执行都会存为一个新版本{controller.dirty ? '；未保存笔划会先自动存下' : ''}。填充和移动请用左侧工具直接在画布上操作。</p>
            <label><input type="checkbox" checked={preserveAlpha} onChange={event => setPreserveAlpha(event.target.checked)} />保持所有透明度不变</label>
            <h4>换色</h4>
            {pairs.map((pair, index) => <div className="ie-row" key={index}>
              <label>原色{pairs.length > 1 ? ` ${index + 1}` : ''}<input type="color" value={pair.from} onChange={event => index ? setExtraPairs(extraPairs.map((item, i) => i === index - 1 ? { ...item, from: event.target.value } : item)) : setReplaceFrom(event.target.value)} /></label>
              <label>替换色{pairs.length > 1 ? ` ${index + 1}` : ''}<input type="color" value={pair.to} onChange={event => index ? setExtraPairs(extraPairs.map((item, i) => i === index - 1 ? { ...item, to: event.target.value } : item)) : setReplaceTo(event.target.value)} /></label>
              {index > 0 && <Button size="sm" variant="ghost" onClick={() => setExtraPairs(extraPairs.filter((_, i) => i !== index - 1))}>移除</Button>}
            </div>)}
            <div className="ie-row">
              <Button size="sm" variant="ghost" title="把画笔颜色（可用取色工具获得）填入第一组原色" onClick={() => setReplaceFrom(color)}>用画笔颜色作原色</Button>
              <Button size="sm" variant="ghost" disabled={pairs.length >= MAX_PALETTE_PAIRS} onClick={() => setExtraPairs([...extraPairs, { from: color, to: replaceTo }])}>添加颜色对</Button>
            </div>
            {duplicateColor && <output>原色重复，请为每种原色指定一个结果。</output>}
            <Button size="sm" variant="outline" disabled={duplicateColor} onClick={() => void runOperation(extraPairs.length ? { type: 'palette-map', pairs } : { type: 'replace-color', from: replaceFrom, to: replaceTo })}>{extraPairs.length ? '一次多色替换' : '精确替色'}</Button>
            <h4>清理与擦除</h4>
            <div className="ie-row"><label>低透明度阈值<input type="number" min={0} max={16} value={threshold} onChange={event => setThreshold(Math.max(0, Math.min(16, Number(event.target.value))))} /></label><Button size="sm" variant="outline" onClick={() => void runOperation({ type: 'clean-alpha', threshold })}>清理透明噪点</Button></div>
            <Button size="sm" variant="outline" onClick={() => void runOperation({ type: 'erase' })}>擦除范围内像素</Button>
            <h4>从旧版本恢复</h4>
            <div className="ie-row"><NativeSelect aria-label="区域恢复来源" value={restoreVersion} onChange={event => setRestoreVersion(event.target.value)}><NativeSelectOption value="source">打开时的图片</NativeSelectOption>{loaded.session.candidates.filter(item => item.status === 'completed').map(item => <NativeSelectOption key={item.version} value={item.version}>{versionName(item.version)} · {operationNames[item.operation.type] || '本地修改'}</NativeSelectOption>)}</NativeSelect>
              <Button size="sm" variant="outline" onClick={() => void runOperation({ type: 'restore-region', candidateVersion: restoreVersion })}>恢复范围内像素</Button></div>
          </fieldset>}
          {mode === 'ai' && <fieldset className="ie-panel-section" disabled={blocked}><legend>描述修改</legend>
            {!localIntent && !aiSupported && <div className="ie-lock-reason">{loaded.metadata.target.aiEdit?.reason || '尚未取得 AI 编辑可用性，可在「更多」里刷新目标状态。'} 这张图仍可本地精修，不会自动放大。<Button size="sm" variant="outline" onClick={() => switchMode('local')}>改用本地精修</Button></div>}
            {!localIntent && aiSupported && <p className="ie-hint">{loaded.metadata.target.aiEdit?.model || loaded.metadata.target.aiEdit?.provider} · 保持 {controller.width} × {controller.height} · 基于{versionName(loaded.baseVersion)}</p>}
            <label>修改描述<textarea rows={5} maxLength={12000} value={aiPrompt} placeholder="例如：将门框改为生锈的铁质，保留门洞布局" onChange={event => setAiPrompt(event.target.value)} /></label>
            <p className="ie-hint">{aiPrompt.length.toLocaleString()}/12,000 字 · 逐行写「#112233 → #445566」或「擦除选区像素」「移动选区(2,0)」会改为本地执行，不调用模型。</p>
            <details className="ie-reference-options"><summary>参考图（可选） · {aiReferences.length}/8</summary><label>可选参考图（最多 8 张）<input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={referencesLoading || aiReferences.length >= 8} onChange={event => void addAiReferences(event)} /></label>
              {referencesLoading && <output>正在冻结参考图字节…</output>}
              <div className="ie-ai-references">{aiReferences.map(reference => <div key={reference.id}><img src={reference.source} alt={reference.name} /><span title={reference.name}>{reference.name}</span><Button size="xs" variant="ghost" disabled={referencesLoading} onClick={() => setAiReferences(current => current.filter(item => item.id !== reference.id))}>移除</Button></div>)}</div>
              <p className="ie-hint">单张不超过 30 MiB，合计不超过 32 MiB。只发送这里选的参考；摆放上下文不会上传。</p></details>
            <label><input type="checkbox" checked={keepsIntentAlpha} disabled={localIntent} onChange={event => setAiPreserveAlpha(event.target.checked)} />保留原图透明度</label>
            <p className="ie-hint">{keepsIntentAlpha ? '透明边缘（含半透明）逐像素保持；要改轮廓时关闭。' : '范围内的透明度可能变化。'}</p>
            {intent.route === 'invalid' && <output>{intent.reason}</output>}
            {intent.operation && <p className="ie-hint" aria-live="polite">{rangeText}可写 · {localIntent ? `${operationNames[intent.operation.type]}，本地执行` : '按描述生成，调用一次图片服务'}。颜色、细节、接缝仍需对比检查。</p>}
            {!controller.selectionCount && <p className="ie-lock-reason">先在画布上框选或涂选要修改的范围。</p>}
            {controller.dirty && <p className="ie-hint">提交前会先把未保存笔划存为新版本。</p>}
            {localIntent
              ? <Button disabled={!controller.selectionCount || !intent.operation || referencesLoading} onClick={() => intent.operation && void runOperation(intent.operation, aiReferences, true)}>{exactColorIntent ? '按配色生成本地候选' : '执行本地操作'}</Button>
              : <Button disabled={!aiSupported || !controller.selectionCount || !intent.operation || referencesLoading} onClick={() => intent.operation && void runOperation(intent.operation, aiReferences, true)}>生成 AI 候选（调用模型）</Button>}
          </fieldset>}
          {candidate?.status === 'completed' && <section className="ie-panel-section"><h3>检查{versionName(candidate.version)}</h3>
            <PlacementComparison key={loaded.session.editId + candidate.version} session={loaded.session} version={candidate.version} />
            {darkWarning && <output className="ie-warning">这个版本有大面积新增近黑像素，可能是模型返回异常。若本来就要改成黑色，可以继续应用。</output>}
            {candidate.recolorEvidence && <p className="ie-hint">换色路径：{candidate.recolorEvidence.route} · 色域裁切通道 {candidate.recolorEvidence.clippedChannels}。请分别核对目标色与纹理。</p>}
            <details className="ie-task-status"><summary>保护检查</summary><ImageCandidateEvidence candidate={candidate} session={loaded.session} /></details>
          </section>}
          {mode === 'ai' && <details className="ie-experimental"><summary>试验工具</summary>
            <p className="ie-hint">部件计划、模型复核和合成修正仍在试验，结果需要人工判断。</p>
            <ImageAttributePlan offerPlanner={!localIntent} key={`${loaded.session.editId}:${loaded.baseVersion}`} target={loaded.metadata.target} session={loaded.session} baseVersion={loaded.baseVersion} region={controller.region} prompt={aiPrompt} references={aiReferences} preserveAlpha={aiPreserveAlpha} disabled={blocked||referencesLoading} onBusy={label=>{busyRef.current=!!label;setBusy(label);}} onSelectRegion={region=>{controller.selectRegion(region);setSelectionVisible(true);changed();}} onExecute={(operation,planRef)=>void runOperation(operation,aiReferences,true,planRef)}/>
            {candidate?.attributePlan&&<details><summary>本版本的属性计划</summary><p>{candidate.attributePlan.part}</p>{candidate.attributePlan.successCriteria.map(line=><p key={line}>{line}</p>)}
              {candidate.attributePlan.referenceManifest?.map(ref=><p key={ref.slot}>参考 {ref.slot} · {{'user-reference':'用户参考','rgb-control':'RGB 对照','clean-crop':'干净局部图'}[ref.role]} · {ref.width} × {ref.height}</p>)}
            </details>}
            {candidate?.status==='completed' && candidate.operation.type==='ai-edit' && candidate.constraints?.preserveAlpha && candidate.evidence?.rawSha256 && candidate.previewPath &&
              <details className="ie-recompose"><summary>检查原始返回并修正合成区</summary>
                <img alt="本版本的模型原始返回" loading="lazy" src={'/api/workbench/artifacts?path='+encodeURIComponent(candidate.previewPath.replace(/image\.png$/,'provider-response.png'))}/>
                <p>若原始返回里已经画对，可在主画布重新选择要使用的像素，先减去仍需保护的部位。此次选区替代旧合成区，须位于原授权范围内。其余像素及全图透明度取自生成前的基准。</p>
                <Button size="sm" variant="outline" disabled={blocked||controller.dirty||!controller.selectionCount}
                  onClick={()=>void runOperation({type:'recompose-ai',candidateVersion:candidate.version,rawSha256:candidate.evidence!.rawSha256!})}>用当前选区重新合成（本地）</Button>
              </details>}
            {candidate?.status==='completed'&&(candidate.attributePlan||candidate.recolorEvidence)&&<ImageAttributeReview key={candidate.version} editId={loaded.session.editId} candidate={candidate} disabled={blocked}/>}
            {candidate?.status==='completed'&&<CandidateCheck key={'check-'+candidate.version} editId={loaded.session.editId} candidate={candidate} disabled={!!busy||!!pending} canEdit={canContinue} onAction={action=>{
              const group=dialog.current?.querySelector<HTMLDetailsElement>('.ie-experimental'); if(group)group.open=true;
              const section=dialog.current?.querySelector<HTMLDetailsElement>(action==='recompose'?'.ie-recompose':'.ie-attribute-plan');
              if(section){section.open=true;section.scrollIntoView({block:'center'});}
            }}/>}
          </details>}
          {!!loaded.session.candidates.filter(item => item.status !== 'completed').length && <details className="ie-task-status"><summary>处理中或未完成的任务</summary>{loaded.session.candidates.filter(item => item.status !== 'completed').map(item => <p key={item.version}>{versionName(item.version)} · {operationNames[item.operation.type] || '本地修改'}：{statusNames[item.status] || item.status}{item.error && <span> · {item.error}</span>}</p>)}<p>关闭窗口不取消；只查询已有任务，不重新提交。</p></details>}
        </aside>
      </div>
      {recoverableDraft && <div className="ie-status"><span>发现本机未保存笔划（{new Date(recoverableDraft.updatedAt).toLocaleString()}）。</span><Button size="sm" disabled={!!busy || !!pending || forceReadOnly} onClick={() => void restoreDraft()}>恢复本机笔划</Button><Button size="sm" variant="ghost" onClick={() => setRecoverableDraft(null)}>暂不恢复</Button><Button size="sm" variant="ghost" disabled={!!busy || !!pending} onClick={() => { void saveImagePixelDraft(null, recoverableDraft.key).then(() => setRecoverableDraft(null)).catch(cause => setError(message(cause))); }}>删除这份本机草稿</Button></div>}
      <footer className="ie-footer">
        <ol className="ie-history" aria-label="版本">
          {[{ version: 'source', label: '打开时的图片', detail: '', preview: loaded.originalPreviewSource, status: 'completed' },
            ...loaded.session.candidates.map(item => ({ version: item.version, label: `${versionName(item.version)} · ${operationNames[item.operation.type] || '本地修改'}`, detail: `基于${versionName(item.baseCandidateVersion)}`, status: item.status,
              preview: item.previewPath ? `/api/workbench/artifacts?path=${encodeURIComponent(item.previewPath)}` : cache.peek(loaded.session.editId, item.version)?.previewSource }))].map(item => <li key={item.version}>
            <button type="button" className={viewedVersion === item.version ? 'ie-history-selected' : ''} aria-current={viewedVersion === item.version ? 'true' : undefined} disabled={!!busy || !!pending || item.status !== 'completed'} onClick={() => void selectCandidate(item.version)}>
              {item.preview && <img loading="lazy" decoding="async" src={item.preview} alt="" />}
              <span>{item.label}</span>
              <small>{item.status === 'completed' ? item.detail : statusNames[item.status] || item.status}</small>
              <span className="ie-badges">{loaded.baseVersion === item.version && <b>工作中</b>}{appliedVersion === item.version && <b data-tone="applied">已应用</b>}</span>
            </button></li>)}
        </ol>
        <div className="ie-adopt-actions">
          {!!loaded.session.adoptions.length && targetKind !== 'motion-frame' && <Button variant="outline" disabled={adoptionBlocked || !!busy || !!pending || controller.dirty} title="把打开时的图片重新应用为新的目标版本" onClick={() => void adopt('source')}>恢复打开时的图片</Button>}
          <Button disabled={!canApply} title={dirty && !view ? '先把未保存笔划存为新版本，再应用' : `应用${versionName(viewedVersion)}`} onClick={() => void adopt(viewedVersion || 'source')}>{applyLabel}{viewedVersion && viewedVersion !== 'source' && !(dirty && !view) ? ` · ${versionName(viewedVersion)}` : ''}</Button>
        </div>
      </footer>
      <div className="ie-status" aria-live="polite">{busy || error || notice || (controller.dirty ? '有未保存笔划；关闭或离开前会提醒。' : `要应用的是当前查看的${versionName(viewedVersion)}；先对比确认效果。`)}{loaded.followVersion && <span>正在等待所请求版本完成，当前显示它的基础版本。</span>}{loaded.metadata.target.willStopDefaultAnimations && <span>应用默认图会停止默认待机/聚焦动画选择；动画片段保留。</span>}{pending && !busy && <Button size="sm" variant="outline" onClick={() => void execute(pending)}>{pending.external ? '恢复同一请求（不新建）' : '重试同一操作'}</Button>}{!forceReadOnly && !canContinue && !busy && !pending && <><Button size="sm" variant="outline" onClick={() => void startNewSession()}>{sessionStartFailed ? '重试建立编辑会话' : '基于当前图片继续精修'}</Button>{sessionStartFailed && <Button size="sm" variant="ghost" onClick={() => void startNewSession(true)}>放弃此次打开并按当前目标重建</Button>}</>}</div>
    </>}
    {leavePrompt && <div className="ie-leave" role="alertdialog" aria-label="离开局部调整"><h3>离开局部调整？</h3><p>{busy || pending ? '请求可能已保存到会话。关闭不取消，也不会重新提交；之后通过原会话继续检查。' : aiDraftDirty ? '未提交的 AI 描述、参考选择及未保存笔划将丢失；运行中的任务和已保存的版本保留。' : '未保存的笔划将丢失；已保存的版本和应用记录保留。'}</p><div className="ie-row"><Button onClick={() => setLeavePrompt(false)}>继续编辑</Button><Button variant="destructive" onClick={() => { if (loaded) void saveImagePixelDraft(null, `${loaded.session.editId}:${draftOwner.current}`).catch(() => undefined); onClose(); }}>舍弃未保存内容并关闭</Button></div></div>}
  </dialog></div>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

function ImageCandidateEvidence({ candidate, session }: { candidate: ImageCandidate; session: ImageEditSession }) {
  const base = candidate.diffFromBase || candidate.diff, source = candidate.diffFromSource;
  const baseName = !candidate.baseCandidateVersion || candidate.baseCandidateVersion === 'source' ? '原始图' : `候选 ${session.candidates.findIndex(item => item.version === candidate.baseCandidateVersion) + 1}`;
  return <section className="ie-evidence" aria-label="候选保护证据"><h3>候选检查</h3>
    <p>本步基准：{baseName}</p>
    {base ? <><p>本步变化 {base.changedPixelCount.toLocaleString()} 像素 · 保护区变化 {base.changedOutsideRegion.toLocaleString()}</p><p>本步 Alpha 变化 {base.alphaChangedPixelCount.toLocaleString()} 像素</p></> : <p>本步像素检查尚未完成。</p>}
    {source && <p>累计相对原始图：{source.changedPixelCount.toLocaleString()} 像素；当前区域外 {source.changedOutsideRegion.toLocaleString()}（可包含先前编辑）。</p>}
    {candidate.evidence?.preservation?.changedOutsideMaskPixels !== undefined && <p>编码后保护区变化：{candidate.evidence.preservation.changedOutsideMaskPixels}</p>}
    {candidate.operation.type === 'ai-edit' && <p>{candidate.evidence?.model || candidate.evidence?.provider || 'AI 图片候选'} · {candidate.evidence?.alphaPreservation?.changedAlphaPixels === 0 ? '透明度已按本步基准保持并校验' : '未启用透明度保持，选区内 Alpha 可能变化'}；仍需检查内部细节与接缝。</p>}
  </section>;
}
