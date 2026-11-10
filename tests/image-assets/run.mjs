import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { findCapability, loadManifest, persistTask, readTask, refreshTask, repositoryRoot, runConnector, validateInput } from '../../lib/workbench/runtime.mjs';
import { getPublicMapGenerationSettings, resolveMapGenerationProvider } from '../../lib/workbench/map-generation-settings.mjs';
import { imageSha256, inspectImageBytes, readImageAssetSource, validateImageAssetDimensions } from '../../lib/workbench/adapters/image-assets-source.mjs';
import { imageUsageEvidence, requestOpenAIImage } from '../../lib/workbench/adapters/openai-image-provider.mjs';

const manifest = await loadManifest();
const capability = findCapability(manifest, 'image-assets');
const previous = Object.fromEntries(['OPENAI_API_KEY', 'MAP_STITCHER_OPENAI_API_URL', 'MAP_STITCHER_OPENAI_GENERATION_API_URL'].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const calls = [];
let mode = 'success', gate;
const rgba = async (width, height, transparent = false) => {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 40; data[i + 1] = 85; data[i + 2] = 105;
    if (transparent && (i / 4) % width < width / 4) data[i + 3] = 0;
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};
const source = await rgba(1024, 1024, true);
const reference = await rgba(32, 32);
const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const artifact = (task, filename) => path.resolve(repositoryRoot, task.outputs.find(file => file.endsWith(`/${filename}`)) ?? 'missing-artifact');
async function finish(task) {
  for (let i = 0; i < 500; i++) {
    const current = (await refreshTask(manifest, task.id)).task;
    if (current.status !== 'running') return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('mock image task did not finish');
}
async function run(input) { return finish((await runConnector(manifest, capability, { operation: 'generate-background', prompt: '森林营地', ...input })).task); }

try {
  process.env.OPENAI_API_KEY = 'test-image-secret';
  process.env.MAP_STITCHER_OPENAI_API_URL = 'http://127.0.0.1:9012/v1/images/edits';
  delete process.env.MAP_STITCHER_OPENAI_GENERATION_API_URL;
  globalThis.fetch = async (url, init) => {
    const fields = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body);
    calls.push({ url, fields, body: init.body, headers: init.headers });
    if (gate) await gate;
    if (mode === 'network-error') throw new Error('test-image-secret /outside/private-key.pem');
    if (mode === 'timeout') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('test-image-secret', 'AbortError')), { once: true }));
    if (mode === 'server-error') return new Response('test-image-secret', { status: 503 });
    if (mode === 'http-error') return new Response(JSON.stringify({ error: { message: 'test-image-secret must never leak' } }), { status: 401 });
    const [width, height] = fields.size.split('x').map(Number);
    let bytes = mode === 'invalid' ? Buffer.from('not a PNG') : await rgba(mode === 'wrong-size' ? width - 16 : width, height, fields.background === 'transparent' && mode !== 'opaque');
    if (mode === 'drift') {
      const pixels = Buffer.alloc(width * height * 4, 190);
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
      pixels[3] = 1;
      bytes = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    }
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }], quality: 'high', usage: { input_tokens: 110, output_tokens: 200, total_tokens: 310, input_tokens_details: { text_tokens: 100, image_tokens: 10, extra: 'test-image-secret' }, unknown: 'test-image-secret' } }, { headers: { 'x-request-id': 'req_test_usage' } });
  };

  assert.equal(capability.connector.providerSource, 'map-stitcher');
  assert.equal(getPublicMapGenerationSettings(capability.connector).providers[0].model, 'gpt-image-2.6-sunburst');
  assert.equal(resolveMapGenerationProvider(capability.connector, 'gpt-image-2.6', 'generate-background').endpoint, 'http://127.0.0.1:9012/v1/images/generations');
  process.env.MAP_STITCHER_OPENAI_GENERATION_API_URL = 'http://127.0.0.1:9012/custom-generations';
  assert.match(resolveMapGenerationProvider(capability.connector, 'gpt-image-2.6', 'generate-prop').endpoint, /custom-generations$/);
  delete process.env.MAP_STITCHER_OPENAI_GENERATION_API_URL;
  assert.deepEqual(validateInput(capability, { operation: 'generate-prop', prompt: '灯笼' }), []);
  assert.deepEqual(validateInput(capability, { operation: 'edit-image', prompt: 'fixture', image: dataUrl(source), preserveAlpha: true }), []);
  for (const invalidAlpha of [{ operation: 'generate-prop', prompt: 'fixture', preserveAlpha: true }, { operation: 'process-image', image: dataUrl(source), preserveAlpha: false }, { operation: 'edit-image', prompt: 'fixture', image: dataUrl(source), preserveAlpha: 'true' }]) assert.ok(validateInput(capability, invalidAlpha).length);
  for (const invalid of [{ prompt: ' ' }, { width: 128, height: 128 }, { width: 1000, height: 1000 }, { width: 1024 }, { references: Array(9).fill('x') }, { image: 'x' }, { apiKey: 'do-not-store' }, { provider: 'qwen' }, { operation: 'edit-image' }])
    assert.ok(validateInput(capability, { operation: 'generate-background', prompt: 'x', ...invalid }).length, JSON.stringify(invalid));
  for (const size of [[3840, 3840], [4096, 1024], [512, 512], [3072, 768]]) assert.throws(() => validateImageAssetDimensions(...size));
  assert.deepEqual(validateImageAssetDimensions(1536, 864), { width: 1536, height: 864, size: '1536x864' });

  let release;
  gate = new Promise(resolve => { release = resolve; });
  const submitted = await runConnector(manifest, capability, { operation: 'generate-prop', prompt: '独立灯笼' });
  assert.equal(submitted.task.status, 'running', 'HTTP caller receives a durable task before the paid request finishes');
  assert.equal((await readTask(manifest, submitted.task.id)).status, 'running');
  const observed = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', 'import {loadManifest,refreshTask} from "./lib/workbench/runtime.mjs"; console.log((await refreshTask(await loadManifest(),process.argv[1])).task.status);', submitted.task.id], { cwd: repositoryRoot, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
  assert.equal(observed, 'running', 'another gateway process must observe the live worker without orphaning or resubmitting');
  release(); gate = null;
  const prop = await finish(submitted.task);
  assert.equal(prop.status, 'completed', prop.error);
  const result = JSON.parse(await readFile(artifact(prop, 'result.json'), 'utf8'));
  assert.equal(result.image, 'image.png');
  assert.equal(result.kind, 'prop');
  assert.equal(result.width, 1024);
  assert.equal(result.hasTransparency, true);
  assert.equal(result.requiresAdoption, true);
  assert.equal(calls.at(-1).fields.model, 'gpt-image-2.6-sunburst');
  assert.equal(calls.at(-1).fields.background, 'transparent');
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:9012/v1/images/generations');
  assert.equal(calls.at(-1).headers.authorization, 'Bearer test-image-secret');
  const bytes = await readFile(artifact(prop, 'image.png'));
  assert.equal(imageSha256(bytes), result.sha256);
  assert.deepEqual(bytes, await readFile(artifact(prop, 'provider-response.png')));
  const metadata = JSON.parse(await readFile(artifact(prop, 'image-metadata.json'), 'utf8'));
  assert.equal(metadata.sourceTaskId, prop.id);
  assert.equal(metadata.inputs.length, 0);
  assert.equal(metadata.preservesSourcePixels, false);
  const usage = JSON.parse(await readFile(artifact(prop, 'provider-usage.json'), 'utf8'));
  assert.equal(result.usageEvidence, 'provider-usage.json');
  assert.deepEqual(usage.usage, { input_tokens: 110, output_tokens: 200, total_tokens: 310, input_tokens_details: { text_tokens: 100, image_tokens: 10 } });
  assert.equal(usage.requestId, 'req_test_usage');
  assert.equal(usage.returnedQuality, 'high');
  assert.equal(usage.billingAmount, null, 'Usage is not an invoice.');
  assert.equal(JSON.stringify(usage).includes('test-image-secret'), false);
  assert.ok(usage.elapsedMs >= 0);
  assert.equal(imageUsageEvidence(undefined), null);
  assert.equal(imageUsageEvidence({ total_tokens: '500', input_tokens: -1, extra: 'secret' }), null);
  assert.deepEqual(imageUsageEvidence({ input_tokens_details: { cached_tokens: 5, cached_tokens_details: { text_tokens: 2, image_tokens: 3, extra: 'secret' } } }), { input_tokens_details: { cached_tokens: 5, cached_tokens_details: { text_tokens: 2, image_tokens: 3 } } });
  assert.equal(JSON.stringify(prop).includes('test-image-secret'), false);

  const beforeEvidenceFailure = calls.length;
  await assert.rejects(requestOpenAIImage(resolveMapGenerationProvider(capability.connector, 'gpt-image-2.6', 'generate-background'), {
    prompt: 'fixture evidence failure', dimensions: { size: '1024x1024' },
    onResponseMetadata: async () => { throw new Error('test-image-secret disk failure'); },
  }), error => error.submissionUnknown === true && !error.message.includes('test-image-secret'));
  assert.equal(calls.length, beforeEvidenceFailure + 1, 'Evidence persistence failure never retries the paid submission.');

  const background = await run({ width: 1536, height: 864, references: [dataUrl(reference)] });
  assert.equal(background.status, 'completed', background.error);
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:9012/v1/images/edits');
  assert.equal(calls.at(-1).body.getAll('image[]').length, 1);
  assert.equal(calls.at(-1).body.has('mask'), false);
  assert.deepEqual(await readFile(artifact(background, 'reference-01.png')), reference);
  const edited = await run({ operation: 'edit-image', kind: 'prop', image: dataUrl(source), references: [dataUrl(reference)], mask: dataUrl(source), width: 1024, height: 1024 });
  assert.equal(edited.status, 'completed', edited.error);
  assert.equal(calls.at(-1).body.getAll('image[]').length, 2);
  assert.equal(calls.at(-1).body.get('mask').type, 'image/png');
  const editedMetadata = JSON.parse(await readFile(artifact(edited, 'image-metadata.json'), 'utf8'));
  assert.deepEqual(editedMetadata.inputs.map(item => item.role), ['source-image', 'reference-01', 'edit-mask']);
  assert.equal(editedMetadata.inputs[0].sha256, imageSha256(source));
  assert.equal(editedMetadata.semantics, 'model-edit-with-local-processing');
  assert.equal(editedMetadata.preservesPixelsOutsideMask, true);
  assert.equal(editedMetadata.processing.preservation.changedOutsideMaskPixels, 0);
  mode = 'drift';
  const driftingEdit = await run({ operation: 'edit-image', kind: 'prop', image: dataUrl(source), mask: dataUrl(source) });
  assert.equal(driftingEdit.status, 'completed', driftingEdit.error);
  const fixedPixels = await sharp(await readFile(artifact(driftingEdit, 'image.png'))).ensureAlpha().raw().toBuffer();
  const sourcePixels = await sharp(source).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < 1024; y++) assert.deepEqual(fixedPixels.subarray((y * 1024 + 256) * 4, (y + 1) * 1024 * 4), sourcePixels.subarray((y * 1024 + 256) * 4, (y + 1) * 1024 * 4), 'Paid-path output repairs all protected rows after a drifting mock response.');
  assert.deepEqual(fixedPixels.subarray(0, 4), Buffer.alloc(4), 'Default prop cleanup also applies within the edited region.');
  const driftingResult = JSON.parse(await readFile(artifact(driftingEdit, 'result.json')));
  assert.notEqual(driftingResult.sha256, driftingResult.rawSha256);
  assert.equal(imageSha256(await readFile(artifact(driftingEdit, 'provider-response.png'))), driftingResult.rawSha256);
  const beforeWrongDimensions = calls.length;
  const mismatchedMaskEdit = await run({ operation: 'edit-image', kind: 'prop', image: dataUrl(source), mask: dataUrl(source), width: 1536, height: 1024 });
  assert.equal(mismatchedMaskEdit.status, 'failed');
  assert.equal(calls.length, beforeWrongDimensions, 'Requested resizing under a mask is rejected before any provider call.');
  const resizedAlpha = await run({ operation: 'edit-image', kind: 'prop', image: dataUrl(source), preserveAlpha: true, width: 1536, height: 1024 });
  assert.equal(resizedAlpha.status, 'failed');
  assert.equal(calls.length, beforeWrongDimensions, 'Unmasked alpha-preserving resize is also rejected before submission.');
  const keptAlpha = await run({ operation: 'edit-image', kind: 'prop', image: dataUrl(source), preserveAlpha: true });
  assert.equal(keptAlpha.status, 'completed', keptAlpha.error);
  const keptPixels = await sharp(await readFile(artifact(keptAlpha, 'image.png'))).ensureAlpha().raw().toBuffer();
  assert.deepEqual(keptPixels.filter((_, i) => i % 4 === 3), sourcePixels.filter((_, i) => i % 4 === 3));
  assert.deepEqual([...keptPixels.subarray(0, 4)], [190, 190, 190, 0], 'Original transparent pixels retain candidate RGB without becoming visible.');
  const keptMetadata = JSON.parse(await readFile(artifact(keptAlpha, 'image-metadata.json'), 'utf8'));
  assert.equal(keptMetadata.processing.alphaPreservation.changedAlphaPixels, 0);
  assert.equal(keptMetadata.processing.alphaCleanup.threshold, 0);
  mode = 'success';

  const map = findCapability(manifest, 'map-stitcher');
  const expanded = (await runConnector(manifest, map, {
    operation: 'generate-layer', provider: 'gpt-image-2.6', image: dataUrl(source), prompt: 'extend forest',
    tile: { key: '1,0' }, layer: 'overall', mask_mode: 'white',
  })).task;
  assert.equal(expanded.status, 'completed', expanded.error);
  assert.equal(calls.at(-1).fields.model, 'gpt-image-2.6-sunburst');
  const maskBytes = Buffer.from(await calls.at(-1).body.get('mask').arrayBuffer());
  assert.equal((await inspectImageBytes(maskBytes)).hasFullyTransparentPixels, true);
  const composite = await sharp(await readFile(artifact(expanded, 'generated-layer.png'))).raw().toBuffer();
  const original = await sharp(source).raw().toBuffer();
  for (let offset = 0; offset < original.length; offset += 4) {
    if (original[offset + 3] > 0) assert.ok(original.subarray(offset, offset + 4).equals(composite.subarray(offset, offset + 4)));
  }

  for (const input of [
    { references: ['https://example.test/image.png'] },
    { references: ['../outside.png'] },
    { references: ['data:image/png;base64,aGVsbG8='] },
    { operation: 'edit-image', image: dataUrl(source), mask: dataUrl(reference) },
    { operation: 'edit-image', image: dataUrl(source), mask: dataUrl(await rgba(1024, 1024)) },
  ]) {
    const count = calls.length;
    const task = await run(input);
    assert.equal(task.status, 'failed', `${mode}: ${task.error}`);
    assert.equal(calls.length, count, 'invalid sources must not create a paid request');
  }
  await assert.rejects(readImageAssetSource('data:image/jpeg;base64,' + source.toString('base64'), repositoryRoot), /MIME/);
  await assert.rejects(inspectImageBytes(await rgba(32, 32), { transparency: true }), /透明物件/);
  const localSourcePath = artifact(prop, 'image.png');
  assert.equal((await readImageAssetSource(localSourcePath, repositoryRoot)).sha256, result.sha256);
  for (const failure of ['http-error', 'invalid', 'wrong-size', 'opaque']) {
    mode = failure;
    const count = calls.length;
    const task = await run({ operation: 'generate-prop' });
    assert.equal(task.status, 'failed', `${failure}: ${task.error}`);
    assert.equal(task.outputs.some(file => file.endsWith('/image.png')), false);
    assert.equal(calls.length, count + 1);
    await refreshTask(manifest, task.id);
    assert.equal(calls.length, count + 1, 'polling must not resubmit failed paid requests');
    assert.equal(JSON.stringify(task).includes('test-image-secret'), false);
    if (failure !== 'http-error') assert.ok(task.outputs.some(file => file.endsWith('/provider-response.png')));
    const failedUsage = JSON.parse(await readFile(artifact(task, 'provider-usage.json'), 'utf8'));
    assert.equal(failedUsage.httpStatus, failure === 'http-error' ? 401 : 200);
    assert.equal(failedUsage.usage === null, failure === 'http-error', 'Successful paid response usage survives output validation failures.');
  }
  for (const uncertain of ['network-error', 'server-error', 'timeout']) {
    mode = uncertain;
    if (mode === 'timeout') globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 240_000 ? 1 : delay, ...args);
    const count = calls.length;
    const task = await run({ operation: 'generate-prop' });
    globalThis.setTimeout = originalSetTimeout;
    assert.equal(task.status, 'attention_required', uncertain);
    assert.equal(task.outputs.some(file => file.endsWith('/image.png')), false);
    assert.equal(JSON.stringify(task).includes('test-image-secret'), false);
    assert.equal(JSON.stringify(task).includes('/outside/private-key.pem'), false);
    await refreshTask(manifest, task.id);
    assert.equal(calls.length, count + 1, 'unknown submission must never automatically resubmit');
    const diagnostics = JSON.parse(await readFile(artifact(task, 'generation-diagnostics.json'), 'utf8'));
    assert.equal(diagnostics.submissionUnknown, true);
    assert.equal(JSON.parse(await readFile(artifact(task, 'provider-usage.json'), 'utf8')).usage, null, 'Unknown usage stays unknown.');
  }
  mode = 'success';
  const interrupted = { ...submitted.task, id: submitted.task.id + '-restart', status: 'running', outputs: [] };
  await persistTask(manifest, interrupted);
  const beforeRecovery = calls.length;
  assert.equal((await refreshTask(manifest, interrupted.id)).task.status, 'attention_required');
  assert.equal((await readTask(manifest, interrupted.id)).status, 'running', 'Orphan diagnostics must not overwrite a concurrent worker snapshot.');
  await persistTask(manifest, { ...interrupted, status: 'completed', outputs: prop.outputs });
  assert.equal((await refreshTask(manifest, interrupted.id)).task.status, 'completed', 'A late completion must take precedence over prior orphan observations.');
  assert.equal(calls.length, beforeRecovery);
  for (const fault of ['stale-heartbeat', 'wrong-token', 'expired']) {
    const orphan = { ...submitted.task, id: submitted.task.id + '-' + fault, status: 'running', outputs: [], adapter: { ...submitted.task.adapter, backgroundPid: process.ppid, backgroundExpiresAt: fault === 'expired' ? Date.now() - 1 : Date.now() + 600_000 } };
    const directory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory, orphan.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '.background-lease.json'), JSON.stringify({ pid: process.ppid, token: fault === 'wrong-token' ? 'wrong-token' : orphan.adapter.backgroundToken, heartbeatAt: fault === 'stale-heartbeat' ? Date.now() - 21_000 : Date.now() }));
    await persistTask(manifest, orphan);
    assert.equal((await refreshTask(manifest, orphan.id)).task.status, 'attention_required', fault);
  }
  delete process.env.OPENAI_API_KEY;
  const missing = await run({});
  assert.equal(missing.status, 'awaiting_configuration');
  assert.equal(calls.length, beforeRecovery);
  console.log('image-assets: passed (mock provider only; isolated runtime data)');
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
