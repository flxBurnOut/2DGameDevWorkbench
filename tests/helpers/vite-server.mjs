import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createServer } from 'vite';

// SSR-only test servers otherwise replace the live app's optimized dependency index.
// Each test process must own its cache, including concurrently running suites.
export function createTestViteServer(options) {
  return createServer({
    ...options,
    optimizeDeps: { noDiscovery: true, entries: [], ...options.optimizeDeps },
    // These suites load modules explicitly; watching runtime/test outputs creates needless file churn.
    server: { ...options.server, watch: null },
    cacheDir: path.resolve(
      options.root || process.cwd(),
      'work',
      'test-runs',
      `vite-${randomUUID()}`,
      'cache',
    ),
  });
}
