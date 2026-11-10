// Actual package/catalog logic with isolated storage; other service calls stubbed.
import '../helpers/runtime-workspace.mjs';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createTestViteServer } from '../helpers/vite-server.mjs';
import { loadManifest } from '../../lib/workbench/runtime.mjs';
import { inspectAssetPackage, commitAssetPackages, readAssetPackagePreview } from '../../lib/workbench/asset-packages.mjs';
import { listAssets, getAsset, readAssetPreview, buildAssetArchive, manageAssets } from '../../lib/workbench/asset-catalog.mjs';
const root = process.cwd(), manifest = await loadManifest();
const fixturePath = path.join(root, 'work/test-runs', process.env.WORKBENCH_TEST_RUN, 'browser-legacy-assets.zip');
const pack = new JSZip();
for (const [i, color] of ['#ff8833', '#3366cc'].entries()) {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
  pack.file(`animation/走路-12345678/frames/frame_00${i}.png`, bytes);
  if (!i) pack.file('prop/灯笼-87654321/prop.png', bytes);
}
pack.file('animation/走路-12345678/素材说明.txt', '走路\n播放速度：8 FPS\n');
await mkdir(path.dirname(fixturePath), { recursive: true });
await writeFile(fixturePath, await pack.generateAsync({ type: 'nodebuffer' }));
let suppressCommitResponse = true;
const server = await createTestViteServer({ root, configFile: false, css: { postcss: { plugins: [tailwindcss()] } }, resolve: { dedupe: ['react', 'react-dom'], alias: { '@': root, 'next/link': path.join(root, 'tests/helpers/next-link.tsx') } }, optimizeDeps: { noDiscovery: false, entries: ['tests/asset-navigation/browser.html'] }, plugins: [react(), { name: 'asset-fixture', configureServer(vite) {
  vite.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (data, mime = 'application/json') => { response.writeHead(200, { 'content-type': mime }); response.end(Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
    try {
      if (url.pathname === '/native/v1/artworks') { send({ data: { assets: [] } }); return; }
      if (url.pathname.startsWith('/api/workbench/')) {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const input = () => JSON.parse(bytes.toString());
        if (url.pathname.endsWith('/packages/inspect')) send(await inspectAssetPackage(root, manifest, { bytes, filename: decodeURIComponent(request.headers['x-forge-filename'] || 'assets.zip') }));
        else if (url.pathname.endsWith('/packages/commit')) {
          const result = await commitAssetPackages(root, manifest, input());
          // First response is intentionally lost: UI must replay the same request.
          if (suppressCommitResponse) { suppressCommitResponse = false; response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '验收：服务器已入库，但首次回执中断。请恢复原请求。' })); }
          else send(result);
        }
        else if (url.pathname.endsWith('/packages/preview')) { const result = await readAssetPackagePreview(root, manifest, { ...Object.fromEntries(url.searchParams), frame: Number(url.searchParams.get('frame') || 0) }); send(result.bytes, result.mime); }
        else if (url.pathname.endsWith('/assets/preview')) { const result = await readAssetPreview(manifest, url.searchParams.get('assetId')); send(result.bytes, result.mime); }
        else if (url.pathname.endsWith('/assets/download')) { const result = await buildAssetArchive(manifest, input()); send(result.bytes, 'application/zip'); }
        else if (url.pathname.endsWith('/assets/manage')) send(await manageAssets(manifest, input()));
        else if (url.pathname.endsWith('/assets')) {
          if (url.searchParams.has('assetId')) send(await getAsset(manifest, { assetId: url.searchParams.get('assetId') }));
          else { const params = Object.fromEntries(url.searchParams); for (const key of ['offset', 'limit']) if (key in params) params[key] = Number(params[key]); send(await listAssets(manifest, params)); }
        } else send({ tasks: [], jobs: [], works: [], request: null });
        return;
      }
      if (url.pathname === '/assets') request.url = '/tests/asset-navigation/browser.html' + url.search;
      next();
    } catch (error) { response.writeHead(error.status || 400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
  });
} }], server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
process.env.SPRITE_PIPELINE_API_URL = origin + '/native';
console.log(JSON.stringify({ url: origin + '/assets?import=package', file: fixturePath }));
process.on('SIGINT', async () => { await server.close(); process.exit(0); });
