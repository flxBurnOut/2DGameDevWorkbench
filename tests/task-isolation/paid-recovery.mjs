import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RequestJournal } from '../../features/editor-documents/request-journal.mjs';
import { submitPaidTask } from '../../features/workbench/paid-task.mjs';
import {
  commandTaskId, findCapability, loadManifest, publicTaskRecord, readTask, refreshTask,
  runConnector, summarizeTask, archiveTaskHistory, listTasks,
} from '../../lib/workbench/runtime.mjs';

const execFile = promisify(execFileCallback);
const manifest = await loadManifest();
const capability = findCapability(manifest, 'reference-art');
const payload = { capabilityId: capability.id, input: { operation: 'generate', prompt: '蓝色电池', subject: 'prop' } };
process.env.SPRITE_PIPELINE_API_URL = 'http://sprite-fixture.invalid';

if (process.argv[2] === '--interrupt') {
  const { task } = await runConnector(manifest, capability, payload.input, {
    ...(process.argv[3] ? { commandId: process.argv[3] } : {}),
    onPrepared: ({ task }) => { writeSync(1, `${JSON.stringify(task)}\n`); process.exit(); },
  });
  assert.fail(`Worker went past the ownership checkpoint: ${task.id}`);
} else {
  const rows = new Map();
  const store = {
    read: async key => structuredClone(rows.get(key)),
    update: async (key, change) => {
      const next = change(structuredClone(rows.get(key)));
      rows.set(key, structuredClone(next));
      return next;
    },
  };
  const journal = () => new RequestJournal({ scope: 'paid-task', documentId: 'reference-prop', store });
  const attempts = [];
  let disconnected = false, nativeOffline = false;
  globalThis.fetch = async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/v1/reference-art/settings') {
      if (nativeOffline) throw new TypeError('network unavailable');
      return Response.json({ configured: true });
    }
    if (route === '/v1/reference-art/jobs') {
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      const saved = await readTask(manifest, body.requestId);
      assert.equal(saved.execution.phase, 'submitting');
      assert.equal(saved.adapter.referenceRequestId, body.requestId);
      attempts.push(body);
      return Response.json({ requestId: body.requestId, status: 'running', jobId: `fixture-job-${attempts.length}` });
    }
    assert.fail(`Unexpected provider request ${route}`);
  };
  const originalWorkspace = 'a'.repeat(64), otherWorkspace = 'b'.repeat(64);
  let workspaceId = originalWorkspace, replaceAfterLookup = false;
  const posted = [];
  let disconnectAt = 'before';
  const browser = async (url, options) => {
    if (disconnected) throw new TypeError('offline');
    const query = new URL(url, 'http://fixture.invalid').searchParams;
    if (!options.method && !query.has('commandId')) return Response.json({ workspaceId });
    if (options.headers['x-forge-workspace'] !== workspaceId)
      return Response.json({ code: 'WORKSPACE_MISMATCH', error: '原任务属于另一份工作区。' }, { status: 409 });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual((await journal().pending()).request.input, body, 'the exact request is durable before sending');
      posted.push(body);
      if (disconnectAt === 'before') throw new TypeError('before bridge receipt');
      const result = await runConnector(manifest, capability, body.input, { commandId: body.commandId });
      if (disconnectAt === 'after') throw new TypeError('bridge reply lost');
      return Response.json(summarizeTask(result));
    }
    const commandId = new URL(url, 'http://fixture.invalid').searchParams.get('commandId');
    try {
      const result = await refreshTask(manifest, commandTaskId(commandId));
      return Response.json({ task: publicTaskRecord(result.task) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (replaceAfterLookup) workspaceId = otherWorkspace;
      return Response.json({ code: 'ENOENT' }, { status: 404 });
    }
  };
  await assert.rejects(submitPaidTask(journal(), payload, { request: browser }), /恢复原请求/);
  assert.equal(attempts.length, 0);
  const durable = await journal().pending();
  assert.equal(durable.workspaceId, originalWorkspace);
  workspaceId = otherWorkspace;
  await assert.rejects(submitPaidTask(journal(), undefined, { request: browser, resume: true }), /另一份工作区/);
  assert.deepEqual(await journal().pending(), durable);
  workspaceId = originalWorkspace;
  replaceAfterLookup = true;
  await assert.rejects(submitPaidTask(journal(), undefined, { request: browser, resume: true }), /另一份工作区/);
  assert.equal(posted.length, 1, 'A replacement between GET and POST cannot receive the original payload');
  replaceAfterLookup = false;
  workspaceId = originalWorkspace;
  disconnected = true;
  await assert.rejects(submitPaidTask(journal(), undefined, { request: browser, resume: true }), /暂时无法查询/);
  assert.equal(posted.length, 1, 'offline query cannot turn into a new attempt');
  disconnected = false;
  disconnectAt = 'after';
  const original = posted[0];
  await assert.rejects(submitPaidTask(journal(), undefined, { request: browser, resume: true }), /恢复原请求/);
  assert.deepEqual(posted[1], original, 'pre-send loss replays the same payload and command ID');
  assert.equal(attempts.length, 1);
  disconnectAt = null;
  const replay = await submitPaidTask(journal(), undefined, { request: browser, resume: true });
  assert.equal(replay.taskId, commandTaskId(original.commandId));
  assert.equal(attempts.length, 1, 'lost browser response recovers using only GET');
  await assert.rejects(runConnector(manifest, capability, { ...payload.input, prompt: 'different' }, { commandId: original.commandId }), { code: 'COMMAND_ID_REUSED' });
  const next = await submitPaidTask(journal(), payload, { request: browser });
  assert.notEqual(next.taskId, replay.taskId);
  assert.equal(attempts.length, 2, 'an explicit new generation gets a distinct receipt');

  let lookupCalls = 0;
  const absent = async (url, request) => {
    if (!new URL(url, 'http://fixture.invalid').searchParams.has('commandId')) return Response.json({ workspaceId });
    assert.notEqual(request.method, 'POST');
    lookupCalls++;
    return Response.json({ code: 'ENOENT' }, { status: 404 });
  };
  await assert.rejects(submitPaidTask(journal(), payload, { commandId: next.commandId, request: absent }), /已保存原任务回执/);
  assert.equal(lookupCalls, 1, 'The acknowledged receipt cannot become another submission if its record disappears.');
  assert.equal((await submitPaidTask(journal(), undefined, { request: browser, resume: true })).taskId, next.taskId);

  const legacy = new RequestJournal({ scope: 'paid-task', documentId: 'legacy-prop', store });
  const legacyRequest = { operation: 'run-task', input: { ...payload, commandId: 'legacy-unknown-receipt' } };
  await legacy.begin(legacyRequest);
  for (const tryAgain of [() => submitPaidTask(legacy, undefined, { request: browser, resume: true }),
    () => submitPaidTask(legacy, payload, { request: browser, commandId: legacyRequest.input.commandId })]) {
    await assert.rejects(tryAgain(), /旧请求缺少工作区身份/);
    assert.deepEqual((await legacy.pending()).request, legacyRequest);
  }
  await runConnector(manifest, capability, payload.input, { commandId: legacyRequest.input.commandId });
  assert.equal((await submitPaidTask(legacy, undefined, { request: browser, resume: true })).commandId, legacyRequest.input.commandId);
  assert.equal(await legacy.pending(), null);
  assert.equal(posted.length, 3, 'An unbound historical entry can only read an existing receipt');

  const checkoutJournal = new RequestJournal({ scope: 'paid-task', documentId: 'old-checkout', store });
  const oldCheckout = 'e'.repeat(64);
  await checkoutJournal.begin(legacyRequest, { workspaceId: oldCheckout });
  const readOnly = input => async (_url, options) => {
    assert.notEqual(options.method, 'POST');
    assert.equal(options.headers['x-forge-workspace'], oldCheckout);
    return Response.json(input, { status: input.task ? 200 : 404, headers: { 'x-forge-paid-workspace': workspaceId } });
  };
  for (const input of [{ code: 'ENOENT' }, { task: { status: 'prepared' } },
    { task: { id: 'wrong', commandId: legacyRequest.input.commandId, requestSha256: 'wrong' } }]) {
    await assert.rejects(submitPaidTask(checkoutJournal, undefined, { request: readOnly(input), resume: true }), /旧请求|任务参数/);
    assert.equal((await checkoutJournal.pending()).workspaceId, oldCheckout);
  }
  const existing = await readTask(manifest, commandTaskId(legacyRequest.input.commandId));
  assert.equal((await submitPaidTask(checkoutJournal, undefined, {
    request: readOnly({ task: publicTaskRecord(existing) }), resume: true,
  })).taskId, existing.id);

  nativeOffline = true;
  const offline = await runConnector(manifest, capability, payload.input, { commandId: 'provider-offline' });
  assert.equal(offline.task.status, 'awaiting_configuration');
  nativeOffline = false;
  assert.equal((await runConnector(manifest, capability, payload.input, { commandId: 'provider-offline' })).task.status, 'awaiting_configuration');
  assert.equal(attempts.length, 3, 'a confirmed offline result is stable on replay');

  for (const key of ['', 'interrupted-before-send']) {
    const { stdout } = await execFile(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', key], { env: process.env });
    const claimed = JSON.parse(stdout);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.execution.phase, 'preparing');
    assert.equal(typeof claimed.execution.owner.pid, 'number');
    assert.equal(typeof claimed.execution.owner.token, 'string');
    assert.equal((await refreshTask(manifest, claimed.id)).task.status, 'prepared');
    if (key) {
      const resumed = await runConnector(manifest, capability, payload.input, { commandId: key });
      assert.equal(resumed.task.id, claimed.id);
      assert.equal(resumed.replayed, true);
      assert.equal(attempts.at(-1).requestId, claimed.id);
    }
  }
  assert.equal(attempts.length, 4);
  assert.equal((await listTasks(manifest)).filter(task => task.status === 'prepared').length, 1);
  await assert.rejects(archiveTaskHistory(manifest), /仍在制作/);
  console.log('Browser command recovery, pre-send restart, offline reuse, explicit regeneration and immutable request conflicts passed with fixture calls only.');
}
