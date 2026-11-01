import { readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compareImagePlacement } from './image-edit-comparison.mjs';
import { cropPanel } from '../../features/image-edit/metal-panel.mjs';
import { suggestPanelRegion } from './image-edit-panel-sam.mjs';
import { planImageIntent } from '../../features/image-edit/edit-intent.mjs';
import { imageEditInputs } from './image-edit-contract.mjs';
import { planScope, compileAttributePrompt } from '../../features/image-edit/attribute-plan.mjs';
import { preparePlanReferences } from './image-edit-plan-references.mjs';
import { assessIntrinsics, recolorIntrinsic, recolorSimple } from '../../features/image-edit/intrinsic-recolor.mjs';
import { intrinsicProfileKey, runIntrinsicAnalysis, loadIntrinsicLayers } from './image-edit-intrinsics.mjs';
import { partCrop, partPlannerSettings, partViews, requestPartSuggestion, resolvePartSuggestion } from './image-part-planner.mjs';
import { criticRequest } from './image-edit-critic.mjs';
import { readImageTarget, listImageTargets, applyImageTarget, checkTarget } from './image-edit-targets.mjs';
import { resolveRegion, applyLocalOperation } from '../../features/image-edit/core.mjs';
import { findCapability, runConnector, refreshTask } from './runtime.mjs';
import { hash, error, fingerprint, recordFile, storage, safe, json, atomic, lock, sessionFile, session, saveSession, blob, readBlob, decode, command } from './image-edit-store.mjs';
import { MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, readImageAssetSource, validateImageAssetDimensions } from './adapters/image-assets-source.mjs';

const localOperations = ['recompose-ai', 'intrinsic-recolor', 'color-map', 'metal-panel', 'palette-map', 'clean-alpha', 'replace-color', 'fill', 'erase', 'translate', 'restore-region', 'pixel-patch'];
const analysisJobs = new Map();
const activePartCalls = new Set();
const encode = (pixels, width, height) => sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
const localConstraints = { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: true };
const aiConstraints = { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: true };
function aiSupport(target, manifest) {
  const connector = findCapability(manifest, 'image-assets').connector;
  const registry = connector.providerSource ? findCapability(manifest, connector.providerSource).connector : connector;
  const provider = registry.providers?.find(provider => provider.id === connector.defaultProvider);
  let reason, code;
  if (!target.editable || target.locked) { reason = target.locked ? 'This image layer is locked.' : target.readOnlyReason || 'This image target is read-only.'; code = target.locked ? 'IMAGE_TARGET_LOCKED' : 'IMAGE_TARGET_READ_ONLY'; }
  else try { validateImageAssetDimensions(target.width, target.height); } catch (cause) { reason = cause.message; code = 'IMAGE_AI_SIZE_UNSUPPORTED'; }
  return { supported: !reason, ...(reason ? { reason, code } : {}), provider: provider?.id || connector.defaultProvider, model: provider?.model,
    width: target.width, height: target.height, minPixels: 655360, maxPixels: 8294400, maxEdge: 3840, dimensionStep: 16, maxAspectRatio: 3,
    maxReferences: 8, maxImageBytes: MAX_IMAGE_BYTES, maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES, constraints: aiConstraints, alphaPreservation: 'copy-edit-base-alpha' };
}
function targetInfo(target, manifest) {
  const { bytes: _bytes, ...metadata } = target, aiEdit = aiSupport(target, manifest);
  return { ...metadata, supportedOperations: target.editable && !target.locked ? [...localOperations, ...(aiEdit.supported ? ['ai-edit'] : [])] : [],
    constraints: localConstraints, operationConstraints: { ...Object.fromEntries(localOperations.map(operation => [operation, localConstraints])), 'ai-edit': aiConstraints }, aiEdit,
    pixelPatchLimitBytes: 524288, translation: 'rectangular region, no clipping; source and destination are both editable' };
}
async function imageView(bytes, includePixels) {
  const decoded = await decode(bytes);
  const { format } = await sharp(bytes).metadata();
  return { imageBase64: bytes.toString('base64'), imageMimeType: ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' })[format], width: decoded.width, height: decoded.height, sha256: hash(bytes), rgbaSha256: decoded.rgbaSha256, ...(includePixels ? { rgbaBase64: decoded.pixels.toString('base64'), rgbaByteLength: decoded.pixels.length, pixelFormat: 'sRGB-RGBA8-straight' } : {}) };
}
async function newSession(root, manifest, directory, target, commandId) {
  const editId = `edit-${hash(`${target.targetId}\0${commandId}`).slice(0, 32)}`;
  const existing = await json(await safe(root, sessionFile(directory, editId)));
  if (existing) return existing;
  const source = await blob(root, directory, target.bytes, ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[target.mimeType] || 'png');
  const decoded = await decode(target.bytes);
  const value = { schemaVersion: 1, editId, revision: 1, target: targetInfo(target, manifest), source: { ...source, rgbaSha256: decoded.rgbaSha256 }, createdAt: new Date().toISOString(), candidates: [], adoptions: [] };
  await saveSession(root, directory, value); return value;
}
function pixelDiff(decoded, base, mask) {
  let changedPixelCount = 0, changedOutsideRegion = 0, alphaChangedPixelCount = 0, minX = decoded.width, minY = decoded.height, maxX = -1, maxY = -1;
  for (let index = 0; index < mask.length; index++) {
    const offset = index * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel++) if (decoded.pixels[offset + channel] !== base.pixels[offset + channel]) changed = true;
    if (!changed) continue;
    changedPixelCount++; if (!mask[index]) changedOutsideRegion++;
    if (decoded.pixels[offset + 3] !== base.pixels[offset + 3]) alphaChangedPixelCount++;
    const x = index % decoded.width, y = Math.floor(index / decoded.width); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { changedPixelCount, changedOutsideRegion, alphaChangedPixelCount, bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}
async function candidateEvidence(root, manifest, candidate, actual, base, source) {
  const prefix = `${manifest.workspace.outputDirectory.replaceAll('\\', '/')}/${candidate.taskId}`;
  const artifact = async name => {
    const file = `${prefix}/${name}`;
    if (!actual.outputs?.includes(file)) return null;
    return { file, value: await json(await safe(root, path.resolve(root, file))) };
  };
  const result = await artifact('result.json'), processing = await artifact('processing-report.json');
  const usageEvidence = `${prefix}/provider-usage.json`;
  return { sourceRgbaSha256: source.rgbaSha256, baseRgbaSha256: base.rgbaSha256, regionMaskSha256: candidate.mask.sha256,
    maskSha256: processing?.value?.preservation?.maskSha256, rawSha256: result?.value?.rawSha256, sha256: result?.value?.sha256,
    processingEvidence: processing?.file, ...(result?.value?.usageEvidence === 'provider-usage.json' && actual.outputs?.includes(usageEvidence) ? { usageEvidence } : {}),
    provider: result?.value?.provider, model: result?.value?.model, preservation: processing?.value?.preservation ?? null, alphaPreservation: processing?.value?.alphaPreservation ?? null, alphaCleanup: processing?.value?.alphaCleanup ?? null };
}
async function refreshCandidate(root, manifest, directory, value, candidate) {
  if (!candidate?.taskId || (!candidate.derivedState && ['completed', 'failed', 'attention_required', 'awaiting_configuration'].includes(candidate.status))) return;
  const task = await refreshTask(manifest, candidate.taskId);
  candidate.status = task.task?.status || task.status;
  const actual = task.task || task;
  candidate.derivedState = actual.derivedState === true;
  if (actual.error) candidate.error = actual.error;
  else delete candidate.error;
  if (candidate.status === 'completed') {
    const image = await readImageTarget(root, manifest, { kind: 'image-task', taskId: candidate.taskId });
    const decoded = await decode(image.bytes), base = await decode(await readBlob(root, candidate.base));
    if (decoded.width !== base.width || decoded.height !== base.height) throw error('Candidate dimensions changed.', 'IMAGE_CONSTRAINT_FAILED');
    const mask = await readBlob(root, candidate.mask);
    candidate.diff = pixelDiff(decoded, base, mask); candidate.diffFromBase = candidate.diff;
    const source = candidate.base.sha256 === value.source.sha256 ? base : await decode(await readBlob(root, value.source));
    candidate.diffFromSource = pixelDiff(decoded, source, mask);
    candidate.evidence = await candidateEvidence(root, manifest, candidate, actual, base, source);
    if (candidate.diff.changedOutsideRegion || (candidate.constraints.preserveAlpha && candidate.diff.alphaChangedPixelCount)) {
      candidate.status = 'attention_required'; candidate.error = 'Candidate violates pixel protection constraints; it cannot be adopted.';
    } else {
      candidate.image = await blob(root, directory, image.bytes, 'png'); candidate.rgbaSha256 = decoded.rgbaSha256; candidate.assetId = `image:${candidate.taskId}`;
    }
  }
  await saveSession(root, directory, value);
}
async function publicSession(root, manifest, directory, value, includePixels = false, selectedVersion, comparisonOptions) {
  for (const candidate of value.candidates) await refreshCandidate(root, manifest, directory, value, candidate);
  const candidates = value.candidates.map(({ base: _base, mask: _mask, image, ...candidate }) => ({ ...candidate, ...(image ? { sha256: image.sha256, previewPath: `${manifest.workspace.outputDirectory}/${candidate.taskId}/image.png` } : {}) }));
  const chosen = selectedVersion === 'source' ? null : selectedVersion ? value.candidates.find(item => item.version === selectedVersion) : value.candidates.at(-1);
  if (selectedVersion && selectedVersion !== 'source' && !chosen) throw error('Selected candidate does not exist in this session.', 'IMAGE_CANDIDATE_NOT_FOUND', 404);
  if (selectedVersion && selectedVersion !== 'source' && includePixels && (!chosen.image || chosen.status !== 'completed')) throw error('Selected candidate is not completed.', 'IMAGE_CANDIDATE_UNAVAILABLE', 409);
  let comparison;
  if (comparisonOptions) {
    if (!selectedVersion || !chosen?.image || chosen.status !== 'completed')
      throw error('按摆放尺寸对比需要指定已完成的候选版本。', 'IMAGE_CANDIDATE_UNAVAILABLE', 409);
    const base = await decode(await readBlob(root, chosen.base));
    const after = await decode(await readBlob(root, chosen.image));
    comparison = { editId: value.editId, candidateVersion: chosen.version, baseCandidateVersion: chosen.baseCandidateVersion,
      targetRevision: value.target.revision, baseSha256: chosen.base.sha256, candidateSha256: chosen.image.sha256,
      ...await compareImagePlacement({ base, after, target: value.target, region: chosen.plan?.regionBounds ?? chosen.diff?.bounds, previewWidth: comparisonOptions.previewWidth }) };
  }
  return { ...(comparison ? { comparison } : {}), editId: value.editId, revision: value.revision, target: value.target, source: { sha256: value.source.sha256, rgbaSha256: value.source.rgbaSha256 }, candidates, adoptions: value.adoptions, ...(value.partContexts ? { partContexts: value.partContexts } : {}), ...(value.analyses?{analyses:value.analyses}:{}), ...(includePixels ? { selectedVersion: chosen?.image ? chosen.version : 'source', pixels: await imageView(await readBlob(root, chosen?.image || value.source), true) } : {}) };
}
function bindingKey(target) {
  const ref = target.targetRef;
  if (ref?.kind === 'interactable' && ref.slot === 'visual') return target.imageBindingFingerprint || fingerprint({ definitionId: ref.definitionId, slot: ref.slot, assetId: target.source.assetId, sha256: target.sha256 });
  if (ref?.kind === 'scene-instance' && ref.slot === 'visual') return target.imageBindingFingerprint || fingerprint({ instanceId: ref.instanceId, materialId: target.source.materialId, definitionId: target.source.definitionId, slot: ref.slot, assetId: target.source.assetId, sha256: target.sha256 });
  return target.slotFingerprint;
}
function knownBinding(value, target) {
  return [value.target, ...value.adoptions.map(item => item.result?.target).filter(Boolean)]
    .some(known => known.targetId === target.targetId && known.sha256 === target.sha256 && bindingKey(known) === bindingKey(target));
}
async function relatedMetadata(root, directory, target, input) {
  const records = async folder => {
    const base = path.join(directory, folder);
    await safe(root, base);
    const names = await readdir(base).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause; });
    const rows = [];
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) rows.push(await json(await safe(root, path.join(base, name))));
    return rows;
  };
  const named = (await records('regions')).filter(region => region?.targetId === target.targetId && region.regionId).map(region => ({
    regionId: region.regionId, regionRef: region.regionRef, name: region.name, spec: region.spec,
    sourceRevision: region.sourceRevision, sourceSha256: region.sourceSha256, count: region.count, bounds: region.bounds,
    stale: region.sourceSha256 !== target.sha256 || region.sourceRevision !== target.revision,
  })).sort((a, b) => a.name.localeCompare(b.name) || a.regionId.localeCompare(b.regionId));
  const sessions = (await records('sessions')).filter(value => value?.target?.targetId === target.targetId).map(value => {
    const stale = value.target.sha256 !== target.sha256 || value.target.revision !== target.revision;
    return { editId: value.editId, revision: value.revision, createdAt: value.createdAt, sourceRevision: value.target.revision, sourceSha256: value.source.sha256,
      candidateCount: value.candidates.length, latestCandidateVersion: value.candidates.at(-1)?.version, latestCandidateStatus: value.candidates.at(-1)?.status,
      adoptionCount: value.adoptions.length, stale, canContinue: !stale && target.editable && !target.locked && knownBinding(value, target),
      canRestoreSource: target.editable && !target.locked && knownBinding(value, target) };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.editId.localeCompare(b.editId));
  const page = rows => ({ total: rows.length, nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null });
  return { namedRegions: named.slice(input.offset, input.offset + input.limit), sessions: sessions.slice(input.offset, input.offset + input.limit), relatedPagination: { limit: input.limit, offset: input.offset, namedRegions: page(named), sessions: page(sessions) } };
}
async function resolve(root, manifest, directory, input) {
  const target = await readImageTarget(root, manifest, input.targetId || input.target); checkTarget(target, input);
  if (input.region.type === 'named') {
    const region = await json(await safe(root, path.join(directory, 'regions', `${hash(input.region.regionId)}.json`)));
    if (!region || region.targetId !== target.targetId) throw error('Named region is not available for this target.', 'IMAGE_REGION_NOT_FOUND', 404);
    if (region.sourceSha256 !== target.sha256 || region.sourceRevision !== target.revision) throw error('Named region belongs to an earlier source. Review and resolve it again.', 'IMAGE_REGION_STALE', 409);
    return region;
  }
  const decoded = await decode(target.bytes), resolved = resolveRegion(decoded.pixels, decoded.width, decoded.height, input.region);
  if (!resolved.count) throw error('The selected region contains no pixels.', 'EMPTY_IMAGE_REGION');
  const reference = await blob(root, directory, Buffer.from(resolved.mask), 'mask');
  const regionRef = `region-${fingerprint({ targetId: target.targetId, revision: target.revision, sha256: target.sha256, spec: input.region, saveAs: input.saveAs }).slice(0, 40)}`;
  const region = { regionRef, ...(input.saveAs ? { regionId: regionRef, name: input.saveAs } : {}), targetId: target.targetId, sourceSha256: target.sha256, sourceRevision: target.revision, rgbaSha256: decoded.rgbaSha256, spec: input.region, width: decoded.width, height: decoded.height, count: resolved.count, bounds: resolved.bounds, mask: reference, semantics: 'mask=1 editable, mask=0 protected; exported PNG alpha=0 editable' };
  await atomic(root, path.join(directory, 'regions', `${hash(regionRef)}.json`), region); return region;
}
async function encodeMask(mask, width, height) {
  const pixels = Buffer.alloc(mask.length * 4);
  for (let index = 0; index < mask.length; index++) pixels[index * 4 + 3] = mask[index] ? 0 : 255;
  return encode(pixels, width, height);
}
async function frozenAiInput(root, directory, input, target, base, decoded, mask, referenceManifest) {
  const dimensions = validateImageAssetDimensions(decoded.width, decoded.height);
  const pngMaskBytes = await encodeMask(mask, decoded.width, decoded.height), baseBytes = await readBlob(root, base);
  let totalBytes = baseBytes.length + pngMaskBytes.length;
  const references = [];
  if (referenceManifest && referenceManifest.length!==(input.operation.references??[]).length)
    throw error('冻结参考数量与计划不一致。','IMAGE_PLAN_REFERENCE_CONFLICT',409);
  for (const reference of input.operation.references || []) {
    const source = await readImageAssetSource(reference, root);
    if (referenceManifest && hash(source.buffer)!==referenceManifest[references.length].sha256)
      throw error('冻结参考已变化，请重新准备计划。','IMAGE_PLAN_REFERENCE_CONFLICT',409);
    totalBytes += source.bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw error('Source, mask and references exceed the 80 MiB image budget.', 'IMAGE_REFERENCE_LIMIT');
    references.push(source);
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw error('Source and mask exceed the 80 MiB image budget.', 'IMAGE_REFERENCE_LIMIT');
  const frozen = [];
  for (const source of references) frozen.push({ ...await blob(root, directory, source.buffer, source.format === 'jpeg' ? 'jpg' : source.format), width: source.width, height: source.height, mimeType: source.mimeType, bytes: source.bytes });
  const pngMask = await blob(root, directory, pngMaskBytes, 'png');
  const operation = { type: 'ai-edit', prompt: input.operation.prompt, references: frozen };
  const summary = { type: 'ai-edit', prompt: input.operation.prompt, referenceCount: frozen.length, references: frozen.map(({ file: _file, ...reference }) => reference) };
  return { operation, summary, pngMask, effectiveMask: await blob(root, directory, Buffer.from(mask), 'mask'),
    taskInput: { operation: 'edit-image', kind: target.kind, image: base.file, mask: pngMask.file, width: dimensions.width, height: dimensions.height,
      prompt: input.operation.prompt, references: frozen.map(reference => reference.file), preserveAlpha: input.constraints.preserveAlpha } };
}
async function guardedBase(root, manifest, directory, input) {
  const target=await readImageTarget(root,manifest,input.targetId||input.target);checkTarget(target,input,true);
  const current=await session(root,directory,input.editId);
  if(current.target.targetId!==target.targetId||current.target.sha256!==target.sha256||current.target.revision!==target.revision||current.revision!==input.expectedEditRevision)throw error('计划或分析的基准已变化。','IMAGE_EDIT_CONFLICT',409);
  const candidate=input.baseCandidateVersion==='source'?null:current.candidates.find(c=>c.version===input.baseCandidateVersion);
  if(candidate)await refreshCandidate(root,manifest,directory,current,candidate);
  const base=input.baseCandidateVersion==='source'?current.source:candidate?.status==='completed'?candidate.image:null;
  if(!base)throw error('基准候选不可用。','IMAGE_CANDIDATE_UNAVAILABLE',409);
  return {target,current,base,decoded:await decode(await readBlob(root,base))};
}
async function readPart(root, directory, partRef) {
  const record = await json(await safe(root, recordFile(directory, 'part-contexts', partRef)));
  if (!record || record.partRef !== partRef) throw error('部件规划记录不存在。', 'PART_NOT_FOUND', 404);
  return record;
}

async function publicPart(root, directory, partRef) {
  const record = await readPart(root, directory, partRef);
  const { mask: _mask, guards: _guards, views, ...result } = record;
  const status = record.status === 'requesting' && !activePartCalls.has(recordFile(directory, 'part-contexts', partRef))
    ? 'attention_required' : record.status;
  const previews = await Promise.all(views.map(async view => ({
    role: view.role, sha256: view.sha256, png: (await readBlob(root, view)).toString('base64'),
  })));
  return { ...result, targetId: record.guards.targetId, status, views: previews };
}

async function freezePartContext(root, manifest, directory, input, partRef) {
  const { target, current, base, decoded } = await guardedBase(root, manifest, directory, input);
  const region = await json(await safe(root, recordFile(directory, 'regions', input.regionRef)));
  if (!region || region.targetId !== target.targetId || region.sourceRevision !== target.revision || region.sourceSha256 !== target.sha256)
    throw error('授权选区已失效。', 'IMAGE_REGION_STALE', 409);
  const crop = partCrop(region.bounds, decoded.width, decoded.height);
  const buffers = await partViews(decoded, await readBlob(root, region.mask), crop);
  const views = await Promise.all(buffers.map(async view => ({ role: view.role, ...await blob(root, directory, view.buffer, 'png') })));
  const guards = { targetId: target.targetId, expectedRevision: target.revision, expectedSha256: target.sha256,
    editId: input.editId, expectedEditRevision: input.expectedEditRevision, baseCandidateVersion: input.baseCandidateVersion };
  const record = {
    schemaVersion: 1, partRef, status: 'prepared', editId: current.editId, baseCandidateVersion: input.baseCandidateVersion,
    expectedEditRevision: current.revision, baseSha256: base.sha256, regionRef: region.regionRef, mask: region.mask,
    sourceSize: { width: decoded.width, height: decoded.height }, guards, crop, instruction: input.instruction,
    preserveAlpha: input.preserveAlpha, service: partPlannerSettings(manifest), views, maxPlanningCalls: 1, createdAt: new Date().toISOString(),
  };
  await atomic(root, recordFile(directory, 'part-contexts', partRef), record);
  return current;
}

async function suggestPart(root, manifest, directory, input) {
  const record = await readPart(root, directory, input.partRef);
  if (record.status !== 'prepared') throw error('这份定位请求已使用，请查看原记录。', 'PART_ALREADY_REQUESTED', 409);
  const currentService = partPlannerSettings(manifest);
  if (!currentService.configured) throw error('请先配置部件规划使用的视觉服务。', 'PART_PLANNER_UNCONFIGURED', 409);
  if (currentService.endpoint !== record.service.endpoint || fingerprint(currentService.profile) !== fingerprint(record.service.profile))
    throw error('规划服务或模型已变，请重新准备送检内容。', 'PART_SERVICE_CHANGED', 409);
  const { base, decoded } = await lock(root, directory, 'session:' + record.editId, () => guardedBase(root, manifest, directory, record.guards));
  if (base.sha256 !== record.baseSha256) throw error('规划基准已经变化。', 'IMAGE_EDIT_CONFLICT', 409);
  const allowed = await readBlob(root, record.mask);
  const views = await Promise.all(record.views.map(async view => ({ role: view.role, buffer: await readBlob(root, view) })));
  const file = recordFile(directory, 'part-contexts', input.partRef);
  const persist = () => atomic(root, file, record);
  activePartCalls.add(file);
  try {
    record.status = 'requesting';
    record.commandId = input.commandId;
    record.requestedAt = new Date().toISOString();
    await persist();
    try {
      const prediction = await requestPartSuggestion(manifest, record, views, async receipt => {
        record.receipt = receipt;
        await persist();
      });
      record.prediction = prediction;
      record.suggestion = await resolvePartSuggestion(prediction, record, decoded, allowed);
      record.status = 'completed';
    } catch (cause) {
      record.status = cause.code === 'SCENE_MODEL_OUTCOME_UNKNOWN' || record.receipt?.httpStatus >= 500 ? 'attention_required' : 'failed';
      record.error = cause.message;
    }
    record.finishedAt = new Date().toISOString();
    await persist();
    return { partRef: record.partRef };
  } finally {
    activePartCalls.delete(file);
  }
}

async function prepareAttributePlan(root,manifest,directory,input) {
  const {target,base,decoded}=await guardedBase(root,manifest,directory,input);
  let scopeSource;
  if (input.partRef) {
    const part = await readPart(root, directory, input.partRef);
    if (part.status !== 'completed' || part.suggestion?.decision !== 'propose' || part.editId !== input.editId ||
        part.expectedEditRevision !== input.expectedEditRevision || part.baseCandidateVersion !== input.baseCandidateVersion ||
        part.baseSha256 !== base.sha256 || part.regionRef !== input.regionRef || part.preserveAlpha !== input.constraints.preserveAlpha ||
        (input.operation.type === 'ai-edit' && input.operation.prompt !== part.instruction))
      throw error('视觉建议不属于当前指令、选区或基准，请重新准备。', 'PART_CONTEXT_CONFLICT', 409);
    scopeSource = !input.targetRegion ? 'authorized-selection'
      : fingerprint(input.targetRegion) === fingerprint(part.suggestion.target) &&
        fingerprint(input.influenceRegion ?? null) === fingerprint(part.suggestion.influence ?? null) &&
        fingerprint(input.protectedRegions) === fingerprint(part.suggestion.protect.map(item => item.region)) ? 'as-suggested' : 'adjusted';
  }
  if(!['ai-edit','intrinsic-recolor','color-map'].includes(input.operation.type))throw error('属性计划只支持生成、分层换色和简单换色。');
  if (input.softReference && (input.operation.type!=='ai-edit' || !input.localContext || (input.operation.references?.length??0)>6))
    throw error('属性参考需要生成外观、干净局部图和两个空余参考位。','IMAGE_SOFT_REFERENCE_CONFLICT',422);
  if(input.operation.type!=='ai-edit'&&(!input.constraints.preserveAlpha||Object.entries(input.policy).some(([key,value])=>value!==(key==='albedo'?'edit':'preserve'))))throw error('换色实验须保持轮廓、纹理、明暗、反光和 Alpha。');
  const region=await json(await safe(root,recordFile(directory,'regions',input.regionRef)));
  if(!region||region.targetId!==target.targetId||region.sourceSha256!==target.sha256||region.sourceRevision!==target.revision)throw error('选区已经失效。','IMAGE_REGION_STALE',409);
  const expand=async spec=>{
    if(spec?.type!=='named')return spec;
    const named=await resolve(root,manifest,directory,{targetId:target.targetId,expectedRevision:target.revision,expectedSha256:target.sha256,region:spec});
    return readBlob(root,named.mask);
  };
  const scope=planScope(decoded.pixels,decoded.width,decoded.height,new Uint8Array(await readBlob(root,region.mask)),await expand(input.targetRegion),await expand(input.influenceRegion),await Promise.all(input.protectedRegions.map(expand)));
  const mask=await blob(root,directory,Buffer.from(scope.mask),'mask'),overlay=Buffer.from(decoded.pixels);
  for(let i=0;i<scope.mask.length;i++)if(scope.mask[i]){overlay[i*4]=Math.round(overlay[i*4]*.5);overlay[i*4+1]=Math.round(overlay[i*4+1]*.5+120);overlay[i*4+3]=Math.max(150,overlay[i*4+3]);}
  const preview=await sharp(overlay,{raw:{width:decoded.width,height:decoded.height,channels:4}}).resize({width:Math.min(512,decoded.width),kernel:'nearest'}).png().toBuffer();
  let compiled=structuredClone(input.operation),crop=null,localPreview=null;const warnings=[];
  let planReferences;
  if(compiled.type==='ai-edit'){
    const intrinsic=input.softReference?.kind==='shading'
      ? await boundIntrinsicLayers(root,directory,input.editId,input.baseCandidateVersion,base,decoded,input.softReference.analysisId) : null;
    planReferences=await preparePlanReferences(root,directory,input,base,decoded,scope.bounds,intrinsic);
    crop=planReferences.crop;localPreview=planReferences.localPreviewPng;warnings.push(...planReferences.warnings);
    const prompt=compileAttributePrompt(compiled.prompt,input.part,input.policy,input.successCriteria,scope.bounds,crop);
    const guidance=input.softReference?'\nThe penultimate reference shows the same crop and provides optional evidence of surface structure and illumination. Follow the requested appearance and return the complete first image.':'';
    compiled={...compiled,prompt:prompt+guidance,references:planReferences.references};
    if(compiled.prompt.length>12000)throw error('编译后的属性说明超过提示长度，请缩短描述。');
  }
  const planRef=`plan-${fingerprint(input).slice(0,40)}`;
  const record={schemaVersion:1,planRef,editId:input.editId,expectedEditRevision:input.expectedEditRevision,baseCandidateVersion:input.baseCandidateVersion,baseSha256:base.sha256,baseRgbaSha256:decoded.rgbaSha256,targetId:target.targetId,sourceSha256:target.sha256,sourceRevision:target.revision,regionRef:input.regionRef,originalOperation:input.operation,compiledOperation:compiled,constraints:input.constraints,part:input.part,policy:input.policy,successCriteria:input.successCriteria,scope:{bounds:scope.bounds,count:scope.count,spec:scope.spec,mask},crop,warnings,maxCandidates:1,maxImageCalls:compiled.type==='ai-edit'?1:0,automaticRetries:0,createdAt:new Date().toISOString(),previewPng:preview.toString('base64'),localPreviewPng:localPreview};
  if (input.partRef) Object.assign(record, {partRef: input.partRef, scopeSource});
  if (planReferences) record.referenceManifest=planReferences.referenceManifest;
  if (input.softReference) Object.assign(record,{softReference:input.softReference,softReferencePreviewPng:planReferences.softReferencePreviewPng});
  if (compiled.type==='intrinsic-recolor') {
    const {assessment}=await evaluateRecolor(root,directory,input.editId,input.baseCandidateVersion,base,decoded,scope.mask,compiled);
    record.recolorDecision={assessment,route:recolorRoute(assessment,compiled)};
  }
  await atomic(root,recordFile(directory,'plans',planRef),record);return {plan:record};
}
async function getAnalysis(root,directory,analysisId) {
  const file=recordFile(directory,'analyses',analysisId),record=await json(await safe(root,file));
  if(!record||record.analysisId!==analysisId)throw error('分层记录不存在。','IMAGE_ANALYSIS_NOT_FOUND',404);
  if(record.status==='running'&&!analysisJobs.has(file)){record.status='attention_required';record.error='分析进程已中断；保留原记录，不自动重新运行。';await atomic(root,file,record);}
  return record;
}
async function startAnalysis(root,manifest,directory,input) {
  const {base,decoded,current}=await guardedBase(root,manifest,directory,input);
  const profileKey=await intrinsicProfileKey(root);
  if(Math.max(decoded.width,decoded.height)>1536)throw error('分层试验当前支持最长边 1536 像素。');
  if (!input.fresh) {
    for (const previous of [...(current.analyses??[])].reverse()) {
      if (previous.profileKey!==profileKey || previous.baseSha256!==base.sha256 || previous.baseCandidateVersion!==input.baseCandidateVersion) continue;
      const saved=await getAnalysis(root,directory,previous.analysisId);
      if (saved.editId!==input.editId || saved.baseCandidateVersion!==input.baseCandidateVersion ||
          saved.baseSha256!==base.sha256 || saved.baseRgbaSha256!==decoded.rgbaSha256)
        throw error('已有分析的身份与当前基准不一致。','IMAGE_ANALYSIS_CONFLICT',409);
      if (saved.status==='running' || saved.status==='completed') {
        if (saved.status==='completed') await loadIntrinsicLayers(await safe(root,path.join(directory,'analysis-data',hash(saved.analysisId))),saved.receipt);
        return {analysisId:saved.analysisId,cacheHit:true};
      }
    }
  }
  const analysisId=`analysis-${fingerprint(input).slice(0,40)}`,file=recordFile(directory,'analyses',analysisId),output=path.join(directory,'analysis-data',hash(analysisId));
  await safe(root,output);
  const record={schemaVersion:1,analysisId,editId:input.editId,baseCandidateVersion:input.baseCandidateVersion,baseSha256:base.sha256,baseRgbaSha256:decoded.rgbaSha256,width:decoded.width,height:decoded.height,status:'running',createdAt:new Date().toISOString(),output:path.relative(root,output).replaceAll('\\','/')};
  await atomic(root,file,record);
  current.analyses=[...(current.analyses??[]),{analysisId,profileKey,baseCandidateVersion:input.baseCandidateVersion,baseSha256:base.sha256}];await saveSession(root,directory,current);
  const job=(async()=>{
    try{record.receipt=await runIntrinsicAnalysis(root,output,path.resolve(root,base.file),base.sha256);if(record.receipt.width!==decoded.width||record.receipt.height!==decoded.height)throw new Error('分层输出尺寸不一致。');record.status='completed';record.previews={};for(const name of ['albedo','shading','residual','uncertainty'])record.previews[name]=(await sharp(path.join(output,name+'.png')).resize({width:Math.min(384,decoded.width)}).png().toBuffer()).toString('base64');}
    catch(cause){record.status='failed';record.error=String(cause.message).slice(0,2000);}
    record.finishedAt=new Date().toISOString();await atomic(root,file,record);
  })();analysisJobs.set(file,job);void job.finally(()=>analysisJobs.delete(file)).catch(()=>{});
  return {analysisId,cacheHit:false};
}
function recolorRoute(assessment,operation) {
  if (assessment.eligible) return 'intrinsic-delta';
  if (operation.fallback!=='simple') return 'stop';
  return operation.fallbackMapping==='luminance' ? 'simple-luminance-fallback' : 'simple-rgb-fallback';
}
async function boundIntrinsicLayers(root,directory,editId,baseVersion,base,decoded,analysisId) {
  const analysis=await getAnalysis(root,directory,analysisId);
  if (analysis.status!=='completed' || analysis.editId!==editId || analysis.baseSha256!==base.sha256 ||
      analysis.baseRgbaSha256!==decoded.rgbaSha256 || analysis.width!==decoded.width || analysis.height!==decoded.height ||
      analysis.receipt?.width!==decoded.width || analysis.receipt?.height!==decoded.height ||
      (analysis.receipt.sourceSha256 && analysis.receipt.sourceSha256!==base.sha256) ||
      (analysis.baseCandidateVersion && analysis.baseCandidateVersion!==baseVersion))
    throw error('分层数据尚未完成或属于另一基准。','IMAGE_ANALYSIS_CONFLICT',409);
  const output=await safe(root,path.join(directory,'analysis-data',hash(analysisId)));
  const layers=await loadIntrinsicLayers(output,analysis.receipt);
  return {layers,analysis};
}
async function evaluateRecolor(root,directory,editId,baseVersion,base,decoded,mask,operation) {
  const {layers,analysis}=await boundIntrinsicLayers(root,directory,editId,baseVersion,base,decoded,operation.analysisId);
  const assessment=assessIntrinsics(decoded.pixels,mask,layers,undefined,operation.surface);
  return {layers,analysis,assessment};
}
async function recomposeReturnedImage(root, manifest, directory, session, operation, base, baseVersion, decoded, mask, constraints) {
  const prior = session.candidates.find(candidate => candidate.version === operation.candidateVersion);
  if (prior?.status !== 'completed' || prior.operation.type !== 'ai-edit' || !prior.constraints?.preserveAlpha ||
      !constraints.preserveAlpha || prior.base.sha256 !== base.sha256 || prior.baseCandidateVersion !== baseVersion ||
      prior.evidence?.rawSha256 !== operation.rawSha256)
    throw error('重合成需要同一会话、原生成基准和锁定透明度的已完成 AI 候选。', 'RECOMPOSE_SOURCE_CONFLICT', 409);
  const maximum = await json(await safe(root, recordFile(directory, 'regions', prior.regionRef)));
  if (!maximum || maximum.targetId !== session.target.targetId || maximum.sourceSha256 !== session.target.sha256 ||
      maximum.sourceRevision !== session.target.revision) throw error('原授权范围失效。', 'RECOMPOSE_SCOPE_CONFLICT', 409);
  const allowed = await readBlob(root, maximum.mask);
  if (mask.length !== allowed.length || mask.some((value,i) => value && !allowed[i]))
    throw error('这次选区超出原生成的最大授权范围，请缩小选区。', 'RECOMPOSE_SCOPE_CONFLICT', 409);
  const file = path.join(manifest.workspace.outputDirectory, prior.taskId, 'provider-response.png');
  const raw = await decode(await readBlob(root, { file, sha256: operation.rawSha256 }));
  if (raw.width !== decoded.width || raw.height !== decoded.height) throw error('原始返回尺寸与基准不符。', 'RECOMPOSE_SOURCE_CONFLICT', 409);
  // The existing local processing task restores the base RGBA outside this mask.
  for (let i = 3; i < raw.pixels.length; i += 4) raw.pixels[i] = decoded.pixels[i];
  return { pixels: raw.pixels, effectiveMask: mask };
}

async function edit(root, manifest, directory, input, state, persist) {
  const target = await readImageTarget(root, manifest, input.targetId || input.target); checkTarget(target, input, true);
  if (input.operation.type === 'ai-edit') {
    const support = aiSupport(target, manifest);
    if (!support.supported) throw error(support.reason, support.code);
  }
  const value = input.editId ? await session(root, directory, input.editId) : await newSession(root, manifest, directory, target, input.commandId);
  await persist({ editId: value.editId, ...(input.planRef ? { phase: 'validating-plan' } : {}) });
  return lock(root, directory, `session:${value.editId}`, async () => {
    const current = await session(root, directory, value.editId);
    if (current.target.targetId !== target.targetId || current.target.sha256 !== target.sha256 || current.target.revision !== target.revision) throw error('Session belongs to another source version.', 'IMAGE_SOURCE_CONFLICT', 409);
    if (input.editId && (input.expectedEditRevision !== current.revision || !input.baseCandidateVersion)) throw error('An existing session requires its current revision and an explicit baseCandidateVersion (source is allowed).', 'IMAGE_EDIT_CONFLICT', 409, { currentRevision: current.revision });
    const region = await json(await safe(root, path.join(directory, 'regions', `${hash(input.regionRef)}.json`)));
    if (!region || region.targetId !== target.targetId || region.sourceSha256 !== target.sha256 || region.sourceRevision !== target.revision) throw error('Region is missing or belongs to another source version.', 'IMAGE_REGION_STALE', 409);
    const baseVersion = input.baseCandidateVersion || 'source';
    const baseCandidate = baseVersion === 'source' ? null : current.candidates.find(item => item.version === baseVersion);
    if (baseVersion !== 'source') { await refreshCandidate(root, manifest, directory, current, baseCandidate); if (baseCandidate?.status !== 'completed' || !baseCandidate.image) throw error('Base candidate is not completed.', 'IMAGE_CANDIDATE_UNAVAILABLE', 409); }
    const base = baseCandidate?.image || current.source, decoded = await decode(await readBlob(root, base));
    let mask = new Uint8Array(await readBlob(root, region.mask));
    let attributePlan;
    if(input.planRef){
      attributePlan=await json(await safe(root,recordFile(directory,'plans',input.planRef)));
      if(!attributePlan||attributePlan.editId!==current.editId||attributePlan.expectedEditRevision!==current.revision||attributePlan.baseSha256!==base.sha256||attributePlan.baseCandidateVersion!==baseVersion||attributePlan.regionRef!==input.regionRef||attributePlan.sourceSha256!==target.sha256||attributePlan.sourceRevision!==target.revision||fingerprint(attributePlan.originalOperation)!==fingerprint(input.operation)||fingerprint(attributePlan.constraints)!==fingerprint(input.constraints))throw error('计划已过期或提交内容不一致，请重新准备。','IMAGE_PLAN_CONFLICT',409);
      if(current.candidates.some(item=>item.attributePlan?.planRef===input.planRef))throw error('此计划已经提交过一个候选，请查询原任务。','IMAGE_PLAN_CONSUMED',409);
      mask=new Uint8Array(await readBlob(root,attributePlan.scope.mask));
      input={...input,operation:attributePlan.compiledOperation};
    }
    let restorePixels, operation = input.operation;
    let prepared;
    let intrinsicEvidence;
    if (operation.type === 'ai-edit') prepared = await frozenAiInput(root, directory, input, target, base, decoded, mask,attributePlan?.referenceManifest);
    if (operation.type === 'restore-region') {
      const restore = operation.candidateVersion === 'source' ? current.source : current.candidates.find(item => item.version === operation.candidateVersion && item.status === 'completed')?.image;
      if (!restore) throw error('Restore candidate is unavailable.', 'IMAGE_CANDIDATE_UNAVAILABLE', 409);
      restorePixels = (await decode(await readBlob(root, restore))).pixels;
      operation = { type: 'restore-region' };
    }
    if (operation.type === 'pixel-patch') {
      if (operation.baseRgbaSha256 !== decoded.rgbaSha256) throw error('Manual pixels belong to another candidate.', 'IMAGE_PIXEL_CONFLICT', 409);
      operation = { type: 'pixel-patch', spans: operation.spans.map(span => {
        if (![span.beforeRgbaBase64, span.afterRgbaBase64].every(value => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))) throw error('Invalid pixel patch encoding.');
        return { startPixel: span.startPixel, before: new Uint8Array(Buffer.from(span.beforeRgbaBase64, 'base64')), after: new Uint8Array(Buffer.from(span.afterRgbaBase64, 'base64')) };
      }) };
    }
    if (!prepared) {
      let output;
      if (operation.type === 'recompose-ai') {
        output = await recomposeReturnedImage(root, manifest, directory, current, operation, base, baseVersion, decoded, mask, input.constraints);
      } else if(['intrinsic-recolor','color-map'].includes(operation.type)){
        if(!input.constraints.preserveAlpha)throw error('换色操作必须保持 Alpha。');
        if(operation.type==='color-map'){output=recolorSimple(decoded.pixels,mask,operation.from,operation.to,operation.mapping);intrinsicEvidence={route:operation.mapping==='luminance'?'simple-luminance-control':'simple-rgb-control',clippedChannels:output.clippedChannels,changedPixels:output.changedPixels};}
        else{
          const {analysis,layers,assessment}=await evaluateRecolor(root,directory,current.editId,baseVersion,base,decoded,mask,operation);
          const route=recolorRoute(assessment,operation);
          if(route==='stop')throw error(assessment.reasons.join('。'),'IMAGE_ANALYSIS_UNCERTAIN',422,{assessment});
          output=assessment.eligible?recolorIntrinsic(decoded.pixels,mask,layers,operation.from,operation.to):recolorSimple(decoded.pixels,mask,operation.from,operation.to,operation.fallbackMapping);
          intrinsicEvidence={analysisId:analysis.analysisId,model:analysis.receipt.model,revision:analysis.receipt.revision,assessment,route,clippedChannels:output.clippedChannels,changedPixels:output.changedPixels};
        }
        output.effectiveMask=mask;
      }else output = applyLocalOperation({ ...decoded, mask, operation, restorePixels });
      if (input.constraints.preserveAlpha) for (let i = 3; i < output.pixels.length; i += 4) if (output.pixels[i] !== decoded.pixels[i]) throw error('Operation changes alpha while preserveAlpha is enabled.', 'IMAGE_CONSTRAINT_FAILED');
      const image = await blob(root, directory, await encode(output.pixels, decoded.width, decoded.height), 'png');
      const effectiveMask = await blob(root, directory, Buffer.from(output.effectiveMask), 'mask');
      const pngMask = await blob(root, directory, await encodeMask(output.effectiveMask, decoded.width, decoded.height), 'png');
      prepared = { operation: input.operation, summary: input.operation.type === 'pixel-patch' ? { type: 'pixel-patch', spanCount: input.operation.spans.length, changedByteLength: input.operation.spans.reduce((total, span) => total + Buffer.byteLength(span.afterRgbaBase64, 'base64'), 0) } : input.operation,
        effectiveMask, taskInput: { operation: 'process-image', image: image.file, preserveFrom: base.file, mask: pngMask.file, alphaCleanupThreshold: 0, kind: target.kind } };
    }
    const version = `candidate-${hash(input.commandId).slice(0, 32)}`;
    const recipe = await blob(root, directory, Buffer.from(JSON.stringify({ operation: prepared.operation, regionRef: input.regionRef, baseCandidateVersion: baseVersion, constraints: input.constraints })), 'json');
    const plan = { target: target.name, regionBounds: attributePlan?.scope.bounds??region.bounds, selectedPixels: attributePlan?.scope.count??region.count,
      route: operation.type === 'ai-edit' ? 'ai' : 'local', preserveAlpha: input.constraints.preserveAlpha || ['metal-panel', 'palette-map', 'replace-color'].includes(operation.type),
      operationType: operation.type, baseCandidateVersion: baseVersion };
    const candidate = { version, plan, ...(attributePlan?{attributePlan:{planRef:attributePlan.planRef,...(attributePlan.referenceManifest?{referenceManifest:attributePlan.referenceManifest}:{}),...(attributePlan.partRef?{partRef:attributePlan.partRef,scopeSource:attributePlan.scopeSource}:{}),part:attributePlan.part,policy:attributePlan.policy,successCriteria:attributePlan.successCriteria,scope:{bounds:attributePlan.scope.bounds,count:attributePlan.scope.count},crop:attributePlan.crop}}:{}), ...(intrinsicEvidence?{intrinsicEvidence}:{}), commandId: input.commandId, baseCandidateVersion: baseVersion, base, regionRef: input.regionRef, operation: prepared.summary, recipe, constraints: input.constraints, mask: prepared.effectiveMask, status: 'preparing', createdAt: new Date().toISOString() };
    current.candidates.push(candidate); current.revision++; await saveSession(root, directory, current);
    await persist({ candidateVersion: version, ...(attributePlan ? { phase: 'candidate-recorded' } : {}) });
    try {
      await runConnector(manifest, findCapability(manifest, 'image-assets'), { ...prepared.taskInput, name: (input.name || target.source?.name || target.name || 'Edited image').slice(0, 80) }, { imageEditContext: { editId: current.editId, candidateVersion: candidate.version, target: current.target.targetRef }, onPrepared: async ({ task }) => {
        candidate.taskId = task.id; candidate.status = 'running'; await saveSession(root, directory, current); await persist({ taskId: task.id });
      } });
    } catch (cause) { if (!candidate.taskId) throw cause; }
    await refreshCandidate(root, manifest, directory, current, candidate);
    return { edit: await publicSession(root, manifest, directory, current), candidateVersion: version, taskId: candidate.taskId, status: candidate.status };
  });
}
async function sourceRestore(root, manifest, directory, value, state, persist, resuming) {
  const intent = state.applyIntent, version = intent.candidateVersion;
  let candidate = value.candidates.find(item => item.version === version);
  if (!candidate) {
    if (resuming) throw error('Source restoration was interrupted before recording a task. Inspect this session; it will not be submitted again.', 'IMAGE_SUBMISSION_UNKNOWN', 409, { editId: value.editId });
    const decoded = await decode(await readBlob(root, intent.base));
    const mask = new Uint8Array(decoded.width * decoded.height).fill(1);
    const constraints = { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: false };
    candidate = { version, commandId: state.commandId, sourceRestore: true, baseCandidateVersion: 'target-snapshot', baseTargetRevision: intent.binding.revision, baseTargetSha256: intent.binding.sha256,
      base: intent.base, mask: await blob(root, directory, Buffer.from(mask), 'mask'), operation: { type: 'restore-region', candidateVersion: 'source' }, constraints, status: 'preparing', createdAt: new Date().toISOString() };
    value.candidates.push(candidate); value.revision++;
    await saveSession(root, directory, value); await persist({ sourceRestoreVersion: version });
    const pngMask = await blob(root, directory, await encode(Buffer.alloc(mask.length * 4), decoded.width, decoded.height), 'png');
    try {
      await runConnector(manifest, findCapability(manifest, 'image-assets'), { operation: 'process-image', image: value.source.file, preserveFrom: intent.base.file, mask: pngMask.file,
        alphaCleanupThreshold: 0, kind: value.target.kind, name: (value.target.source?.name || value.target.name || 'Restored original').slice(0, 80) }, {
        imageEditContext: { editId: value.editId, candidateVersion: candidate.version, target: value.target.targetRef },
        onPrepared: async ({ task }) => { candidate.taskId = task.id; candidate.status = 'running'; await saveSession(root, directory, value); await persist({ taskId: task.id }); },
      });
    } catch (cause) { if (!candidate.taskId) throw cause; }
  }
  if (!candidate.taskId) throw error('Source restoration has no durable task identity. It will not be submitted again.', 'IMAGE_SUBMISSION_UNKNOWN', 409, { editId: value.editId });
  await refreshCandidate(root, manifest, directory, value, candidate);
  return candidate;
}
async function adopt(root, manifest, directory, input, state, persist, resuming = false) {
  return lock(root, directory, `session:${input.editId}`, async () => {
    const value = await session(root, directory, input.editId);
    const previous = value.adoptions.find(item => item.commandId === input.commandId);
    if (previous) return previous.result;
    if (!state.applyIntent) {
      if (resuming) throw error('Interrupted adoption has no recorded target binding. Review it before a new command.', 'IMAGE_SUBMISSION_UNKNOWN', 409, { editId: value.editId });
      const target = await readImageTarget(root, manifest, value.target.targetId);
      if (target.revision !== input.expectedRevision || target.sha256 !== input.expectedSha256) throw error('Image target changed. Inspect its current version before adopting.', 'IMAGE_TARGET_CONFLICT', 409, { currentRevision: target.revision });
      if (target.locked) throw error('This image layer is locked.', 'IMAGE_TARGET_LOCKED', 409);
      if (!target.editable) throw error('This image target is read-only.', 'IMAGE_TARGET_READ_ONLY', 409);
      if (!knownBinding(value, target)) throw error('The image binding was replaced outside this session. Keep the candidate and inspect a new target before adopting.', 'IMAGE_TARGET_CONFLICT', 409);
      const binding = { targetId: target.targetId, revision: target.revision, sha256: target.sha256, ...(target.slotFingerprint ? { slotFingerprint: target.slotFingerprint } : {}) };
      const base = await blob(root, directory, target.bytes, ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[target.mimeType]);
      await persist({ applyIntent: { binding, base, candidateVersion: input.candidateVersion === 'source' ? `source-restore-${hash(input.commandId).slice(0, 32)}` : input.candidateVersion, sourceRestore: input.candidateVersion === 'source' } });
    }
    const intent = state.applyIntent;
    const candidate = intent.sourceRestore ? await sourceRestore(root, manifest, directory, value, state, persist, resuming) : value.candidates.find(item => item.version === intent.candidateVersion);
    await refreshCandidate(root, manifest, directory, value, candidate);
    if (candidate?.status !== 'completed' || !candidate.image) throw error('Only a completed verified candidate can be adopted.', 'IMAGE_CANDIDATE_UNAVAILABLE', 409, { editId: value.editId, taskId: candidate?.taskId });
    // A response-loss replay uses this original binding, not a fresh target.
    // The document/map adoption marker decides whether it already committed.
    const result = await applyImageTarget(root, manifest, { targetId: intent.binding.targetId, expectedRevision: intent.binding.revision, expectedSha256: intent.binding.sha256,
      expectedSlotFingerprint: intent.binding.slotFingerprint, bytes: await readBlob(root, candidate.image), candidate: { taskId: candidate.taskId, sha256: candidate.image.sha256 }, commandId: input.commandId });
    const receipt = JSON.parse(JSON.stringify({ ...result, ...(intent.sourceRestore ? { sourceRestore: { candidateVersion: candidate.version, taskId: candidate.taskId, sourceSha256: value.source.sha256, sourceRgbaSha256: value.source.rgbaSha256 } } : {}) }));
    value.adoptions.push({ commandId: input.commandId, candidateVersion: input.candidateVersion, appliedCandidateVersion: candidate.version, at: new Date().toISOString(), result: receipt });
    await saveSession(root, directory, value);
    return receipt;
  });
}
export async function imageEditRequest(root, manifest, operation, rawInput = {}) {
  if (!Object.hasOwn(imageEditInputs, operation)) throw error('Unknown image edit operation.');
  const input = imageEditInputs[operation].parse(rawInput), directory = storage(root, manifest);
  if (operation.startsWith('image-critic-')) return criticRequest(root,manifest,directory,operation,input,refreshCandidate);
  if (operation === 'image-part-get') return { part: await publicPart(root, directory, input.partRef) };
  if (operation === 'image-part-context') {
    const partRef = 'part-' + fingerprint(input).slice(0, 40);
    const prepare = () => lock(root, directory, 'session:' + input.editId, async () => {
      const stored = await json(await safe(root, recordFile(directory, 'part-contexts', partRef)));
      const current = stored ? await session(root, directory, input.editId) : await freezePartContext(root, manifest, directory, input, partRef);
      if (!current.partContexts?.some(item => item.partRef === partRef)) {
        current.partContexts = [...(current.partContexts || []), { partRef, baseCandidateVersion: input.baseCandidateVersion, expectedEditRevision: input.expectedEditRevision }];
        await saveSession(root, directory, current);
      }
      return { partRef };
    });
    const result = await command(root, directory, operation, input, prepare, prepare);
    return { part: await publicPart(root, directory, result.partRef), replayed: result.replayed };
  }
  if (operation === 'image-part-suggest') {
    const suggest = () => lock(root, directory, 'part:' + input.partRef, () => suggestPart(root, manifest, directory, input));
    const result = await command(root, directory, operation, input, suggest, () => lock(root, directory, 'part:' + input.partRef, async () => {
      const record = await readPart(root, directory, input.partRef);
      if (record.status === 'prepared' && !record.commandId) return suggestPart(root, manifest, directory, input);
      if (record.commandId !== input.commandId) throw error('请核对原命令和定位记录。', 'PART_COMMAND_CONFLICT', 409);
      return { partRef: input.partRef };
    }));
    return { part: await publicPart(root, directory, result.partRef), replayed: result.replayed };
  }
  if(operation==='image-plan-prepare'){
    const prepare=()=>lock(root,directory,`session:${input.editId}`,async()=>{
      const plan=await json(await safe(root,recordFile(directory,'plans',`plan-${fingerprint(input).slice(0,40)}`)));
      return plan ? {plan} : prepareAttributePlan(root,manifest,directory,input);
    });
    return command(root,directory,operation,input,prepare,prepare);
  }
  if(operation==='image-plan-get'){
    const plan=await json(await safe(root,recordFile(directory,'plans',input.planRef)));
    if(!plan)throw error('计划不存在。','IMAGE_PLAN_NOT_FOUND',404);
    // A single session commit records both the candidate and its claim on this plan.
    const current=await session(root,directory,plan.editId);
    const candidate=current.candidates.find(item=>item.attributePlan?.planRef===input.planRef);
    if(candidate)plan.consumedCommandId=candidate.commandId;
    else delete plan.consumedCommandId;
    return {plan};
  }
  if(operation==='image-analysis-create'){
    const createOrRecover=(state,persist)=>lock(root,directory,`session:${input.editId}`,async()=>{
      if(state.analysisId)return {analysisId:state.analysisId,cacheHit:state.cacheHit??false};
      const analysisId=state.result?.analysisId??state.result?.analysis?.analysisId??`analysis-${fingerprint(input).slice(0,40)}`;
      if(await json(await safe(root,recordFile(directory,'analyses',analysisId))))
        return {analysisId,cacheHit:state.result?.cacheHit??false};
      const identity=await startAnalysis(root,manifest,directory,input);
      await persist(identity);return identity;
    });
    const result=await command(root,directory,operation,input,createOrRecover,createOrRecover);
    const analysisId=result.analysisId??result.analysis.analysisId;
    return {analysis:await getAnalysis(root,directory,analysisId),cacheHit:result.cacheHit??false,replayed:result.replayed};
  }
  if(operation==='image-analysis-get')return {analysis:await getAnalysis(root,directory,input.analysisId)};
  if(operation==='image-review-record')return command(root,directory,operation,input,()=>lock(root,directory,`session:${input.editId}`,async()=>{
    const current=await session(root,directory,input.editId),candidate=current.candidates.find(c=>c.version===input.candidateVersion);await refreshCandidate(root,manifest,directory,current,candidate);
    if(!candidate?.image||candidate.image.sha256!==input.expectedCandidateSha256||candidate.status!=='completed')throw error('复核候选版本不一致。','IMAGE_REVIEW_CONFLICT',409);
    if(input.defects.some(d=>d.x>=current.target.width||d.y>=current.target.height))throw error('缺陷位置超出图片。');
    const judgments=[input.targetAchieved,input.preservedContent,input.boundaryAndAlpha],review={...input,independent:false,verdict:judgments.includes(false)?'fail':judgments.includes(null)?'uncertain':'pass',createdAt:new Date().toISOString()};
    candidate.reviews=[...(candidate.reviews??[]),review];await saveSession(root,directory,current);return {review};
  }));
  if (operation === 'image-panel-suggest') {
    const target = await readImageTarget(root, manifest, input.targetId || input.target);
    checkTarget(target, input, true);
    const current = await session(root, directory, input.editId);
    if (current.target.targetId !== target.targetId || current.target.sha256 !== target.sha256 || current.target.revision !== target.revision || current.revision !== input.expectedEditRevision)
      throw error('板面分析会话或来源版本已变化。', 'IMAGE_EDIT_CONFLICT', 409);
    const region = await json(await safe(root, path.join(directory, 'regions', `${hash(input.regionRef)}.json`)));
    if (!region || region.targetId !== target.targetId || region.sourceSha256 !== target.sha256 || region.sourceRevision !== target.revision)
      throw error('板面选区已失效。', 'IMAGE_REGION_STALE', 409);
    const base = input.baseCandidateVersion === 'source' ? current.source : current.candidates.find(c => c.version === input.baseCandidateVersion && c.status === 'completed')?.image;
    if (!base) throw error('板面基准候选不可用。', 'IMAGE_CANDIDATE_UNAVAILABLE', 409);
    const decoded = await decode(await readBlob(root, base));
    const crop = cropPanel(decoded.pixels, await readBlob(root, region.mask), decoded.width, decoded.height);
    return { ...await suggestPanelRegion(root, crop, decoded, input), baseRgbaSha256: decoded.rgbaSha256, baseCandidateVersion: input.baseCandidateVersion, regionRef: input.regionRef };
  }
  if (operation === 'image-inspect') {
    if (input.intent && ((!input.target && !input.targetId) || input.view !== 'metadata')) throw error('编辑计划需要一个明确的目标和 metadata 视图。');
    if (!input.target && !input.targetId) {
      const listed = await listImageTargets(root, manifest, { scope: input.scope, query: input.query, limit: input.limit, offset: input.offset });
      return { ...listed, targets: listed.targets.map(target => targetInfo(target, manifest)) };
    }
    if (input.target && input.targetId) throw error('Supply exactly one targetId or target.');
    const target = await readImageTarget(root, manifest, input.targetId || input.target);
    if (input.view === 'candidate' || input.view === 'diff') {
      if (!input.editId || !input.candidateVersion) throw error('Candidate views require editId and candidateVersion.');
      return lock(root, directory, `session:${input.editId}`, async () => {
        const value = await session(root, directory, input.editId);
        if (value.target.targetId !== target.targetId) throw error('Candidate belongs to another target.');
        const candidate = value.candidates.find(item => item.version === input.candidateVersion); await refreshCandidate(root, manifest, directory, value, candidate);
        if (!candidate?.image || candidate.status !== 'completed') throw error('Candidate is not completed.', 'IMAGE_CANDIDATE_UNAVAILABLE', 409);
        if (input.view === 'diff') return { target: targetInfo(target, manifest), editId: value.editId, candidateVersion: candidate.version, diff: candidate.diff, diffFromBase: candidate.diffFromBase, diffFromSource: candidate.diffFromSource, evidence: candidate.evidence };
        return { target: targetInfo(target, manifest), editId: value.editId, candidateVersion: candidate.version, ...await imageView(await readBlob(root, candidate.image), input.includePixels) };
      });
    }
    const info = targetInfo(target, manifest);
    const intent = input.intent && planImageIntent(input.intent);
    const plan = intent && { ...intent, targetName: info.name, targetRevision: info.revision,
      supported: !!intent.operation && info.supportedOperations.includes(intent.operation.type),
      ...(intent.route === 'ai' && !info.aiEdit.supported ? { reason: info.aiEdit.reason } : {}) };
    return { target: info, ...(plan ? { plan } : {}), ...await relatedMetadata(root, directory, target, input), ...(input.view !== 'metadata' || input.includePixels ? await imageView(target.bytes, input.includePixels) : {}) };
  }
  if (operation === 'image-session-get') return lock(root, directory, `session:${input.editId}`, async () => ({ edit: await publicSession(root, manifest, directory, await session(root, directory, input.editId), input.includePixels, input.candidateVersion, input.comparison) }));
  if (operation === 'image-resolve') return input.saveAs ? command(root, directory, operation, input, () => resolve(root, manifest, directory, input)) : resolve(root, manifest, directory, input);
  if (operation === 'image-session-create') return command(root, directory, operation, input, async () => {
    const target = await readImageTarget(root, manifest, input.targetId || input.target); checkTarget(target, input, true);
    return { edit: await publicSession(root, manifest, directory, await newSession(root, manifest, directory, target, input.commandId)) };
  });
  if (operation === 'image-edit') return command(root, directory, operation, input, (state, persist) => edit(root, manifest, directory, input, state, persist), async (state,persist) => {
    if (!state.editId) throw error('Interrupted command has no task identity. Review before starting another command.', 'IMAGE_SUBMISSION_UNKNOWN', 409);
    const recovered=await lock(root, directory, `session:${state.editId}`, async () => {
      const value = await session(root, directory, state.editId), candidate = value.candidates.find(item => item.commandId === input.commandId);
      if (!candidate && state.phase==='validating-plan' && !state.candidateVersion && !state.taskId) return null;
      if (!candidate?.taskId) throw error('Interrupted command has no task identity. It will not be submitted again.', 'IMAGE_SUBMISSION_UNKNOWN', 409, { editId: state.editId });
      await refreshCandidate(root, manifest, directory, value, candidate);
      return { edit: await publicSession(root, manifest, directory, value), candidateVersion: candidate.version, taskId: candidate.taskId, status: candidate.status };
    });
    return recovered ?? edit(root,manifest,directory,input,state,persist);
  });
  if (operation === 'image-apply') {
    return command(root, directory, operation, input, (state, persist) => adopt(root, manifest, directory, input, state, persist), (state, persist) => adopt(root, manifest, directory, input, state, persist, true));
  }
}
