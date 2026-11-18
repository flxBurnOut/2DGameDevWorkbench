import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  findCapability, loadManifest, publicTaskRecord, readTask, refreshTask, repositoryRoot,
  runConnector, validateInput,
} from '../../lib/workbench/runtime.mjs';

const execFile = promisify(execFileCallback);
const manifest = await loadManifest();
const capability = findCapability(manifest, 'sprite-generator');
const testDirectory = path.join(repositoryRoot, manifest.workspace.taskDirectory);
const workId = 'b'.repeat(32);
const jobId = 'same-native-job';
const frame = byte => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, byte]);
const hash = data => createHash('sha256').update(data).digest('hex');
const fixtures = [frame(1), frame(2)];
const input = { operation: 'generate-motion', openWorkId: workId, expectedRevision: 1, planSha256: '4'.repeat(64) };
const work = (status, revision, frames = []) => ({
  id: workId, revision: 1,
  job: { job_id: jobId, revision, status, candidates: [{ candidate_index: 1, status, frames }], export: null },
});
const evidence = fixtures.map((bytes, index) => ({ index, sha256: hash(bytes) }));
const marker = name => path.join(testDirectory, `.${name}`);
const writeMarker = name => writeFile(marker(name), '');
async function expectMarker(name) {
  for (let i = 0; i < 250; i++) {
    if (await stat(marker(name)).then(() => true, () => false)) return;
    await delay(20);
  }
  assert.fail(`Worker did not reach ${name}.`);
}

process.env.SPRITE_PIPELINE_API_URL = 'http://sprite-fixture.invalid';
if (process.argv[2] === '--worker') {
  const [, , , taskId, role] = process.argv;
  globalThis.fetch = async (_url, options) => {
    assert(!options.method || options.method === 'GET', 'Poll workers only read');
    await writeMarker(`${role}-entered`);
    if (role === 'old') await expectMarker('release-old');
    return Response.json(role === 'old' ? work('provider_pending', 2) : work('approved', 3));
  };
  await writeMarker(`${role}-ready`);
  const result = await refreshTask(manifest, taskId);
  assert(!result.refreshError, result.refreshError);
} else {
  await mkdir(testDirectory, { recursive: true });
  const calls = [];
  const accepted = work('review_required', 4, evidence);
  let wrongBytes = true;
  let lostResponse = false;
  let returnRaceJob = false;
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    const method = options.method || 'GET';
    calls.push({ method, target, options });
    if (target.pathname.endsWith('/generate') && method === 'POST')
      return Response.json(returnRaceJob ? work('provider_pending', 1) : accepted);
    if (target.pathname === '/v1/open-motion' && method === 'POST') {
      if (lostResponse) throw new TypeError('fixture connection closed after native acceptance');
      assert.fail('Unexpected plan POST.');
    }
    if (target.pathname.startsWith('/v1/open-motion/requests/') && method === 'GET')
      return Response.json({ id: workId, revision: 1, status: 'ready' });
    if (target.pathname === `/v1/open-motion/${workId}` && method === 'GET')
      return Response.json(accepted);
    const index = target.pathname.match(/\/frames\/(\d+)\/image$/)?.[1];
    if (index !== undefined) {
      assert.equal(target.searchParams.get('revision'), '4');
      assert.equal(target.searchParams.get('expected_sha256'), evidence[Number(index)].sha256);
      const bytes = wrongBytes && Number(index) === 1 ? frame(9) : fixtures[Number(index)];
      return new Response(bytes, { headers: { 'content-type': 'image/png' } });
    }
    assert.fail(`Unexpected request ${method} ${target.href}.`);
  };

  const interrupted = await runConnector(manifest, capability, input);
  assert.equal(interrupted.task.status, 'attention_required');
  assert.match(interrupted.refreshError, /读取期间发生变化/);
  const saved = await readTask(manifest, interrupted.task.id);
  assert.equal(saved.adapter.remoteJobId, jobId);
  assert.equal(saved.adapter.openWorkId, workId);
  assert.equal(saved.adapter.jobRevision, 4);
  assert.equal(saved.adapter.materializationPending, true);
  assert.deepEqual(saved.outputs, []);
  const output = path.join(repositoryRoot, manifest.workspace.outputDirectory, saved.id);
  assert.deepEqual(await readdir(path.join(output, 'artifacts')), [], 'A partial bundle is never published');

  wrongBytes = false;
  const beforeRetry = calls.length;
  const finished = await refreshTask(manifest, saved.id);
  assert.equal(finished.task.status, 'attention_required');
  assert(!finished.refreshError, finished.refreshError);
  assert.equal(finished.task.adapter.originalReceiptSha256, saved.adapter.originalReceiptSha256);
  assert(!finished.task.adapter.materializationPending);
  assert.deepEqual(calls.slice(beforeRetry).map(call => call.target.pathname.match(/\/frames\/\d+\/image$/) !== null), [true, true]);
  const frameFiles = finished.task.outputs.filter(file => file.endsWith('.png'));
  assert.deepEqual(await Promise.all(frameFiles.map(file => readFile(path.join(repositoryRoot, file)))), fixtures);
  const beforeNoop = calls.length;
  const unchanged = await refreshTask(manifest, saved.id);
  assert.equal(unchanged.task.updatedAt, finished.task.updatedAt);
  assert.equal(calls.length, beforeNoop + 1, 'An unchanged receipt only makes the metadata GET');

  const raceTask = await runConnector(manifest, capability, input, { commandId: 'race:original' });
  // Start a running job with the same capability and observe it from two Node processes.
  returnRaceJob = true;
  const { task: race } = await runConnector(manifest, capability, input, { commandId: 'race:polls' });
  assert.equal(race.status, 'running');
  assert.notEqual(race.id, raceTask.task.id);
  const workers = [];
  const startWorker = role => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', race.id, role],
      { env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker ${role} exited with ${code}: ${stderr}`)));
    });
    exited.catch(() => {});
    workers.push(child);
    return exited;
  };
  try {
    const old = startWorker('old');
    await expectMarker('old-entered');
    const fresh = startWorker('fresh');
    await expectMarker('fresh-ready');
    await delay(300);
    assert.equal(await stat(marker('fresh-entered')).then(() => true, () => false), false);
    await writeMarker('release-old');
    await Promise.all([old, fresh]);
    assert.equal((await readTask(manifest, race.id)).adapter.jobRevision, 3);
    assert.equal((await readTask(manifest, race.id)).status, 'completed');
  } finally { for (const child of workers) if (child.exitCode === null) child.kill(); }

  const plan = { operation: 'plan-motion', motionSpec: { object_id: 'test_fixture', description: 'Take one clear step' }, planningAuthorized: true };
  assert(validateInput(capability, { ...plan, motionSpec: { ...plan.motionSpec, budget: { max_generation_calls: 1000 } } }).length);
  assert(validateInput(capability, { ...plan, stray: 'forbidden' }).length);
  assert(validateInput(capability, JSON.parse('{"operation":"plan-motion","__proto__":{},"planningAuthorized":true,"motionSpec":{"object_id":"test_fixture","description":"Fixture"}}')).length);
  assert(validateInput(capability, { ...input, targetSetSha256: 'z'.repeat(64) }).some(message => /targetSetSha256/.test(message)));
  const adjustments = {
    operation: 'edit-motion-frames', openWorkId: workId, expectedRevision: 1, candidateIndex: 1,
    adjustmentToken: '0'.repeat(64), adjustmentRegions: [{ frame: 0, source_sha256: '0'.repeat(64),
      spans: [{ start: 0, length: 1, forbidden: true }] }], motionPalette: [{ from: '#000000', to: '#090909' }],
  };
  assert(validateInput(capability, adjustments).some(message => /forbidden/.test(message)));

  const args = ['scripts/workbench.mjs', 'prepare', 'sprite-generator', '--input-json', JSON.stringify(plan), '--command-id', 'motion:lost-response', '--json'];
  const prepared = JSON.parse((await execFile(process.execPath, args, { env: process.env })).stdout);
  assert.equal(prepared.status, 'prepared');
  lostResponse = true;
  const submitted = await runConnector(manifest, capability, plan, { commandId: 'motion:lost-response' });
  assert.equal(submitted.task.id, prepared.taskId);
  assert.equal(submitted.task.status, 'attention_required');
  assert.equal(submitted.task.adapter.nativeRequestKey, prepared.taskId);
  assert.equal(JSON.parse(calls.find(call => call.target.pathname === '/v1/open-motion').options.body).request_key, prepared.taskId);
  const replay = await runConnector(manifest, capability, plan, { commandId: 'motion:lost-response' });
  assert.equal(replay.task.id, prepared.taskId);
  assert.equal(replay.task.adapter.openWorkId, workId);
  assert.equal(replay.replayed, true);
  assert.equal(calls.filter(call => call.target.pathname === '/v1/open-motion' && call.method === 'POST').length, 1);
  await assert.rejects(runConnector(manifest, capability, { ...plan, autoExecute: true }, { commandId: 'motion:lost-response' }), { code: 'COMMAND_ID_REUSED' });
  const status = JSON.parse((await execFile(process.execPath,
    ['scripts/workbench.mjs', 'status', '--command-id', 'race:polls', '--detail', '--json'], { env: process.env })).stdout);
  assert.equal(status.id, race.id);
  assert.deepEqual(status.input, input);
  const redacted = publicTaskRecord({ input: { operation: 'process-image', image: 'data:image/png;base64,AAAA', references: ['data:image/png;base64,BBBB'] } });
  assert.deepEqual(redacted.input, { operation: 'process-image' });
  console.log('Native receipts, hash-bound bundle retries, unchanged polls, separate-process ordering, strict validation and durable command recovery passed.');
}
