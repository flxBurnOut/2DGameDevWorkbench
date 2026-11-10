import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const root = process.cwd();
const server = await createTestViteServer({
  root, configFile: false, plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'], alias: [
    { find: '@/components/workbench/workbench-provider', replacement: path.join(root, 'tests/image-assets/dimensions-fixture-provider.ts') },
    { find: '@', replacement: root },
  ] },
  optimizeDeps: { noDiscovery: false, entries: ['tests/image-assets/dimensions.html'] },
  server: { host: '127.0.0.1', port: 0, strictPort: true },
});
await server.listen();
console.log(`Image dimensions fixture ready: http://127.0.0.1:${server.httpServer.address().port}/tests/image-assets/dimensions.html`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void server.close().then(() => process.exit(0)));
