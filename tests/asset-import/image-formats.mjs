import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createServer } from 'vite';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { inspectAssetPackage, commitAssetPackages } from '../../lib/workbench/asset-packages.mjs';
import { listImportedAssets, resolveImportedAssetFile } from '../../lib/workbench/asset-packages-store.mjs';
import { buildAssetArchive, buildAssetImport, getAsset, listAssets, readAssetPreview } from '../../lib/workbench/asset-catalog.mjs';
import { importPurposes, importPurposeIssue, imageMimeFromHeader } from '../../lib/workbench/asset-import-contract.mjs';

const manifest = await loadManifest();
const namespace = path.join(repositoryRoot, 'work/test-runs', process.env.WORKBENCH_TEST_RUN);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const formats = [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif']];
const originals = new Map();
for (const [extension, mime] of formats) {
  const image = sharp({ create: { width: 4, height: 4, channels: 4, background: '#24b787' } });
  const bytes = await image.toFormat(extension === 'jpg' ? 'jpeg' : extension).toBuffer();
  assert.equal(imageMimeFromHeader(bytes.subarray(0, 16)), mime);
  originals.set(extension, bytes);
}
const originalFetch = globalThis.fetch, originalReader = globalThis.FileReader;
const originalPipelineUrl = process.env.SPRITE_PIPELINE_API_URL;
process.env.SPRITE_PIPELINE_API_URL = 'http://image-import-fixture.test';
const native = [];
let importCalls = 0, nativeDetails = 0, nativeFiles = 0;
const nativeRows = new Map();
globalThis.fetch = async (input, options = {}) => {
  const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(address, 'http://browser-fixture.test');
  if (url.pathname === '/api/workbench/assets') return Response.json(await getAsset(manifest, { assetId: url.searchParams.get('assetId') }));
  if (url.pathname === '/api/workbench/assets/import') {
    importCalls++;
    try { return new Response((await buildAssetImport(manifest, JSON.parse(options.body))).bytes); }
    catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  }
  if (url.pathname === '/v1/artworks') return Response.json({ data: { assets: native, issues: [] } });
  if (url.pathname === '/v1/artworks/file') {
    nativeFiles++;
    const fixture = nativeRows.get(url.searchParams.get('asset_id'));
    return new Response(fixture[url.searchParams.get('key')]);
  }
  if (url.pathname.startsWith('/v1/artworks/')) {
    nativeDetails++;
    return Response.json({ data: { asset: nativeRows.get(decodeURIComponent(url.pathname.slice('/v1/artworks/'.length))).detail } });
  }
  throw new Error('Unexpected fixture request: ' + url.href);
};
globalThis.FileReader = class {
  readAsDataURL(blob) {
    void blob.arrayBuffer().then((bytes) => {
      this.result = 'data:' + blob.type + ';base64,' + Buffer.from(bytes).toString('base64');
      this.onload();
    });
  }
};
let server;
try {
  const zip = new JSZip(), entries = [];
  for (const [extension, mime] of formats) {
    const bytes = originals.get(extension), name = `prop/${extension}/original.${extension}`;
    const preview = `prop/${extension}/preview.${extension === 'gif' ? 'png' : 'gif'}`;
    const previewBytes = originals.get(extension === 'gif' ? 'png' : 'gif');
    zip.file(name, bytes); zip.file(preview, previewBytes);
    entries.push({ key: extension, kind: 'prop', title: extension, files: [
      { path: name, role: 'image', mime, bytes: bytes.length, sha256: sha(bytes) },
      { path: preview, role: 'preview', mime: extension === 'gif' ? 'image/png' : 'image/gif', bytes: previewBytes.length, sha256: sha(previewBytes) },
    ] });
  }
  zip.file('forge-assets.json', JSON.stringify({ format: 'forge-asset-archive', version: 1, packageId: 'image-format-fixture', exportedAt: new Date().toISOString(), entries }));
  const inspected = await inspectAssetPackage(repositoryRoot, manifest, { bytes: await zip.generateAsync({ type: 'nodebuffer' }), filename: 'image-formats.zip' });
  assert.ok(inspected.candidates.every((candidate) => candidate.status === 'material'));
  const committed = await commitAssetPackages(repositoryRoot, manifest, { commandId: 'image-format-fixture', selections: inspected.candidates.map((candidate) => ({ inspectionId: inspected.inspectionId, candidateId: candidate.id })) });
  assert.equal(committed.importedCount, 4);
  server = await createServer({ root: repositoryRoot, configFile: false, appType: 'custom', logLevel: 'error', cacheDir: path.join(namespace, 'vite-cache'), resolve: { alias: { '@': repositoryRoot } }, optimizeDeps: { noDiscovery: true, entries: [] }, server: { middlewareMode: true, watch: null, hmr: { server: createHttpServer() } } });
  const browser = await server.ssrLoadModule('/lib/workbench/asset-import.ts');
  const { importAsset } = await server.ssrLoadModule('/features/interactable-editor/browser-storage.ts');
  const records = await listImportedAssets(repositoryRoot, manifest);
  const ids = new Map(records.map((record) => [record.label, record.id]));
  for (const [extension, mime] of formats) {
    const id = ids.get(extension), { asset } = await getAsset(manifest, { assetId: id });
    assert.equal(asset.primaryMime, mime, 'The primary source, not its different-format preview, supplies MIME');
    assert.deepEqual(browser.purposesFor(asset, ['image']).map((rule) => rule.id), importPurposes(manifest, asset).map((rule) => rule.id));
    const preview = await readAssetPreview(manifest, id);
    assert.ok(preview.bytes.length > 0, 'All four formats keep asset-library previews');
    assert.deepEqual(preview.bytes, originals.get(extension));
    if (extension === 'gif') {
      const reason = importPurposeIssue(asset, 'image');
      assert.match(reason, /GIF.*PNG、JPG、WebP/);
      assert.ok(asset.readiness.issues.includes(reason));
      assert.equal(asset.editorPath, undefined, 'Imported GIF has no unusable editor link');
      await assert.rejects(buildAssetImport(manifest, { assetId: id, revision: asset.revision, purpose: 'image' }), (error) => error.message === reason);
      const before = importCalls;
      await assert.rejects(browser.loadLibraryAsset(id, 'image'), (error) => error.message === reason);
      assert.equal(importCalls, before, 'The browser rejects GIF before requesting an import bundle');
    } else {
      const bundle = await browser.loadLibraryAsset(id, 'image');
      assert.equal(bundle.files[0].file.type, mime);
      assert.deepEqual(Buffer.from(await bundle.files[0].file.arrayBuffer()), originals.get(extension));
      const editable = await importAsset(bundle.files[0].file);
      assert.equal(editable.mime, mime);
      assert.deepEqual(Buffer.from(editable.source.split(',')[1], 'base64'), originals.get(extension));
    }
  }
  const eligible = await listAssets(manifest, { purposes: 'image', limit: 2 });
  assert.equal(eligible.total, 3, 'Unsupported GIF is excluded before pagination');
  const next = await listAssets(manifest, { purposes: 'image', offset: 2, limit: 2, snapshot: eligible.snapshot });
  assert.equal(next.assets.length, 1);
  assert.ok([...eligible.assets, ...next.assets].every((asset) => asset.id !== ids.get('gif')));
  assert.equal((await listAssets(manifest, {})).total, 4, 'GIF remains in the full library');
  const download = await JSZip.loadAsync((await buildAssetArchive(manifest, { assetIds: [...ids.values()] })).bytes);
  const downloaded = JSON.parse(await download.file('forge-assets.json').async('string'));
  for (const entry of downloaded.entries) {
    const primary = entry.files.find((file) => file.role === 'image');
    assert.deepEqual(await download.file(primary.path).async('nodebuffer'), originals.get(entry.title));
  }
  for (const record of records) for (const file of record.files)
    assert.equal(sha(await readFile(await resolveImportedAssetFile(repositoryRoot, record, file.path, manifest))), file.sha256);

  for (const [format, extension] of [['gif', 'png'], ['png', 'gif']]) {
    const bytes = originals.get(format);
    const inspection = await inspectAssetPackage(repositoryRoot, manifest, { bytes, filename: 'misnamed.' + extension });
    const receipt = await commitAssetPackages(repositoryRoot, manifest, { commandId: 'misnamed-' + format, selections: [{ inspectionId: inspection.inspectionId, candidateId: inspection.candidates[0].id }] });
    const { asset } = await getAsset(manifest, { assetId: receipt.assets[0].id });
    assert.equal(asset.primaryMime, 'image/' + format, 'Image headers, not declared MIME or filename extensions, determine eligibility');
    if (format === 'gif') await assert.rejects(buildAssetImport(manifest, { assetId: asset.id, revision: asset.revision, purpose: 'image' }), /GIF.*PNG、JPG、WebP/);
    else {
      const bundle = await browser.loadLibraryAsset(asset.id, 'image');
      assert.equal(bundle.files[0].file.type, 'image/png');
      assert.deepEqual(Buffer.from(await bundle.files[0].file.arrayBuffer()), bytes, 'No image conversion is applied');
      assert.equal((await importAsset(bundle.files[0].file)).mime, 'image/png');
    }
  }

  // A native list supplies lightweight source MIME; filtering never asks for N details.
  for (const [extension, mime] of [['png', 'image/png'], ['gif', 'image/gif']]) {
    const id = 'character:native_' + extension, source = originals.get(extension), preview = originals.get(extension === 'gif' ? 'png' : 'gif');
    const row = { id, kind: 'character', title: id, availability: 'available', primaryMime: mime, previewKind: extension === 'gif' ? 'image' : 'animation', hasArtwork: true };
    native.push(row);
    nativeRows.set(id, { source, preview, detail: { ...row, files: [
      { key: 'preview', name: extension === 'gif' ? 'preview.png' : 'preview.gif', available: true, bytes: preview.length, sha256: sha(preview) },
      { key: 'source', name: 'source.' + extension, available: true, bytes: source.length, sha256: sha(source) },
    ] } });
  }
  nativeDetails = 0; nativeFiles = 0;
  const nativePage = await listAssets(manifest, { purposes: 'image', limit: 100 });
  assert.ok(nativePage.assets.some((asset) => asset.id === 'character:native_png'));
  assert.ok(!nativePage.assets.some((asset) => asset.id === 'character:native_gif'));
  assert.equal(nativeDetails, 0); assert.equal(nativeFiles, 0);
  for (const extension of ['png', 'gif']) {
    const { asset } = await getAsset(manifest, { assetId: 'character:native_' + extension });
    assert.equal(asset.primaryMime, 'image/' + extension);
    if (extension === 'gif') await assert.rejects(buildAssetImport(manifest, { assetId: asset.id, revision: asset.revision, purpose: 'image' }), /GIF.*PNG、JPG、WebP/);
    else assert.equal((await browser.loadLibraryAsset(asset.id, 'image')).files[0].file.type, 'image/png');
  }
  assert.equal(importPurposes(manifest, { kind: 'animation', primaryMime: 'image/gif' })[0].id, 'animation', 'Animation preview format does not change its existing import purpose');
  console.log('Image import formats passed: real GIF/PNG/JPEG/WebP package, exact primary MIME, shared eligibility, explicit GIF rejection, unchanged previews/downloads/source bytes, browser editor import and native filtering without detail fan-out.');
} finally {
  globalThis.fetch = originalFetch;
  if (originalReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = originalReader;
  if (originalPipelineUrl === undefined) delete process.env.SPRITE_PIPELINE_API_URL; else process.env.SPRITE_PIPELINE_API_URL = originalPipelineUrl;
  await server?.close();
  await rm(namespace, { recursive: true, force: true });
}
