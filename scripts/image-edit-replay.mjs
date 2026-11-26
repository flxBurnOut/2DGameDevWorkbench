// Recompose saved provider bytes without submitting, changing, or adopting an asset.
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha, json, save, localFile, measure, decode } from './image-edit-evaluation/core.mjs';
import { processImagePixels } from '../lib/workbench/adapters/image-assets-processing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [input, destination] = process.argv.slice(2);
if (!input || !destination) throw new Error('Usage: node scripts/image-edit-replay.mjs <replay-list.json> <new-work-directory>');
const out = path.resolve(root, destination), relative = path.relative(path.join(root, 'work'), out);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Use a new directory within work/.');
if (await access(out).then(() => true, () => false)) throw new Error('Replay output already exists.');
const records = await json(await localFile(root, input));
if (!Array.isArray(records) || !records.length) throw new Error('A nonempty replay list is required.');
await mkdir(out, { recursive: true });
const results = [];
for (const item of records) {
  if (!/^[a-z0-9-]+$/.test(item.id) || typeof item.preserveAlpha !== 'boolean') throw new Error('Invalid replay definition.');
  const dir = path.join(out, item.id); await mkdir(dir);
  const files = {};
  for (const name of ['source-image.png', 'edit-mask.png', 'provider-response.png', 'image.png', 'image-metadata.json', 'provider-usage.json']) {
    const file = await localFile(root, path.join(item.directory, name));
    files[name] = { sha256: sha(await readFile(file)) };
    await copyFile(file, path.join(dir, name === 'image.png' ? 'historical-final.png' : name));
  }
  const source = await readFile(path.join(dir, 'source-image.png')), mask = await readFile(path.join(dir, 'edit-mask.png')), raw = await readFile(path.join(dir, 'provider-response.png'));
  const metadata = await json(path.join(dir, 'image-metadata.json'));
  const recomposed = await processImagePixels(raw, { preserveFrom: source, mask, ...(item.preserveAlpha ? { preserveAlphaFrom: source } : {}), alphaCleanupThreshold: 0 });
  await writeFile(path.join(dir, 'current-composite.png'), recomposed.buffer, { flag: 'wx' });
  const pixels = await decode(mask); let left = pixels.info.width, top = pixels.info.height, right = -1, bottom = -1;
  for (let i = 0; i < pixels.info.width * pixels.info.height; i++) if (!pixels.data[i * 4 + 3]) { const x = i % pixels.info.width, y = Math.floor(i / pixels.info.width); left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  const evidence = { id: item.id, historicalTaskId: metadata.sourceTaskId, historicalPrompt: metadata.effectivePrompt ?? null, sourceFamily: item.family, sourceFiles: files, preserveAlpha: item.preserveAlpha, rawMetrics: await measure(source, mask, raw), historicalMetrics: await measure(source, mask, await readFile(path.join(dir, 'historical-final.png'))), currentMetrics: await measure(source, mask, recomposed.buffer), currentProcessing: recomposed.evidence, crop: { left, top, width: right - left + 1, height: bottom - top + 1 }, newProviderCalls: 0, currentGeneration: false, wireRequest: 'Historical metadata available; exact multipart capture unavailable.', independentReview: 'pending' };
  await save(path.join(dir, 'replay.json'), evidence); results.push(evidence);
}
await save(path.join(out, 'summary.json'), { createdAt: new Date().toISOString(), newProviderCalls: 0, scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))), processingCodeSha256: sha(await readFile(path.join(root, 'lib/workbench/adapters/image-assets-processing.mjs'))), records: results });
console.log(JSON.stringify({ replayed: results.length, newProviderCalls: 0, results: results.map(r => ({ id: r.id, historicalOutsideChanges: r.historicalMetrics.changedOutside, currentOutsideChanges: r.currentMetrics.changedOutside, historicalAlphaChanges: r.historicalMetrics.alphaChanged, currentAlphaChanges: r.currentMetrics.alphaChanged })) }));
