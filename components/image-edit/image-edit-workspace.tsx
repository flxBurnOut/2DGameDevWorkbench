'use client';
import { ImageAttributePlan } from './image-attribute-plan';
import { ImageAttributeReview } from './image-attribute-review';
import { CandidateCheck } from './candidate-check';
/* oxlint-disable next/no-img-element -- AI references preview the exact uploaded source bytes. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { PlacementComparison } from './placement-comparison';
import { MetalPanelDialog } from './metal-panel-dialog';
import { cropPanel, type PanelCrop } from '@/features/image-edit/metal-panel.mjs';
import { MAX_PALETTE_PAIRS, planImageIntent, type PalettePair } from '@/features/image-edit/edit-intent.mjs';
import { Button } from '@/components/ui/button';
import { PixelController } from '@/features/image-edit/pixel-controller.mjs';
import { base64ToBytes, encodePixelPatch, imageAiEditInput, imageApplyInput, imageCandidateBase, imageCandidateFollowState, imageEditInput, imageEditRequest, imageInspectionMetadata, imageResolveInput, imageSessionNeedsPolling, imageSourceActionBlockReason, ImageEditClientError, inspectImage, listImagePixelDrafts, mergeImageInspectionPage, mergeImageWorkspaceRefresh, openImageSession, performImageSourceAction, readImageAiReference, readImageEdit, saveImagePixelDraft, validateAiReferences } from '@/features/image-edit/client';
import type { ImageAdoptionReceipt, ImageAiReference, ImageCandidate, ImageEditContextLayer, ImageEditOperation, ImageEditSession, ImageInspection, ImagePixelDraft, ImageRelatedKind, ImageSessionBootstrap, ImageTargetInfo, ImageTargetRef } from '@/features/image-edit/client';
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
  onOpenSource?: (target: ImageTargetInfo) => void | Promise<void>;
  onDownloadSource?: (target: ImageTargetInfo) => void | Promise<void>;
}
interface PendingCommand { label: string; operation: string; body: unknown; external?: boolean; complete: (value: unknown) => Promise<void> }
interface LoadedWorkspace { metadata: ImageInspection; session: ImageEditSession; controller: PixelController; baseVersion: string; baseHash: string; followVersion?: string; originalPreviewSource?: string; basePreviewSource?: string }
const plainSession = (value: ImageEditSession) => { const { pixels: _pixels, ...rest } = value; return rest; };
const metadataOnly = imageInspectionMetadata;
const operationNames: Record<string, string> = { 'recompose-ai': '修正合成区', 'intrinsic-recolor': '分层换色', 'color-map': '简单换色', 'metal-panel': '拼板换金属', 'palette-map': '多色替换', 'pixel-patch': '手工笔划', 'clean-alpha': '透明噪点清理', 'replace-color': '精确替色', fill: '连通填充', erase: '擦除', translate: '移动像素', 'restore-region': '恢复区域', 'source-restore': '恢复原图', 'ai-edit': 'AI 修改' };
const statusNames: Record<string, string> = { completed: '已生成 · 待确认效果', running: '处理中', preparing: '准备中', failed: '失败', attention_required: '需要检查', awaiting_configuration: '等待配置' };
const tools: { id: ImagePixelTool; name: string }[] = [{ id: 'pencil', name: '画笔' }, { id: 'eraser', name: '橡皮' }, { id: 'mask-add', name: '涂选' }, { id: 'rectangle', name: '矩形选区' }, { id: 'connected', name: '连通选区' }, { id: 'picker', name: '取色' }, { id: 'pan', name: '平移' }];
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
  if (base.width !== original.width || base.height !== original.height) throw new Error('候选尺寸与原始图不一致。');
  const controller = new PixelController(original.pixels, original.width, original.height, base.pixels);
  controller.selectRegion(null, false);
  return { metadata: metadataOnly(inspection), session: plainSession(edit), controller, ...selection, baseHash: base.rgbaSha256, originalPreviewSource: original.previewSource, basePreviewSource: base.previewSource };
}

export function ImageEditWorkspace({ target, initialEditId, initialCandidateVersion, readOnly = false, contextLayers = [], beforeApply, onBusyChange, onAdopt, onClose, onNavigationChange, renderContext, onOpenSource, onDownloadSource }: ImageEditWorkspaceProps) {
  const adoptCallback = useRef(onAdopt);
  useEffect(() => { adoptCallback.current = onAdopt; }, [onAdopt]);
  const [loaded, setLoaded] = useState<LoadedWorkspace | null>(null), [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState<PendingCommand | null>(null);
  const [cache] = useState(() => new ImageVersionCache()), [viewRequest] = useState(() => new ImageViewRequest());
  const [preview, setPreview] = useState<{ editId: string; version: string; image: VerifiedPixels } | null>(null);
  const [viewLoading, setViewLoading] = useState('');
  const [comparison, setComparison] = useState<{ key: string; image: VerifiedPixels } | null>(null);
  const [selectionMode, setSelectionMode] = useState<'replace' | 'add' | 'subtract'>('replace');
  const [selectionVisible, setSelectionVisible] = useState(true), [advancedTools, setAdvancedTools] = useState(false);
  const [maskBrushSize, setMaskBrushSize] = useState(32);
  const [tool, setTool] = useState<ImagePixelTool>('rectangle'), [display, setDisplay] = useState<ImageViewMode>('candidate');
  const [color, setColor] = useState('#eebc52'), [alpha, setAlpha] = useState(255), [brushSize, setBrushSize] = useState(1), [tolerance, setTolerance] = useState(0);
  const [threshold, setThreshold] = useState(1), [replaceFrom, setReplaceFrom] = useState('#000000'), [replaceTo, setReplaceTo] = useState('#ffffff');
  const [dx, setDx] = useState(1), [dy, setDy] = useState(0), [seedX, setSeedX] = useState(0), [seedY, setSeedY] = useState(0);
  const [regionName, setRegionName] = useState(''), [selectedNamed, setSelectedNamed] = useState(''), [restoreVersion, setRestoreVersion] = useState('source');
  const [preserveAlpha, setPreserveAlpha] = useState(false), [showContext, setShowContext] = useState(false), [leavePrompt, setLeavePrompt] = useState(false), [retryLoad, setRetryLoad] = useState(0);
  const [recoverableDraft, setRecoverableDraft] = useState<ImagePixelDraft | null>(null);
  const [sessionStartFailed, setSessionStartFailed] = useState(false);
  const [contextPreview, setContextPreview] = useState<{ controller: PixelController; version: number; display: ImageViewMode; url: string } | null>(null);
  const [aiPreserveAlpha, setAiPreserveAlpha] = useState(true);
  const [mode, setMode] = useState<'local' | 'ai'>('ai'), [aiPrompt, setAiPrompt] = useState(''), [aiReferences, setAiReferences] = useState<ImageAiReference[]>([]), [referencesLoading, setReferencesLoading] = useState(false), [savedAiDraft, setSavedAiDraft] = useState('');
  const [extraPairs, setExtraPairs] = useState<PalettePair[]>([]);
  const [panelTrial, setPanelTrial] = useState<{ crop: PanelCrop; id: string; base: string; region: RegionSpec; maskRevision: number } | null>(null);
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

  const switchMode = (next: 'local' | 'ai') => { setMode(next); if (next === 'ai' && ['pencil', 'eraser', 'picker'].includes(tool)) setTool('rectangle'); };
  const chooseTool = (next: ImagePixelTool) => { setTool(next); setSelectionVisible(true); if (['pencil', 'eraser', 'picker'].includes(next)) setMode('local'); };
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
        setLoaded(value); setPending(original ? {
          label: '恢复原图片请求', operation: original.request.operation, body: original.request.input, external: true,
          complete: async response => {
            const latest = loadedRef.current;
            if (!latest || latest.controller.dirty) throw new Error('请保留当前笔划后再恢复原请求结果。');
            if (original.request.operation === 'apply') await adoptCallback.current(response as ImageAdoptionReceipt);
            const result = response as { edit?: ImageEditSession; candidateVersion?: string };
            const editId = result.edit?.editId || (original.request.input.editId as string | undefined) || latest.session.editId;
            const next = await loadWorkspace(cache, selection.target, { commandId: crypto.randomUUID(), editId }, result.candidateVersion);
            setLoaded(next); setPreview(null); setNotice('原图片请求已确认，候选与采用回执已恢复。');
          },
        } : null); setBusy('');
      }
    }).catch(cause => { if (alive) { setError(message(cause)); setBusy(''); } });
    return () => { alive = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [key, retryLoad, initialEditId, cache]);
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
              setNotice('请求的候选已完成；未保存笔划保留，请保存后明确选择该候选。');
            } else {
              busyRef.current = true; setBusy('读取请求的候选');
              try {
                const pixels = await cache.load(edit.editId, requested.version);
                const latest = loadedRef.current;
                if (!active || !latest || latest.session.editId !== edit.editId || latest.followVersion !== requested.version) return;
                if (latest.controller.dirty) { setNotice('候选已完成，未覆盖后来产生的笔划。'); return; }
                const controller = latest.controller; controller.setBase(pixels.pixels);
                setLoaded({ ...latest, session: plainSession(edit), controller, baseVersion: requested.version, baseHash: pixels.rgbaSha256, basePreviewSource: pixels.previewSource, followVersion: undefined });
                setPreview(null); setSelectionVisible(false); changed(); setDisplay('candidate'); setNotice('候选已生成，请对比效果后决定是否采用。');
              } finally { busyRef.current = false; if (active) setBusy(''); }
            }
          } else {
            const stopped = following.state === 'stopped';
            setLoaded(old => old?.session.editId === edit.editId && old.session.revision <= edit.revision ? { ...old, session: plainSession(edit), ...(stopped ? { followVersion: undefined } : {}) } : old);
            if (stopped) setError(requested?.error || '原任务需要检查，不会重新提交或自动采用。');
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
  const blocked = !!busy || !!pending || !!view || !!viewLoading || display !== 'candidate' || showContext || !canContinue;
  const selectCandidate = async (candidateVersion: string) => {
    if (!loaded || busyRef.current || pending) return;
    const current = loaded, signal = viewRequest.begin();
    setViewLoading(candidateVersion); setError('');
    setLoaded(old => old ? { ...old, followVersion: undefined } : old);
    try {
      if (candidateVersion === current.baseVersion) setPreview(null);
      else {
        const image = await cache.load(current.session.editId, candidateVersion, signal);
        if (signal.aborted || loadedRef.current?.session.editId !== current.session.editId) return;
        setPreview({ editId: current.session.editId, version: candidateVersion, image });
      }
      setDisplay('candidate'); setSelectionVisible(false);
    } catch (cause) { if (!signal.aborted) setError(message(cause)); }
    finally { if (!signal.aborted) setViewLoading(''); }
  };
  const cancelView = () => { viewRequest.cancel(); setViewLoading(''); };
  const editViewed = () => {
    if (!loaded || !view || busyRef.current || pending || !canContinue) return;
    try {
      loaded.controller.setBase(view.image.pixels);
      setLoaded({ ...loaded, baseVersion: view.version, baseHash: view.image.rgbaSha256, basePreviewSource: view.image.previewSource });
      setPreview(null); setDisplay('candidate'); setSelectionVisible(true); changed();
      setNotice('已更换修改基准，选区与选区历史保留。');
    } catch (cause) { setError(message(cause)); }
  };
  const runOperation = async (operation: ImageEditOperation, references: readonly ImageAiReference[] = [], fromDescription = false, planRef?: string) => {
    if (!loaded || blocked || busyRef.current || (!loaded.controller.region && !planRef)) return;
    if (loaded.controller.maskStrokeActive) { setError('请先结束当前选区笔划，再提交候选。'); return; }
    if (operation.type !== 'pixel-patch' && loaded.controller.dirty) { setError('请先将未保存笔划保存为候选，再执行其他操作。'); return; }
    const current = loaded, region = current.controller.region, commandId = crypto.randomUUID();
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
        if (!original?.baseCandidateVersion) throw new Error('原候选的生成基准不可用。');
        body = imageEditInput(current.metadata.target,current.session,original.baseCandidateVersion,regionRef,operation,true,commandId);
      } else {
        body = operation.type === 'ai-edit' ? imageAiEditInput(current.metadata.target, current.session, current.baseVersion, regionRef, operation.prompt, frozenReferences, current.controller.dirty, commandId, prepared?.constraints.preserveAlpha??aiPreserveAlpha) : imageEditInput(current.metadata.target, current.session, current.baseVersion, regionRef, operation, prepared?.constraints.preserveAlpha??(operation.type === 'metal-panel' || (fromDescription ? keepsIntentAlpha : preserveAlpha)), commandId);
      }
      if(planRef)body={...body,planRef};
    }
    catch (cause) { setError(message(cause)); busyRef.current = false; setBusy(''); return; }
    busyRef.current = false;
    await execute({
      label: external ? '正在提交 AI 候选请求' : '正在保存本地候选', operation: 'edit', body, external,
      complete: async value => {
        const result = value as { edit: ImageEditSession; candidateVersion: string; status: string };
        if (external || fromDescription) setSavedAiDraft(submittedAiKey);
        if (result.status !== 'completed') {
          const stopped = ['failed', 'attention_required', 'awaiting_configuration'].includes(result.status);
          setLoaded(old => old?.session.editId === result.edit.editId ? { ...old, session: plainSession(result.edit), followVersion: stopped ? undefined : result.candidateVersion } : old);
          if (stopped) setError(result.edit.candidates.find(item => item.version === result.candidateVersion)?.error || '候选未通过检查，原图与笔划保留；不会自动重新请求。');
          else setNotice('原任务正在处理。关闭不取消；重开此会话继续查看，不会重复提交或采用。');
          return;
        }
        const pixels = await cache.load(result.edit.editId, result.candidateVersion);
        const controller = current.controller; controller.discardPixels(); controller.setBase(pixels.pixels);
        setLoaded(old => old?.session.editId === result.edit.editId ? { ...old, session: plainSession(result.edit), controller, baseVersion: result.candidateVersion, baseHash: pixels.rgbaSha256, basePreviewSource: pixels.previewSource, followVersion: undefined } : old);
        setPreview(null); setSelectionVisible(false); changed(); setDisplay('candidate'); setNotice('候选已保存，请对比效果后决定是否采用。');
      },
    });
  };
  const savePixels = () => {
    if (!loaded) return;
    try { void runOperation(encodePixelPatch(loaded.controller.patch(), loaded.baseHash)); } catch (cause) { setError(message(cause)); }
  };
  const adopt = async (candidateVersion: string) => {
    if (!loaded || busyRef.current || pending || forceReadOnly || !loaded.metadata.target.editable || loaded.metadata.target.locked) return;
    if (loaded.controller.dirty) { setError('请先保存或舍弃未保存笔划，再采用。'); return; }
    const current = loaded;
    await execute({ label: candidateVersion === 'source' ? '恢复原始图片' : '采用当前候选', operation: 'apply', body: imageApplyInput(current.metadata.target, current.session.editId, candidateVersion, crypto.randomUUID()), complete: async value => {
      const receipt = value as ImageAdoptionReceipt;
      try { await onAdopt(receipt); }
      catch (cause) { throw new Error(`服务端已采用，本页尚未完成同步。请重试同一操作以重新读取：${message(cause)}`); }
      const refreshed = await readImageEdit(current.session.editId);
      const selected = await cache.load(current.session.editId, candidateVersion);
      current.controller.setBase(selected.pixels); changed();
      setLoaded({ ...current, metadata: { ...current.metadata, target: receipt.target }, session: plainSession(refreshed.edit), controller: current.controller, baseVersion: candidateVersion, baseHash: selected.rgbaSha256, basePreviewSource: selected.previewSource, followVersion: undefined });
      setPreview(null); setSelectionVisible(false); setDisplay('candidate'); setNotice(candidateVersion === 'source' ? '原始图片已恢复为新的目标版本。其他源图和工程内容保留。' : '已采用到指定目标。继续精修将基于采用结果创建新会话。');
    } });
  };
  const startNewSession = async (reset = false) => {
    if (!loaded || busyRef.current || loaded.controller.dirty || forceReadOnly) return;
    busyRef.current = true; setBusy('基于当前目标新建编辑'); setError('');
    if (reset || !nextSession.current) nextSession.current = { commandId: crypto.randomUUID() };
    try { setLoaded(await loadWorkspace(cache, target, nextSession.current)); setPreview(null); setSelectionVisible(true); nextSession.current = null; setSessionStartFailed(false); setNotice('已基于当前目标打开新会话。'); }
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
      setLoaded({ ...loaded, controller, baseVersion: recoverableDraft.baseVersion, baseHash: base.rgbaSha256, basePreviewSource: base.previewSource }); setRecoverableDraft(null); setNotice('本机笔划已恢复，尚未保存为候选。');
    } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setBusy(''); }
  };
  const selectSession = async (editId: string) => {
    if (!loaded || busyRef.current || !editId) return;
    if (loaded.controller.dirty) { setError('请先保存或舍弃当前笔划，再打开另一份会话。'); return; }
    busyRef.current = true; setBusy('打开已保存会话'); setError('');
    try { viewRequest.cancel(); setViewLoading(''); setLoaded(await loadWorkspace(cache, target, { commandId: crypto.randomUUID(), editId })); setPreview(null); setSelectionVisible(true); setNotice('已打开明确选择的历史会话。'); }
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
      setNotice('目标与会话版本已刷新；本机笔划、已选基准和候选保留。');
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
  const sourceActionState = { busy: !!busy, pending: !!pending, pixelDirty: !!loaded?.controller.dirty, aiDraftDirty, referencesLoading };
  const openSourceBlocked = imageSourceActionBlockReason(sourceActionState, true);
  const downloadSourceBlocked = imageSourceActionBlockReason(sourceActionState, false);
  const sourceAction = async (opensEditor: boolean) => {
    const action = opensEditor ? onOpenSource : onDownloadSource;
    if (!loaded || !action) return;
    const state = { ...sourceActionState, busy: !!busy || busyRef.current };
    const reason = imageSourceActionBlockReason(state, opensEditor);
    if (reason) { setError(reason); return; }
    busyRef.current = true; setBusy('正在核验嵌入源包版本与内容'); setError('');
    try { await performImageSourceAction(loaded.metadata.target, state, opensEditor, action); }
    catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setBusy(''); }
  };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); if (viewLoading) cancelView(); else if (loaded?.controller.selectionCount && display === 'candidate' && !view) local(() => loaded.controller.selectRegion(null)); else close(); return; }
    if (event.key === 'Tab' && dialog.current) {
      const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')).filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || blocked || !loaded) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); local(() => { if (['rectangle', 'connected', 'mask-add', 'mask-erase'].includes(tool)) { if (event.shiftKey) loaded.controller.redoMask(); else loaded.controller.undoMask(); } else if (event.shiftKey) loaded.controller.redoPixels(); else loaded.controller.undoPixels(); }); }
  };
  const controller = loaded?.controller;
  const candidate = viewedCandidate;
  const versionName = (id?: string) => !id || id === 'source' ? '会话原图' : `候选 ${(loaded?.session.candidates.findIndex(item => item.version === id) ?? -1) + 1}`;
  const content = <div className="ie-backdrop"><dialog open ref={dialog} aria-modal="true" aria-labelledby="ie-title" tabIndex={-1} className="ie-workspace" onKeyDown={keyDown}>
    <header className="ie-header"><div><h2 id="ie-title">局部调整</h2><p>{loaded?.metadata.target.name || '读取已有图片'}{loaded && ` · ${loaded.metadata.target.width} × ${loaded.metadata.target.height}`}</p></div><div className="ie-header-actions"><span className="ie-local-badge">{mode === 'ai' && !localIntent ? '外观修改 · 图片服务' : '本地操作 · 无需生图'}</span><Button variant="ghost" onClick={close}>关闭</Button></div></header>
    {!loaded && <div className="ie-loading"><p>{busy || error || '准备编辑工作区'}</p>{!busy && <><Button onClick={() => setRetryLoad(value => value + 1)}>重试同一次打开</Button><Button variant="ghost" onClick={() => { boot.current = null; setRetryLoad(value => value + 1); }}>按当前目标重新打开</Button></>}</div>}
    {loaded && controller && <>
      <div className="ie-main">
        <aside className="ie-tools" aria-label="像素工具">
          <span className="ie-label">画布工具 · 两种模式共用</span>
          <div className="ie-tool-buttons">{tools.map(item => <Button key={item.id} size="sm" variant={tool === item.id ? 'secondary' : 'ghost'} aria-pressed={tool === item.id} onClick={() => chooseTool(item.id)} disabled={item.id !== 'pan' && blocked}>{item.name}</Button>)}</div>
          <div className="ie-tool-settings">
          <label>颜色<input type="color" value={color} onChange={event => setColor(event.target.value)} /></label>
          <label>不透明度<input type="number" min={0} max={255} value={alpha} onChange={event => setAlpha(Math.max(0, Math.min(255, Number(event.target.value))))} /></label>
          <label>笔宽<input type="number" min={1} max={32} value={brushSize} onChange={event => setBrushSize(Math.max(1, Math.min(32, Number(event.target.value))))} /></label>
          <label>连通容差<input type="number" min={0} max={255} value={tolerance} onChange={event => setTolerance(Math.max(0, Math.min(255, Number(event.target.value))))} /></label>
          <label>涂选笔宽<input type="number" min={1} max={256} value={maskBrushSize} onChange={event => setMaskBrushSize(Math.max(1, Math.min(256, Number(event.target.value))))} /></label>
          </div>
          <hr /><span className="ie-label">像素历史</span><Button size="sm" variant="outline" disabled={blocked || !controller.canUndoPixels} onClick={() => local(() => controller.undoPixels())}>撤销笔划</Button><Button size="sm" variant="outline" disabled={blocked || !controller.canRedoPixels} onClick={() => local(() => controller.redoPixels())}>重做笔划</Button>
          <Button size="sm" disabled={blocked || !controller.dirty} onClick={savePixels}>保存笔划为候选</Button>
          <Button size="sm" variant="ghost" disabled={!!busy || !!pending || !controller.dirty} onClick={() => local(() => controller.discardPixels())}>舍弃未保存笔划</Button>
          <p className="ie-hint">手工与 AI 共用选区。先框选或选整图，再绘制；笔划保存为候选后可继续 AI 修改。</p>
        </aside>
        <section className="ie-center">
          <div className="ie-modebar"><Button size="sm" variant={mode === 'local' ? 'secondary' : 'ghost'} onClick={() => switchMode('local')}>本地精修</Button><Button size="sm" variant={mode === 'ai' ? 'secondary' : 'ghost'} onClick={() => switchMode('ai')}>AI 局部修改</Button><span>{mode === 'ai' ? '选范围 → 描述修改 → 生成 → 对比' : '选范围 → 绘制 → 保存候选'}</span></div>
          <div className="ie-compare" aria-label="图片对比">{([{ id: 'candidate', name: '修改后' }, { id: 'source', name: '修改前' }, { id: 'diff', name: '差异高亮' }] as const).map(item => <Button key={item.id} size="sm" variant={display === item.id ? 'secondary' : 'ghost'} onClick={() => { setSelectionVisible(false); setDisplay(item.id); if (item.id === 'diff' && renderContext) setShowContext(false); }}>{item.name}</Button>)}{(contextLayers.length > 0 || renderContext) && <label><input type="checkbox" checked={showContext} onChange={event => { setShowContext(event.target.checked); if (event.target.checked && display === 'diff' && renderContext) setDisplay('candidate'); }} />{renderContext ? '场景上下文' : '地图上下文'}</label>}</div>
          <div className="ie-view-state"><span>查看：{versionName(viewedVersion)} · 对比基准：{versionName(beforeVersion)}</span>{view && <Button size="sm" disabled={!!busy || !!pending || !!viewLoading || !canContinue || controller.dirty} onClick={editViewed}>以此版本继续修改</Button>}{view && controller.dirty && <span>未保存笔划保留在 {versionName(loaded.baseVersion)}，切回后可继续。</span>}{viewLoading && <><output>正在读取 {versionName(viewLoading)}，保留当前画面…</output><Button size="sm" variant="ghost" onClick={cancelView}>取消等待</Button></>}{display !== 'candidate' && !beforeImage && <span>正在读取对比基准…</span>}</div>
          {candidate?.status === 'completed' && <PlacementComparison key={loaded.session.editId + candidate.version} session={loaded.session} version={candidate.version} />}
          {showContext && renderContext && <div className="ie-context-preview">{contextPreviewUrl ? <div className="ie-context-image" key={contextPreviewUrl}>{renderContext(contextPreviewUrl)}</div> : <p>正在准备当前版本的只读上下文…</p>}<p className="ie-hint">仅预览所选图片位置，不修改其他实例、源包或运行状态；上下文不会自动上传。</p></div>}
          <div className="ie-source-pane" style={{ display: showContext && renderContext ? 'none' : undefined }}><ImageEditCanvas controller={controller} version={version} tool={tool} color={color} alpha={alpha} brushSize={tool === 'mask-add' ? maskBrushSize : brushSize} display={display} viewPixels={viewPixels} beforePixels={beforeImage?.pixels} selectionMode={selectionMode} selectionVisible={selectionVisible} onSelectionVisible={setSelectionVisible} disabled={blocked} tolerance={tolerance} contextLayers={contextLayers} showContext={showContext && !renderContext} onChange={changed} onColor={(nextColor, nextAlpha) => { setColor(nextColor); setAlpha(nextAlpha); }} onError={setError} /></div>
        </section>
        <aside className="ie-properties" aria-label="局部调整参数">
          {loaded.metadata.target.targetRef.kind === 'scene-instance' && <p className="ie-ai-reason">仅修改选中实例，采用时派生独立素材。{loaded.metadata.target.sharedInstanceCount !== undefined && `当前素材由 ${loaded.metadata.target.sharedInstanceCount} 个实例共享。`}其他实例、位置、锚点与联动保留。</p>}
          {(!loaded.metadata.target.editable || loaded.metadata.target.locked || forceReadOnly) && <p className="ie-ai-reason">{loaded.metadata.target.readOnlyReason || (loaded.metadata.target.locked ? '此图片目标已锁定，只读查看。' : '此入口只读，可查看原图和历史候选。')}</p>}
          {loaded.metadata.target.sourceEntry && <section className="ie-evidence"><h3>嵌入地图源包</h3><p>打开源包不会自动更新已固定的场景快照。交付前将核验宿主版本与源包内容。</p>{onOpenSource && <Button size="sm" variant="outline" disabled={!!openSourceBlocked} onClick={() => void sourceAction(true)}>打开嵌入地图源包</Button>}{onDownloadSource && <Button size="sm" variant="ghost" disabled={!!downloadSourceBlocked} onClick={() => void sourceAction(false)}>下载嵌入地图源包</Button>}{openSourceBlocked && <p className="ie-hint">{openSourceBlocked}</p>}</section>}
          <fieldset disabled={blocked}><legend>1 · 选择修改范围</legend>
            <output>{!controller.selectionCount ? '尚未选择范围 · 拖动框选开始' : controller.selectionCount === controller.width * controller.height ? '整张图片' : `${controller.selectionCount.toLocaleString()} 个像素`} {controller.dirty ? `· 未保存 ${controller.dirtyPixelCount.toLocaleString()} 个像素` : ''}</output>
            <div className="ie-selection-modes" aria-label="选区组合方式">{([{ id: 'replace', name: '新建' }, { id: 'add', name: '添加' }, { id: 'subtract', name: '减去' }] as const).map(item => <Button key={item.id} size="sm" variant={selectionMode === item.id ? 'secondary' : 'ghost'} aria-pressed={selectionMode === item.id} onClick={() => { setSelectionMode(item.id); setSelectionVisible(true); }}>{item.name}</Button>)}</div>
            <div className="ie-row"><Button size="sm" variant="outline" onClick={() => local(() => controller.selectRegion({ type: 'all' }))}>选整图</Button><Button size="sm" variant="ghost" onClick={() => local(() => controller.selectRegion(null))}>清空选区</Button></div>
            <div className="ie-row"><Button size="sm" variant="outline" onClick={() => local(() => controller.selectRegion({ type: 'alpha-bounds', threshold: 1 }))}>可见包围框</Button><Button size="sm" variant="outline" onClick={() => local(() => controller.selectRegion({ type: 'alpha-selection', minAlpha: 1, maxAlpha: 255 }))}>可见像素</Button></div>
            <div className="ie-row"><Button size="sm" variant="ghost" disabled={!controller.canUndoMask} onClick={() => local(() => controller.undoMask())}>撤销选区</Button><Button size="sm" variant="ghost" disabled={!controller.canRedoMask} onClick={() => local(() => controller.redoMask())}>重做选区</Button></div>
            <Button size="sm" variant="ghost" onClick={() => setAdvancedTools(value => !value)}>{advancedTools ? '收起区域管理' : '命名区域管理'}</Button>
            {advancedTools && <><label>区域名称<input value={regionName} maxLength={80} placeholder="例如：门框" onChange={event => setRegionName(event.target.value)} /></label><Button size="sm" variant="outline" disabled={!regionName.trim() || !controller.selectionCount} onClick={() => void saveNamedRegion()}>保存命名区域</Button>
            <select aria-label="已保存区域" value={selectedNamed} onChange={event => setSelectedNamed(event.target.value)}><option value="">选择已保存区域</option>{loaded.metadata.namedRegions?.map(region => <option key={region.regionId} value={region.regionId} disabled={region.stale}>{region.name}{region.stale ? '（来源已变）' : ''}</option>)}</select><Button size="sm" variant="ghost" disabled={!selectedNamed} onClick={() => void loadNamedRegion()}>使用区域</Button>
            {loaded.metadata.relatedPagination?.namedRegions.nextOffset != null && <Button size="sm" variant="outline" onClick={() => void loadMoreRelated('namedRegions')}>加载更多区域（已显示 {loaded.metadata.namedRegions?.length || 0}/{loaded.metadata.relatedPagination.namedRegions.total}）</Button>}
            </>}
          </fieldset>
          <Button variant="outline" size="sm" disabled={blocked || controller.dirty || !controller.region} onClick={() => {
            if (!controller.region) return;
            try {
              setPanelTrial({ crop: cropPanel(controller.basePixels, controller.mask, controller.width, controller.height), id: loaded.session.editId,
                base: loaded.baseVersion, region: controller.region, maskRevision: controller.maskRevision });
              setError('');
            } catch (cause) { setError(message(cause)); }
          }}>拼板换金属 · 试验</Button>
          {panelTrial && !blocked && panelTrial.id === loaded.session.editId && panelTrial.base === loaded.baseVersion && panelTrial.maskRevision === controller.maskRevision &&
            <MetalPanelDialog crop={panelTrial.crop} target={loaded.metadata.target} region={panelTrial.region} editId={loaded.session.editId}
              revision={loaded.session.revision} baseVersion={loaded.baseVersion} baseHash={loaded.baseHash} onClose={() => setPanelTrial(null)}
              onSave={(op, confirmed) => { controller.selectRegion(confirmed); setPanelTrial(null); changed(); void runOperation(op); }}
              onAiDraft={(confirmed, reference) => {
                const refs = [...aiReferences, reference]; validateAiReferences(refs);
                const instruction = '将选中板面改为铁板，覆盖原木纹，保留拼缝、铁件、光向和画风。最后一张参考图为金属板反光示意，只表示反光的位置、方向和宽度。';
                const prompt = [aiPrompt.trim(), instruction].filter(Boolean).join('\n');
                if (prompt.length > 12000) throw new Error('请先缩短现有描述，再添加反光示意。');
                controller.selectRegion(confirmed); setAiPrompt(prompt); setAiReferences(refs); setAiPreserveAlpha(true);
                switchMode('ai'); setPanelTrial(null); setSelectionVisible(true); changed(); setNotice('已准备板面范围与反光参考，可检查描述后生成 AI 候选。');
              }} />}
          {mode === 'local' && <fieldset disabled={blocked || controller.dirty || !controller.selectionCount}><legend>本地操作</legend>
            <label><input type="checkbox" checked={preserveAlpha} onChange={event => setPreserveAlpha(event.target.checked)} />保持所有 Alpha 通道</label>
            <label>低 Alpha 阈值<input type="number" min={0} max={16} value={threshold} onChange={event => setThreshold(Math.max(0, Math.min(16, Number(event.target.value))))} /></label><Button size="sm" variant="outline" onClick={() => void runOperation({ type: 'clean-alpha', threshold })}>清理透明噪点</Button>
            <div className="ie-row"><label>原色<input type="color" value={replaceFrom} onChange={event => setReplaceFrom(event.target.value)} /></label><label>替换色<input type="color" value={replaceTo} onChange={event => setReplaceTo(event.target.value)} /></label></div>
            {extraPairs.map((pair, index) => <div className="ie-row" key={index}>
              {(['from', 'to'] as const).map(field => <label key={field}>{field === 'from' ? '原色' : '替换色'} {index + 2}<input type="color" value={pair[field]} onChange={event => setExtraPairs(extraPairs.map((item, i) => i === index ? { ...item, [field]: event.target.value } : item))} /></label>)}
              <Button size="sm" variant="ghost" onClick={() => setExtraPairs(extraPairs.filter((_, i) => i !== index))}>移除第 {index + 2} 对</Button>
            </div>)}
            <Button size="sm" variant="outline" disabled={pairs.length >= MAX_PALETTE_PAIRS} onClick={() => setExtraPairs([...extraPairs, { from: color, to: replaceTo }])}>添加颜色对</Button>
            {duplicateColor && <output>原色重复，请为每种原色指定一个结果。</output>}
            <p className="ie-hint">{loaded.metadata.target.name} · 选区 {controller.selectionCount} 像素 · {pairs.length} 对原色同时替换 · 保留透明度 · 本地执行</p>
            <Button size="sm" variant="outline" disabled={duplicateColor || !controller.selectionCount} onClick={() => void runOperation(extraPairs.length ? { type: 'palette-map', pairs } : { type: 'replace-color', from: replaceFrom, to: replaceTo })}>{extraPairs.length ? '一次多色替换' : '精确替色'}</Button>
            <div className="ie-row"><label>种子 X<input type="number" min={0} max={controller.width - 1} value={seedX} onChange={event => setSeedX(Number(event.target.value))} /></label><label>Y<input type="number" min={0} max={controller.height - 1} value={seedY} onChange={event => setSeedY(Number(event.target.value))} /></label></div><Button size="sm" variant="outline" onClick={() => void runOperation({ type: 'fill', x: seedX, y: seedY, rgba: [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), alpha] })}>用画笔颜色填充</Button>
            <div className="ie-row"><label>移动 X<input type="number" min={-3839} max={3839} value={dx} onChange={event => setDx(Number(event.target.value))} /></label><label>Y<input type="number" min={-3839} max={3839} value={dy} onChange={event => setDy(Number(event.target.value))} /></label></div><Button size="sm" variant="outline" onClick={() => void runOperation({ type: 'translate', dx, dy })}>移动矩形内像素</Button>
            <Button size="sm" variant="outline" onClick={() => void runOperation({ type: 'erase' })}>擦除选区内像素</Button>
            <select aria-label="区域恢复来源" value={restoreVersion} onChange={event => setRestoreVersion(event.target.value)}><option value="source">原始图片</option>{loaded.session.candidates.filter(item => item.status === 'completed').map((item, index) => <option key={item.version} value={item.version}>候选 {index + 1} · {operationNames[item.operation.type] || '本地修改'}</option>)}</select><Button size="sm" variant="outline" onClick={() => void runOperation({ type: 'restore-region', candidateVersion: restoreVersion })}>从所选版本恢复区域</Button>
          </fieldset>}
          {mode === 'ai' && <fieldset disabled={blocked}><legend>2 · 描述修改</legend>
            <p className="ie-hint">范围：{controller.selectionCount === controller.width * controller.height ? '整张图片' : `${controller.selectionCount.toLocaleString()} 个选区像素`}。只有选中的范围会被替换。</p>
            <p className="ie-hint">基准：{loaded.baseVersion === 'source' ? '会话原始图' : `候选 ${loaded.session.candidates.findIndex(item => item.version === loaded.baseVersion) + 1}`}。生成结果会保存为新候选。</p>
            {!localIntent && !loaded.metadata.target.aiEdit?.supported && <output className="ie-ai-reason">{loaded.metadata.target.aiEdit?.reason || '尚未取得 AI 编辑可用性，请刷新目标状态。'} 小像素图仍可本地精修，不会自动放大。</output>}
            {!localIntent && loaded.metadata.target.aiEdit?.supported && <p className="ie-hint">{loaded.metadata.target.aiEdit.model || loaded.metadata.target.aiEdit.provider} · 保持 {controller.width} × {controller.height} 尺寸</p>}
            <label><input type="checkbox" checked={keepsIntentAlpha} disabled={localIntent} onChange={event => setAiPreserveAlpha(event.target.checked)} />保留原图透明度</label>
            <p className="ie-hint">保留本次基准图的透明边缘，包括半透明像素；连续精修以所选候选为准。需要改变轮廓时关闭。</p>
            <label>修改描述<textarea rows={5} maxLength={12000} value={aiPrompt} placeholder="例如：将门框改为生锈的铁质，保留门洞布局" onChange={event => setAiPrompt(event.target.value)} /></label>
            <p className="ie-hint">精确换色可逐行填写 #112233 → #445566。完整配色表、明确的“擦除选区像素”或“移动选区(2,0)”在本地执行。</p>
            <span className="ie-label">{aiPrompt.length.toLocaleString()}/12,000 字</span>
            <details className="ie-reference-options"><summary>参考图（可选） · {aiReferences.length}/8</summary><label>可选参考图（最多 8 张）<input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={referencesLoading || aiReferences.length >= 8} onChange={event => void addAiReferences(event)} /></label>
            {referencesLoading && <output>正在冻结参考图字节…</output>}
            <div className="ie-ai-references">{aiReferences.map(reference => <div key={reference.id}><img src={reference.source} alt={reference.name} /><span title={reference.name}>{reference.name}</span><Button size="xs" variant="ghost" disabled={referencesLoading} onClick={() => setAiReferences(current => current.filter(item => item.id !== reference.id))}>移除</Button></div>)}</div>
            <p className="ie-hint">单张不超过 30 MiB，合计不超过 32 MiB。只发送已选参考；地图上下文不会自动上传。</p></details>
            <p className="ie-hint">选区外像素保持不变。{keepsIntentAlpha ? '透明度逐像素保持，不额外清理低透明度像素。' : '选区内透明度可能变化。'}颜色、内部细节、接缝与碰撞适配仍需检查。</p>
            {controller.dirty && <output className="ie-ai-reason">仍有未保存笔划，请用左侧“保存笔划为候选”保存，再生成 AI 候选。</output>}
            {intent.route === 'invalid' && <output>{intent.reason}</output>}
            {intent.operation && <p className="ie-hint" aria-live="polite">本次编辑 · {loaded.metadata.target.name} · {controller.selectionCount} 个可写像素 · {localIntent ? (operationNames[intent.operation.type] + '，本地执行') : '按描述生成外观，调用一次图片服务'}。选区外四通道受保护。{!localIntent && '描述中的材质、光向和结构需看候选核对。'}</p>}
            {localIntent
              ? <Button disabled={controller.dirty || !controller.selectionCount || !intent.operation || referencesLoading}
                  onClick={()=>intent.operation && void runOperation(intent.operation,aiReferences,true)}>{exactColorIntent ? '按配色生成本地候选' : '执行本地操作'}</Button>
              : <details><summary>直接按当前选区生成</summary><Button disabled={!loaded.metadata.target.aiEdit?.supported || controller.dirty || !controller.selectionCount || !intent.operation || referencesLoading}
                  onClick={()=>intent.operation && void runOperation(intent.operation,aiReferences,true)}>生成 AI 候选（调用模型）</Button></details>}
          </fieldset>}
          <p className="ie-hint">选区外保持原样。生成后先比较效果，再决定是否采用。</p>
          <ImageAttributePlan offerPlanner={mode==='ai' && !localIntent} key={`${loaded.session.editId}:${loaded.baseVersion}`} target={loaded.metadata.target} session={loaded.session} baseVersion={loaded.baseVersion} region={controller.region} prompt={aiPrompt} references={aiReferences} preserveAlpha={aiPreserveAlpha} disabled={blocked||controller.dirty||referencesLoading} onBusy={label=>{busyRef.current=!!label;setBusy(label);}} onSelectRegion={region=>{controller.selectRegion(region);setSelectionVisible(true);changed();}} onExecute={(operation,planRef)=>void runOperation(operation,aiReferences,true,planRef)}/>
          {candidate?.attributePlan&&<details><summary>本候选的属性计划</summary><p>{candidate.attributePlan.part}</p>{candidate.attributePlan.successCriteria.map(line=><p key={line}>{line}</p>)}
            {candidate.attributePlan.referenceManifest?.map(ref=><p key={ref.slot}>参考 {ref.slot} · {{'user-reference':'用户参考','rgb-control':'RGB 对照','diffuse-shading':'分层明暗','clean-crop':'干净局部图'}[ref.role]} · {ref.width} × {ref.height}</p>)}
          </details>}
          {candidate?.status==='completed' && candidate.operation.type==='ai-edit' && candidate.constraints?.preserveAlpha && candidate.evidence?.rawSha256 && candidate.previewPath &&
            <details className="ie-recompose"><summary>检查原始返回并修正合成区</summary>
              <img alt="本候选的模型原始返回" loading="lazy" src={'/api/workbench/artifacts?path='+encodeURIComponent(candidate.previewPath.replace(/image\.png$/,'provider-response.png'))}/>
              <p>若原始返回里已经画对，可在主画布重新选择要使用的像素，先减去仍需保护的部位。此次选区替代旧合成区，须位于原授权范围内。其余像素及全图透明度取自生成前的基准。</p>
              <Button size="sm" variant="outline" disabled={blocked||controller.dirty||!controller.selectionCount}
                onClick={()=>void runOperation({type:'recompose-ai',candidateVersion:candidate.version,rawSha256:candidate.evidence!.rawSha256!})}>用当前选区重新合成（本地）</Button>
            </details>}
          {candidate?.intrinsicEvidence&&<p className="ie-hint">换色路径：{candidate.intrinsicEvidence.route} · 色域裁切通道 {candidate.intrinsicEvidence.clippedChannels}{candidate.intrinsicEvidence.assessment&&` · 重建误差 P90 ${candidate.intrinsicEvidence.assessment.errorP90.toFixed(3)}`}。请分别核对目标色与纹理保持。</p>}
          {candidate?.status==='completed'&&(candidate.attributePlan||candidate.intrinsicEvidence)&&<ImageAttributeReview key={candidate.version} editId={loaded.session.editId} candidate={candidate} disabled={blocked}/>}
          {candidate?.status==='completed'&&<CandidateCheck key={'check-'+candidate.version} editId={loaded.session.editId} candidate={candidate} disabled={!!busy||!!pending} canEdit={canContinue} onAction={action=>{
            const section=dialog.current?.querySelector<HTMLDetailsElement>(action==='recompose'?'.ie-recompose':'.ie-attribute-plan');
            if(section){section.open=true;section.scrollIntoView({block:'center'});}
          }}/>}
          {darkWarning && <output className="ie-warning">此候选有大面积新增近黑像素，可能是模型返回异常。请检查实际效果；若本来就要改为黑色，可继续采用。保护检查通过不代表画面正确。</output>}
          {candidate && <details className="ie-task-status"><summary>查看保护检查</summary><ImageCandidateEvidence candidate={candidate} session={loaded.session} /></details>}
          {!!loaded.session.candidates.filter(item => item.status !== 'completed').length && <details className="ie-task-status"><summary>原任务状态</summary>{loaded.session.candidates.filter(item => item.status !== 'completed').map((item, index) => <p key={item.version}>{operationNames[item.operation.type] || '候选'} {index + 1}：{statusNames[item.status] || item.status}{item.error && <span> · {item.error}</span>}</p>)}<p>关闭窗口不取消；只查询既有任务，不重新提交。</p></details>}
        </aside>
      </div>
      {recoverableDraft && <div className="ie-status"><span>发现本机未保存笔划（{new Date(recoverableDraft.updatedAt).toLocaleString()}）。</span><Button size="sm" disabled={!!busy || !!pending || forceReadOnly} onClick={() => void restoreDraft()}>恢复本机笔划</Button><Button size="sm" variant="ghost" onClick={() => setRecoverableDraft(null)}>暂不恢复</Button><Button size="sm" variant="ghost" disabled={!!busy || !!pending} onClick={() => { void saveImagePixelDraft(null, recoverableDraft.key).then(() => setRecoverableDraft(null)).catch(cause => setError(message(cause))); }}>删除这份本机草稿</Button></div>}
      <footer className="ie-footer"><div className="ie-history"><button className={viewedVersion === 'source' ? 'ie-history-selected' : ''} disabled={!!busy || !!pending} onClick={() => void selectCandidate('source')}><img src={loaded.originalPreviewSource} alt="" />会话原图</button>{loaded.session.candidates.map((item, index) => <button key={item.version} className={viewedVersion === item.version ? 'ie-history-selected' : ''} disabled={!!busy || !!pending || item.status !== 'completed'} onClick={() => void selectCandidate(item.version)}>{(item.previewPath || cache.peek(loaded.session.editId, item.version)?.previewSource) && <img loading="lazy" src={item.previewPath ? `/api/workbench/artifacts?path=${encodeURIComponent(item.previewPath)}` : cache.peek(loaded.session.editId, item.version)?.previewSource} alt="" />}<span>候选 {index + 1} · {operationNames[item.operation.type] || '本地修改'}</span><small>{statusNames[item.status] || item.status}</small></button>)}</div><div className="ie-adopt-actions"><select aria-label="编辑会话" value={loaded.session.editId} disabled={!!busy || !!pending} onChange={event => void selectSession(event.target.value)}><option value={loaded.session.editId}>当前编辑会话</option>{loaded.metadata.sessions?.filter(item => item.editId !== loaded.session.editId).map(item => <option key={item.editId} value={item.editId}>{new Date(item.createdAt).toLocaleString()}{item.stale ? ' · 历史来源' : ''}</option>)}</select><Button variant="outline" disabled={adoptionBlocked || !!busy || !!pending || controller.dirty || !loaded.session.adoptions.length} onClick={() => void adopt('source')}>恢复会话原图</Button><Button disabled={adoptionBlocked || !!busy || !!pending || controller.dirty || !!viewLoading || viewedVersion === 'source' || candidate?.status !== 'completed'} onClick={() => void adopt(viewedVersion || 'source')}>采用此候选</Button></div></footer>
      <div className="ie-status" aria-live="polite">{busy || error || notice || (controller.dirty ? '笔划尚未保存；关闭或离开前会提醒。' : '查看版本不会改变修改基准；确认效果后再采用。')}{forceReadOnly && <span>{readOnly ? '当前入口只读：可查看原图和历史候选，不能编辑或采用。' : loaded.metadata.target.readOnlyReason}</span>}{loaded.followVersion && <span>跟随请求的候选；当前显示其已保存基准。</span>}{loaded.metadata.target.willStopDefaultAnimations && <span>采用默认图将停止默认待机/聚焦动画选择；动画片段保留。</span>}{pending && !busy && <Button size="sm" variant="outline" onClick={() => void execute(pending)}>{pending.external ? '恢复同一请求（不新建）' : '重试同一操作'}</Button>}{!busy && <Button size="sm" variant="ghost" onClick={() => void refreshTarget()}>刷新目标状态</Button>}{loaded.metadata.relatedPagination?.sessions.nextOffset != null && <Button size="sm" variant="outline" disabled={!!busy || !!pending} onClick={() => void loadMoreRelated('sessions')}>加载更多会话（已显示 {loaded.metadata.sessions?.length || 0}/{loaded.metadata.relatedPagination.sessions.total}）</Button>}{!forceReadOnly && !canContinue && !busy && !pending && <><span>此会话用于查看与恢复；继续修改将基于当前目标。</span><Button size="sm" variant="outline" onClick={() => void startNewSession()}>{sessionStartFailed ? '重试建立编辑会话' : '基于当前图片继续精修'}</Button>{sessionStartFailed && <Button size="sm" variant="ghost" onClick={() => void startNewSession(true)}>放弃此次打开并按当前目标重建</Button>}</>}</div>
    </>}
    {leavePrompt && <div className="ie-leave" role="alertdialog" aria-label="离开局部调整"><h3>离开局部调整？</h3><p>{busy || pending ? '请求可能已保存到会话。关闭不取消，也不会重新提交；之后通过原会话继续检查。' : aiDraftDirty ? '未提交的 AI 描述、参考选择及未保存笔划将丢失；运行任务和已保存候选保留。' : '未保存的笔划将丢失；已保存的候选和采用记录保留。'}</p><div className="ie-row"><Button onClick={() => setLeavePrompt(false)}>继续编辑</Button><Button variant="destructive" onClick={() => { if (loaded) void saveImagePixelDraft(null, `${loaded.session.editId}:${draftOwner.current}`).catch(() => undefined); onClose(); }}>舍弃未保存内容并关闭</Button></div></div>}
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
