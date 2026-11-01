import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { resolveRegion } from '../../features/image-edit/core.mjs';
import { imageEditOperationSchema } from '../../lib/workbench/image-edit-contract.mjs';

export const categories = ['color', 'texture', 'material', 'geometry', 'removal', 'lighting'];
export const sha = value => createHash('sha256').update(value).digest('hex');
export const json = async file => JSON.parse(await readFile(file, 'utf8'));
export async function save(file, value, exclusive = true) {
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) await writeFile(file, bytes, { flag: 'wx' });
  else {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, file);
  }
}
export async function localFile(root, file) {
  const base = await realpath(root), resolved = await realpath(path.resolve(root, file));
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evidence must be a file inside the repository.');
  return resolved;
}
export const decode = bytes => sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
export const encode = (pixels, width, height) => sharp(pixels, { raw: { width, height, channels: 4 } }).png({ palette: false }).toBuffer();

export function validateBatch(batch) {
  if (batch.schemaVersion !== 1 || !/^[a-z0-9-]+$/.test(batch.id)) throw new Error('Invalid batch identity.');
  if (!['real', 'fixture'].includes(batch.execution)) throw new Error('Explicit execution mode is required.');
  if (batch.service?.model !== 'gpt-image-2.5-sunburst' || !batch.service?.endpoint?.startsWith('https://')) throw new Error('Freeze the current image provider explicitly.');
  for (const key of ['textInput', 'imageInput', 'imageOutput']) if (!Number.isFinite(batch.pricing?.perMillion?.[key]) || batch.pricing.perMillion[key] < 0) throw new Error('Explicit price rates are required.');
  if (!Array.isArray(batch.cases) || batch.cases.length !== 24) throw new Error('P0 requires 24 diagnostic cases.');
  if (new Set(batch.cases.map(c => c.id)).size !== 24) throw new Error('Duplicate case identity.');
  for (const category of categories) if (batch.cases.filter(c => c.category === category).length !== 4) throw new Error(`P0 needs four ${category} cases.`);
  const geometry = batch.cases.filter(c => c.category === 'geometry');
  if (geometry.filter(c => c.subtype === 'part').length !== 2 || geometry.filter(c => c.subtype === 'silhouette').length !== 2) throw new Error('Geometry requires two part and two silhouette cases.');
  const b = batch.budget;
  if (b?.currency !== 'USD' || !Number.isFinite(b.maxUsd) || b.maxUsd < 0 || !Number.isFinite(b.reservationUsd) || b.reservationUsd <= 0 || b.maxCalls < 0 || !Number.isInteger(b.maxCalls) || b.maxCalls > 24 || b.candidatesPerCase !== 1 || b.retries !== 0) throw new Error('Invalid budget: USD, K=1, no retries, bounded calls required.');
  for (const c of batch.cases) {
    if (!/^[a-z0-9-]+$/.test(c.id) || !c.family || !c.source || !['pixel', 'painterly'].includes(c.style) || typeof c.preserveAlpha !== 'boolean' || !c.instruction || !c.keep || !c.failureExample || !Number.isInteger(c.displayWidth) || c.displayWidth < 1) throw new Error(`Incomplete case ${c.id}`);
    imageEditOperationSchema.parse(c.operation);
    if (c.operation.type === 'ai-edit' && c.operation.prompt !== c.instruction) throw new Error('A baseline uses the registered instruction verbatim.');
    if (c.subtype === 'silhouette' && c.preserveAlpha) throw new Error('Silhouette change conflicts with locked alpha.');
    if (!['agent-draft', 'agent-reviewed', 'human-reviewed'].includes(c.annotationStatus)) throw new Error('Annotation provenance is required.');
  }
  return batch;
}

/** Evaluation annotations only; this does not add a production planning API. */
export function writableMask(pixels, width, height, annotation) {
  const region = spec => resolveRegion(pixels, width, height, spec).mask;
  const allowed = region(annotation.allowed), target = region(annotation.target);
  const influence = annotation.influence ? region(annotation.influence) : new Uint8Array(width * height);
  const protectedMask = new Uint8Array(width * height);
  for (const spec of annotation.protected ?? []) {
    const selected = region(spec);
    for (let i = 0; i < selected.length; i++) protectedMask[i] |= selected[i];
  }
  const writable = new Uint8Array(width * height), spans = [];
  for (let i = 0; i < writable.length; i++) writable[i] = Number(Boolean(allowed[i] && (target[i] || influence[i]) && !protectedMask[i]));
  for (let i = 0; i < writable.length;) {
    if (!writable[i]) { i++; continue; }
    const startPixel = i;
    while (i < writable.length && writable[i]) i++;
    spans.push({ startPixel, length: i - startPixel });
  }
  if (!spans.length) throw new Error('Empty writable mask.');
  return { writable, spec: { type: 'mask-runs', spans } };
}
export async function providerMask(mask, width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < mask.length; i++) rgba[i * 4 + 3] = mask[i] ? 0 : 255;
  return encode(rgba, width, height);
}

/** Independent decoded-PNG measurements, including hidden RGB. Not a quality score. */
export async function measure(sourceBytes, maskBytes, candidateBytes) {
  const [source, mask, candidate] = await Promise.all([decode(sourceBytes), decode(maskBytes), decode(candidateBytes)]);
  const { width, height } = source.info;
  if ([mask, candidate].some(x => x.info.width !== width || x.info.height !== height)) return { dimensionsMatch: false, hardProtection: 'failed' };
  let selected = 0, changedInside = 0, changedOutside = 0, alphaChanged = 0, blackInside = 0, sourceBlackInside = 0, selectedVisible = 0;
  const expected = Buffer.alloc(source.data.length), actual = Buffer.alloc(source.data.length);
  for (let i = 0; i < source.data.length; i += 4) {
    const changed = !source.data.subarray(i, i + 4).equals(candidate.data.subarray(i, i + 4));
    if (source.data[i + 3] !== candidate.data[i + 3]) alphaChanged++;
    if (mask.data[i + 3] === 0) {
      selected++; changedInside += Number(changed);
      selectedVisible += Number(source.data[i + 3] > 0);
      if (candidate.data[i + 3] && candidate.data[i] === 0 && candidate.data[i + 1] === 0 && candidate.data[i + 2] === 0) blackInside++;
      if (source.data[i + 3] && source.data[i] === 0 && source.data[i + 1] === 0 && source.data[i + 2] === 0) sourceBlackInside++;
    } else {
      changedOutside += Number(changed);
      source.data.copy(expected, i, i, i + 4); candidate.data.copy(actual, i, i, i + 4);
    }
  }
  return { dimensionsMatch: true, width, height, selected, selectedFraction: selected / (width * height), selectedVisible, changedInside, changedOutside, alphaChanged, blackInside, sourceBlackInside, addedBlackInside: blackInside - sourceBlackInside, protectedSourceSha256: sha(expected), protectedCandidateSha256: sha(actual), sourceRgbaSha256: sha(source.data), candidateRgbaSha256: sha(candidate.data), hardProtection: changedOutside === 0 ? 'passed' : 'failed' };
}

export function usageCost(usage, rates) {
  const input = usage?.input_tokens_details, output = usage?.output_tokens_details;
  if (![input?.text_tokens, input?.image_tokens, usage?.output_tokens].every(v => Number.isSafeInteger(v) && v >= 0)) return null;
  // Direct Images API has no cached-input discount. Unknown output modalities are not priced as zero.
  if (input.text_tokens + input.image_tokens !== usage.input_tokens || (output && (output.text_tokens !== 0 || output.image_tokens !== usage.output_tokens))) return null;
  return (input.text_tokens * rates.textInput + input.image_tokens * rates.imageInput + usage.output_tokens * rates.imageOutput) / 1e6;
}
export function reserve(ledger, id, budget) {
  if (ledger.entries.some(e => e.id === id)) throw new Error('Attempt already exists; recover the original record, never resubmit.');
  if (ledger.entries.some(e => ['reserved', 'unknown'].includes(e.status))) throw new Error('Unresolved submission blocks further paid calls.');
  const spent = ledger.entries.reduce((n, e) => n + (e.costUsd ?? e.reservedUsd), 0);
  if (ledger.entries.length >= budget.maxCalls || spent + budget.reservationUsd > budget.maxUsd + 1e-9) throw new Error('BUDGET_EXHAUSTED');
  ledger.entries.push({ id, status: 'reserved', reservedUsd: budget.reservationUsd, costUsd: null, reservedAt: new Date().toISOString() });
  return ledger.entries.at(-1);
}
export function evidenceState({ submission, raw, final, review }) {
  const missing = Object.entries({ submission, raw, final, review }).filter(([, present]) => !present).map(([key]) => key);
  return { complete: !missing.length, missing, causalAttribution: missing.length ? 'unknown' : 'eligible-for-review' };
}
