// Browser fixture with a complete request stub: never contacts a game or Bridge.
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const root = process.cwd();
const server = await createTestViteServer({
  root, configFile: false,
  plugins: [react(), { name: 'history-fixture', configureServer(vite) {
    vite.middlewares.use((request, _response, next) => {
      if (request.url.startsWith('/advanced')) request.url = '/tests/game-export/history.html' + (request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '');
      next();
    });
  } }],
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { dedupe: ['react', 'react-dom'], alias: { '@': root } },
  optimizeDeps: { noDiscovery: false, entries: ['tests/game-export/history.html'] },
  server: { host: '127.0.0.1', port: 5217 },
});
await server.listen();
console.log(`Game history fixture: http://127.0.0.1:${server.httpServer.address().port}/advanced?tab=deliveries&delivery=delivery-${(24).toString(16).padStart(32, '0')}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void server.close().then(() => process.exit(0)));
