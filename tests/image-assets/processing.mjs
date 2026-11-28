import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { processImagePixels } from '../../lib/workbench/adapters/image-assets-processing.mjs';
import { imageSha256 } from '../../lib/workbench/adapters/image-assets-source.mjs';
import { findCapability, loadManifest, repositoryRoot, runConnector, validateInput } from '../../lib/workbench/runtime.mjs';
import { readGeneratedImage } from '../../lib/workbench/document-assets.mjs';

const png = (data, width = 4, height = 2) => sharp(Buffer.from(data), { raw: { width, height, channels: 4 } }).png().toBuffer();
const rgba = bytes => sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
const originalPixels = Buffer.from([11,22,33,0, 20,30,40,1, 90,80,70,128, 10,20,30,255, 40,50,60,255, 99,88,77,2, 50,60,70,255, 80,90,100,255]);
const original = await png(originalPixels);
const candidatePixels = Buffer.from([200,100,50,255, 200,100,50,255, 200,100,50,255, 255,0,0,1, 0,255,0,2, 0,0,255,128, 77,66,55,0, 20,40,60,255]);
const candidate = await png(candidatePixels);
const maskValues = [255, 128, 1, 0, 0, 0, 0, 0];
const mask = await png(maskValues.flatMap(alpha => [250, 0, 200, alpha]));
const processed = await processImagePixels(candidate, { preserveFrom: original, mask, alphaCleanupThreshold: 1 });
const actual = await rgba(processed.buffer);
assert.deepEqual(actual.subarray(0, 12), originalPixels.subarray(0, 12), 'Protected RGBA is exact, including hidden RGB, alpha1 source, and alpha1/128 mask edges.');
assert.deepEqual(actual.subarray(12, 16), Buffer.alloc(4), 'Only eligible low-alpha edit pixels are cleared.');
assert.deepEqual(actual.subarray(16), candidatePixels.subarray(16), 'Alpha2+, soft edges, and hidden RGB in already-transparent candidate pixels are retained.');
assert.equal(processed.evidence.preservation.protectedPixels, 3);
assert.equal(processed.evidence.preservation.changedOutsideMaskPixels, 0);
assert.equal(processed.evidence.alphaCleanup.protectedLowAlphaPixels, 1);
assert.equal(processed.evidence.alphaCleanup.cleanedPixels, 1);
assert.equal(processed.evidence.preservation.expectedProtectedRgbaSha256, processed.evidence.preservation.actualProtectedRgbaSha256);
assert.equal(processed.evidence.candidateSha256, imageSha256(candidate));
assert.equal(processed.evidence.outputSha256, imageSha256(processed.buffer));
const twice = await processImagePixels(processed.buffer, { preserveFrom: original, mask, alphaCleanupThreshold: 1 });
assert.deepEqual(twice.buffer, processed.buffer, 'Processing is idempotent and avoids unnecessary PNG rewrites.');
const clean = await processImagePixels(original, { alphaCleanupThreshold: 1 });
const cleaned = await rgba(clean.buffer);
assert.deepEqual(cleaned.subarray(0, 4), originalPixels.subarray(0, 4), 'Already transparent pixels are not rewritten.');
assert.deepEqual(cleaned.subarray(4, 8), Buffer.alloc(4));
assert.deepEqual(cleaned.subarray(8), originalPixels.subarray(8), 'All alpha2+ source pixels remain byte-identical.');
assert.deepEqual((await processImagePixels(original, { alphaCleanupThreshold: 0 })).buffer, original);
const alphaPreserved = await processImagePixels(candidate, { preserveFrom: original, mask, preserveAlphaFrom: original, alphaCleanupThreshold: 16 });
const alphaPixels = await rgba(alphaPreserved.buffer);
for (let i = 0; i < alphaPixels.length; i += 4) {
  assert.equal(alphaPixels[i + 3], originalPixels[i + 3], 'All Alpha bytes come from the base, including 0, 1, 2, 128 and 255.');
  assert.deepEqual(alphaPixels.subarray(i, i + 3), (maskValues[i / 4] ? originalPixels : candidatePixels).subarray(i, i + 3), 'Alpha preservation must not clear the candidate RGB before restoring opacity.');
}
assert.equal(alphaPreserved.evidence.alphaCleanup.threshold, 0);
assert.equal(alphaPreserved.evidence.alphaCleanup.requestedThreshold, 16);
assert.equal(alphaPreserved.evidence.alphaCleanup.cleanedPixels, 0);
assert.equal(alphaPreserved.evidence.alphaCleanup.skippedReason, 'preserve-alpha');
assert.equal(alphaPreserved.evidence.alphaPreservation.changedAlphaPixels, 0);
assert.equal(alphaPreserved.evidence.alphaPreservation.expectedAlphaSha256, imageSha256(originalPixels.filter((_, index) => index % 4 === 3)));
assert.equal(alphaPreserved.evidence.alphaPreservation.expectedAlphaSha256, alphaPreserved.evidence.alphaPreservation.actualAlphaSha256);
assert.equal(alphaPreserved.evidence.preservation.changedOutsideMaskPixels, 0);
assert.deepEqual((await processImagePixels(alphaPreserved.buffer, { preserveFrom: original, mask, preserveAlphaFrom: original, alphaCleanupThreshold: 1 })).buffer, alphaPreserved.buffer, 'The encoded result is idempotent.');
const alphaOnly = await processImagePixels(candidate, { preserveAlphaFrom: original, alphaCleanupThreshold: 1 });
const alphaOnlyPixels = await rgba(alphaOnly.buffer);
for (let i = 0; i < alphaOnlyPixels.length; i += 4) {
  assert.deepEqual(alphaOnlyPixels.subarray(i, i + 3), candidatePixels.subarray(i, i + 3));
  assert.equal(alphaOnlyPixels[i + 3], originalPixels[i + 3]);
}
assert.equal(alphaOnly.evidence.preservation, null, 'Unmasked edits can still preserve all Alpha bytes.');
const resized = await sharp(candidate).resize(8, 4, { kernel: 'nearest' }).png().toBuffer();
await assert.rejects(processImagePixels(resized, { preserveFrom: original, mask }), /尺寸完全一致/);
await assert.rejects(processImagePixels(resized, { preserveAlphaFrom: original }), /尺寸完全一致/);
await assert.rejects(processImagePixels(candidate, { preserveFrom: original, mask, preserveAlphaFrom: candidate }), /蒙版外像素校验失败/, 'A conflicting Alpha source cannot weaken outside-mask RGBA protection.');
await assert.rejects(processImagePixels(candidate, { preserveFrom: original }), /同时提供/);
await assert.rejects(processImagePixels(candidate, { alphaCleanupThreshold: 17 }), /0–16/);
await assert.rejects(processImagePixels(candidate, { preserveFrom: original, mask: await png(Array(8).fill([0,0,0,255]).flat()) }), /透明区域/);

const manifest = await loadManifest(), capability = findCapability(manifest, 'image-assets');
const data = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const input = { operation: 'process-image', kind: 'prop', image: data(candidate), preserveFrom: data(original), mask: data(mask), alphaCleanupThreshold: 1 };
assert.deepEqual(validateInput(capability, input), []);
for (const changes of [{ preserveFrom: undefined }, { mask: undefined }, { provider: 'gpt-image-2.6' }, { prompt: 'never generate' }, { references: [] }, { width: 1024, height: 1024 }, { alphaCleanupThreshold: 1.5 }]) {
  const invalid = Object.fromEntries(Object.entries({ ...input, ...changes }).filter(([, value]) => value !== undefined));
  assert.ok(validateInput(capability, invalid).length, JSON.stringify(changes));
}
assert.ok(validateInput(capability, { operation: 'generate-prop' }).length, 'Paid generation still requires a prompt.');
const originalFetch = globalThis.fetch;
let networkRequests = 0;
globalThis.fetch = () => { networkRequests++; throw new Error('Local processing must never use fetch.'); };
try {
  const { task } = await runConnector(manifest, capability, input);
  assert.equal(task.status, 'completed', task.error);
  assert.equal(task.adapter.provider, 'local');
  assert.equal(task.adapter.backgroundExecution, undefined);
  assert.equal(task.outputs.some(file => file.endsWith('provider-usage.json')), false, 'No fictional provider usage for a local task.');
  const get = name => readFile(path.resolve(repositoryRoot, task.outputs.find(file => file.endsWith(`/${name}`))));
  const result = JSON.parse(await get('result.json'));
  assert.equal(result.rawSha256, imageSha256(candidate));
  assert.equal(result.provider, 'local');
  assert.equal(result.model, undefined);
  assert.equal(result.requiresAdoption, true);
  assert.deepEqual(await get(result.rawImage), candidate, 'Original candidate is saved byte-for-byte.');
  assert.deepEqual(await get('source-image.png'), original);
  assert.deepEqual(await get('edit-mask.png'), mask);
  assert.deepEqual(await get('image.png'), processed.buffer);
  const metadata = JSON.parse(await get('image-metadata.json'));
  assert.equal(metadata.source, 'local-image-processing');
  assert.equal(metadata.providerOrigin, undefined);
  assert.equal(metadata.semantics, 'local-processing');
  assert.equal(metadata.preservesPixelsOutsideMask, true);
  const adopted = await readGeneratedImage(repositoryRoot, manifest, task.id, result.sha256);
  assert.deepEqual(adopted.bytes, processed.buffer, 'Adoption reads the derived PNG and its new identity/hash.');
  await assert.rejects(readGeneratedImage(repositoryRoot, manifest, task.id, result.rawSha256), /已变化/, 'The raw hash must not authorize the derivative.');
  const unmasked = await runConnector(manifest, capability, { operation: 'process-image', kind: 'prop', image: data(original) });
  assert.equal(unmasked.task.status, 'completed');
  const unmaskedReport = JSON.parse(await readFile(path.resolve(repositoryRoot, unmasked.task.outputs.find(file => file.endsWith('/processing-report.json')))));
  assert.equal(unmaskedReport.alphaCleanup.threshold, 1, 'Props default to conservative alpha1 cleanup.');
  assert.equal(unmaskedReport.alphaCleanup.cleanedPixels, 1);
  assert.equal(networkRequests, 0);
} finally { globalThis.fetch = originalFetch; }
console.log('Image processing: exact protected RGBA, soft-mask protection, transparent candidate replacement, alpha1-only cleanup, idempotence, size rejection, raw/derived provenance and adoption passed; 0 network calls.');

const { imageDarkeningWarning } = await import('../../features/image-edit/appearance-check.mjs');
const bright = new Uint8Array(100 * 4).fill(180), black = new Uint8Array(bright);
for (let i = 0; i < bright.length; i += 4) { bright[i + 3] = 255; black.set([0, 0, 0, 255], i); }
assert.equal(imageDarkeningWarning(bright, black)?.code, 'large-dark-patch');
assert.equal(imageDarkeningWarning(black, black), null, 'Unchanged black art is not an anomaly.');
for (let i = 0; i < black.length; i += 4) black[i + 3] = 0;
assert.equal(imageDarkeningWarning(bright, black), null, 'Intentional transparency is not a black patch.');
