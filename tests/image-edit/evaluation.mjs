import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writableMask, providerMask, measure, encode, decode, reserve, usageCost, evidenceState, validateBatch, json, categories } from '../../scripts/image-edit-evaluation/core.mjs';
import { processImagePixels } from '../../lib/workbench/adapters/image-assets-processing.mjs';
import {checkP2cResume} from './p2c-quality.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = path.join(root, 'work', 'test-runs', `p0-evaluation-${randomUUID()}`);
await mkdir(directory, { recursive: true });
let checks = 0;
const equal = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const rejects = (fn, pattern) => { assert.throws(fn, pattern); checks++; };
const rect = (x, y, width, height) => ({ type: 'rectangle', x, y, width, height });

// Coordinate intersection and mask polarity must also preserve invisible RGB and alpha=1.
const pixels = Buffer.from([17, 23, 29, 0, 31, 37, 41, 1, 43, 47, 53, 128, 59, 61, 67, 255]);
const resolved = writableMask(pixels, 4, 1, { allowed: rect(0, 0, 3, 1), target: rect(1, 0, 2, 1), influence: rect(0, 0, 1, 1), protected: [rect(1, 0, 1, 1)] });
equal([...resolved.writable], [1, 0, 1, 0]);
equal(resolved.spec.spans, [{ startPixel: 0, length: 1 }, { startPixel: 2, length: 1 }]);
const mask = await providerMask(resolved.writable, 4, 1), decodedMask = await decode(mask);
equal([3, 7, 11, 15].map(i => decodedMask.data[i]), [0, 255, 0, 255]);
const source = await encode(pixels, 4, 1), raw = await encode(Buffer.alloc(16, 255), 4, 1);
const composed = await processImagePixels(raw, { preserveFrom: source, mask, preserveAlphaFrom: source });
const measured = await measure(source, mask, composed.buffer);
equal(measured.changedOutside, 0); equal(measured.alphaChanged, 0); equal(measured.selected, 2);
equal(measured.protectedCandidateSha256, measured.protectedSourceSha256);
equal((await measure(source, mask, raw)).changedOutside, 2);
equal((await measure(source, mask, await encode(Buffer.alloc(8), 2, 1))).dimensionsMatch, false);
equal(evidenceState({ submission: true, raw: true, final: true, review: false }).causalAttribution, 'unknown');

const budget = { currency: 'USD', maxUsd: 3, reservationUsd: 2, maxCalls: 2, candidatesPerCase: 1, retries: 0 };
const ledger = { entries: [] };
reserve(ledger, 'first', budget);
rejects(() => reserve(ledger, 'first', budget), /already exists/);
rejects(() => reserve(ledger, 'second', budget), /Unresolved/);
ledger.entries[0].status = 'accounted'; ledger.entries[0].costUsd = 1.1;
rejects(() => reserve(ledger, 'second', budget), /BUDGET_EXHAUSTED/);
ledger.entries[0].costUsd = .03; reserve(ledger, 'second', budget); equal(ledger.entries.length, 2);
const rates = { textInput: 5, imageInput: 8, imageOutput: 30 };
equal(usageCost({ input_tokens: 110, output_tokens: 10, input_tokens_details: { text_tokens: 10, image_tokens: 100, cached_tokens: 90 } }, rates), .00115);
equal(usageCost({ input_tokens: 110, output_tokens: 10, input_tokens_details: { text_tokens: 10 } }, rates), null);

// A real Bridge/adapter round trip with the network replaced by the explicit mock command.
const big = Buffer.alloc(1024 * 1024 * 4);
for (let i = 0; i < big.length; i += 4) { big[i] = 17; big[i + 1] = 23; big[i + 2] = 29; big[i + 3] = i % 5 === 0 ? 1 : 255; }
const sourceFile = path.join(directory, 'source.png'); await writeFile(sourceFile, await encode(big, 1024, 1024));
const cases = categories.flatMap(category => Array.from({ length: 4 }, (_, i) => ({ id: `${category}-${i + 1}`, category, family: 'synthetic-only', source: path.relative(root, sourceFile), style: 'pixel', displayWidth: 160, preserveAlpha: !(category === 'geometry' && i >= 2), ...(category === 'geometry' ? { subtype: i < 2 ? 'part' : 'silhouette' } : {}), instruction: 'Change only the selected area.', keep: 'Protected RGBA and selected base alpha.', failureExample: 'Changed protected pixel.', annotationStatus: 'agent-draft', annotation: { allowed: rect(117, 213, 13, 17), target: rect(117, 213, 13, 17), protected: [rect(120, 217, 3, 4)] }, operation: category === 'color' && i === 0 ? { type: 'replace-color', from: '#11171d', to: '#304050' } : { type: 'ai-edit', prompt: 'Change only the selected area.' } })));
const batch = { schemaVersion: 1, execution: 'fixture', id: `fixture-${randomUUID()}`, service: { endpoint: 'https://api.openai.com/v1/images/edits', model: 'gpt-image-2.5-sunburst' }, budget, pricing: { perMillion: rates }, cases };
validateBatch(batch); checks++;
const wrong = structuredClone(batch); wrong.cases.find(c => c.subtype === 'silhouette').preserveAlpha = true;
rejects(() => validateBatch(wrong), /conflicts/);
const inputFile = path.join(directory, 'batch.json'), output = path.join(directory, 'frozen');
await writeFile(inputFile, JSON.stringify(batch));
const fixtureEnv = {...process.env,WORKBENCH_TEST_RUN:batch.id};
delete fixtureEnv.OPENAI_API_KEY;
delete fixtureEnv.MAP_STITCHER_OPENAI_API_URL;
const child = (...args) => execFileSync(process.execPath, ['scripts/image-edit-evaluation.mjs', ...args], { cwd: root, env: fixtureEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000, windowsHide: true });
child('freeze', inputFile, output);
const baselineFile=path.join(output,'baseline.json'),baseline=await json(baselineFile);
for(const file of ['lib/workbench/runtime.mjs','lib/workbench/image-edit-store.mjs','lib/workbench/atomic-snapshot.mjs','features/image-edit/intrinsic-recolor.mjs'])
  equal(typeof baseline.files[file],'string');
const incomplete=structuredClone(baseline);
delete incomplete.files['lib/workbench/image-edit-store.mjs'];
await writeFile(baselineFile,JSON.stringify(incomplete));
rejects(()=>child('mock',output,'color-1'),/Baseline code changed or missing: lib\/workbench\/image-edit-store/);
await writeFile(baselineFile,JSON.stringify(baseline));
child('mock', output, 'color-1,geometry-1');
for (const id of ['color-1', 'geometry-1']) {
  const result = await json(path.join(output, 'cases', id, 'result.json'));
  equal(result.status, 'completed'); equal(result.metrics.changedOutside, 0); equal(result.metrics.alphaChanged, 0); equal(result.paid, false);
}
const wire = await json(path.join(output, 'cases', 'geometry-1', 'submission.json'));
equal(wire.fields.model, batch.service.model); equal(wire.fields.n, '1'); equal(wire.fields.size, '1024x1024');
equal(Object.hasOwn(wire, 'authorization'), false);
const ledgerBefore = await readFile(path.join(output, 'ledger.json'), 'utf8');
child('mock', output, 'color-1,geometry-1');
equal(await readFile(path.join(output, 'ledger.json'), 'utf8'), ledgerBefore);
child('report', output);
equal((await json(path.join(output, 'summary.json'))).paidCalls, 0);
await checkP2cResume(root,directory,batch);
await writeFile(path.join(output, 'cases', 'geometry-1', 'mask.png'), raw);
rejects(() => child('mock', output, 'geometry-2'), /Frozen pixels changed/);
console.log(`P0 evaluation: ${checks} checks passed; all provider calls mocked. Evidence: ${path.relative(root, directory)}`);
