import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createProject, createObject } from '../../features/interactable-editor/contract.mjs';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';

// Fault gates exist only in these isolated child processes. Production modules
// are unchanged; every child also rejects all non-loopback fetch destinations.
const bootstrap = String.raw`
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    process.send?.({ type: 'forbidden-network', origin: url.origin });
    throw new Error('AI recovery tests forbid non-loopback network destinations.');
  }
  return nativeFetch(input, init);
};
const taskRoot = path.resolve(process.env.AI_RECOVERY_TASK_DIRECTORY);
const ledger = process.env.AI_RECOVERY_LEDGER ? path.resolve(process.env.AI_RECOVERY_LEDGER) : null;
const nativeRename = fs.rename;
let triggered = false, release;
fs.rename = async (from, to) => {
  const result = await nativeRename(from, to);
  const destination = path.resolve(to);
  let selected = false;
  if (!triggered && process.env.AI_RECOVERY_GATE === 'prepared')
    selected = path.dirname(destination) === taskRoot && destination.endsWith('.json');
  if (!triggered && process.env.AI_RECOVERY_GATE === 'task-identity' && destination === ledger) {
    const state = JSON.parse(await fs.readFile(destination, 'utf8'));
    selected = Boolean(state.taskId && !state.result);
  }
  if (selected) {
    triggered = true;
    const pending = new Promise(resolve => { release = resolve; });
    process.send?.({ type: 'fault-gate', destination });
    await pending;
  }
  return result;
};
const servers = [], nativeCreate = http.createServer;
http.createServer = (...args) => { const server = nativeCreate(...args); servers.push(server); return server; };
syncBuiltinESMExports();
process.on('message', message => {
  if (message === 'release') release?.();
  if (message === 'detach') {
    Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => {
      server.close(resolve); server.closeIdleConnections();
    }))).then(() => process.send?.({ type: 'detached' }));
  }
});
await import('./scripts/workbench-http.mjs');
`;

const manifest = await loadManifest();
const namespace = process.env.WORKBENCH_TEST_RUN;
for (const key of ['taskDirectory', 'documentDirectory', 'imageEditDirectory', 'outputDirectory'])
  assert.ok(manifest.workspace[key].includes('/test-runs/') && manifest.workspace[key].split('/').includes(namespace), `Unisolated ${key}`);
const taskDirectory = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
const editDirectory = path.resolve(repositoryRoot, manifest.workspace.imageEditDirectory);
const outputDirectory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory);
const reportDirectory = path.resolve(repositoryRoot, 'work/test-runs', namespace);
await mkdir(reportDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const ledgerFile = commandId => path.join(editDirectory, 'commands', `${hash(commandId)}.json`);
const taskFile = taskId => path.join(taskDirectory, `${taskId}.json`);
const countTasks = async () => (await readdir(taskDirectory).catch(error => {
  if (error.code === 'ENOENT') return []; throw error;
})).filter(name => name.endsWith('.json')).length;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(callback, label, timeoutMs = 20000) {
  const started = Date.now(); let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await callback(); if (latest) return latest;
    await wait(40);
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(latest)}`);
}
async function bounded(promise, label) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 20000); })]); }
  finally { clearTimeout(timeout); }
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
let assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const scenarios = [], forbiddenNetwork = [], children = new Set(), mockSlots = [], calls = [];
const width = 1024, height = 1024;
const originalPixels = Buffer.alloc(width * height * 4, 255);
originalPixels.set([9, 7, 5, 0], 0);
const png = await sharp(originalPixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
const drift = await sharp({ create: { width, height, channels: 4, background: '#39a588' } }).png().toBuffer();
const oldReference = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#e77721' } }).png().toBuffer();
const changedReference = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#112233' } }).png().toBuffer();
const referencePath = path.join(outputDirectory, 'recovery-reference.png');
await writeFile(referencePath, oldReference);
function slot() {
  let seen;
  const value = { seen: new Promise(resolve => { seen = resolve; }), resolveSeen: call => seen(call), response: null,
    release: () => { if (value.response && !value.response.destroyed) value.response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': `recovery-${calls.length}` }).end(JSON.stringify({ data: [{ b64_json: drift.toString('base64') }] })); },
    disconnect: () => value.response?.destroy(),
  };
  mockSlots.push(value); return value;
}
const provider = http.createServer(async (request, response) => {
  try {
    const mode = mockSlots.shift();
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const form = await new Request('http://127.0.0.1/mock', { method: 'POST', headers: { 'content-type': request.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
    const files = [];
    for (const file of form.getAll('image[]')) files.push({ sha256: hash(Buffer.from(await file.arrayBuffer())), name: file.name });
    const call = { path: request.url, size: form.get('size'), images: files, hasMask: Boolean(form.get('mask')) };
    calls.push(call);
    if (!mode) { response.writeHead(500).end(); return; }
    mode.response = response; mode.resolveSeen(call);
  } catch (error) { response.writeHead(500).end(); console.error(`Mock provider: ${error.message}`); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1/images/edits`;
const port = await freePort(), base = `http://127.0.0.1:${port}`;
let active, proxy;
async function start(gate, commandId) {
  const env = { ...process.env, WORKBENCH_RUNTIME_PORT: String(port), WORKBENCH_RUNTIME_URL: base,
    OPENAI_API_KEY: 'fixture-ai-recovery-no-real-key', MAP_STITCHER_IMAGE_PROVIDER: 'gpt-image-2.6', IMAGE_ASSETS_PROVIDER: 'gpt-image-2.6',
    MAP_STITCHER_OPENAI_API_URL: providerUrl, MAP_STITCHER_OPENAI_GENERATION_API_URL: providerUrl,
    AI_RECOVERY_TASK_DIRECTORY: taskDirectory, AI_RECOVERY_GATE: gate || '', AI_RECOVERY_LEDGER: commandId ? ledgerFile(commandId) : '',
  };
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: repositoryRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child); let stdout = '', stderr = '', fault, detached;
  const faultPromise = new Promise(resolve => { fault = resolve; });
  const detachedPromise = new Promise(resolve => { detached = resolve; });
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-5000); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-5000); });
  child.on('message', message => {
    if (message.type === 'fault-gate') fault(message);
    if (message.type === 'detached') detached();
    if (message.type === 'forbidden-network') forbiddenNetwork.push(message.origin);
  });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Bridge exited ${child.exitCode}: ${stderr} ${stdout}`);
    try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }, 'Bridge readiness');
  return { child, fault: faultPromise, release: () => child.send('release'), detach: async () => { child.send('detach'); await bounded(detachedPromise, 'old Bridge detached'); } };
}
async function stop(controller) {
  const child = controller?.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await bounded(exited, 'Bridge process exit');
  }
  if (child) children.delete(child);
}
async function post(operation, input, options = {}) {
  const response = await fetch(`${base}/v1/agent/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(20000), ...options });
  return { status: response.status, body: await response.json() };
}
async function success(operation, input) {
  const result = await post(operation, input);
  check(result.status, 200, `${operation}: ${JSON.stringify(result.body)}`); return result.body;
}
async function candidate(result, expected = 'completed') {
  return until(async () => {
    const value = await success('image-session-get', { editId: result.edit.editId });
    return value.edit.candidates.find(item => item.version === result.candidateVersion && item.status === expected);
  }, `candidate ${expected}`);
}
let guard, regionRef;
const input = (commandId, references) => ({ ...guard, regionRef, operation: { type: 'ai-edit', prompt: 'Change only the selected square to green.', ...(references ? { references } : {}) }, commandId });
try {
  active = await start();
  const object = createObject('inspect'); object.definitionId = 'recovery-prop'; object.visual.assetId = 'original';
  const project = { ...createProject(), projectId: 'ai-recovery-project', objects: [object], assets: [{ id: 'original', name: 'original.png', mime: 'image/png', source: `data:image/png;base64,${png.toString('base64')}` }] };
  await success('document-create', { kind: 'interactable', content: project, commandId: 'ai-recovery-create' });
  const inspection = await success('image-inspect', { target: { kind: 'interactable', documentId: project.projectId, definitionId: object.definitionId, slot: 'visual' } });
  guard = { targetId: inspection.target.targetId, expectedRevision: inspection.target.revision, expectedSha256: inspection.target.sha256 };
  regionRef = (await success('image-resolve', { ...guard, region: { type: 'rectangle', x: 128, y: 128, width: 128, height: 128 } })).regionRef;

  // A prepared task may exist, but the durable caller hook has not run. It must
  // stay an unknown submission rather than create a second task on restart.
  const beforeInput = input('ai-before-prepared-hook');
  await stop(active); active = await start('prepared', beforeInput.commandId);
  const interrupted = post('image-edit', beforeInput).catch(error => ({ disconnected: error.name }));
  await bounded(active.fault, 'prepared task before onPrepared');
  const beforeLedger = await readJson(ledgerFile(beforeInput.commandId));
  check(Boolean(beforeLedger.editId), true); check(beforeLedger.taskId, undefined); check(calls.length, 0);
  const preparedCount = await countTasks(); check(preparedCount, 1);
  await stop(active); await interrupted; active = await start();
  const beforeReplay = await post('image-edit', beforeInput);
  check(beforeReplay.status, 409); check(beforeReplay.body.code, 'IMAGE_SUBMISSION_UNKNOWN');
  check(await countTasks(), preparedCount); check(calls.length, 0);
  scenarios.push('crash before onPrepared: no provider, no replacement task');

  // Freeze references before the task hook returns, then mutate the caller's
  // file while execution is paused. The provider must still receive old bytes.
  const freezeInput = input('ai-frozen-reference', [path.relative(repositoryRoot, referencePath).replaceAll('\\', '/')]);
  await stop(active); active = await start('task-identity', freezeInput.commandId);
  const held = slot(), submitting = post('image-edit', freezeInput);
  await bounded(active.fault, 'durable task identity');
  const frozenLedger = await readJson(ledgerFile(freezeInput.commandId));
  const frozenTask = await readJson(taskFile(frozenLedger.taskId));
  check(frozenTask.input.operation, 'edit-image'); check(calls.length, 0);
  assert.ok(frozenTask.input.references[0].startsWith(manifest.workspace.imageEditDirectory)); assertions++;
  check(hash(await readFile(path.resolve(repositoryRoot, frozenTask.input.references[0]))), hash(oldReference));
  await writeFile(referencePath, changedReference); active.release();
  const freezeResult = await submitting; check(freezeResult.status, 200);
  const request = await bounded(held.seen, 'provider sees frozen reference');
  check(request.images[1].sha256, hash(oldReference)); check(request.hasMask, true); check(request.size, '1024x1024');
  held.release(); await candidate(freezeResult.body);
  const metadata = await readJson(path.join(outputDirectory, frozenLedger.taskId, 'image-metadata.json'));
  check(metadata.inputs.find(item => item.role === 'reference-01').sha256, hash(oldReference));
  // Simulate the last response/result write being absent after task completion.
  const incompleteLedger = await readJson(ledgerFile(freezeInput.commandId)); delete incompleteLedger.result;
  await writeFile(ledgerFile(freezeInput.commandId), JSON.stringify(incompleteLedger));
  const afterFreezeTasks = await countTasks();
  await stop(active); active = await start();
  const freezeReplays = await Promise.all(Array.from({ length: 4 }, () => success('image-edit', freezeInput)));
  for (const value of freezeReplays) { check(value.taskId, frozenLedger.taskId); check(value.status, 'completed'); check(value.replayed, true); }
  check(await countTasks(), afterFreezeTasks); check(calls.length, 1);
  scenarios.push('frozen reference survives caller mutation; completed task recovery and concurrent replay submit once');

  // The Bridge response is received by a proxy and lost to its caller. The
  // adapter continues, and the same command resumes its original task.
  const lostInput = input('ai-client-response-lost'), lostSlot = slot();
  let responseReceived;
  const received = new Promise(resolve => { responseReceived = resolve; });
  proxy = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const result = await post('image-edit', JSON.parse(Buffer.concat(chunks).toString('utf8')));
      responseReceived(result); // Deliberately never send the saved response.
      response.on('error', () => {});
    } catch (error) { responseReceived({ error: error.message }); }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const abort = new AbortController();
  const disconnected = fetch(`http://127.0.0.1:${proxy.address().port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lostInput), signal: abort.signal }).catch(error => error.name);
  const lostResponse = await bounded(received, 'Bridge response received before disconnect');
  check(lostResponse.status, 200); await bounded(lostSlot.seen, 'provider after caller disconnect');
  abort.abort(); check(await disconnected, 'AbortError');
  const lostReplay = await success('image-edit', lostInput); check(lostReplay.taskId, lostResponse.body.taskId);
  lostSlot.release(); await candidate(lostResponse.body);
  check((await success('image-edit', lostInput)).taskId, lostResponse.body.taskId); check(calls.length, 2);
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = null;
  scenarios.push('client response loss after persisted task: detached caller, one provider request');

  const networkInput = input('ai-provider-disconnected'), networkSlot = slot();
  const networkResult = await success('image-edit', networkInput);
  await bounded(networkSlot.seen, 'provider socket disconnect'); networkSlot.disconnect();
  await candidate(networkResult, 'attention_required');
  const uncertainTasks = await countTasks();
  await stop(active); active = await start();
  check((await success('image-edit', networkInput)).taskId, networkResult.taskId);
  check(await countTasks(), uncertainTasks); check(calls.length, 3);
  scenarios.push('provider disconnect remains uncertain across Bridge restart; no retry submission');

  const crashInput = input('ai-bridge-crash'), crashSlot = slot();
  const crashResult = await success('image-edit', crashInput);
  await bounded(crashSlot.seen, 'provider before Bridge crash');
  const crashTasks = await countTasks();
  await stop(active); crashSlot.release(); active = await start();
  const crashed = await candidate(crashResult, 'attention_required'); check(crashed.derivedState, true);
  check((await success('image-edit', crashInput)).taskId, crashResult.taskId);
  check(await countTasks(), crashTasks); check(calls.length, 4);
  const changed = await post('image-edit', { ...crashInput, operation: { type: 'ai-edit', prompt: 'Different request with the same command.' } });
  check(changed.status, 409); check(changed.body.code, 'COMMAND_ID_REUSED'); check(calls.length, 4);
  scenarios.push('Bridge crash after provider submission: derived attention, immutable command identity, no resubmission');

  // Detach the old listener while its bounded worker remains alive. An expired
  // observer lease must not overwrite the owner's later completion commit.
  const lateInput = input('ai-late-completion'), lateSlot = slot();
  const lateResult = await success('image-edit', lateInput);
  await bounded(lateSlot.seen, 'late worker provider request');
  const owner = active; await owner.detach(); active = await start();
  const leaseFile = path.join(outputDirectory, lateResult.taskId, '.background-lease.json');
  const lease = await readJson(leaseFile); await writeFile(leaseFile, JSON.stringify({ ...lease, heartbeatAt: 0 }));
  const lateAttention = await candidate(lateResult, 'attention_required'); check(lateAttention.derivedState, true);
  check((await readJson(taskFile(lateResult.taskId))).status, 'running', 'derived attention must not overwrite the active owner task');
  lateSlot.release(); await candidate(lateResult);
  check((await success('image-edit', lateInput)).taskId, lateResult.taskId);
  check((await readJson(taskFile(lateResult.taskId))).status, 'completed'); check(calls.length, 5);
  await stop(owner);
  scenarios.push('expired observer lease accepts late owner completion without another provider request');

  check((await success('document-get', { documentId: project.projectId })).document.revision, 1, 'no recovery scenario adopts into the source document');
  check(forbiddenNetwork, []);
  const report = { batch: '7C', test: 'image-edit-ai-recovery', assertions, mockProviderCalls: calls.length, realPaidCalls: 0, namespace, scenarios };
  await writeFile(path.join(reportDirectory, 'image-edit-ai-recovery.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  for (const child of children) await stop({ child });
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
