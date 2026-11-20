import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';

import sharp from 'sharp';
import { loadManifest, agentRequest } from '../../lib/workbench/runtime.mjs';

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['scripts/workbench-http.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    WORKBENCH_RUNTIME_PORT: String(port),
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    TOKENHUB_API_KEY: '',
    IMAGE_ASSETS_PROVIDER: '',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${new URL('../helpers/mock-keychain.mjs', import.meta.url).href}`.trim(),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth(baseUrl);
  const health = await jsonFetch(`${baseUrl}/health`);
  assert.equal(health.ok, true);
  assert.equal(health.service, '2d-game-workbench-runtime');
  const webAi = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: { type: 'ai-edit' } }) };
  const legacyEdit = await fetch(baseUrl + '/v1/web/image-edit/local', webAi);
  assert.equal(legacyEdit.status, 409);
  assert.equal((await legacyEdit.json()).code, 'IMAGE_SUBMISSION_UNKNOWN');
  const editPath = '/v1/web/image-edit/paid';
  const paidEdit = '/paired/v1/paid/v1' + editPath;
  assert.equal((await fetch(baseUrl + paidEdit, webAi)).status, 409);
  assert.equal((await fetch(baseUrl + paidEdit, { ...webAi, headers: { ...webAi.headers, 'x-forge-workspace': 'b'.repeat(64) } })).status, 409);
  const checkoutHeaders = { ...webAi.headers, 'x-forge-workspace': health.workspaceId };
  assert.equal((await fetch(baseUrl + '/paired/v1' + editPath, { ...webAi, headers: checkoutHeaders })).status, 409);
  assert.equal((await fetch(baseUrl + paidEdit, { ...webAi, headers: checkoutHeaders })).status, 409);
  const paidIdentity = await jsonFetch(baseUrl + '/v1/paid-workspace');
  assert.equal((await fetch(baseUrl + paidEdit, { ...webAi, headers: {
    ...checkoutHeaders, 'x-forge-paid-workspace': paidIdentity.paidWorkspaceId,
  } })).status, 400,
    'The original workspace reaches input validation.');
  assert.equal((await fetch(baseUrl + '/v1/tasks', { headers: { 'x-forge-workspace': 'another-checkout' } })).status, 409);
  assert.equal((await fetch(baseUrl + '/v1/tasks?limit=0')).status, 400);
  assert.equal((await fetch(baseUrl + '/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  const oldTab = await fetch(baseUrl + '/v1/web/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'from-old-web', capabilityId: 'sprite-generator', input: { operation: 'generate-existing' } }) });
  assert.equal(oldTab.status, 409);
  assert.equal((await oldTab.json()).code, 'WORKSPACE_REQUIRED');
  assert.equal((await fetch(baseUrl + '/v1/tasks?commandId=from-old-web')).status, 404);
  const created = await jsonFetch(`${baseUrl}/v1/documents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'interactable', name: 'HTTP object', commandId: 'http-create' }) });
  const documentUrl = `${baseUrl}/v1/documents/${created.document.id}`;
  const apply = expectedRevision => fetch(`${documentUrl}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision, commandId: `http-rename-${expectedRevision}`, commands: [{ type: 'rename', name: 'Updated object' }] }) });
  assert.equal((await apply(1)).status, 200);
  const stale = await fetch(`${documentUrl}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, commandId: 'http-stale', commands: [{ type: 'rename', name: 'Stale' }] }) });
  assert.equal(stale.status, 409);
  assert.equal((await jsonFetch(documentUrl)).document.revision, 2);
  assert.equal((await jsonFetch(`${documentUrl}?revision=1`)).document.name, 'HTTP object');

  const guidanceResponse = await fetch(`${baseUrl}/v1/agent/guidance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(guidanceResponse.status, 200);
  assert.deepEqual(
    await guidanceResponse.json(),
    await agentRequest(await loadManifest(), 'guidance'),
  );
  const topicResponse = await fetch(`${baseUrl}/v1/agent/guidance`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'motion' }),
  });
  assert.equal(topicResponse.status, 200);
  assert.deepEqual(await topicResponse.json(), await agentRequest(await loadManifest(), 'guidance', { topic: 'motion' }));
  for (const input of [{ topic: '../SECURITY.md' }, { topic: 'missing-topic' }, { source: 'SECURITY.md' }]) {
    const invalid = await fetch(`${baseUrl}/v1/agent/guidance`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    assert.equal(invalid.status, 400);
  }

  const template = await fetch(`${baseUrl}/v1/agent/interactable-template`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'pickup', name: '钥匙' }),
  });
  assert.equal(template.status, 200);
  const templateValue = await template.json();
  assert.equal(templateValue.createsTask, false);
  assert.equal(templateValue.project.objects[0].behavior.kind, 'pickup');

  const initialSettings = await jsonFetch(
    `${baseUrl}/v1/image-assets/settings`,
  );
  assert.equal(initialSettings.active, false);
  assert.deepEqual(
    initialSettings.providers.map((provider) => provider.id),
    ['gpt-image-2.6'],
  );
  assert.equal(JSON.stringify(initialSettings).includes('apiKey'), false);

  for (const apiKey of ['test-密钥', 'test key', 'test\nkey']) {
    const invalid = await fetch(`${baseUrl}/v1/image-assets/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gpt-image-2.6', active: true, apiKey }),
    });
    assert.equal(invalid.status, 400);
    const rejected = await invalid.json();
    assert.match(rejected.error, /密钥格式无效/);
    assert.ok(!JSON.stringify(rejected).includes(apiKey));
    assert.deepEqual(await jsonFetch(`${baseUrl}/v1/image-assets/settings`), initialSettings);
  }

  const settingsResponse = await fetch(`${baseUrl}/v1/image-assets/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'gpt-image-2.6',
      active: true,
      apiKey: 'runtime-test-secret',
    }),
  });
  const savedSettings = await settingsResponse.json();
  assert.equal(settingsResponse.status, 200, savedSettings.error);
  assert.equal(savedSettings.active, true);
  assert.equal(savedSettings.provider, 'gpt-image-2.6');
  assert.equal(
    savedSettings.providers.find((provider) => provider.id === 'gpt-image-2.6')
      .configured,
    true,
  );
  assert.equal(
    JSON.stringify(savedSettings).includes('runtime-test-secret'),
    false,
  );

  const tile = await sharp({
    create: {
      width: 3,
      height: 3,
      channels: 4,
      background: { r: 220, g: 80, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const image = `data:image/png;base64,${tile.toString('base64')}`;
  const body = {
    commandId: 'http:process-image',
    capabilityId: 'image-assets',
    input: { operation: 'process-image', kind: 'prop', image, alphaCleanupThreshold: 0 },
  };
  const postTask = (suffix, value) => fetch(`${baseUrl}/v1/tasks${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  const preparation = await (await postTask('/prepare', body)).json();
  assert.equal(preparation.status, 'prepared');
  const response = await postTask('', body);
  assert.equal(response.status, 200);
  const task = await response.json();
  assert.equal(task.status, 'completed');
  assert.equal(task.taskId, preparation.taskId);
  const replay = await (await postTask('', body)).json();
  assert.equal(replay.taskId, task.taskId);
  assert.equal(replay.replayed, true);
  const conflict = await postTask('', { ...body, input: { ...body.input, alphaCleanupThreshold: 1 } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'COMMAND_ID_REUSED');
  const query = `/v1/tasks?commandId=${encodeURIComponent(body.commandId)}`;
  assert.equal((await jsonFetch(baseUrl + query)).task.input.image, undefined);
  assert.equal((await jsonFetch(baseUrl + query + '&detail=true')).task.input.image, image);
  const artifact = task.outputs.find((value) =>
    value.endsWith('/image.png'),
  );
  assert(artifact);
  const privateMarker = artifact.replace(/image\.png$/, '.task-publication.json');
  assert.equal((await fetch(baseUrl + '/v1/artifacts?path=' + encodeURIComponent(privateMarker))).status, 403);

  const tasks = await jsonFetch(`${baseUrl}/v1/tasks?limit=1`);
  assert.equal(tasks.tasks[0].id, task.taskId);
  assert.equal(tasks.tasks[0].input.image, undefined);
  const artifactResponse = await fetch(
    `${baseUrl}/v1/artifacts?path=${encodeURIComponent(artifact)}`,
  );
  assert.equal(artifactResponse.status, 200);
  assert.equal(artifactResponse.headers.get('content-type'), 'image/png');
  assert((await artifactResponse.arrayBuffer()).byteLength > 0);

  process.stdout.write(
    `${JSON.stringify({ runtimeBridge: 'ok', port, taskId: task.taskId, artifact }, null, 2)}\n`,
  );
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(stderr || `runtime bridge exited ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The bridge may still be importing native dependencies.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runtime bridge did not become ready: ${stderr}`);
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  assert.equal(response.status, 200);
  return response.json();
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
