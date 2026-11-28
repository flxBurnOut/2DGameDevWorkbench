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
  findCapability, loadManifest, persistTask, publicTaskRecord, readTask, refreshTask, repositoryRoot,
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

  const nativeCalls = [];
  const nativeJobs = new Map();
  const generationReceipts = new Map();
  const saveGeneration = (job, body) => {
    const receipt = { request_key: body.request_key, job_id: job.job_id, candidate_index: body.candidate_index ?? null,
      wait: body.wait, revision: job.revision, state: 'returned' };
    const data = { job: structuredClone(job), generation_receipt: receipt };
    generationReceipts.set(body.request_key, data);
    return data;
  };
  const readGeneration = key => generationReceipts.has(key)
    ? Response.json({ data: generationReceipts.get(key) }) : Response.json({}, { status: 404 });
  let boundary = 'generate', offline = false;
  globalThis.fetch = async (url, options) => {
    const route = new URL(url).pathname;
    const method = options.method || 'GET';
    nativeCalls.push([method, route]);
    if (offline) throw new TypeError('fixture native offline');
    const body = job => Response.json({ data: { job } });
    if (method === 'POST' && route === '/v1/jobs') {
      const request = JSON.parse(options.body);
      const job = { job_id: `job-for-${request.request_key}`, status: 'created', revision: 1, request,
        candidates: [{ candidate_index: 1, status: 'created', submission_attempts: 0 }] };
      nativeJobs.set(job.job_id, job);
      if (boundary === 'create') throw new TypeError('response closed after creating native job');
      return body(job);
    }
    if (method === 'GET' && route.startsWith('/v1/jobs/requests/')) {
      const key = route.split('/').at(-1);
      return body([...nativeJobs.values()].find(job => job.request.request_key === key));
    }
    if (route.startsWith('/v1/jobs/')) {
      const job = nativeJobs.get(route.split('/')[3]);
      assert(job);
      if (method === 'GET' && route.includes('/generation-requests/')) return readGeneration(route.split('/').at(-1));
      if (method === 'GET') return body(job);
      if (route.endsWith('/generate')) {
        job.status = 'provider_pending';
        job.revision += 1;
        job.candidates[0] = { candidate_index: 1, status: 'provider_pending', submission_attempts: 1, provider_job_id: 'provider-fixture' };
        saveGeneration(job, JSON.parse(options.body));
        throw new TypeError('response closed after paid acceptance');
      }
    }
    assert.fail(`Unexpected request ${method} ${route}`);
  };
  const createAndGenerate = { operation: 'create-and-generate', characterId: 'test_fixture', actionId: 'idle', provider: 'fixture' };
  const nativeClaim = await runConnector(manifest, capability, createAndGenerate, { commandId: 'job-after-acceptance' });
  assert.equal(nativeClaim.task.status, 'attention_required');
  assert.equal(nativeClaim.task.execution.phase, 'awaiting_receipt');
  const remoteId = nativeClaim.task.adapter.remoteJobId;
  offline = true;
  const offlineRefresh = await refreshTask(manifest, nativeClaim.task.id);
  assert.match(offlineRefresh.refreshError, /offline/);
  offline = false;
  const nativeReplay = await runConnector(manifest, capability, createAndGenerate, { commandId: 'job-after-acceptance' });
  assert.equal(nativeReplay.task.id, nativeClaim.task.id);
  assert.equal(nativeReplay.task.adapter.remoteJobId, remoteId);
  assert.equal(nativeReplay.task.status, 'running');
  assert.equal(nativeCalls.filter(([method]) => method === 'POST').length, 2);

  boundary = 'create';
  const lostFirst = await runConnector(manifest, capability, createAndGenerate, { commandId: 'job-created-reply-lost' });
  const firstReplay = await runConnector(manifest, capability, createAndGenerate, { commandId: 'job-created-reply-lost' });
  assert.equal(firstReplay.task.id, lostFirst.task.id);
  assert.equal(firstReplay.task.adapter.remoteJobId, `job-for-${lostFirst.task.id}`);
  assert.equal(firstReplay.task.status, 'attention_required');
  assert.match(firstReplay.task.error, /无法确认/);
  assert.equal(nativeCalls.filter(([method]) => method === 'POST').length, 3, 'Read-only lookup cannot begin generation for a merely created job');

  const resume = { operation: 'generate-existing', jobId: firstReplay.task.adapter.remoteJobId, candidateIndex: 1 };
  const existing = await runConnector(manifest, capability, resume, { commandId: 'existing-job-acceptance' });
  assert.equal(existing.task.status, 'attention_required');
  const existingRestored = await refreshTask(manifest, existing.task.id);
  assert.equal(existingRestored.task.adapter.remoteJobId, resume.jobId);
  assert.equal(existingRestored.task.status, 'running');
  assert.equal(nativeCalls.filter(([method]) => method === 'POST').length, 4);

  for (const mode of ['normal', 'reply-lost', 'legacy-422', 'other-command']) {
    let posts = 0, receiptBody;
    globalThis.fetch = async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname.includes('/generation-requests/')) return Response.json(receiptBody);
      if (options.method !== 'POST') return Response.json({ job: { job_id: jobId, revision: 1, status: 'created' } });
      assert.equal(++posts, 1);
      const command = JSON.parse(options.body);
      const row = { candidate_index: 2, stage_index: 1, submission_attempts: 1, provider_job_id: 'paid-stage-two', usage: { usd: 3.5 } };
      const receipt = { ...command, job_id: jobId, revision: 9, state: 'interrupted', error: 'invalid PNG', evidence: [row] };
      const job = { job_id: jobId, revision: 9, status: 'provider_pending', candidates: [{ candidate_index: 2,
        plan_execution: { stages: [{}, { provider_job_id: row.provider_job_id, usage: row.usage }] } }],
        events: [{ ...command, event: 'generation_command_progress', result_revision: 9,
          request_key: mode === 'other-command' ? 'another-command' : command.request_key, evidence: [row] }] };
      receiptBody = { data: { generation_receipt: receipt, job } };
      if (mode === 'reply-lost') throw new TypeError('response closed after paid validation failure');
      if (mode === 'legacy-422') return Response.json({ error: 'validation failed after polling' }, { status: 422 });
      return Response.json(receiptBody);
    };
    const action = { operation: 'generate-existing', jobId, candidateIndex: 2, wait: true };
    const first = await runConnector(manifest, capability, action, { commandId: 'generation-error-' + mode });
    const restored = await refreshTask(manifest, first.task.id);
    assert.equal(restored.task.status, 'attention_required');
    assert.equal(restored.task.execution.phase, 'awaiting_receipt');
    if (mode === 'other-command') assert.equal(restored.task.resultDigest, undefined);
    else {
      const record = JSON.parse(await readFile(path.join(repositoryRoot, restored.task.outputs[0]), 'utf8'));
      assert.equal(record.generationReceipt.state, 'interrupted');
      assert.equal(record.generationReceipt.revision, record.jobRecord.revision);
      assert.deepEqual(record.generationReceipt.evidence[0].usage, { usd: 3.5 });
      assert.equal(record.generationReceipt.evidence[0].provider_job_id, 'paid-stage-two');
    }
    assert.equal(posts, 1);
  }

  let quotaCalls = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method !== 'POST') return Response.json({ job: { job_id: jobId, revision: 1, status: 'created' } });
    quotaCalls++;
    const command = JSON.parse(options.body);
    const receipt = { ...command, job_id: jobId, revision: 3, state: 'rejected', submission_created: false, error: 'insufficient quota' };
    const job = { job_id: jobId, revision: 3, status: 'not_submitted', candidates: [{ candidate_index: 2, submission_attempts: 0 }],
      events: [{ ...command, event: 'generation_command_preflight', result_revision: 3 }] };
    return Response.json({ data: { generation_receipt: receipt, job } });
  };
  const quotaInput = { operation: 'generate-existing', jobId, candidateIndex: 2, wait: false };
  const noSpend = await runConnector(manifest, capability, quotaInput, { commandId: 'quota-preflight' });
  assert.equal(noSpend.task.status, 'not_submitted');
  assert.equal(noSpend.task.execution.phase, 'not_submitted');
  const quotaReport = JSON.parse(await readFile(path.join(repositoryRoot, noSpend.task.outputs[0]), 'utf8'));
  assert.equal(quotaReport.jobRecord.revision, quotaReport.generationReceipt.revision);
  assert.equal(quotaReport.jobRecord.candidates[0].submission_attempts, 0);
  assert.equal((await runConnector(manifest, capability, quotaInput, { commandId: 'quota-preflight' })).task.id, noSpend.task.id);
  assert.equal(quotaCalls, 1);

  const siblingJob = { job_id: 'sibling-candidates', revision: 1, status: 'created', generation_requested_at: null,
    candidates: [1, 2].map(candidate_index => ({ candidate_index, status: 'created', submission_attempts: 0 })) };
  let siblingPosts = 0;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.includes('/generation-requests/')) return readGeneration(path.split('/').at(-1));
    if (options.method === 'POST') {
      siblingPosts++;
      if (siblingPosts === 1) throw new TypeError('connection closed before command A arrived');
      const body = JSON.parse(options.body);
      siblingJob.status = 'provider_pending';
      siblingJob.revision++;
      siblingJob.generation_requested_at = '2026-11-01T12:03:04Z';
      Object.assign(siblingJob.candidates[body.candidate_index - 1], { status: 'provider_pending', submission_attempts: 1,
        provider_job_id: 'provider-' + body.request_key });
      saveGeneration(siblingJob, body);
      throw new TypeError('connection closed after the named command arrived');
    }
    assert.equal(path, '/v1/jobs/sibling-candidates');
    return Response.json({ job: siblingJob });
  };
  const specific = { operation: 'generate-existing', jobId: siblingJob.job_id, candidateIndex: 2 };
  const uncertain = await runConnector(manifest, capability, specific, { commandId: 'command-A-never-sent' });
  const expectUncertain = async () => {
    const result = await refreshTask(manifest, uncertain.task.id);
    assert.equal(result.task.execution.phase, 'awaiting_receipt', result.refreshError);
    assert.equal(result.task.adapter.nativeSubmissionPending, 'job-generation');
    return result.task;
  };
  for (const candidateIndex of [1, 2]) {
    const other = await runConnector(manifest, capability, { ...specific, candidateIndex },
      { commandId: 'command-B-candidate-' + candidateIndex });
    assert.equal((await refreshTask(manifest, other.task.id)).task.status, 'running');
    await expectUncertain();
  }
  const historical = await expectUncertain();
  delete historical.adapter.nativeGenerationKey;
  historical.adapter.nativeGenerationEvidence = JSON.stringify([null, [[2, 'created', 0, null]]]);
  await persistTask(manifest, historical);
  await expectUncertain();
  assert.equal(siblingPosts, 3, 'Neither foreign receipts nor legacy candidate progress can replay A');

  let revisionPosts = 0;
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    if (options.method === 'POST') {
      revisionPosts++;
      throw new TypeError('response closed after revision acceptance');
    }
    const key = target.pathname.split('/').at(-1);
    assert.equal(target.pathname, `/v1/open-motion/${workId}/requests/${key}`);
    return Response.json({ id: workId, revision: 2, current_revision: 3, request_key: key, status: 'ready',
      command_receipt: { version: 1, operation: 'revise', work_id: workId, work_revision: 2, current_revision: 3 } });
  };
  const revise = { ...plan, operation: 'revise-motion', openWorkId: workId, expectedRevision: 1 };
  const revised = await runConnector(manifest, capability, revise, { commandId: 'native-revise-lost' });
  assert.equal(revised.task.status, 'attention_required');
  const originalRevision = await runConnector(manifest, capability, revise, { commandId: 'native-revise-lost' });
  assert.equal(originalRevision.task.adapter.openWorkRevision, 2);
  assert.equal(originalRevision.task.adapter.commandReceipt.current_revision, 3);
  assert.equal(revisionPosts, 1);

  const targets = 'a'.repeat(64);
  let activationError = '';
  let generationPosts = 0;
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    if (options.method === 'POST') {
      generationPosts++;
      throw new TypeError('response closed after authorization');
    }
    assert.equal(target.pathname, `/v1/open-motion/${workId}`);
    assert.equal(target.searchParams.get('revision'), '1');
    return Response.json({ id: workId, revision: 1, status: 'ready', plan_sha256: input.planSha256, target_set_sha256: targets,
      execution_intent: { version: 1, revision: 1, phase: 'authorized', authorization: 'explicit', plan_sha256: input.planSha256,
        targets_sha256: targets, ...(activationError ? { activation_error: activationError } : {}) } });
  };
  const openGeneration = { ...input, targetSetSha256: targets };
  const openClaim = await runConnector(manifest, capability, openGeneration, { commandId: 'open-authorization-response-lost' });
  const openReceipt = await refreshTask(manifest, openClaim.task.id);
  assert.equal(openReceipt.task.status, 'running', 'An exact version with persisted authorization may wait for its original Job binding.');
  const openResult = JSON.parse(await readFile(path.join(repositoryRoot, openReceipt.task.outputs[0]), 'utf8'));
  assert.deepEqual(openResult.nextActions, ['get-motion']);
  activationError = 'fixture account mismatch';
  const blocked = await refreshTask(manifest, openClaim.task.id);
  assert.equal(blocked.task.status, 'attention_required');
  assert.equal(generationPosts, 1);
  for (const action of [{ operation: 'resume-motion', openWorkId: workId, expectedRevision: 1 },
    { operation: 'recover', jobId, candidateIndex: 1 }]) {
    let sent = 0;
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.method, 'POST');
      sent++;
      if (sent === 1) return Response.json(action.operation === 'resume-motion' ? work('provider_pending', 2)
        : { job: work('provider_pending', 2).job });
      throw new TypeError('response closed after command');
    };
    const returned = await runConnector(manifest, capability, action);
    assert.equal(returned.task.status, 'running');
    const old = await runConnector(manifest, capability, action, { commandId: 'lost-' + action.operation });
    assert.equal(old.task.execution.phase, 'awaiting_receipt');
    const check = await runConnector(manifest, capability, action, { commandId: old.task.command.id });
    assert.equal(check.task.status, 'attention_required');
    assert.equal(check.task.execution.phase, 'awaiting_receipt');
    assert.equal(sent, 2);
  }
  console.log('Native receipts, hash-bound bundle retries, unchanged polls, separate-process ordering, strict validation and durable command recovery passed.');
}
