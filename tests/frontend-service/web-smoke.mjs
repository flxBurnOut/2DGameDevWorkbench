import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { workspaceIdentity } from '../../lib/workbench/workspace-identity.mjs';

const mode = process.argv[2];
assert.ok(['dev', 'production'].includes(mode), 'Choose dev or production (after npm run build).');
const lease = createServer().listen(0, '127.0.0.1');
await once(lease, 'listening');
const { port } = lease.address();
await new Promise(resolve => lease.close(resolve));
const origin = 'http://127.0.0.1:' + port;
const args = mode === 'dev'
  ? ['node_modules/vinext/dist/cli.js', 'dev', '--hostname', '127.0.0.1', '--port', String(port)]
  : ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'dist/server/wrangler.json', '--ip', '127.0.0.1', '--port', String(port), '--var', 'WORKBENCH_FRONTEND_URL:' + origin];
const child = spawn(process.execPath, args, { env: { ...process.env, WORKBENCH_TEST_RUN: 'smoke-' + randomUUID(),
  WORKBENCH_FRONTEND_URL: origin, WRANGLER_SEND_METRICS: 'false' },
  detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-10000); });
const done = once(child, 'exit');
try {
  const deadline = Date.now() + 90_000;
  let last;
  while (Date.now() < deadline && child.exitCode === null && !child.signalCode) {
    try {
      const response = await fetch(origin + '/api/workbench/health', { signal: AbortSignal.timeout(3000) });
      last = [response.status, await response.text()];
      if (response.ok && JSON.parse(last[1]).service === '2d-game-workbench-web') break;
    } catch (error) { last = String(error); }
    await delay(250);
  }
  assert.equal(last?.[0], 200, JSON.stringify(last) + '\n' + output);
  assert.equal(JSON.parse(last[1]).service, '2d-game-workbench-web');
  assert.equal(JSON.parse(last[1]).workspaceId, workspaceIdentity(process.cwd()));
  const page = await fetch(origin + '/', { signal: AbortSignal.timeout(45000) });
  assert.equal(page.status, 200, output);
  assert.match(await page.text(), /<html[\s>]/i);
  console.log('PASS ' + mode + ' health and rendered root route');
} finally {
  const pid = child.pid;
  if (pid && child.exitCode === null && !child.signalCode) {
    if (process.platform === 'win32') {
      const cleanup = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f']);
      await once(cleanup, 'exit');
    } else {
      process.kill(-pid, 'SIGTERM');
      const timeout = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 4000);
      try { await done; } finally { clearTimeout(timeout); }
    }
  }
}
