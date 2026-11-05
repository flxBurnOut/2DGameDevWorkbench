import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';

import sharp from 'sharp';
import { mapProjectFixture } from '../helpers/map-project.mjs';
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
    MAP_STITCHER_IMAGE_PROVIDER: '',
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
  const projectPng = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#abcdef' } }).png().toBuffer();
  const { bytes: projectBytes } = await mapProjectFixture(projectPng, 'map:http');
  const projectUrl = `${baseUrl}/v1/map-stitcher/projects/map%3Ahttp`;
  assert.equal((await fetch(projectUrl)).status, 404);
  const saveProject = (revision) => fetch(projectUrl, { method: 'PUT',
    headers: { 'content-type': 'application/zip', 'x-map-revision': String(revision) }, body: projectBytes });
  assert.equal((await saveProject(0)).status, 200);
  assert.equal((await saveProject(0)).status, 409);
  const projectRead = await fetch(projectUrl);
  assert.equal(projectRead.status, 200);
  assert.equal(projectRead.headers.get('x-map-revision'), '1');
  assert.deepEqual(Buffer.from(await projectRead.arrayBuffer()), Buffer.from(projectBytes));

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
    `${baseUrl}/v1/map-stitcher/settings`,
  );
  assert.equal(initialSettings.active, false);
  assert.deepEqual(
    initialSettings.providers.map((provider) => provider.id),
    ['nano-banana', 'gpt-image-2.6', 'gpt-image-2', 'hunyuan-image-3'],
  );
  assert.equal(JSON.stringify(initialSettings).includes('apiKey'), false);

  for (const apiKey of ['test-密钥', 'test key', 'test\nkey']) {
    const invalid = await fetch(`${baseUrl}/v1/map-stitcher/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gpt-image-2', active: true, apiKey }),
    });
    assert.equal(invalid.status, 400);
    const rejected = await invalid.json();
    assert.match(rejected.error, /密钥格式无效/);
    assert.ok(!JSON.stringify(rejected).includes(apiKey));
    assert.deepEqual(await jsonFetch(`${baseUrl}/v1/map-stitcher/settings`), initialSettings);
  }

  const settingsResponse = await fetch(`${baseUrl}/v1/map-stitcher/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'nano-banana',
      active: true,
      apiKey: 'runtime-test-secret',
    }),
  });
  const savedSettings = await settingsResponse.json();
  assert.equal(settingsResponse.status, 200, savedSettings.error);
  assert.equal(savedSettings.active, true);
  assert.equal(savedSettings.provider, 'nano-banana');
  assert.equal(
    savedSettings.providers.find((provider) => provider.id === 'nano-banana')
      .configured,
    true,
  );
  assert.equal(
    JSON.stringify(savedSettings).includes('runtime-test-secret'),
    false,
  );

  const hunyuanSaved = await jsonFetch(`${baseUrl}/v1/map-stitcher/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'hunyuan-image-3', active: true, apiKey: 'test-tokenhub-secret' }),
  });
  assert.equal(hunyuanSaved.provider, 'hunyuan-image-3');
  assert.equal(hunyuanSaved.providers.find(p => p.id === 'hunyuan-image-3').configured, true);
  assert.equal(hunyuanSaved.providers.find(p => p.id === 'nano-banana').configured, true);
  assert.equal(JSON.stringify(hunyuanSaved).includes('test-tokenhub-secret'), false);

  const expertSettings = await jsonFetch(`${baseUrl}/v1/agent/scene-workflow-settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configuration: { default: { provider: 'tokenhub', model: 'fixture-vision' }, roles: { visual_reviewer: { provider: 'openai', model: 'fixture-reviewer' } } }, keys: { openai: 'scene-expert-test-key' } }),
  });
  assert.equal(expertSettings.configured, true);
  assert.equal(expertSettings.configuration.roles.visual_reviewer.model, 'fixture-reviewer');
  assert.equal(JSON.stringify(expertSettings).includes('scene-expert-test-key'), false);
  assert.equal(JSON.stringify(expertSettings).includes('test-tokenhub-secret'), false);
  const preserved = await jsonFetch(`${baseUrl}/v1/map-stitcher/settings`);
  assert.equal(preserved.provider, 'hunyuan-image-3');
  assert.equal(preserved.providers.find(p => p.id === 'nano-banana').configured, true, 'expert settings preserve existing image-provider keys');

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
  const response = await fetch(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capabilityId: 'map-stitcher',
      input: {
        operation: 'compose',
        images: [`data:image/png;base64,${tile.toString('base64')}`],
        columns: 1,
        checkSeams: true,
      },
    }),
  });
  assert.equal(response.status, 200);
  const task = await response.json();
  assert.equal(task.status, 'completed');
  const artifact = task.outputs.find((value) =>
    value.endsWith('stitched-map.png'),
  );
  assert(artifact);

  const tasks = await jsonFetch(`${baseUrl}/v1/tasks?limit=1`);
  assert.equal(tasks.tasks[0].id, task.taskId);
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
