// Dedicated-origin fixture: every service response is synthetic metadata. No
// production files, document mutations, tasks, models or engine calls.
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { createTestViteServer } from '../helpers/vite-server.mjs';
const root = process.cwd();
let mode = 'ready';
const calls = [];
const server = await createTestViteServer({
  root, configFile: false, css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { dedupe: ['react', 'react-dom'], alias: { '@': root, 'next/link': path.join(root, 'tests/helpers/next-link.tsx') } },
  optimizeDeps: { noDiscovery: false, entries: ['tests/editor-documents/library.html'] },
  plugins: [react(), { name: 'shared-project-fixture', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      const url = new URL(request.url, 'http://localhost');
      const send = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/__service') { mode = url.searchParams.get('mode') || 'ready'; send({ mode }); return; }
      if (url.pathname === '/__calls') { send(calls); return; }
      if (url.pathname === '/api/workbench/documents') {
        calls.push({ method: request.method, pathname: url.pathname, search: url.search });
        if (request.method !== 'GET') { send({ error: 'Fixture is read-only' }, 405); return; }
        if (mode === 'error') { send({ error: '验收：共享服务暂不可读' }, 503); return; }
        const kind = url.searchParams.get('kind') || 'scene', offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100);
        const documents = Array.from({ length: 238 }, (_, index) => ({ id: `${kind}-${index}`, kind, revision: 1, name: `${kind === 'scene' ? '共享场景' : '共享交互物'} ${index}`, createdAt: '2026-10-29T12:00:00Z', updatedAt: '2026-10-30T12:00:00Z', viewPath: '/ignored-remote-path' }));
        const result = { documents: documents.slice(offset, offset + limit), total: documents.length, nextOffset: offset + limit < documents.length ? offset + limit : null };
        if (mode === 'slow') setTimeout(() => { if (!response.destroyed) send(result); }, 1500); else send(result);
        return;
      }
      if (url.pathname.startsWith('/api/workbench/')) { send({ tasks: [], jobs: [], works: [], request: null }); return; }
      if (url.pathname === '/tools/scene-composer') request.url = `/tests/editor-documents/library.html${url.search}`;
      next();
    });
  } }],
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
console.log(`Shared projects fixture: http://127.0.0.1:${server.httpServer.address().port}/tools/scene-composer`);
process.on('SIGINT', async () => { await server.close(); process.exit(0); });
