import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { listGameExports, readGameExportSummary } from '../../lib/workbench/game-export.mjs';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const manifest = await loadManifest();
const records = path.join(repositoryRoot, manifest.workspace.gameExportDirectory);
await mkdir(records, { recursive: true });
const fixtures = Array.from({ length: 25 }, (_, index) => ({
  format: 'forge-game-delivery', version: 1,
  deliveryId: `delivery-${index.toString(16).padStart(32, '0')}`,
  title: `隔离交付 ${index + 1}`,
  createdAt: new Date(Date.UTC(2026, 0, 25 - index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 25 - index)).toISOString(),
  status: index === 0 ? 'integrated' : 'awaiting_agent',
  project: { name: '离线夹具项目', path: path.join(records, 'absent-game') },
  package: { kind: 'animation', packageId: `test-${index}`, details: { animation: 'idle', candidateIndex: 2, frameCount: 8, fps: 12, loop: true } },
  packageSha256: 'a'.repeat(64), inboxPath: path.join(records, 'absent-game', 'forge_imports', String(index)),
  integration: index === 0 ? { summary: '仅验证保存的历史；未运行引擎。', files: [], engine: { status: 'not_run', evidence: '测试夹具' } } : null,
}));
for (const fixture of fixtures) await writeFile(path.join(records, fixture.deliveryId + '.json'), JSON.stringify(fixture));
const first = await listGameExports(repositoryRoot, manifest, { pendingOnly: false });
assert.equal(first.deliveries.length, 20);
assert.equal(first.total, 25);
const second = await listGameExports(repositoryRoot, manifest, { pendingOnly: false, offset: first.nextOffset, snapshot: first.snapshot });
assert.equal(second.deliveries.length, 5);
assert.equal(second.nextOffset, null);
assert.equal((await listGameExports(repositoryRoot, manifest)).total, 24);
const exact = await readGameExportSummary(repositoryRoot, manifest, { deliveryId: fixtures[24].deliveryId });
assert.equal(exact.title, '隔离交付 25');
assert.equal(exact.package.details.animation, 'idle');
assert.equal(exact.project.path, fixtures[24].project.path, 'saved records remain readable without inspecting an unavailable game');
await assert.rejects(() => readGameExportSummary(repositoryRoot, manifest, { deliveryId: '../outside' }), /无效/);
fixtures[0].updatedAt = '2026-02-01T00:00:00.000Z';
await writeFile(path.join(records, fixtures[0].deliveryId + '.json'), JSON.stringify(fixtures[0]));
await assert.rejects(() => listGameExports(repositoryRoot, manifest, { pendingOnly: false, offset: 20, snapshot: first.snapshot }), (error) => error.status === 409);

const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const child = spawn(process.execPath, ['scripts/workbench-http.mjs'], {
  cwd: repositoryRoot, env: { ...process.env, WORKBENCH_RUNTIME_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
});
const runtimeUrl = `http://127.0.0.1:${port}`;
const previousRuntime = process.env.WORKBENCH_RUNTIME_URL;
let vite;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('History test bridge did not start.')), 15000);
    child.stdout.on('data', (data) => { if (String(data).includes('ready at')) { clearTimeout(timeout); resolve(); } });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', () => { clearTimeout(timeout); reject(new Error('History test bridge exited.')); });
  });
  const before = await readdir(records);
  const bytesBefore = await Promise.all(before.map((file) => readFile(path.join(records, file))));
  const listing = await (await fetch(`${runtimeUrl}/v1/game-export/history?pendingOnly=false&offset=20&limit=20`)).json();
  assert.equal(listing.deliveries.length, 5);
  const record = await fetch(`${runtimeUrl}/v1/game-export/record?deliveryId=${fixtures[24].deliveryId}`);
  assert.equal(record.status, 200);
  assert.equal((await record.json()).deliveryId, fixtures[24].deliveryId);
  assert.equal((await fetch(`${runtimeUrl}/v1/game-export/history?pendingOnly=anything`)).status, 400);
  assert.equal((await fetch(`${runtimeUrl}/v1/game-export/history?offset=-1`)).status, 400);
  assert.equal((await fetch(`${runtimeUrl}/v1/game-export/record?deliveryId=..%2Fescape`)).status, 400);
  assert.equal((await fetch(`${runtimeUrl}/v1/game-export/record?deliveryId=delivery-${'f'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${runtimeUrl}/v1/game-export/history?snapshot=${first.snapshot}`)).status, 409);
  assert.deepEqual(await readdir(records), before, 'read-only HTTP does not create a delivery');
  assert.deepEqual(await Promise.all(before.map((file) => readFile(path.join(records, file)))), bytesBefore);
  process.env.WORKBENCH_RUNTIME_URL = runtimeUrl;
  vite = await createTestViteServer({ configFile: false, appType: 'custom', resolve: { alias: { '@': repositoryRoot } }, server: { middlewareMode: true }, logLevel: 'error' });
  const proxy = await vite.ssrLoadModule('/app/api/workbench/game-export/[action]/route.ts');
  const forwarded = await proxy.GET(new Request('http://localhost:3000/api/workbench/game-export/history?pendingOnly=false&offset=20&limit=20'));
  assert.equal(forwarded.status, 200);
  assert.equal((await forwarded.json()).deliveries.length, 5, 'the Web proxy preserves pagination query parameters');
  const detail = await proxy.GET(new Request(`http://localhost:3000/api/workbench/game-export/record?deliveryId=${fixtures[24].deliveryId}`));
  assert.equal((await detail.json()).title, '隔离交付 25');
  assert.equal((await proxy.GET(new Request('http://localhost:3000/api/workbench/game-export/history', { headers: { origin: 'https://unrelated.invalid' } }))).status, 403);
  console.log('Game delivery history: pagination, exact old records, offline destinations, snapshot conflicts, read-only HTTP and Web proxy passed.');
} finally {
  child.kill();
  await vite?.close();
  if (previousRuntime === undefined) delete process.env.WORKBENCH_RUNTIME_URL;
  else process.env.WORKBENCH_RUNTIME_URL = previousRuntime;
}
