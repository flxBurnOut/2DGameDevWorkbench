import { readFile, writeFile, mkdir, copyFile, open, unlink, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ts from 'typescript';
import { sha, json, save, decode, encode, localFile, validateBatch, writableMask, providerMask, measure, reserve, usageCost, evidenceState } from './image-edit-evaluation/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, argument, destination] = process.argv.slice(2);
async function* baselineSources() {
  const files = new Set(['package.json', 'package-lock.json', 'workbench/manifest.json', 'scripts/image-edit-evaluation.mjs']);
  for (const file of files) {
    const bytes = await readFile(await localFile(root, file));
    yield {file, bytes};
    if (!/\.[cm]?js$/.test(file)) continue;
    // Includes re-exports and literal dynamic imports used by the runner and Bridge.
    for (const { fileName } of ts.preProcessFile(bytes.toString('utf8'), true, true).importedFiles) {
      if (fileName.startsWith('.')) files.add(path.posix.join(path.posix.dirname(file), fileName));
    }
  }
}
const exists = async file => access(file).then(() => true, () => false);
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function safeOutput(directory) {
  const resolved = path.resolve(root, directory), relative = path.relative(path.join(root, 'work'), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evaluation outputs must be in a new work/ subdirectory.');
  return resolved;
}

async function freeze() {
  const batch = validateBatch(await json(await localFile(root, argument))), out = safeOutput(destination);
  if (await exists(out)) throw new Error('Freeze requires a new directory.');
  await mkdir(out, { recursive: true });
  const fileHashes = {};
  for await (const {file, bytes} of baselineSources()) {
    fileHashes[file] = sha(bytes);
    await mkdir(path.dirname(path.join(out, 'baseline', file)), { recursive: true });
    await writeFile(path.join(out, 'baseline', file), bytes, { flag: 'wx' });
  }
  const { loadManifest, findCapability } = await import('../lib/workbench/runtime.mjs');
  const { getPublicMapGenerationSettings } = await import('../lib/workbench/map-generation-settings.mjs');
  const service = getPublicMapGenerationSettings(findCapability(await loadManifest(), 'image-assets').connector);
  const baseline = { schemaVersion: 1, createdAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files: fileHashes, service, quality: 'auto (quality field omitted)', seed: null, environment: { node: process.version, sharp: sharp.versions, platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() }, batchSha256: sha(JSON.stringify(batch)), formalHoldout: 'Every source family and derivative in this batch is excluded from formal evaluation.' };
  for (const c of batch.cases) {
    const dir = path.join(out, 'cases', c.id); await mkdir(dir, { recursive: true });
    const bytes = await readFile(await localFile(root, c.source));
    const { data, info: { width, height } } = await decode(bytes);
    const mask = writableMask(data, width, height, c.annotation), png = await providerMask(mask.writable, width, height);
    await writeFile(path.join(dir, 'source.png'), bytes, { flag: 'wx' });
    await writeFile(path.join(dir, 'mask.png'), png, { flag: 'wx' });
    const overlay = Buffer.from(data);
    for (let i = 0; i < mask.writable.length; i++) if (mask.writable[i]) { overlay[i * 4] = Math.round(overlay[i * 4] * .55); overlay[i * 4 + 1] = Math.round(overlay[i * 4 + 1] * .55 + 110); overlay[i * 4 + 2] = Math.round(overlay[i * 4 + 2] * .55 + 90); overlay[i * 4 + 3] = Math.max(overlay[i * 4 + 3], 150); }
    await writeFile(path.join(dir, 'selection.png'), await encode(overlay, width, height), { flag: 'wx' });
    await save(path.join(dir, 'frozen.json'), { ...c, width, height, sourceSha256: sha(bytes), sourceRgbaSha256: sha(data), maskSha256: sha(png), region: mask.spec, selectedPixels: mask.writable.reduce((a, b) => a + b, 0) });
  }
  await save(path.join(out, 'batch.json'), batch); await save(path.join(out, 'baseline.json'), baseline);
  await save(path.join(out, 'ledger.json'), { schemaVersion: 1, currency: 'USD', maxUsd: batch.budget.maxUsd, entries: [], billedAmount: null });
  console.log(JSON.stringify({ frozen: out, cases: batch.cases.length, families: new Set(batch.cases.map(c => c.family)).size, baseline: baseline.commit }));
}

async function verifyFrozen(out, batch, checkCode = true) {
  const baseline = await json(path.join(out, 'baseline.json'));
  if (sha(JSON.stringify(batch)) !== baseline.batchSha256) throw new Error('Frozen batch was modified.');
  if (checkCode) for await (const {file, bytes} of baselineSources()) {
    if (sha(bytes) !== baseline.files[file]) throw new Error(`Baseline code changed or missing: ${file}. Freeze a separate batch.`);
  }
  for (const c of batch.cases) {
    const dir = path.join(out, 'cases', c.id), frozen = await json(path.join(dir, 'frozen.json'));
    for (const [file, hash] of [['source.png', frozen.sourceSha256], ['mask.png', frozen.maskSha256]]) if (sha(await readFile(path.join(dir, file))) !== hash) throw new Error(`Frozen pixels changed: ${c.id}/${file}`);
    const { data, info } = await decode(await readFile(path.join(dir, 'source.png')));
    const expected = writableMask(data, info.width, info.height, c.annotation);
    if (JSON.stringify(expected.spec) !== JSON.stringify(frozen.region) || sha(await providerMask(expected.writable, info.width, info.height)) !== frozen.maskSha256) throw new Error(`Frozen annotation changed: ${c.id}`);
  }
}

async function run() {
  const out = safeOutput(argument), batch = validateBatch(await json(path.join(out, 'batch.json')));
  if ((command === 'mock') !== (batch.execution === 'fixture')) throw new Error('Real and fixture runs must use separately frozen batches.');
  await verifyFrozen(out, batch);
  // Read the configured credential before switching to isolated task/document storage.
  // Keep it only in this process; never copy the protected settings file into a batch.
  const { loadManifest, readTask, findCapability } = await import('../lib/workbench/runtime.mjs');
  if (batch.execution === 'fixture') {
    process.env.OPENAI_API_KEY = 'p0-fixture-only';
    process.env.MAP_STITCHER_OPENAI_API_URL = batch.service.endpoint;
  } else if (batch.cases.some(c => c.operation.type === 'ai-edit')) {
    const { resolveMapGenerationProvider } = await import('../lib/workbench/map-generation-settings.mjs');
    const configured = resolveMapGenerationProvider(findCapability(await loadManifest(), 'image-assets').connector, 'gpt-image-2.5', 'edit-image');
    if (!configured?.apiKey) throw new Error('Image provider is not configured; no task or reservation created.');
    if (configured.endpoint !== batch.service.endpoint || configured.model !== batch.service.model) throw new Error('Provider differs from the frozen service.');
    process.env.OPENAI_API_KEY = configured.apiKey;
  }
  const lock = await open(path.join(out, 'runner.lock'), 'wx');
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    process.env.WORKBENCH_TEST_RUN = `p0-${batch.id}`;
    const { imageEditRequest } = await import('../lib/workbench/image-edits.mjs');
    const { createDocument } = await import('../lib/workbench/editor-documents.mjs');
    const { createProject, createObject } = await import('../features/interactable-editor/contract.mjs');
    const manifest = await loadManifest();
    for (const key of ['taskDirectory', 'documentDirectory', 'imageEditDirectory', 'outputDirectory']) if (!manifest.workspace[key].includes(`/test-runs/${process.env.WORKBENCH_TEST_RUN}/`) && !manifest.workspace[key].endsWith(`/test-runs/${process.env.WORKBENCH_TEST_RUN}`)) throw new Error(`Not isolated: ${key}`);
    const request = (op, input) => imageEditRequest(root, manifest, op, input);
    const ledger = await json(path.join(out, 'ledger.json'));
    const filter = destination ? new Set(destination.split(',')) : null;
    for (const c of batch.cases) {
      if (filter && !filter.has(c.id)) continue;
      const dir = path.join(out, 'cases', c.id);
      if (await exists(path.join(dir, 'result.json'))) continue;
      if (await exists(path.join(dir, 'intent.json'))) throw new Error(`Recover original intent for ${c.id}; not resubmitting.`);
      const frozen = await json(path.join(dir, 'frozen.json')), png = await readFile(path.join(dir, 'source.png'));
      const project = createProject(); project.name = `P0 ${c.id}`;
      const object = createObject('inspect'); object.definitionId = 'sample'; object.visual.assetId = 'source'; object.visual.width = Math.min(frozen.width, 1024); object.visual.height = Math.min(frozen.height, 1024);
      project.objects = [object]; project.assets = [{ id: 'source', name: 'source.png', mime: 'image/png', source: `data:image/png;base64,${png.toString('base64')}` }];
      const { document } = await createDocument(root, manifest, { kind: 'interactable', documentId: project.projectId, commandId: `create-${c.id}`, content: project });
      const target = (await request('image-inspect', { target: { kind: 'interactable', documentId: document.id, definitionId: 'sample', slot: 'visual' } })).target;
      const guard = { targetId: target.targetId, expectedRevision: target.revision, expectedSha256: target.sha256 };
      const region = await request('image-resolve', { ...guard, region: frozen.region });
      const input = { ...guard, regionRef: region.regionRef, operation: c.operation, constraints: { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: c.preserveAlpha }, commandId: `p0-${batch.id}-${c.id}`, name: `P0 ${c.id}` };
      const paid = c.operation.type === 'ai-edit';
      let reservation;
      if (paid) {
        try { reservation = reserve(ledger, c.id, batch.budget); }
        catch (error) { console.log(JSON.stringify({ stopped: c.id, reason: error.message })); break; }
        await save(path.join(out, 'ledger.json'), ledger, false);
      }
      await save(path.join(dir, 'intent.json'), { input, documentId: document.id, sourceSha256: frozen.sourceSha256, createdAt: new Date().toISOString() });
      const originalFetch = globalThis.fetch;
      let captured = false;
      globalThis.fetch = async (url, options) => {
        if (!paid || captured || typeof url !== 'string' || url !== batch.service.endpoint || !(options?.body instanceof FormData)) throw new Error('Unexpected network request in P0.');
        const form = options.body;
        if (form.get('model') !== batch.service.model || form.get('n') !== '1' || form.get('quality') !== null) throw new Error('Frozen provider settings changed.');
        const fields = Object.fromEntries(['model', 'prompt', 'n', 'size', 'output_format', 'background'].map(key => [key, form.get(key)]));
        const images = [];
        for (const [i, blob] of form.getAll('image[]').entries()) {
          const bytes = Buffer.from(await blob.arrayBuffer()), name = `submitted-image-${i}.png`;
          await writeFile(path.join(dir, name), bytes, { flag: 'wx' }); images.push({ file: name, sha256: sha(bytes) });
        }
        const mask = Buffer.from(await form.get('mask').arrayBuffer());
        if (images[0]?.sha256 !== frozen.sourceSha256 || sha((await decode(mask)).data) !== sha((await decode(await readFile(path.join(dir, 'mask.png')))).data)) throw new Error('Submitted source/mask differs from frozen annotation.');
        await writeFile(path.join(dir, 'submitted-mask.png'), mask, { flag: 'wx' });
        await save(path.join(dir, 'submission.json'), { fields, images, mask: { file: 'submitted-mask.png', sha256: sha(mask) }, endpointOrigin: new URL(url).origin, capturedAt: new Date().toISOString() });
        captured = true;
        if (batch.execution === 'fixture') {
          const raw = await sharp({ create: { width: frozen.width, height: frozen.height, channels: 4, background: { r: 91, g: 142, b: 209, alpha: 0.5 } } }).png().toBuffer();
          return Response.json({ data: [{ b64_json: raw.toString('base64') }], quality: 'medium', usage: { input_tokens: 1034, output_tokens: 100, input_tokens_details: { text_tokens: 10, image_tokens: 1024 }, output_tokens_details: { text_tokens: 0, image_tokens: 100 } } }, { headers: { 'x-request-id': 'p0_mock_only' } });
        }
        return originalFetch(url, options);
      };
      try {
        const receipt = await request('image-edit', input);
        await save(path.join(dir, 'receipt.json'), receipt);
        let edit, candidate;
        const deadline = Date.now() + 300_000;
        do {
          ({ edit } = await request('image-session-get', { editId: receipt.edit.editId }));
          candidate = edit.candidates.find(x => x.version === receipt.candidateVersion);
          if (!['running', 'preparing'].includes(candidate.status)) break;
          if (Date.now() > deadline) throw new Error('Original task remains pending; recover without resubmission.');
          await new Promise(resolve => setTimeout(resolve, 500));
        } while (['running', 'preparing'].includes(candidate.status));
        const task = candidate.taskId ? await readTask(manifest, candidate.taskId) : null;
        if (task) {
          const output = path.resolve(root, manifest.workspace.outputDirectory, task.id);
          for (const name of ['provider-response.png', 'provider-usage.json', 'generation-diagnostics.json', 'image-metadata.json', 'processing-report.json', 'image.png']) if (await exists(path.join(output, name))) await copyFile(path.join(output, name), path.join(dir, name));
        }
        if (candidate.status === 'completed' && !await exists(path.join(dir, 'image.png'))) {
          const pixels = (await request('image-session-get', { editId: edit.editId, candidateVersion: candidate.version, includePixels: true })).edit.pixels;
          await writeFile(path.join(dir, 'image.png'), await encode(Buffer.from(pixels.rgbaBase64, 'base64'), frozen.width, frozen.height), { flag: 'wx' });
        }
        if (!paid) await save(path.join(dir, 'submission.json'), { executor: 'local', operation: c.operation, sourceSha256: frozen.sourceSha256, maskSha256: frozen.maskSha256, input });
        if (paid) {
          const usage = await exists(path.join(dir, 'provider-usage.json')) ? await json(path.join(dir, 'provider-usage.json')) : null;
          reservation.costUsd = usageCost(usage?.usage, batch.pricing.perMillion);
          reservation.status = reservation.costUsd === null ? 'unknown' : 'accounted';
          reservation.dispatched = captured;
          if (!captured && candidate.status === 'awaiting_configuration') { reservation.status = 'not_submitted'; reservation.costUsd = 0; }
          reservation.requestId = usage?.requestId ?? null; reservation.taskId = candidate.taskId; reservation.returnedQuality = usage?.returnedQuality ?? null;
          await save(path.join(out, 'ledger.json'), ledger, false);
        }
        const metrics = await exists(path.join(dir, 'image.png')) ? await measure(png, await readFile(path.join(dir, 'mask.png')), await readFile(path.join(dir, 'image.png'))) : null;
        await save(path.join(dir, 'result.json'), { execution: batch.execution, status: candidate.status, taskId: candidate.taskId, editId: edit.editId, candidateVersion: candidate.version, paid: paid && batch.execution === 'real', metrics, adopted: false, finishedAt: new Date().toISOString() });
        console.log(JSON.stringify({ case: c.id, status: candidate.status, changedOutside: metrics?.changedOutside, alphaChanged: metrics?.alphaChanged, costUsd: paid ? reservation.costUsd : 0 }));
        if (paid && reservation.status === 'unknown') break;
      } finally { globalThis.fetch = originalFetch; }
    }
  } finally { await lock.close(); await unlink(path.join(out, 'runner.lock')); }
}

async function report() {
  const out = safeOutput(argument), batch = validateBatch(await json(path.join(out, 'batch.json')));
  await verifyFrozen(out, batch, false);
  const results = [], articles = [];
  for (const c of batch.cases) {
    const dir = path.join(out, 'cases', c.id), base = `cases/${c.id}/`, frozen = await json(path.join(dir, 'frozen.json'));
    const result = await exists(path.join(dir, 'result.json')) ? await json(path.join(dir, 'result.json')) : { status: 'not-run' };
    const hasFinal = await exists(path.join(dir, 'image.png')), hasRaw = await exists(path.join(dir, 'provider-response.png'));
    const review = await exists(path.join(dir, 'review.json')) ? await json(path.join(dir, 'review.json')) : null;
    const rawMetrics = hasRaw ? await measure(await readFile(path.join(dir, 'source.png')), await readFile(path.join(dir, 'mask.png')), await readFile(path.join(dir, 'provider-response.png'))) : null;
    const evidence = evidenceState({ submission: await exists(path.join(dir, 'submission.json')), raw: hasRaw || c.operation.type !== 'ai-edit', final: hasFinal, review: Boolean(review?.reviewer && review?.verdict && review?.independent === true) });
    results.push({ id: c.id, category: c.category, family: c.family, style: c.style, ...result, rawMetrics, evidence, review });
    const bounds = c.crop ?? c.annotation.allowed;
    if (hasFinal && bounds.type === 'rectangle') for (const file of ['source', 'image']) await sharp(path.join(dir, `${file}.png`)).extract({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }).resize({ width: Math.min(bounds.width * 3, 700), kernel: c.style === 'pixel' ? 'nearest' : 'lanczos3' }).png().toFile(path.join(dir, `${file}-crop.png`));
    articles.push(`<article id="${c.id}"><h2>${escape(c.id)} · ${escape(c.category)}</h2><p>${escape(c.instruction)}</p><p>Keep: ${escape(c.keep)}<br>Annotation: ${c.annotationStatus}; source ${frozen.width}×${frozen.height}; W=${frozen.selectedPixels} pixels; ${escape(result.status)}</p><div class="row">${['source', 'selection', ...(hasRaw ? ['provider-response'] : []), ...(hasFinal ? ['image'] : [])].map(file => `<figure><a href="${base}${file}.png"><img src="${base}${file}.png" style="width:${Math.min(c.displayWidth, 400)}px;image-rendering:${c.style === 'pixel' ? 'pixelated' : 'auto'}"></a><figcaption>${file}</figcaption></figure>`).join('')}</div>${hasFinal && bounds.type === 'rectangle' ? `<div class="row"><img class="crop" src="${base}source-crop.png"><img class="crop" src="${base}image-crop.png"></div>` : ''}<p>${escape(JSON.stringify(result.metrics ?? {}))}</p><p>Review: ${escape(review ? JSON.stringify(review) : 'pending; not a human acceptance score')}</p></article>`);
  }
  const ledger = await json(path.join(out, 'ledger.json'));
  const summary = { schemaVersion: 1, execution: batch.execution, createdAt: new Date().toISOString(), cases: results, completed: results.filter(r => r.status === 'completed').length, families: new Set(batch.cases.map(c => c.family)).size, paidCalls: batch.execution === 'real' ? ledger.entries.filter(e => e.dispatched).length : 0, measuredCostUsd: batch.execution === 'real' ? ledger.entries.reduce((n, e) => n + (e.costUsd ?? 0), 0) : 0, unresolvedReservationsUsd: ledger.entries.filter(e => e.costUsd === null).reduce((n, e) => n + e.reservedUsd, 0), invoiceAmount: null, humanBlindReview: 'pending', successRate: null };
  await save(path.join(out, 'summary.json'), summary, false);
  await writeFile(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Forge P0 diagnostics</title><style>body{font:16px system-ui;margin:32px;background:#eee;color:#222}article{background:white;padding:20px;margin:24px 0}figure{margin:8px}.row{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}img{background:repeating-conic-gradient(#ccc 0% 25%,#eee 0% 50%) 0/16px 16px}.crop{max-width:46%;height:auto}p{overflow-wrap:anywhere}a{color:#265}</style><h1>Forge P0 · ${escape(batch.id)}</h1><p>Diagnostic development set, ${summary.completed}/24 completed; ${summary.families} source families. Cost by usage: USD ${summary.measuredCostUsd.toFixed(6)}. Not an independent human benchmark.</p>${articles.join('\n')}`);
  console.log(JSON.stringify({ completed: summary.completed, paidCalls: summary.paidCalls, measuredCostUsd: summary.measuredCostUsd, report: path.join(out, 'index.html') }));
}

if (command === 'freeze' && argument && destination) await freeze();
else if (['run', 'mock'].includes(command) && argument) await run();
else if (command === 'report' && argument) await report();
else { console.error('Usage: node scripts/image-edit-evaluation.mjs freeze <batch.json> <new-work-dir> | run <work-dir> [case,case] | report <work-dir>'); process.exitCode = 1; }
