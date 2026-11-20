import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, utimes } from 'node:fs/promises';
import {
  probeFrontendService,
  startManagedFrontendProcess,
} from '../../lib/workbench/frontend-service.mjs';

const root = await mkdtemp(path.resolve('work/frontend-test-'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, service: 'test-web', version: 1, workspaceId: 'workspace-a' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/health`;
const probe = () => probeFrontendService(url, 'test-web');
assert.equal((await probe()).state, 'ready');
assert.equal((await probeFrontendService(url, 'test-web', 'workspace-a')).state, 'ready');
assert.equal((await probeFrontendService(url, 'test-web', 'workspace-b')).state, 'conflict');
assert.equal((await probeFrontendService(url, 'other-web')).state, 'conflict');
assert.equal(
  (
    await startManagedFrontendProcess(
      root,
      'reused',
      { args: ['missing.js'] },
      probe,
    )
  ).status,
  'reused',
);
assert.equal(
  (
    await startManagedFrontendProcess(
      root,
      'conflict',
      { args: ['missing.js'] },
      () => probeFrontendService(url, 'other-web'),
    )
  ).status,
  'blocked',
);
// A pooled HTTP connection can fail with a reset/socket error when the listener closes.
// Make these platform-dependent failures deterministic while exercising a real TCP port.
async function withFetchFailure(code, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', {
      cause:
        typeof code === 'string'
          ? Object.assign(new Error('socket closed'), { code })
          : code,
    });
  };
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}
for (const code of ['ECONNRESET', 'UND_ERR_SOCKET']) {
  await withFetchFailure(code, async () => {
    assert.equal(
      (await probe()).state,
      'unreachable',
      'a listening service must not be restarted',
    );
    assert.equal(
      (
        await startManagedFrontendProcess(
          root,
          'occupied-reset',
          { args: ['missing.js'] },
          probe,
        )
      ).status,
      'blocked',
    );
  });
}
await withFetchFailure(
  {
    code: 'ECONNREFUSED',
    errors: [{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }],
  },
  async () => {
    assert.equal(
      (await probe()).state,
      'unreachable',
      'one refused address does not prove all addresses are offline',
    );
  },
);
await new Promise((resolve) => server.close(resolve));
for (const code of ['ECONNRESET', 'UND_ERR_SOCKET']) {
  await withFetchFailure(code, async () => {
    assert.equal(
      (await probe()).state,
      'offline',
      'confirm the closed listener independently of pooled HTTP errors',
    );
  });
}
assert.equal((await probe()).state, 'offline');

const fixture = path.join(root, 'fixture.mjs');
await writeFile(
  fixture,
  `import http from 'node:http';
const server = http.createServer((req,res) => res.end(JSON.stringify({ok:true,service:'test-web'})));
setTimeout(() => server.listen(${port}, '127.0.0.1'), 500);
setTimeout(() => server.close(() => process.exit(0)), 20000);
`,
);
let pid;
try {
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      startManagedFrontendProcess(root, 'cold', { args: [fixture] }, probe),
    ),
  );
  const started = results.filter((r) => r.pid);
  assert.ok(started.length > 0);
  assert.equal(
    new Set(started.map((r) => r.pid)).size,
    1,
    'concurrent requests share one child',
  );
  pid = started[0].pid;
  assert.equal(
    (
      await startManagedFrontendProcess(
        root,
        'cold',
        { args: [fixture] },
        probe,
      )
    ).pid,
    pid,
  );
  const deadline = Date.now() + 10000;
  while ((await probe()).state !== 'ready' && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await probe()).state, 'ready');
  assert.equal(
    (
      await startManagedFrontendProcess(
        root,
        'cold',
        { args: [fixture] },
        probe,
      )
    ).status,
    'reused',
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(root, 'work/services/cold.json'), 'utf8'),
    ).pid,
    pid,
  );
  const lockPath = path.join(root, 'work/services/stale.lock');
  await writeFile(lockPath, JSON.stringify({ pid: 0 }));
  const old = new Date(Date.now() - 20000);
  await utimes(lockPath, old, old);
  assert.equal(
    (
      await startManagedFrontendProcess(
        root,
        'stale',
        { args: ['missing.js'] },
        probe,
      )
    ).status,
    'reused',
  );
} finally {
  if (pid) {
    try {
      process.kill(pid);
    } catch {}
  }
}
console.log(
  'Frontend service: identity, pooled socket failures, occupied-port protection, offline, cold start, concurrent reuse and stale lock checks passed.',
);
