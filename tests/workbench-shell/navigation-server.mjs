// Isolated browser acceptance fixture: no bridge, model calls or production data.
// Start, then open the printed URL. Menu/focus, help, goal selection and each
// leave protection can be exercised against the actual WorkbenchProvider.
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const root = process.cwd();
const server = await createTestViteServer({
  root, configFile: false,
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { dedupe: ['react', 'react-dom'], alias: { '@': root, 'next/link': path.join(root, 'tests/helpers/next-link.tsx') } },
  optimizeDeps: { noDiscovery: false, entries: ['tests/workbench-shell/navigation.html'] },
  plugins: [react(), { name: 'navigation-fixture', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/workbench/')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ tasks: [], jobs: [], works: [], request: null })); return;
      }
      if (['/', '/player', '/scene', '/assets', '/advanced'].includes(url.pathname) || url.pathname.startsWith('/tools/')) request.url = `/tests/workbench-shell/navigation.html${url.search}`;
      next();
    });
  } }],
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
console.log(`Navigation fixture: http://127.0.0.1:${server.httpServer.address().port}/tools/map-stitcher?map=fixture&returnTo=%2Fassets%3Fkind%3Dmap%26offset%3D40%26asset%3Dfixture`);
process.on('SIGINT', async () => { await server.close(); process.exit(0); });
