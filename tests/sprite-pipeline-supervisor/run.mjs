import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSpritePipelineLaunch,
  probeSpritePipeline,
  resolveSpritePipelineTarget,
} from '../../lib/workbench/sprite-pipeline-supervisor.mjs';

let healthMode = 'valid';
let uiMode = 'missing';
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/' && uiMode !== 'missing') {
    response.setHeader('content-type', 'text/html');
    response.end(uiMode === 'valid' ? '<html><gradio-app></gradio-app></html>' : '<html>Other application</html>');
    return;
  }
  if (request.url !== '/health') {
    response.writeHead(404);
    response.end('{}');
    return;
  }
  response.writeHead(200);
  response.end(
    healthMode === 'valid'
      ? JSON.stringify({ ok: true, version: 'test-version' })
      : JSON.stringify({ ok: true }),
  );
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const target = {
  mode: 'managed',
  baseUrl: `http://127.0.0.1:${address.port}`,
  host: '127.0.0.1',
  port: address.port,
};

const ready = await probeSpritePipeline(target);
assert.deepEqual(ready, { state: 'ready', version: 'test-version' });

const apiOnly = await probeSpritePipeline(target, { requireUi: true });
assert.equal(apiOnly.state, 'conflict');
assert.match(apiOnly.reason, /API 已连接.*界面不可用/);
uiMode = 'other';
assert.equal((await probeSpritePipeline(target, { requireUi: true })).state, 'conflict');
uiMode = 'valid';
assert.deepEqual(await probeSpritePipeline(target, { requireUi: true }), ready);
healthMode = 'invalid';
const conflict = await probeSpritePipeline(target);
assert.equal(conflict.state, 'conflict');

await new Promise((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);
const offline = await probeSpritePipeline(target, { timeoutMs: 250 });
assert.deepEqual(offline, { state: 'offline' });

const defaultTarget = resolveSpritePipelineTarget({});
assert.equal(defaultTarget.mode, 'managed');
assert.equal(defaultTarget.baseUrl, 'http://127.0.0.1:7860');

const remoteTarget = resolveSpritePipelineTarget({
  SPRITE_PIPELINE_API_URL: 'https://sprites.example.test',
  NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL: 'https://sprites.example.test',
});
assert.equal(remoteTarget.mode, 'external');

const splitTarget = resolveSpritePipelineTarget({
  SPRITE_PIPELINE_API_URL: 'http://127.0.0.1:8765',
});
assert.equal(splitTarget.mode, 'external');

// Command construction only needs file existence, not a real Python installation.
// Keep these fixtures independent of the developer's ignored .venv and the CI OS.
const temporaryRoot = path.resolve(os.tmpdir());
const repositoryRoot = await fs.mkdtemp(
  path.join(temporaryRoot, 'sprite-supervisor-'),
);
try {
  const pipelineRoot = path.join(repositoryRoot, 'Tools', 'SpritePipeline');
  const pythonName = process.platform === 'win32' ? 'python.exe' : 'python';
  const pythonDirectory = path.join(
    pipelineRoot,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
  );
  assert.throws(
    () => createSpritePipelineLaunch(repositoryRoot, defaultTarget, {}),
    /Python 环境不存在/,
  );
  await fs.mkdir(pythonDirectory, { recursive: true });
  await fs.writeFile(path.join(pythonDirectory, pythonName), '');
  assert.throws(
    () => createSpritePipelineLaunch(repositoryRoot, defaultTarget, {}),
    /CLI 不存在/,
  );
  await fs.writeFile(path.join(pipelineRoot, 'cli.py'), '');
  const launch = createSpritePipelineLaunch(repositoryRoot, defaultTarget, {});
  assert.equal(launch.command, path.join(pythonDirectory, pythonName));
  assert.equal(createSpritePipelineLaunch(repositoryRoot, defaultTarget, {}, { apiOnly: true }).args[1], 'serve-api');
  assert.equal(createSpritePipelineLaunch(repositoryRoot, defaultTarget, {}, { apiOnly: false }).args[1], 'serve-ui');
  assert.equal(launch.args[0], path.join(pipelineRoot, 'cli.py'));
  assert.deepEqual(launch.args.slice(1), [
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    '7860',
  ]);
  assert.equal(launch.env.SPRITE_PIPELINE_IMPORT_USER_CREDENTIALS, '1');
  assert.equal(
    launch.env.SPRITE_PIPELINE_DATA_DIR,
    path.join(repositoryRoot, 'work', 'sprite-pipeline'),
  );
} finally {
  // Only remove the exact temporary directory created above.
  assert.equal(path.dirname(path.resolve(repositoryRoot)), temporaryRoot);
  assert(path.basename(repositoryRoot).startsWith('sprite-supervisor-'));
  await fs.rm(repositoryRoot, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      healthProbe: 'ok',
      wrongServiceDetection: 'ok',
      localAutoStart: 'ok',
      externalEndpointBypass: 'ok',
    },
    null,
    2,
  ),
);
