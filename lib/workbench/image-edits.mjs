import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compareImagePlacement } from './image-edit-comparison.mjs';
import { cropPanel } from '../../features/image-edit/metal-panel.mjs';
import { suggestPanelRegion } from './image-edit-panel-sam.mjs';
import { planImageIntent } from '../../features/image-edit/edit-intent.mjs';
import { imageEditInputs } from './image-edit-contract.mjs';
import { readImageTarget, listImageTargets, applyImageTarget } from './image-edit-targets.mjs';
import { resolveRegion, applyLocalOperation } from '../../features/image-edit/core.mjs';
import { findCapability, runConnector, refreshTask } from './runtime.mjs';
import { validateImageProcessingSize } from './adapters/image-assets-processing.mjs';
import { MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, readImageAssetSource, validateImageAssetDimensions } from './adapters/image-assets-source.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const error = (message, code = 'INVALID_IMAGE_EDIT', status = 400, details = {}) => Object.assign(new Error(message), { code, status, ...details });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => hash(JSON.stringify(canonical(value)));
const localOperations = ['metal-panel', 'palette-map', 'clean-alpha', 'replace-color', 'fill', 'erase', 'translate', 'restore-region', 'pixel-patch'];
const inside = (base, target) => { const relative = path.relative(base, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
function storage(root, manifest) {
  const directory = path.resolve(root, manifest.workspace.imageEditDirectory || `${path.posix.dirname(manifest.workspace.taskDirectory.replaceAll('\\', '/'))}/image-edits`);
  if (!inside(path.resolve(root), directory)) throw error('Image edit storage must stay inside the workspace.');
  return directory;
}
async function safe(root, file) {
  const base = await realpath(root);
  let ancestor = file;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      if (resolved !== path.resolve(base, path.relative(path.resolve(root), ancestor))) throw error('Image edit storage cannot cross a symlink.', 'UNSAFE_IMAGE_EDIT_PATH');
      break;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error('Invalid image edit storage path.');
      ancestor = parent;
    }
  }
  return file;
}
async function json(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } }
async function atomic(root, file, value) {
  await safe(root, file); await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (cause) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(cause.code) || attempt >= 19) throw cause; await new Promise(resolve => setTimeout(resolve, 25)); }
    }
  } finally { await rm(temporary, { force: true }); }
}
// As with shared documents and maps, the canonical Bridge owns mutations.
// MCP/CLI and the browser forward every image operation (including refresh reads)
// to it. Durable command intents, not stale filesystem leases, survive restarts.
// Running multiple independent Bridges over the same storage is unsupported.
const locks = new Map();
async function lock(_root, directory, name, fn) {
  const key = `${directory}\0${name}`, previous = locks.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(fn);
  locks.set(key, pending);
  try { return await pending; }
  finally { if (locks.get(key) === pending) locks.delete(key); }
}
const sessionFile = (directory, id) => path.join(directory, 'sessions', `${hash(id)}.json`);
async function session(root, directory, id) {
  const file = await safe(root, sessionFile(directory, id));
  const value = await json(file);
  if (!value || value.editId !== id) throw error('Image edit session not found.', 'IMAGE_EDIT_NOT_FOUND', 404);
  return value;
}
const saveSession = (root, directory, value) => atomic(root, sessionFile(directory, value.editId), value);
async function blob(root, directory, bytes, extension) {
  const sha256 = hash(bytes), file = path.join(directory, 'blobs', `${sha256}.${extension}`);
  await safe(root, file); await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { flag: 'wx' }); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; if (hash(await readFile(file)) !== sha256) throw error('Image edit blob is corrupt.', 'CORRUPT_IMAGE_EDIT', 500); }
  return { sha256, file: path.relative(root, file).replaceAll('\\', '/') };
}
async function readBlob(root, reference) {
  const file = path.resolve(root, reference.file);
  if (!inside(path.resolve(root), file)) throw error('Invalid image edit blob.');
  await safe(root, file); const bytes = await readFile(file);
  if (hash(bytes) !== reference.sha256) throw error('Image edit source has changed on disk.', 'CORRUPT_IMAGE_EDIT', 409);
  return bytes;
}
async function decode(bytes) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 8294400 }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  validateImageProcessingSize(info.width, info.height);
  return { pixels: data, width: info.width, height: info.height, rgbaSha256: hash(data) };
}
const encode = (pixels, width, height) => sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
function checkTarget(target, input, editable = false) {
  if (target.revision !== input.expectedRevision || target.sha256 !== input.expectedSha256) throw error('Source changed. Inspect and resolve the region again before editing.', 'IMAGE_SOURCE_CONFLICT', 409, { currentRevision: target.revision, expectedRevision: input.expectedRevision });
  if (editable && (!target.editable || target.locked)) throw error(target.locked ? 'This image layer is locked.' : 'This target is read-only.', 'IMAGE_TARGET_READ_ONLY', 409);
}
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
  return { ...(comparison ? { comparison } : {}), editId: value.editId, revision: value.revision, target: value.target, source: { sha256: value.source.sha256, rgbaSha256: value.source.rgbaSha256 }, candidates, adoptions: value.adoptions, ...(includePixels ? { selectedVersion: chosen?.image ? chosen.version : 'source', pixels: await imageView(await readBlob(root, chosen?.image || value.source), true) } : {}) };
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
async function command(root, directory, operation, input, execute, resume) {
  const file = path.join(directory, 'commands', `${hash(input.commandId)}.json`), requestHash = fingerprint({ operation, input });
  return lock(root, directory, `command:${input.commandId}`, async () => {
    const previous = await json(await safe(root, file));
    const state = previous || { commandId: input.commandId, requestHash, operation, startedAt: new Date().toISOString() };
    const persist = async changes => { Object.assign(state, changes); await atomic(root, file, state); };
    const saveResult = result => persist({ result: operation === 'image-edit' ? { editId: result.edit.editId, candidateVersion: result.candidateVersion, taskId: result.taskId, status: result.status } : result });
    if (previous) {
      if (previous.requestHash !== requestHash) throw error('commandId was used with a different request.', 'COMMAND_ID_REUSED', 409);
      if (previous.result && !(operation === 'image-edit' && resume)) return { ...previous.result, replayed: true };
      if (resume) { const result = await resume(previous, persist); await saveResult(result); return { ...result, replayed: true }; }
      throw error('Previous submission was interrupted. Inspect its saved session; do not submit a new command.', 'IMAGE_SUBMISSION_UNKNOWN', 409, { editId: previous.editId, taskId: previous.taskId });
    }
    await persist({});
    const result = await execute(state, persist);
    // The ledger stores identities, not another copy of the growing history.
    await saveResult(result);
    return { ...result, replayed: false };
  });
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
async function frozenAiInput(root, directory, input, target, base, decoded, mask) {
  const dimensions = validateImageAssetDimensions(decoded.width, decoded.height);
  const pngMaskBytes = await encodeMask(mask, decoded.width, decoded.height), baseBytes = await readBlob(root, base);
  let totalBytes = baseBytes.length + pngMaskBytes.length;
  const references = [];
  for (const reference of input.operation.references || []) {
    const source = await readImageAssetSource(reference, root);
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
async function edit(root, manifest, directory, input, state, persist) {
  const target = await readImageTarget(root, manifest, input.targetId || input.target); checkTarget(target, input, true);
  if (input.operation.type === 'ai-edit') {
    const support = aiSupport(target, manifest);
    if (!support.supported) throw error(support.reason, support.code);
  }
  const value = input.editId ? await session(root, directory, input.editId) : await newSession(root, manifest, directory, target, input.commandId);
  await persist({ editId: value.editId });
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
    const mask = new Uint8Array(await readBlob(root, region.mask));
    let restorePixels, operation = input.operation;
    let prepared;
    if (operation.type === 'ai-edit') prepared = await frozenAiInput(root, directory, input, target, base, decoded, mask);
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
      const output = applyLocalOperation({ ...decoded, mask, operation, restorePixels });
      if (input.constraints.preserveAlpha) for (let i = 3; i < output.pixels.length; i += 4) if (output.pixels[i] !== decoded.pixels[i]) throw error('Operation changes alpha while preserveAlpha is enabled.', 'IMAGE_CONSTRAINT_FAILED');
      const image = await blob(root, directory, await encode(output.pixels, decoded.width, decoded.height), 'png');
      const effectiveMask = await blob(root, directory, Buffer.from(output.effectiveMask), 'mask');
      const pngMask = await blob(root, directory, await encodeMask(output.effectiveMask, decoded.width, decoded.height), 'png');
      prepared = { operation: input.operation, summary: input.operation.type === 'pixel-patch' ? { type: 'pixel-patch', spanCount: input.operation.spans.length, changedByteLength: input.operation.spans.reduce((total, span) => total + Buffer.byteLength(span.afterRgbaBase64, 'base64'), 0) } : input.operation,
        effectiveMask, taskInput: { operation: 'process-image', image: image.file, preserveFrom: base.file, mask: pngMask.file, alphaCleanupThreshold: 0, kind: target.kind } };
    }
    const version = `candidate-${hash(input.commandId).slice(0, 32)}`;
    const recipe = await blob(root, directory, Buffer.from(JSON.stringify({ operation: prepared.operation, regionRef: input.regionRef, baseCandidateVersion: baseVersion, constraints: input.constraints })), 'json');
    const plan = { target: target.name, regionBounds: region.bounds, selectedPixels: region.count,
      route: operation.type === 'ai-edit' ? 'ai' : 'local', preserveAlpha: input.constraints.preserveAlpha || ['metal-panel', 'palette-map', 'replace-color'].includes(operation.type),
      operationType: operation.type, baseCandidateVersion: baseVersion };
    const candidate = { version, plan, commandId: input.commandId, baseCandidateVersion: baseVersion, base, regionRef: input.regionRef, operation: prepared.summary, recipe, constraints: input.constraints, mask: prepared.effectiveMask, status: 'preparing', createdAt: new Date().toISOString() };
    current.candidates.push(candidate); current.revision++; await saveSession(root, directory, current); await persist({ candidateVersion: version });
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
  if (operation === 'image-edit') return command(root, directory, operation, input, (state, persist) => edit(root, manifest, directory, input, state, persist), async state => {
    if (!state.editId) throw error('Interrupted command has no task identity. Review before starting another command.', 'IMAGE_SUBMISSION_UNKNOWN', 409);
    return lock(root, directory, `session:${state.editId}`, async () => {
      const value = await session(root, directory, state.editId), candidate = value.candidates.find(item => item.commandId === input.commandId);
      if (!candidate?.taskId) throw error('Interrupted command has no task identity. It will not be submitted again.', 'IMAGE_SUBMISSION_UNKNOWN', 409, { editId: state.editId });
      await refreshCandidate(root, manifest, directory, value, candidate);
      return { edit: await publicSession(root, manifest, directory, value), candidateVersion: candidate.version, taskId: candidate.taskId, status: candidate.status };
    });
  });
  if (operation === 'image-apply') {
    return command(root, directory, operation, input, (state, persist) => adopt(root, manifest, directory, input, state, persist), (state, persist) => adopt(root, manifest, directory, input, state, persist, true));
  }
}
