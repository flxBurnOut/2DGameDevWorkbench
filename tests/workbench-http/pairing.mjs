import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { localWorkspaceId } from '../../lib/workbench/workspace-identity.mjs';
import { forwardDocumentRequest } from '../../lib/workbench/document-client.mjs';
import { createTestViteServer } from '../helpers/vite-server.mjs';

let health = { service: '2d-game-workbench-runtime', version: 1 };
let legacy = true;
let redirect = false;
const requests = [];
let mutations = 0;
const bridge = createServer((req, res) => {
  requests.push([req.method, req.url]);
  let status = 200, body = {};
  if (req.url === '/health') body = health;
  else if (redirect) { res.writeHead(307, { location: '/v1/unpaired' }); res.end(); return; }
  else if (req.method === 'POST' && (req.url.startsWith('/v1/') ||
    (!legacy && req.url.startsWith('/paired/v1/') && req.headers['x-forge-workspace'] === localWorkspaceId))) mutations++;
  else status = 404;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}).listen(0, '127.0.0.1');
await once(bridge, 'listening');
const previous = process.env.WORKBENCH_RUNTIME_URL;
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
  redirect = true;
  assert.equal((await post()).status, 502);
  assert.equal(mutations, 2);
  redirect = false;
  // A replacement on the same port lacks the paired namespace even after a successful probe.
  legacy = true;
  assert.equal((await post()).status, 404);
  assert.equal(mutations, 2);
  console.log('PASS Web and Node bridge pairing across legacy, wrong workspace, wrong version and listener replacement');
} finally {
  if (previous === undefined) delete process.env.WORKBENCH_RUNTIME_URL;
  else process.env.WORKBENCH_RUNTIME_URL = previous;
  await vite?.close();
  await new Promise(resolve => bridge.close(resolve));
}
