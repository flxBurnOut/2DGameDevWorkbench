import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadManifest, repositoryRoot, agentRequest } from '../../lib/workbench/runtime.mjs';
import { frontendHeartbeat, frontendContext, previewPath, queuePresentation } from '../../lib/workbench/preview-follow.mjs';
import { followDecision, previewSnapshotPath } from '../../lib/workbench/preview-follow-client.mjs';

const manifest = await loadManifest();
const dir = path.resolve(repositoryRoot, manifest.workspace.presentationDirectory);
assert.match(dir, /test-runs/);
const present = (input) => agentRequest(manifest, 'present', input);
const context = (requestId) => frontendContext(repositoryRoot, manifest, { requestId });
const beat = (input) => frontendHeartbeat(repositoryRoot, manifest, input);
const page = { pageId: randomUUID(), viewPath: '/tools/interactable-editor', visible: true, focused: true, following: true,
  items: [{ id: 'object-draft', title: '灯塔交互物', capabilityId: 'interactable-editor' }], dirty: true, busy: false };
const before = await context();
assert.deepEqual(before.pages, []);
assert.equal(before.presentation, null);
for (const input of [{}, { taskId: 'x', capabilityId: 'reference-art' }, { capabilityId: 'unknown' },
  { capabilityId: 'reference-art', candidateIndex: 2 }, { capabilityId: 'reference-art', url: 'https://evil.invalid' }]) await assert.rejects(present(input));
for (const url of ['//evil.invalid', '/api/secret', '/tools/interactable-editor?apiKey=secret', '/tools/interactable-editor#secret', '/\\evil.invalid']) assert.throws(() => previewPath(manifest, url));
assert.equal(previewPath(manifest, '/tools/interactable-editor?imageTask=image-a'), '/tools/interactable-editor?imageTask=image-a');
assert.equal(previewPath(manifest, '/tools/interactable-editor?document=prop-a&imageEdit=edit-a&imageCandidate=2'), '/tools/interactable-editor?document=prop-a&imageCandidate=2&imageEdit=edit-a');
assert.equal(previewPath(manifest, '/tools/interactable-editor?document=shared-object'), '/tools/interactable-editor?document=shared-object');
await assert.rejects(beat({ ...page, pixels: 'unapproved draft upload' }));
const queued = await present({ capabilityId: 'reference-art' });
assert.equal(queued.state, 'waiting_for_frontend');
assert.equal(queued.displayed, false);
assert.equal(queued.createsTask, false);
const first = await beat(page);
assert.equal(first.request.id, queued.requestId);
assert.equal((await context()).pages[0].items[0].title, '灯塔交互物');
await assert.rejects(beat({ ...page, ack: { requestId: queued.requestId, state: 'displayed' } }), /not reached/);
const other = { ...page, pageId: randomUUID(), focused: false };
assert.equal((await beat(other)).request, null);
await assert.rejects(beat({ ...other, ack: { requestId: queued.requestId, state: 'blocked' } }), /does not belong/);
await beat({ ...page, ack: { requestId: queued.requestId, state: 'blocked', reason: 'editing' } });
assert.equal((await context(queued.requestId)).presentation.state, 'blocked');
await beat({ ...page, viewPath: queued.viewPath, dirty: false, ack: { requestId: queued.requestId, state: 'displayed', reason: 'page-arrived' } });
assert.equal((await context(queued.requestId)).presentation.displayed, true);
assert.equal((await present({ capabilityId: 'reference-art' })).requestId, queued.requestId);
await beat({ ...page, following: false });
const paused = await present({ capabilityId: 'interactable-editor' });
assert.equal(paused.state, 'paused');
assert.equal((await beat({ ...page, ack: { requestId: queued.requestId, state: 'displayed' } })).request.id, paused.requestId);
assert.equal((await context(queued.requestId)).presentation.state, 'displayed');
await beat({ ...page, following: true, ack: { requestId: paused.requestId, state: 'blocked', reason: 'save-failed' } });
assert.equal((await context()).presentation.reason, 'save-failed');
const decision = (extra) => followDecision({ currentPath: '/', targetPath: '/tools/reference-art?task=t', following: true, busy: false, editing: false, handled: false, ...extra });
assert.equal(decision({}), 'navigate');
assert.equal(decision({ following: false }), 'paused');
assert.equal(decision({ busy: true }), 'busy');
assert.equal(decision({ editing: true }), 'editing');
assert.equal(decision({ handled: true }), 'ignore');
assert.equal(decision({ currentPath: '/tools/sprite-generator?job=j&candidate=2', targetPath: '/tools/sprite-generator?candidate=2&job=j', busy: true }), 'displayed');

const identityManifest = { ...manifest, workspace: { ...manifest.workspace, presentationDirectory: `${manifest.workspace.presentationDirectory}/identities` } };
const identityPage = { ...page, pageId: randomUUID(), dirty: false };
for (const viewPath of [
  '/tools/sprite-generator?work=motion-a&version=2&candidate=1',
  '/tools/interactable-editor?document=prop-a&object=door-a&imageEdit=edit-a&imageCandidate=2',
  '/tools/interactable-editor?imageTask=image-a',
  '/assets?asset=image:source-a&imageEdit=edit-d&imageCandidate=2',
]) {
  const request = await queuePresentation(repositoryRoot, identityManifest, { viewPath, title: 'Exact preview identity', summary: 'Identity round trip' });
  const snapshotPath = previewSnapshotPath(`http://localhost${viewPath}&previewSession=private-session&apiKey=not-forwarded`);
  assert.equal(previewPath(identityManifest, snapshotPath), previewPath(identityManifest, viewPath));
  assert.equal(decision({ currentPath: snapshotPath, targetPath: viewPath }), 'displayed');
  await frontendHeartbeat(repositoryRoot, identityManifest, { ...identityPage, viewPath: snapshotPath, ack: { requestId: request.requestId, state: 'displayed', reason: 'page-arrived' } });
  assert.equal((await frontendContext(repositoryRoot, identityManifest, { requestId: request.requestId })).presentation.displayed, true);
}

const client = new Client({ name: 'preview-follow-test', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['scripts/workbench-mcp.mjs'], cwd: repositoryRoot, env: { ...process.env }, stderr: 'pipe' });
let httpChild;
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find((t) => t.name === 'workbench_present').annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === 'workbench_get_frontend_context').annotations.readOnlyHint, true);
  assert.match(client.getInstructions(), /workbench_present/);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    return response.structuredContent;
  };
  const template = await call('workbench_interactable_template', { name: '页面跟随验收物件' });
  const save = () => call('workbench_run_task', { capabilityId: 'interactable-editor', input: { operation: 'save-project', project: template.project } });
  const unarmed = await save();
  assert.equal(unarmed.frontendPresentation, undefined);
  const armed = await call('workbench_present', { capabilityId: 'interactable-editor' });
  assert.equal(armed.browserOpened, false);
  const saved = await save();
  assert.ok(saved.frontendPresentation.requestId);
  assert.match(saved.frontendPresentation.viewPath, /task=/);
  assert.equal(saved.frontendPresentation.displayed, false);
  const taskId = new URL(saved.presentation.viewUrl).searchParams.get('task');
  const polled = await call('workbench_get_task', { taskId });
  assert.equal(polled.frontendPresentation.requestId, saved.frontendPresentation.requestId);
  const result = await call('workbench_get_result', { taskId });
  assert.equal(result.frontendPresentation, undefined);
  assert.equal((await context()).presentation.requestId, saved.frontendPresentation.requestId);
  const crossProcess = await call('workbench_get_frontend_context', { requestId: saved.frontendPresentation.requestId });
  assert.equal(crossProcess.pages[0].items[0].title, '灯塔交互物');
  const taskNames = await readdir(path.resolve(repositoryRoot, manifest.workspace.taskDirectory));
  await call('workbench_present', { taskId });
  assert.deepEqual(await readdir(path.resolve(repositoryRoot, manifest.workspace.taskDirectory)), taskNames);
  // Exact native candidate resolution, including rejection of missing candidates, is tested in presentation/agent acceptance.

  const { createServer } = await import('node:net');
  const reserve = createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  httpChild = spawn(process.execPath, ['scripts/workbench-http.mjs'], { cwd: repositoryRoot, env: { ...process.env, WORKBENCH_RUNTIME_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { httpChild.stdout.on('data', (chunk) => { if (chunk.toString().includes('ready at')) resolve(); }); httpChild.once('error', reject); httpChild.once('exit', () => reject(new Error('Bridge exited'))); });
  const post = (route, body) => fetch('http://127.0.0.1:' + port + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const latest = (await context()).presentation;
  const arrived = await post('/v1/frontend/heartbeat', { ...page, dirty: false, viewPath: latest.viewPath, ack: { requestId: latest.requestId, state: 'displayed' } });
  assert.equal(arrived.status, 200);
  const checked = await (await post('/v1/agent/frontend-context', { requestId: latest.requestId })).json();
  assert.equal(checked.presentation.displayed, true);
  assert.equal((await post('/v1/frontend/heartbeat', { ...page, pageId: '../escape' })).status, 400);

  const latestFile = path.join(dir, 'latest.json');
  const expired = JSON.parse(await readFile(latestFile, 'utf8'));
  expired.expiresAt = Date.now() - 1;
  await writeFile(latestFile, JSON.stringify(expired));
  assert.equal((await beat(page)).request, null);
  const stale = JSON.parse(await readFile(path.join(dir, 'page-' + page.pageId + '.json'), 'utf8'));
  stale.updatedAt = Date.now() - 21_000;
  await writeFile(path.join(dir, 'page-' + page.pageId + '.json'), JSON.stringify(stale));
  assert.equal((await context()).pages.some((p) => p.pageId === page.pageId), false);
  console.log('Preview following passed: exact targets, acknowledgements, pause/dirty/busy guards, deduplication, MCP auto-follow, HTTP bridge, expiry; realPaidCalls=0.');
} finally { await client.close(); httpChild?.kill(); }
