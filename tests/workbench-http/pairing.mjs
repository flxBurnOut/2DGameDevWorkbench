import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { localWorkspaceId } from '../../lib/workbench/workspace-identity.mjs';
import { forwardDocumentRequest } from '../../lib/workbench/document-client.mjs';
import { createTestViteServer } from '../helpers/vite-server.mjs';

let health = { service: '2d-game-workbench-runtime', version: 1 };
let legacy = true;
let redirect = false;
let paidId = 'a'.repeat(64);
let switchAfterProbe = false;
const requests = [];
let mutations = 0;
const bridge = createServer((req, res) => {
  requests.push([req.method, req.url]);
  // /remote models a reverse proxy for a separately configured Bridge installation.
  const route = req.url.replace(/^\/remote(?=\/)/, '');
  let status = 200, body = {};
  if (route === '/health' || (!legacy && route === '/paired/v1/health')) body = health;
  else if (!legacy && ['/v1/paid-workspace', '/paired/v1/v1/paid-workspace'].includes(route)) {
    body = { ...health, paidWorkspaceId: paidId };
    if (switchAfterProbe) paidId = 'c'.repeat(64);
  }
  else if (route.startsWith('/paired/v1/paid/v1/')) {
    if (legacy) status = 404;
    else if (req.headers['x-forge-paid-workspace'] !== paidId || req.headers['x-forge-workspace'] !== localWorkspaceId) status = 409;
    else {
      res.setHeader('x-forge-paid-workspace', paidId);
      if (req.method === 'POST') mutations++;
    }
  }
  else if (redirect) { res.writeHead(307, { location: '/v1/unpaired' }); res.end(); return; }
  else if (req.method === 'POST' && (route.startsWith('/v1/') ||
    (!legacy && route.startsWith('/paired/v1/') && req.headers['x-forge-workspace'] === localWorkspaceId))) mutations++;
  else status = 404;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}).listen(0, '127.0.0.1');
await once(bridge, 'listening');
const port = bridge.address().port;
const previous = process.env.WORKBENCH_RUNTIME_URL;
const previousId = process.env.WORKBENCH_RUNTIME_WORKSPACE_ID;
delete process.env.WORKBENCH_RUNTIME_WORKSPACE_ID;
process.env.WORKBENCH_RUNTIME_URL = 'http://127.0.0.1:' + bridge.address().port + '//';
let vite;
try {
  vite = await createTestViteServer({ configFile: false, appType: 'custom', logLevel: 'error',
    resolve: { alias: { '@': process.cwd() } }, define: { __FORGE_WORKSPACE_ID__: JSON.stringify(localWorkspaceId) },
    server: { middlewareMode: true, hmr: false } });
  const web = await vite.ssrLoadModule('/app/api/workbench/tasks/route.ts');
  const post = () => web.POST(new Request('http://localhost:3000/api/workbench/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }));
  const doc = () => forwardDocumentRequest('document-create', { kind: 'interactable', commandId: 'pairing-fixture' });
  for (const extra of [{}, { workspaceId: 'another-checkout' }, { workspaceId: localWorkspaceId, version: 0 }]) {
    health = { service: '2d-game-workbench-runtime', version: 1, ...extra };
    assert.equal((await post()).status, 409);
    await assert.rejects(doc(), { code: 'WORKSPACE_MISMATCH' });
  }
  assert.ok(requests.every(([method, route]) => method === 'GET' && route === '/health'));
  health = { service: '2d-game-workbench-runtime', version: 1, workspaceId: localWorkspaceId };
  legacy = false;
  assert.equal((await post()).status, 200);
  await doc();
  assert.equal(mutations, 2);
  const paid = await vite.ssrLoadModule('/app/api/workbench/paid-tasks/route.ts');
  const url = 'http://localhost:3000/api/workbench/paid-tasks';
  const paidPost = workspace => paid.POST(new Request(url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(workspace ? { 'x-forge-workspace': workspace } : {}) }, body: '{}' }));
  assert.equal((await (await paid.GET(new Request(url))).json()).workspaceId, paidId);
  const before = requests.length;
  for (const stale of [undefined, 'b'.repeat(64)]) {
    assert.equal((await paidPost(stale)).status, 409);
    assert.equal((await paid.GET(new Request(url + '?commandId=old', {
      headers: stale ? { 'x-forge-workspace': stale } : {} }))).status, 409);
  }
  assert.ok(requests.slice(before).every(([method, route]) => method === 'GET' && route.endsWith('/v1/paid-workspace')),
    'Mismatched requests never transmit the command ID or payload');
  assert.ok(requests.some(([method, route]) => method === 'POST' && route === '/paired/v1/v1/web/tasks'));
  assert.equal((await paidPost(localWorkspaceId)).status, 409, 'Older checkout-only journals are read-only');
  assert.equal((await paid.GET(new Request(url + '?commandId=old', { headers: { 'x-forge-workspace': localWorkspaceId } }))).status, 200);
  assert.equal((await paidPost(paidId)).status, 200);
  switchAfterProbe = true;
  assert.equal((await paidPost(paidId)).status, 409, 'Same checkout, different store after the probe');
  switchAfterProbe = false;
  assert.equal(mutations, 3);
  redirect = true;
  assert.equal((await post()).status, 502);
  assert.equal(mutations, 3);
  redirect = false;
  // A replacement on the same port lacks the paired namespace even after a successful probe.
  legacy = true;
  assert.equal((await post()).status, 404);
  assert.equal((await paidPost(paidId)).status, 409);
  assert.equal(mutations, 3);
  legacy = false;
  process.env.WORKBENCH_RUNTIME_URL = 'http://127.0.0.1:' + port + '/remote';
  assert.equal((await paidPost('a'.repeat(64))).status, 409, 'Remote checkout can share the same absolute source path');
  process.env.WORKBENCH_RUNTIME_WORKSPACE_ID = 'e'.repeat(64);
  assert.equal((await paidPost(paidId)).status, 409, 'Explicit checkout pairing is independent of the store pin');
  delete process.env.WORKBENCH_RUNTIME_WORKSPACE_ID;
  assert.equal((await paidPost(paidId)).status, 200);
  assert.equal(mutations, 4);
  console.log('PASS Web and Node bridge pairing across legacy, wrong workspace, wrong version and listener replacement');
} finally {
  if (previous === undefined) delete process.env.WORKBENCH_RUNTIME_URL;
  else process.env.WORKBENCH_RUNTIME_URL = previous;
  if (previousId === undefined) delete process.env.WORKBENCH_RUNTIME_WORKSPACE_ID;
  else process.env.WORKBENCH_RUNTIME_WORKSPACE_ID = previousId;
  await vite?.close();
  await new Promise(resolve => bridge.close(resolve));
}

// Reuse the exact source checkout and listening address with independent stores.
const base = 'http://127.0.0.1:' + port;
const first = 'pairing-' + randomUUID(), second = 'pairing-' + randomUUID();
const command = { capabilityId: 'sprite-generator', commandId: 'paired-restart-fixture',
  input: { operation: 'generate-existing', jobId: 'fixture', candidateIndex: 1 } };
const pinned = '/paired/v1/paid/v1/v1/tasks';
let child;
async function start(namespace) {
  child = spawn(process.execPath, ['scripts/workbench-http.mjs'], { env: { ...process.env, WORKBENCH_TEST_RUN: namespace,
    WORKBENCH_RUNTIME_PORT: String(port), SPRITE_PIPELINE_API_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw new Error('Bridge exited ' + code); })]);
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    await stopped;
  }
}
const probe = () => fetch(base + '/v1/paid-workspace').then(response => response.json());
const task = (route, id, post) => fetch(base + route, { method: post ? 'POST' : 'GET', headers: {
  'content-type': 'application/json', 'x-forge-workspace': localWorkspaceId, 'x-forge-paid-workspace': id,
}, ...(post && { body: JSON.stringify(command) }) });
try {
  await start(first);
  const store = path.resolve('work/test-runs', first);
  const marker = path.join(store, 'tasks/.paid-workspace-id');
  assert.equal((await (await fetch(base + '/health')).json()).workspaceId, localWorkspaceId);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  const probes = await Promise.all(Array.from({ length: 10 }, probe));
  const id = probes[0].paidWorkspaceId;
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.ok(probes.every(value => value.paidWorkspaceId === id));
  assert.equal((await task('/v1/tasks/prepare', id, true)).status, 200);
  await stop();
  await start(second);
  const other = await probe();
  assert.equal(other.workspaceId, localWorkspaceId);
  assert.notEqual(other.paidWorkspaceId, id);
  assert.equal((await task(pinned, id, true)).status, 409);
  assert.equal((await task('/v1/tasks?commandId=' + command.commandId, other.paidWorkspaceId, false)).status, 404);
  await stop();
  await start(first);
  assert.equal((await probe()).paidWorkspaceId, id);
  const receipt = await (await task(pinned + '?commandId=' + command.commandId, id, false)).json();
  assert.equal(receipt.task.commandId, command.commandId);
  assert.equal(receipt.task.status, 'prepared');
  for (const name of ['tasks', 'image-edits']) {
    const directory = path.join(store, name);
    await rename(directory, directory + '-original');
    assert.notEqual((await probe()).paidWorkspaceId, id);
    assert.equal((await task(pinned, id, true)).status, 409);
    await rename(directory, directory + '-empty');
    const redirected = directory + '-redirected';
    await mkdir(redirected);
    await symlink(redirected, directory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await fetch(base + '/v1/paid-workspace')).status, 503);
    await assert.rejects(access(path.join(redirected, '.paid-workspace-id')), { code: 'ENOENT' });
    await unlink(directory);
    await rename(directory + '-original', directory);
    assert.equal((await probe()).paidWorkspaceId, id);
  }
  await writeFile(marker, 'corrupt');
  assert.equal((await fetch(base + '/v1/paid-workspace')).status, 503);
  assert.equal((await task(pinned, id, true)).status, 503);
  assert.equal((await fetch(base + '/health')).status, 200);
  console.log('PASS real Bridge paid store pairing across restart, replacement and corrupted store identity');
} finally {
  await stop();
}
