import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { createTestViteServer } from '../helpers/vite-server.mjs';
import { createProject } from '../../features/interactable-editor/contract.mjs';
import { createScene, addMaterial, addInstance } from '../../features/scene-composer/model.mjs';
import { mapProjectFixture } from '../helpers/map-project.mjs';
import { createMapProjectPackage } from '../../features/map-stitcher/project-package.mjs';

// All keys, tasks, documents, outputs, browser origin and Vite caches belong to this fixture only.
const repositoryRoot = process.cwd(), run = process.env.WORKBENCH_UI_SMOKE_RUN || `ui-smoke-${randomUUID()}`;
if (!/^ui-smoke-[a-f0-9-]{36}$/.test(run)) throw new Error('Smoke storage must use an isolated UI test run UUID.');
const output = path.join(repositoryRoot, 'work', 'test-runs', run);
await mkdir(output, { recursive: true });
const freePort = async () => { const server = createNetServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
const readBody = async request => { const parts = []; for await (const part of request) parts.push(part); return Buffer.concat(parts); };
const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const providerCalls = [], clientErrors = [];
try { providerCalls.push(...JSON.parse(await readFile(path.join(output, 'mock-calls.json'), 'utf8'))); } catch {}
const gateway = createHttpServer(async (request, response) => {
  if (!request.url.startsWith('/v1/images/')) return json(response, { configured: false, jobs: [] });
  const bytes = await readBody(request);
  let size, background;
  if (request.headers['content-type']?.includes('application/json')) ({ size, background } = JSON.parse(bytes));
  else {
    const body = bytes.toString('latin1');
    size = /name="size"\r\n\r\n([^\r]+)/.exec(body)?.[1];
    background = /name="background"\r\n\r\n([^\r]+)/.exec(body)?.[1];
  }
  const [width, height] = String(size).split('x').map(Number);
  providerCalls.push({ endpoint: request.url, width, height, background });
  await writeFile(path.join(output, 'mock-calls.json'), JSON.stringify(providerCalls, null, 2));
  if (!width || !height) return json(response, { error: 'mock fixture invalid size' }, 400);
  const transparent = background === 'transparent';
  const image = await sharp({ create: { width, height, channels: 4, background: transparent ? '#00000000' : '#a6c6d0' } }).composite([
    { input: await sharp({ create: { width: Math.round(width * (transparent ? .6 : 1)), height: Math.round(height * (transparent ? .4 : .3)), channels: 4, background: transparent ? '#c5963f' : '#385745' } }).png().toBuffer(), left: transparent ? Math.round(width * .2) : 0, top: Math.round(height * (transparent ? .4 : .7)) },
  ]).png().toBuffer();
  await new Promise(resolve => setTimeout(resolve, process.env.WORKBENCH_UI_AI_EDIT === '1' ? 5000 : 1400));
  json(response, { data: [{ b64_json: image.toString('base64') }] });
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
const bridgePort = await freePort(), bridgeUrl = `http://127.0.0.1:${bridgePort}`;
const child = spawn(process.execPath, ['scripts/workbench-http.mjs'], {
  cwd: repositoryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, WORKBENCH_TEST_RUN: run, WORKBENCH_RUNTIME_PORT: String(bridgePort), OPENAI_API_KEY: 'fixture-no-production-key', MAP_STITCHER_OPENAI_API_URL: `${gatewayUrl}/v1/images/edits`, MAP_STITCHER_OPENAI_GENERATION_API_URL: `${gatewayUrl}/v1/images/generations`, IMAGE_ASSETS_PROVIDER: 'gpt-image-2.6', MAP_STITCHER_IMAGE_PROVIDER: 'gpt-image-2.6', SPRITE_PIPELINE_API_URL: gatewayUrl },
});
child.stdout.resume(); child.stderr.on('data', data => process.stderr.write(data));
const until = async callback => { for (let attempt = 0; attempt < 100; attempt++) { try { if (await callback()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 200)); } throw new Error('Isolated bridge readiness timeout'); };
await until(async () => (await fetch(`${bridgeUrl}/health`)).ok);
const bridge = async (pathname, body) => {
  const response = await fetch(bridgeUrl + pathname, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
};
const oldArt = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#00000000' } }).composite([{ input: await sharp({ create: { width: 80, height: 60, channels: 4, background: '#496c8f' } }).png().toBuffer(), left: 24, top: 44 }]).png().toBuffer();
const project = createProject(); project.projectId = 'ui_prop_project'; project.name = '服务端交互物验收';
const object = project.objects[0]; object.definitionId = 'ui_prop_object'; object.displayName = '验收宝箱'; object.behavior.kind = 'toggle'; object.visual.assetId = 'existing_art';
for (const state of object.behavior.states) state.appearance.assetId = 'existing_art';
project.assets = [{ id: 'existing_art', name: '原状态图片.png', mime: 'image/png', source: dataUrl(oldArt) }];
const scene = createScene('服务端场景验收'); scene.id = 'ui_scene_document';
const background = await sharp({ create: { width: 512, height: 256, channels: 4, background: '#8bb1bf' } }).png().toBuffer();
const sourceZip = await new JSZip().file('fixture.txt', 'mock map source; not production artwork').generateAsync({ type: 'nodebuffer' });
scene.map = { name: '验收背景', origin: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, layers: [{ id: 'overall', name: '整体', source: dataUrl(background), width: 512, height: 256, locked: true, hidden: false, included: true }], collisions: [], source: `data:application/zip;base64,${sourceZip.toString('base64')}`, warnings: [] };
scene.order.push('overall');
const material = addMaterial(scene, project, object.definitionId); addInstance(scene, material.id, 150, 150);
if (process.env.WORKBENCH_UI_REFERENCES === '1') {
  const { draft } = await mapProjectFixture(background, 'ui-scene-source');
  draft.pending = [];
  const sourceTile = draft.snapshot.tiles[0];
  Object.assign(sourceTile, { x: 0, y: 0, w: 1, h: 1, feather: { top: 0, right: 0, bottom: 0, left: 0 } });
  for (const sourceImage of Object.values(sourceTile.images)) { sourceImage.width = 512; sourceImage.height = 256; }
  draft.snapshot.imageLocks = Object.fromEntries(Object.keys(draft.snapshot.imageLocks).map(layer => [layer, false]));
  draft.snapshot.activeMapLayer = 'overall';
  draft.snapshot.horizontalOverlapPercent = 0; draft.snapshot.verticalOverlapPercent = 0;
  scene.map.source = `data:application/zip;base64,${Buffer.from(await createMapProjectPackage(draft, background)).toString('base64')}`;
  Object.assign(scene.map.layers[0], { id: 'map_overall', locked: false });
  scene.order = scene.order.map(id => id === 'overall' ? 'map_overall' : id);
  scene.map.offset = { x: 35, y: 20 };
  scene.map.collisions = [structuredClone(draft.snapshot.shapes[0].points)];
  const first = scene.instances[0], oldId = first.id;
  first.id = 'ui_selected_instance'; first.name = '独立修改目标'; first.anchor = { x: 11, y: 55 };
  scene.order = scene.order.map(id => id === oldId ? first.id : id);
  const sibling = addInstance(scene, material.id, 330, 150), siblingId = sibling.id;
  sibling.id = 'ui_shared_sibling'; sibling.name = '保留原图实例';
  scene.order = scene.order.map(id => id === siblingId ? sibling.id : id);
}
if (process.env.WORKBENCH_UI_LINK_SMOKE === '1') {
  object.displayName = '验收拉杆'; object.activation.mode = 'external_request'; object.content.pages = [];
  scene.materials = []; scene.instances = []; scene.order = scene.order.filter(id => id === 'actor' || id === 'overall');
  const sourceMaterial = addMaterial(scene, project, object.definitionId);
  const sourceInstance = addInstance(scene, sourceMaterial.id, 150, 150), sourceId = sourceInstance.id;
  scene.order = scene.order.map(id => id === sourceId ? 'ui_lever' : id); sourceInstance.id = 'ui_lever'; sourceInstance.name = '验收拉杆';
  const target = structuredClone(project); target.projectId = 'ui_door_project'; target.name = '验收门项目';
  const door = target.objects[0]; door.definitionId = 'ui_door_definition'; door.displayName = '验收石门';
  door.behavior.states[0].appearance.visible = true; door.behavior.states[0].appearance.solidEnabled = true;
  door.behavior.states[1].appearance.visible = false; door.behavior.states[1].appearance.solidEnabled = false;
  const targetMaterial = addMaterial(scene, target, door.definitionId);
  const targetInstance = addInstance(scene, targetMaterial.id, 350, 150);
  scene.order = scene.order.map(id => id === targetInstance.id ? 'ui_door' : id); targetInstance.id = 'ui_door'; targetInstance.name = '验收石门';
}
const seeds = [{ kind: 'interactable', content: project, id: project.projectId }, { kind: 'scene', content: scene, id: scene.id }];
if (process.env.WORKBENCH_UI_AI_EDIT === '1') {
  const aiProject = structuredClone(project); aiProject.projectId = 'ui_ai_prop_project'; aiProject.name = '区域 AI mock 验收';
  const rgba = Buffer.alloc(1024 * 1024 * 4);
  for (let y = 256; y < 768; y++) for (let x = 256; x < 768; x++) rgba.set([73, 108, 143, 255], (y * 1024 + x) * 4);
  rgba.set([12, 25, 37, 0], 0); rgba.set([71, 93, 125, 1], 4);
  aiProject.assets[0].source = dataUrl(await sharp(rgba, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer());
  seeds.push({ kind: 'interactable', content: aiProject, id: aiProject.projectId });
}
for (const seed of seeds) {
  try { await bridge(`/v1/documents/${seed.id}`); }
  catch { await bridge('/v1/documents', { kind: seed.kind, content: seed.content, commandId: randomUUID() }); }
}
let editableMapId;
if (process.env.WORKBENCH_UI_IMAGE_EDIT === '1') {
  editableMapId = 'ui-image-edit-map';
  const { draft } = await mapProjectFixture(background, editableMapId);
  draft.pending = [];
  draft.snapshot.imageLocks = Object.fromEntries(Object.keys(draft.snapshot.imageLocks).map(layer => [layer, false]));
  draft.snapshot.activeMapLayer = 'overall'; draft.snapshot.editorPreferences.showImage = true;
  draft.snapshot.zoom = 1; draft.snapshot.pan = { x: 0, y: 0 };
  const tile = draft.snapshot.tiles[0]; tile.x = 0; tile.y = 0; tile.w = 1; tile.h = 1;
  for (const image of Object.values(tile.images)) { image.width = 512; image.height = 256; }
  const bytes = await createMapProjectPackage(draft, background);
  const existing = await fetch(`${bridgeUrl}/v1/map-stitcher/projects/${editableMapId}`);
  if (existing.status === 404) {
    const saved = await fetch(`${bridgeUrl}/v1/map-stitcher/projects/${editableMapId}`, { method: 'PUT', headers: { 'content-type': 'application/zip', 'x-map-revision': '0' }, body: bytes });
    if (!saved.ok) throw new Error(await saved.text());
  }
}
const resources = { vite: null };
const stop = async () => { child.kill(); await resources.vite?.close(); await new Promise(resolve => gateway.close(resolve)); process.exit(0); };
const vite = await createTestViteServer({
  root: repositoryRoot, configFile: false,
  css: { postcss: { plugins: [tailwindcss()] } }, resolve: { dedupe: ['react', 'react-dom'], alias: { '@': repositoryRoot, 'next/link': path.join(repositoryRoot, 'tests', 'helpers', 'next-link.tsx') } },
  // Scan this fixture's complete static graph before the first browser navigation.
  // The repository has other test HTML entries; cold discovery can otherwise replace
  // optimized React chunks while the initial page is still loading.
  optimizeDeps: { noDiscovery: false, entries: ['tests/image-assets/ui-smoke.html', ...(process.env.WORKBENCH_UI_IMAGE_EDIT === '1' ? ['tests/image-edit/workspace-regression.html', 'tests/image-edit/workspace-interaction.html'] : [])] },
  plugins: [react(), { name: 'isolated-image-document-smoke', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/__smoke/reload' && request.method === 'POST') { server.moduleGraph.invalidateAll(); return json(response, { reloaded: true }); }
      if (url.pathname === '/__smoke/status') return json(response, { run, providerCalls, clientErrors });
      if (url.pathname === '/__smoke/client-error') { try { clientErrors.push(JSON.parse(await readBody(request))); } catch {} return json(response, { ok: true }); }
      if (url.pathname === '/__smoke/stop' && request.method === 'POST') { json(response, { stopping: true }); setTimeout(() => void stop(), 50); return; }
      if (url.pathname === '/api/workbench/sprite-pipeline/jobs') return json(response, { jobs: [] });
      if (url.pathname === '/api/workbench/sprite-pipeline/health') return json(response, { ok: false, uiReady: false });
      if (url.pathname === '/api/workbench/assets' && request.method === 'GET') {
        const input = Object.fromEntries(url.searchParams);
        for (const key of ['offset', 'limit', 'candidateIndex', 'candidateCount']) if (key in input) input[key] = Number(input[key]);
        const upstream = await fetch(`${bridgeUrl}/v1/agent/${url.searchParams.has('assetId') ? 'asset' : 'assets'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        return json(response, await upstream.json(), upstream.status);
      }
      if (['/tools/interactable-editor', '/tools/scene-composer', '/tools/map-stitcher', '/assets'].includes(url.pathname)) request.url = `/tests/image-assets/ui-smoke.html${url.search}`;
      next();
    });
  } }],
  server: { host: '127.0.0.1', port: process.env.WORKBENCH_UI_SMOKE_PORT ? Number(process.env.WORKBENCH_UI_SMOKE_PORT) : await freePort(), strictPort: true, proxy: { '/api/workbench': { target: bridgeUrl, rewrite: requestPath => requestPath.startsWith('/api/workbench/image-edit/') ? requestPath.replace('/api/workbench/image-edit/', '/v1/agent/image-') : requestPath.startsWith('/api/workbench/frontend') ? requestPath.replace('/api/workbench/frontend', '/v1/frontend/heartbeat') : requestPath.replace('/api/workbench', '/v1') } } },
});
resources.vite = vite;
await vite.listen();
await vite.warmupRequest('/tests/image-assets/ui-smoke-client.tsx?smoke=2');
await vite.waitForRequestsIdle();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const info = { run, output, origin, bridgeUrl, gatewayUrl, projectId: project.projectId, objectId: object.definitionId, sceneId: scene.id, propUrl: `${origin}/tools/interactable-editor?document=${project.projectId}&object=${object.definitionId}`, sceneUrl: `${origin}/tools/scene-composer?document=${scene.id}`, mapUrl: editableMapId ? `${origin}/tools/map-stitcher?map=${editableMapId}` : `${origin}/tools/map-stitcher?origin=generate`, ...(editableMapId ? { mapProjectId: editableMapId } : {}) };
if (process.env.WORKBENCH_UI_AI_EDIT === '1') info.aiPropUrl = `${origin}/tools/interactable-editor?document=ui_ai_prop_project&object=ui_prop_object`;
await writeFile(path.join(output, 'fixture-info.json'), JSON.stringify(info, null, 2));
console.log(`Isolated UI smoke ready: ${JSON.stringify(info)}`);
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
