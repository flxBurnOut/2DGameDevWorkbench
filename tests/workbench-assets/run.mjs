import '../helpers/runtime-workspace.mjs';
import { mapProjectFixture } from '../helpers/map-project.mjs';
import { saveMapProject } from '../../lib/workbench/map-projects.mjs';
import { createMapProjectPackage } from '../../features/map-stitcher/project-package.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  loadManifest,
  agentRequest,
  persistTask,
  repositoryRoot,
  archiveTaskHistory,
  listTasks,
  listTaskPage,
} from '../../lib/workbench/runtime.mjs';
import { createScene } from '../../features/scene-composer/model.mjs';
import { createScenePackage, readScenePackage } from '../../features/scene-composer/package.mjs';
import {
  manageAssets,
  buildAssetImport,
  readAssetGodotPackage,
  readAssetPreview,
  buildAssetArchive,
} from '../../lib/workbench/asset-catalog.mjs';

let offline = false;
let changeNativeBytes = false;
const nativePng = await sharp({
  create: { width: 128, height: 128, channels: 4, background: '#abcdef' },
})
  .png()
  .toBuffer();
const nativeSha = createHash('sha256').update(nativePng).digest('hex');
const nativeGodot = await new JSZip().file('forge_sprites/fixture/sprite_frames.tres', '[gd_resource type="SpriteFrames" format=3]').generateAsync({type: 'nodebuffer'});
const nativeGodotSha = createHash('sha256').update(nativeGodot).digest('hex');
const nativeAssets = [1, 2, 3].map((candidateIndex) => ({
  id: `animation:original-job:${candidateIndex}`,
  kind: 'animation',
  title: '骑士 · 攻击',
  characterId: 'knight',
  actionId: 'attack',
  jobId: 'original-job',
  candidateIndex,
  candidateCount: 3,
  frameCount: 17,
  status: 'review_required',
  statusLabel: '待检查',
  createdAt: '2026-08-01',
  updatedAt: '2026-08-02',
  availability: 'available',
  previewKind: 'animation',
  hasArtwork: true,
}));
nativeAssets.push({
  id: 'character:transferred',
  kind: 'character',
  characterId: 'transferred',
  title: '已移送骑士',
  createdAt: '2026-08-01',
  updatedAt: '2026-08-01',
  availability: 'available',
  status: 'saved',
  hasArtwork: true,
});
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (offline) {
    res.writeHead(503);
    res.end('{}');
    return;
  }
  if (req.url === '/v1/jobs') {
    res.end(JSON.stringify({ data: { jobs: Array.from({ length: 215 }, (_, i) => ({
      job_id: `native-history-${String(i).padStart(3, '0')}`, status: 'review_required',
      updated_at: '2026-08-01', created_at: '2026-08-01', character_name: '历史角色', action_name: '待检查动作',
    })) } }));
    return;
  }
  if (req.url === '/v1/artworks') {
    res.end(JSON.stringify({ data: { assets: nativeAssets, issues: [] } }));
    return;
  }
  if (req.url.startsWith('/v1/artworks/file?')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    if (
      !nativeAssets.some((a) => a.id === query.get('asset_id')) ||
      !['frame-0', 'godot'].includes(query.get('key'))
    ) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    res.setHeader('Content-Type', query.get('key') === 'godot' ? 'application/zip' : 'image/png');
    res.end(changeNativeBytes ? Buffer.from('changed') : query.get('key') === 'godot' ? nativeGodot : nativePng);
    return;
  }
  const id = decodeURIComponent(req.url.slice('/v1/artworks/'.length));
  const asset = nativeAssets.find((a) => a.id === id);
  if (!asset) {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  res.end(
    JSON.stringify({
      data: {
        asset: {
          ...asset,
          width: 128,
          height: 128,
          files: [
            { key: 'godot', path: '/native/existing/sprite.godot.zip', name: 'sprite.godot.zip', bytes: nativeGodot.length, sha256: nativeGodotSha, available: true },
            {
              key: 'frame-0',
              path: '/native/existing/frame.png',
              name: 'frame_000.png',
              bytes: nativePng.length,
              sha256: nativeSha,
              available: true,
            },
            {
              key: 'preview',
              name: 'frame_000.png',
              path: '/native/existing/frame.png',
              bytes: nativePng.length,
              sha256: nativeSha,
              available: true,
            },
          ],
        },
      },
    }),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.SPRITE_PIPELINE_API_URL = `http://127.0.0.1:${server.address().port}`;
const manifest = await loadManifest();
let client;
let bridge;
try {
  async function task(
    id,
    capabilityId,
    input,
    files = {},
    timestamp = '2026-01-01',
  ) {
    const output = path.join(
      repositoryRoot,
      manifest.workspace.outputDirectory,
      id,
    );
    await mkdir(output, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(output, name)), { recursive: true });
      await writeFile(path.join(output, name), bytes);
    }
    const record = {
      schemaVersion: 1,
      id,
      capabilityId,
      input,
      status: Object.keys(files).length ? 'completed' : 'prepared',
      outputs: Object.keys(files).map(
        (name) => `${manifest.workspace.outputDirectory}/${id}/${name}`,
      ),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await persistTask(manifest, record);
    return record;
  }
  const png = await sharp({
    create: { width: 128, height: 128, channels: 4, background: '#123456' },
  })
    .png()
    .toBuffer();
  const original = await task(
    'reference-original',
    'reference-art',
    { operation: 'generate', name: '最早的骑士' },
    { 'reference.png': png },
  );
  await task(
    'transfer-original',
    'reference-art',
    { operation: 'transfer', sourceTaskId: original.id },
    { 'result.json': JSON.stringify({ characterId: 'transferred' }) },
  );
  for (let i = 0; i < 205; i++)
    await task(
      `empty-${i}`,
      'sprite-generator',
      { operation: 'create', provider: 'fixture' },
      {},
      '2026-09-01',
    );
  const project = {
    projectId: 'door-project',
    name: '门',
    assets: [],
    objects: [
      {
        definitionId: 'door',
        displayName: '木门',
        visual: { width: 64, height: 80 },
        behavior: { kind: 'toggle' },
      },
      {
        definitionId: 'removed',
        displayName: '旧门',
        visual: {},
        behavior: { kind: 'toggle' },
      },
    ],
  };
  await task(
    'old-project',
    'interactable-editor',
    { operation: 'export-godot', project },
    {
      'interactable-project.json': JSON.stringify(project),
      'interactables.zip': 'old export',
    },
  );
  const currentProject = { ...project, objects: project.objects.slice(0, 1) };
  await task(
    'new-project',
    'interactable-editor',
    { operation: 'save-project', project: currentProject },
    { 'interactable-project.json': JSON.stringify(currentProject) },
    '2026-07-01',
  );
  const taskDirectory = path.join(
    repositoryRoot,
    manifest.workspace.taskDirectory,
  );
  const before = await readdir(taskDirectory);
  const first = await agentRequest(manifest, 'assets', { limit: 2 });
  assert.equal(first.total, 5); // one linked reference, three candidates, one current object
  assert.equal(first.coverage.runtimeRecords, 209);
  const second = await agentRequest(manifest, 'assets', {
    limit: 2,
    offset: first.nextOffset,
    snapshot: first.snapshot,
  });
  assert(!first.assets.some((a) => second.assets.some((b) => b.id === a.id)));
  const old = await agentRequest(manifest, 'assets', { query: '最早的骑士' });
  assert.equal(old.assets[0].id, 'reference:reference-original');
  assert.equal(old.assets[0].characterId, 'transferred');
  const selected = await agentRequest(manifest, 'assets', {
    kind: 'animation',
    candidateCount: 3,
    candidateIndex: 2,
    limit: 1,
  });
  assert.equal(selected.total, 1);
  assert.match(selected.assets[0].editorPath, /job=original-job&candidate=2$/);
  const detail = await agentRequest(manifest, 'asset', {
    assetId: 'character:transferred',
  });
  assert.equal(detail.asset.id, 'reference:reference-original');
  assert.equal(detail.asset.width, 128);
  assert.equal(detail.asset.files[0].sha256.length, 64);
  const handoff = await agentRequest(manifest, 'asset-manifest', {
    assetIds: [
      'reference:reference-original',
      'character:transferred',
      selected.assets[0].id,
      'interactable:door-project:door',
    ],
  });
  assert.equal(handoff.manifest.assets.length, 3);
  assert.equal(handoff.manifest.engineValidated, false);
  assert(
    handoff.manifest.assets
      .find((a) => a.kind === 'interactable')
      .readiness.issues.some((i) => i.includes('逻辑')),
  );
  assert.equal(
    handoff.manifest.assets.find((a) => a.kind === 'interactable').status,
    'saved',
  );
  const door = handoff.manifest.assets.find((a) => a.kind === 'interactable');
  assert.equal(door.createdAt, '2026-01-01');
  assert.deepEqual(door.taskIds, ['old-project', 'new-project']);
  assert.deepEqual(door.history.map((h) => h.operation), ['export-godot', 'save-project']);
  assert(!door.files.some((f) => f.name.endsWith('.zip')), 'saving newer source must not retain an obsolete export');
  assert.deepEqual((await readdir(taskDirectory)).sort(), before.sort());
  assert(
    (
      await readAssetPreview(manifest, 'reference:reference-original')
    ).bytes.equals(png),
  );
  const mapZip = new JSZip();
  mapZip.file('map.png', png);
  const mapBytes = await mapZip.generateAsync({ type: 'nodebuffer' });
  await task(
    'saved-map',
    'map-stitcher',
    { operation: 'compose' },
    { 'stitched-map.png': png, 'godot-package.zip': mapBytes },
  );
  nativeAssets.push({ id: 'map:legacy-native', kind: 'map', title: '旧导入图' });
  assert.equal((await agentRequest(manifest, 'assets', { kind: 'map' })).total, 1, 'legacy map image remains discoverable');
  const projectPng = await sharp(png).resize(16, 16).png().toBuffer();
  const { draft: projectDraft } = await mapProjectFixture(projectPng);
  const projectBytes = await createMapProjectPackage(projectDraft, projectPng);
  await saveMapProject(repositoryRoot, manifest, 'map:fixture', 0, projectBytes);
  await saveMapProject(repositoryRoot, manifest, 'map:fixture', 1, projectBytes);
  const maps = await agentRequest(manifest, 'assets', { kind: 'map', mapType: 'project' });
  assert.equal(maps.total, 1);
  assert.equal(maps.assets[0].projectRevision, 2);
  assert.equal(maps.assets[0].previewKind, 'image');
  assert.deepEqual((await readAssetPreview(manifest, maps.assets[0].id)).bytes, projectPng);
  await assert.rejects(readAssetPreview(manifest, maps.assets[0].id, 1), /版本已更新/);
  assert(maps.assets[0].editorPath.endsWith('?map=map%3Afixture&saved=1'));
  const allMaps = await agentRequest(manifest, 'assets', { kind: 'map' });
  assert.equal(allMaps.total, 2);
  const imageMaps = await agentRequest(manifest, 'assets', { kind: 'map', mapType: 'image' });
  assert.equal(imageMaps.total, 1);
  assert.equal(imageMaps.assets[0].id, 'map:saved-map:stitched-map');
  const imageDetail = (await agentRequest(manifest, 'asset', { assetId: imageMaps.assets[0].id })).asset;
  const oldMapDownload = await JSZip.loadAsync((await buildAssetArchive(manifest, { assetIds: [imageDetail.id] })).bytes);
  assert(Object.keys(oldMapDownload.files).some((name) => name.endsWith('/map.png')));
  assert(Object.keys(oldMapDownload.files).some((name) => name.endsWith('/godot-package.zip')));
  assert.deepEqual((await readAssetGodotPackage(manifest, {assetId: imageDetail.id, revision: imageDetail.revision})).bytes, mapBytes);
  const projectDetail = (await agentRequest(manifest, 'asset', {assetId: maps.assets[0].id})).asset;
  const projectRequest = {assetId: projectDetail.id, revision: projectDetail.revision, purpose:'map'};
  const reusable = await JSZip.loadAsync((await buildAssetImport(manifest, projectRequest)).bytes);
  const importInfo = JSON.parse(await reusable.file('import.json').async('string'));
  assert.equal(importInfo.files[0].name, 'map-source.zip');
  assert.deepEqual(await reusable.file(importInfo.files[0].path).async('uint8array'), projectBytes);
  await assert.rejects(buildAssetImport(manifest, {...projectRequest,purpose:'image'}), /不能/);
  await assert.rejects(readAssetGodotPackage(manifest, projectRequest), /Godot 包/);
  const archiveIds = [
    'reference:reference-original',
    'character:transferred',
    'animation:original-job:1',
    'animation:original-job:2',
    'interactable:door-project:door',
    'map-project:map:fixture',
  ];
  const beforeArchive = await readdir(taskDirectory);
  const archive = await buildAssetArchive(manifest, { assetIds: archiveIds });
  assert.equal(archive.assetCount, 5);
  const zip = await JSZip.loadAsync(archive.bytes, { checkCRC32: true });
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  assert(!entries.some((f) => /^map\/.+\/preview\.png$/.test(f.name)), 'thumbnail is not an independent downloadable map asset');
  assert.equal(
    entries.filter((f) => f.name.endsWith('/frames/frame_000.png')).length,
    2,
  );
  for (const frame of entries.filter((f) =>
    f.name.endsWith('/frames/frame_000.png'),
  ))
    assert((await frame.async('nodebuffer')).equals(nativePng));
  assert(
    (
      await entries
        .find((f) => f.name.endsWith('/reference.png'))
        .async('nodebuffer')
    ).equals(png),
  );
  assert((await entries.find((f) => f.name.endsWith('/map-source.zip')).async('nodebuffer')).equals(Buffer.from(projectBytes)));
  assert(!entries.some((f) => f.name.endsWith('/map.png') || f.name.endsWith('/godot-package.zip')));
  assert.deepEqual(
    JSON.parse(
      await entries
        .find((f) => f.name.endsWith('/interactable-project.json'))
        .async('string'),
    ),
    currentProject,
  );
  assert(!entries.some((f) => /manifest|result\.json|qa\.json/.test(f.name)));
  const archiveManifest = JSON.parse(await zip.file('forge-assets.json').async('string'));
  assert.equal(archiveManifest.format, 'forge-asset-archive');
  assert.equal(archiveManifest.version, 1);
  assert.equal(archiveManifest.entries.length, 5);
  for (const entry of archiveManifest.entries) {
    assert(entry.sourceIdentity.assetId);
    assert.match(entry.sourceVersion, /^[a-f0-9]{64}$/);
    for (const file of entry.files) {
      const bytes = await zip.file(file.path).async('nodebuffer');
      assert.equal(file.bytes, bytes.length);
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert(file.mime && file.role);
    }
  }
  const exportedMap = archiveManifest.entries.find((entry) => entry.kind === 'map');
  assert.equal(exportedMap.mapType, 'project');
  assert.equal(exportedMap.metadata.projectRevision, 2);
  assert.deepEqual(exportedMap.metadata.map, { format: 'forge-map-project', version: 1 });
  assert.equal(archiveManifest.entries.find((entry) => entry.kind === 'animation').metadata.loop, null, 'missing loop stays unknown');
  assert(!entries.some((f) => f.name.includes('..') || f.name.startsWith('/')));
  assert.deepEqual((await readdir(taskDirectory)).sort(), beforeArchive.sort());
  changeNativeBytes = true;
  await assert.rejects(
    buildAssetArchive(manifest, { assetIds: ['animation:original-job:2'] }),
    /发生变化/,
  );
  changeNativeBytes = false;
  await assert.rejects(buildAssetArchive(manifest, { assetIds: [] }));
  const bad = { ...original, id: 'escape-original', outputs: original.outputs };
  await persistTask(manifest, bad);
  const escaped = await agentRequest(manifest, 'asset', {
    assetId: 'reference:escape-original',
  });
  assert.equal(escaped.asset.files[0].available, false);
  await assert.rejects(readAssetPreview(manifest, 'reference:escape-original'));
  await assert.rejects(
    buildAssetArchive(manifest, { assetIds: ['reference:escape-original'] }),
    /缺失|不可读取/,
  );
  await assert.rejects(
    agentRequest(manifest, 'assets', { snapshot: first.snapshot }),
  );
  await assert.rejects(
    agentRequest(manifest, 'assets', { candidateIndex: '2' }),
  );
  await assert.rejects(
    agentRequest(manifest, 'asset-manifest', { assetIds: [] }),
  );
  await assert.rejects(
    agentRequest(manifest, 'asset', { assetId: 'does-not-exist' }),
  );
  const oldRevision = detail.asset.revision;
  await writeFile(
    path.join(repositoryRoot, original.outputs[0]),
    await sharp(png).negate().png().toBuffer(),
  );
  assert.notEqual(
    (await agentRequest(manifest, 'asset', { assetId: detail.asset.id })).asset
      .revision,
    oldRevision,
  );
  await unlink(path.join(repositoryRoot, original.outputs[0]));
  assert.equal(
    (await agentRequest(manifest, 'asset', { assetId: detail.asset.id })).asset
      .readiness.filesAvailable,
    false,
  );
  await assert.rejects(
    buildAssetArchive(manifest, { assetIds: ['reference:reference-original'] }),
    /缺失|不可读取/,
  );
  offline = true;
  const partial = await agentRequest(manifest, 'assets', {});
  assert.equal(partial.coverage.complete, false);
  assert(
    partial.assets.some(
      (a) => a.id === detail.asset.id && a.availability === 'missing',
    ),
  );
  offline = false;
  // Later checks/exports must preserve animation creation time and all source tasks,
  // including a generation record which has no copied frame outputs.
  await task('animation-start', 'sprite-generator', { operation: 'create-and-generate', jobId: 'snapshot-job' }, {}, '2025-01-01');
  for (const [id, operation, at] of [['animation-check', 'check', '2026-01-01'], ['animation-export', 'export', '2026-08-01']]) {
    await task(id, 'sprite-generator', { operation, jobId: 'snapshot-job' }, {
      'frames/candidate-01/frame_000.png': png,
      'result.json': JSON.stringify({ jobId: 'snapshot-job', candidates: [{ candidateIndex: 1, status: 'approved' }], jobRecord: { action: { fps: 12, loop: false } } }),
    }, at);
  }
  const snapshotAsset = (await agentRequest(manifest, 'asset', { assetId: 'animation:snapshot-job:1' })).asset;
  assert.equal(snapshotAsset.createdAt, '2025-01-01');
  assert.equal(snapshotAsset.taskId, 'animation-export');
  assert.deepEqual(snapshotAsset.taskIds, ['animation-start', 'animation-check', 'animation-export']);
  assert.equal(snapshotAsset.history.length, 3);
  assert.equal(snapshotAsset.fps, 12);

  client = new Client({ name: 'asset-inventory-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['scripts/workbench-mcp.mjs'],
      cwd: repositoryRoot,
      env: { ...process.env },
      stderr: 'pipe',
    }),
  );
  const tools = await client.listTools();
  for (const name of [
    'workbench_list_assets',
    'workbench_get_asset',
    'workbench_get_asset_manifest',
  ])
    assert.equal(
      tools.tools.find((t) => t.name === name).annotations.readOnlyHint,
      true,
    );
  const response = await client.callTool({
    name: 'workbench_list_assets',
    arguments: { candidateCount: 3, candidateIndex: 2 },
  });
  assert.equal(response.structuredContent.assets[0].id, selected.assets[0].id);
  const serverPort = await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
  bridge = spawn(process.execPath, ['scripts/workbench-http.mjs'], {
    cwd: repositoryRoot,
    env: { ...process.env, WORKBENCH_RUNTIME_PORT: String(serverPort) },
    stdio: 'ignore',
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${serverPort}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/health')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const httpResult = await fetch(base + '/v1/agent/assets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ candidateCount: 3, candidateIndex: 2 }),
  });
  assert.equal(httpResult.status, 200);
  assert.deepEqual(
    (await httpResult.json()).assets,
    response.structuredContent.assets,
  );
  const download = await fetch(base + '/v1/assets/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetIds: ['animation:original-job:2'] }),
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(download.headers.get('content-disposition'), /forge-assets.zip/);
  const downloadedZip = await JSZip.loadAsync(await download.arrayBuffer(), {
    checkCRC32: true,
  });
  assert.equal(
    Object.values(downloadedZip.files).filter((f) =>
      f.name.endsWith('/frames/frame_000.png'),
    ).length,
    1,
  );
  const packagedGodot = Object.values(downloadedZip.files).find((file) => file.name.endsWith('/godot/sprite-frames.zip'));
  assert(packagedGodot);
  assert.deepEqual(await packagedGodot.async('nodebuffer'), nativeGodot);
  const invalidDownload = await fetch(base + '/v1/assets/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetIds: ['reference:escape-original'] }),
  });
  assert.equal(invalidDownload.status, 400);
  // Search applies before the page limit, both API sources remain reachable past 200.
  const historyMatch = await agentRequest(manifest, 'tasks', { query: 'reference-original', capabilityId: 'reference-art', limit: 1 });
  assert.equal(historyMatch.tasks.length, 1);
  assert(historyMatch.totalTasks >= 1);
  assert(historyMatch.searchedTasks > 200);
  const historyFirst = await agentRequest(manifest, 'tasks', { limit: 200 });
  const historySecond = await agentRequest(manifest, 'tasks', { limit: 200, offset: historyFirst.nextOffset, snapshot: historyFirst.snapshot });
  assert.equal(historyFirst.tasks.length + historySecond.tasks.length, historyFirst.totalTasks);
  assert.equal(historyFirst.nativeJobs.length + historySecond.nativeJobs.length, 215);
  assert.equal(historySecond.nextOffset, null);
  assert(!historyFirst.tasks.some((t) => historySecond.tasks.some((u) => u.id === t.id)));
  const historyMcp = await client.callTool({ name: 'workbench_list_tasks', arguments: { limit: 200, offset: 200, snapshot: historyFirst.snapshot } });
  assert.deepEqual(historyMcp.structuredContent.tasks, historySecond.tasks);
  const httpPage = await (await fetch(base + '/v1/tasks?limit=200')).json();
  const httpOlder = await (await fetch(base + `/v1/tasks?limit=200&offset=${httpPage.nextOffset}&snapshot=${httpPage.snapshot}`)).json();
  assert.equal(httpPage.tasks.length + httpOlder.tasks.length, httpPage.total);
  const httpSearch = await (await fetch(base + `/v1/tasks?limit=1&query=${encodeURIComponent('"id":"reference-original"')}`)).json();
  assert.equal(httpSearch.tasks[0].id, original.id);
  await assert.rejects(listTaskPage(manifest, { offset: -1 }), /pagination/);
  await assert.rejects(listTaskPage(manifest, { snapshot: 'stale' }), /历史已变化/);
  await assert.rejects(agentRequest(manifest, 'tasks', { offset: -1 }), /offset/);
  await assert.rejects(agentRequest(manifest, 'tasks', { snapshot: 'stale' }), /历史已变化/);
  // Use the real local scene exporter through an isolated HTTP bridge. Cataloging
  // and downloading must preserve exact ZIP bytes and never create task records.
  const scene = createScene('资产库完整场景');
  scene.map = { name: '测试地图', origin: { x: 0, y: 0 }, offset: { x: 0, y: 0 },
    layers: [{ id: 'base', name: '地形', source: `data:image/png;base64,${png.toString('base64')}`, width: 128, height: 128, included: true, hidden: false, locked: false }],
    collisions: [], source: `data:application/zip;base64,${mapBytes.toString('base64')}`, warnings: [] };
  scene.order = ['base', 'actor'];
  const taskNamesBeforeScenes = await readdir(taskDirectory);
  const exports = [];
  for (const revision of [1, 2]) {
    scene.revision = revision;
    const res = await fetch(base + '/v1/scene-composer/export', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: await createScenePackage(scene) });
    assert.equal(res.status, 200);
    exports.push(await res.json());
  }
  // Cover old records which predate display metadata as well as modern exports.
  const legacy = { ...exports[0] };
  delete legacy.sceneName; delete legacy.instanceCount; delete legacy.materialCount; delete legacy.mapName;
  const sceneDir = path.join(repositoryRoot, manifest.workspace.sceneExportDirectory);
  await writeFile(path.join(sceneDir, `${legacy.exportId}.json`), JSON.stringify(legacy));
  const scenes = await agentRequest(manifest, 'assets', { kind: 'scene' });
  assert.equal(scenes.total, 2);
  assert(scenes.assets.every((a) => a.title === scene.name && a.origin === 'scene-export' && a.taskIds.length === 0));
  assert.deepEqual(scenes.assets.map((a) => a.sceneRevision).sort(), [1, 2]);
  const sceneId = `scene:${exports[0].exportId}`;
  const sceneDetail = (await agentRequest(manifest, 'asset', { assetId: sceneId })).asset;
  assert.equal(sceneDetail.readiness.filesAvailable, true);
  assert.equal(sceneDetail.engineValidated, false);
  const sceneDownload = await buildAssetArchive(manifest, { assetIds: [sceneId] });
  const sceneZip = await JSZip.loadAsync(sceneDownload.bytes);
  for (const file of sceneDetail.files) {
    const entry = Object.values(sceneZip.files).find((f) => f.name.endsWith('/' + file.name));
    assert(entry);
    assert.deepEqual(await entry.async('nodebuffer'), await readFile(path.join(repositoryRoot, file.path)));
  }
  const sourceEntry = Object.values(sceneZip.files).find((f) => f.name.endsWith('/scene-source.zip'));
  assert.equal((await readScenePackage(await sourceEntry.async('uint8array'))).id, scene.id);
  assert.deepEqual(await readdir(taskDirectory), taskNamesBeforeScenes);
  const mcpScenes = await client.callTool({ name: 'workbench_list_assets', arguments: { kind: 'scene' } });
  assert.deepEqual(mcpScenes.structuredContent.assets, scenes.assets);
  assert.equal((await agentRequest(manifest, 'asset-manifest', { assetIds: [sceneId] })).manifest.assets[0].sceneRevision, 1);
  // Missing recorded files stay visible and prevent an incomplete download.
  await unlink(path.join(repositoryRoot, exports[1].outputs[0]));
  assert.equal((await agentRequest(manifest, 'asset', { assetId: `scene:${exports[1].exportId}` })).asset.readiness.filesAvailable, false);
  await assert.rejects(buildAssetArchive(manifest, { assetIds: [`scene:${exports[1].exportId}`] }), /缺失|不可读取/);
  const forged = { ...legacy, exportId: 'scene-export-forged', outputs: legacy.outputs };
  await writeFile(path.join(sceneDir, `${forged.exportId}.json`), JSON.stringify(forged));
  const invalidScenes = await agentRequest(manifest, 'assets', { kind: 'scene' });
  assert.equal(invalidScenes.total, 2);
  assert(invalidScenes.coverage.issues.some((i) => i.record === 'scene-export-forged.json'));
  await unlink(path.join(sceneDir, 'scene-export-forged.json'));

  // Archive only hides history. The index file is never parsed as a task, and
  // exact source/history links and downloadable assets still work afterwards.
  const prior = await agentRequest(manifest, 'assets', { limit: 100 });
  await archiveTaskHistory(manifest);
  assert.deepEqual(await listTasks(manifest), []);
  const archived = await agentRequest(manifest, 'assets', { limit: 100 });
  assert.deepEqual(archived.assets, prior.assets);
  assert(!archived.coverage.issues.some((i) => i.record === '.archived.json'));
  assert.equal(archived.coverage.runtimeRecords, prior.coverage.runtimeRecords);
  assert.deepEqual((await agentRequest(manifest, 'asset', { assetId: 'interactable:door-project:door' })).asset.history, door.history);
  assert((await buildAssetArchive(manifest, { assetIds: [sceneId] })).fileCount === 2);
  const recycledIds = [(await agentRequest(manifest, 'asset', { assetId: 'character:transferred' })).asset.id, 'animation:original-job:2', 'map-project:map:fixture', 'interactable:door-project:door', sceneId];
  const originals = await Promise.all(recycledIds.map(async (assetId) => (await agentRequest(manifest, 'asset', { assetId })).asset));
  const beforeTrash = await agentRequest(manifest, 'assets', { limit: 100 });
  const namesBeforeTrash = await readdir(taskDirectory);
  await assert.rejects(manageAssets(manifest, { operation: 'trash', assetIds: [sceneId, 'unknown:asset'] }), /不可读取/);
  assert.equal((await agentRequest(manifest, 'assets', { scope: 'trashed' })).total, 0);
  const moved = await fetch(base + '/v1/assets/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'trash', assetIds: [...recycledIds, 'character:transferred'] }) });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).count, 5);
  const activeAfter = await agentRequest(manifest, 'assets', { limit: 100 });
  assert.equal(activeAfter.total, beforeTrash.total - 5);
  assert(activeAfter.assets.some((asset) => asset.id === 'animation:original-job:1'));
  assert(activeAfter.assets.some((asset) => asset.id === 'animation:original-job:3'));
  await assert.rejects(agentRequest(manifest, 'assets', { snapshot: beforeTrash.snapshot }), /已变化/);
  const recycled = await agentRequest(manifest, 'assets', { scope: 'trashed', limit: 2 });
  assert.equal(recycled.total, 5);
  assert.equal((await agentRequest(manifest, 'assets', { scope: 'trashed', offset: recycled.nextOffset, snapshot: recycled.snapshot })).assets.length, 3);
  assert((await agentRequest(manifest, 'asset', { assetId: 'character:transferred' })).asset.trashedAt);
  const mcpTrash = await client.callTool({ name: 'workbench_list_assets', arguments: { scope: 'trashed' } });
  assert.equal(mcpTrash.structuredContent.total, 5);
  for (const original of originals) {
    const current = (await agentRequest(manifest, 'asset', { assetId: original.id })).asset;
    assert.deepEqual(current.files, original.files);
    assert.deepEqual(current.history, original.history);
  }
  assert.deepEqual(await readdir(taskDirectory), namesBeforeTrash);
  offline = true;
  const offlineTrash = await agentRequest(manifest, 'assets', { scope: 'trashed' });
  assert.equal(offlineTrash.total, 5);
  assert.equal(offlineTrash.assets.find((a) => a.id === 'animation:original-job:2').availability, 'unknown');
  assert.equal((await agentRequest(manifest, 'asset', { assetId: 'animation:original-job:2' })).asset.readiness.filesAvailable, false);
  await manageAssets(manifest, { operation: 'restore', assetIds: recycledIds });
  offline = false;
  assert.equal((await agentRequest(manifest, 'assets', { scope: 'trashed' })).total, 0);
  assert.deepEqual((await agentRequest(manifest, 'assets', { limit: 100 })).assets, beforeTrash.assets);
  await assert.rejects(manageAssets(manifest, { operation: 'delete', assetIds: [sceneId] }));
  await assert.rejects(manageAssets(manifest, { operation: 'trash', assetIds: [] }));
  const trashIndex = path.join(repositoryRoot, manifest.workspace.assetTrashDirectory, 'index.json');
  const validTrash = await readFile(trashIndex);
  await writeFile(trashIndex, '{corrupt');
  await assert.rejects(agentRequest(manifest, 'assets', {}), /回收站记录无法读取/);
  await assert.rejects(manageAssets(manifest, { operation: 'trash', assetIds: [sceneId] }), /回收站记录无法读取/);
  await writeFile(trashIndex, validTrash);
  for (const kind of ['background', 'prop']) {
    const imageId = `image-assets-${kind}`;
    await task(imageId, 'image-assets', { operation: kind === 'prop' ? 'generate-prop' : 'generate-background', name: `Image 2.6 ${kind}` }, {
      'image.png': png,
      'provider-response.png': png,
      'result.json': JSON.stringify({ kind, image: 'image.png', width: 128, height: 128, sha256: createHash('sha256').update(png).digest('hex'), model: 'gpt-image-2.6-sunburst' }),
    });
    const imageAsset = (await agentRequest(manifest, 'asset', { assetId: `image:${imageId}` })).asset;
    assert.equal(imageAsset.kind, kind === 'prop' ? 'prop' : 'map');
    assert.match(imageAsset.editorPath, new RegExp(`\\?imageTask=${imageId}$`));
    assert.equal(imageAsset.readiness.filesAvailable, true);
    const imported = await buildAssetImport(manifest, { assetId: imageAsset.id, revision: imageAsset.revision, purpose: kind === 'prop' ? 'image' : 'map' });
    const imageZip = await JSZip.loadAsync(imported.bytes);
    const imageImport = JSON.parse(await imageZip.file('import.json').async('string'));
    assert.equal(imageImport.files.length, 1, 'Only the adopted PNG is an image source, not the original provider copy.');
    assert.deepEqual(await imageZip.file(imageImport.files[0].path).async('nodebuffer'), png);
  }
  console.log('Recoverable asset trash: five kinds, aliases, candidate isolation, atomic batch, durable MCP/HTTP views, pagination, offline restore and corrupt index passed; sources unchanged.');
  console.log(
    'Assets: complete record scan, pagination, exact candidates, provenance deduplication, project revisions, file hashes, missing/escaped files, offline coverage, MCP/HTTP parity and actual ZIP bytes/candidate isolation/download errors passed; zero generation.',
  );
} finally {
  await client?.close();
  bridge?.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
