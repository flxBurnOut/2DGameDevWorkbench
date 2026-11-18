import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

import sharp from 'sharp';
import { getTaskResult } from '../../lib/workbench/agent-api.mjs';
import { planImageGenerationSize, imageAspectMatches } from '../../lib/workbench/adapters/image-generation-size.mjs';

import {
  findCapability,
  loadManifest,
  refreshTask,
  repositoryRoot,
  runConnector,
  validateInput,
} from '../../lib/workbench/runtime.mjs';

const requests = [];
const generatedFrame = await sharp({
  create: {
    width: 2,
    height: 2,
    channels: 4,
    background: { r: 10, g: 20, b: 30, alpha: 1 },
  },
})
  .png()
  .toBuffer();
let baseUrl = '';
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const contentType = request.headers['content-type'] ?? '';
  const body =
    rawBody.length && contentType.includes('application/json')
      ? JSON.parse(rawBody.toString('utf8'))
      : null;
  requests.push({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body,
    rawBody,
  });
  response.setHeader('content-type', 'application/json');

  if (request.method === 'POST' && request.url === '/v1/jobs') {
    response.statusCode = 201;
    response.end(
      JSON.stringify({ ok: true, data: { job: spriteJob('created') } }),
    );
    return;
  }
  if (
    request.method === 'POST' &&
    request.url === '/v1/jobs/mock-job/generate'
  ) {
    response.end(
      JSON.stringify({
        ok: true,
        data: { job: spriteJob('provider_pending') },
      }),
    );
    return;
  }
  if (request.method === 'GET' && request.url === '/v1/jobs/mock-job') {
    response.end(
      JSON.stringify({ ok: true, data: { job: spriteJob('review_required') } }),
    );
    return;
  }
  if (request.method === 'GET' && ['/v1/jobs/queued', '/v1/jobs/not_submitted'].includes(request.url)) {
    const status = request.url.split('/').at(-1);
    const job = { job_id: status, status, motion_control: { state: 'waiting' }, candidates: [] };
    response.end(JSON.stringify({ ok: true, data: { job } }));
    return;
  }
  if (
    request.method === 'GET' &&
    new URL(request.url, baseUrl).pathname === '/v1/jobs/mock-job/candidates/1/frames/0/image'
  ) {
    response.setHeader('content-type', 'image/png');
    response.end(generatedFrame);
    return;
  }
  if (
    request.method === 'POST' &&
    [
      '/v1/jobs/mock-job/candidates/1/recover',
      '/v1/jobs/mock-job/candidates/1/attach-provider-job',
    ].includes(request.url)
  ) {
    response.end(
      JSON.stringify({ ok: true, data: { job: spriteJob('review_required') } }),
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ ok: false, error: { message: 'not found' } }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
baseUrl = `http://127.0.0.1:${address.port}`;
const previousSpriteUrl = process.env.SPRITE_PIPELINE_API_URL;
process.env.SPRITE_PIPELINE_API_URL = baseUrl;

try {
  const manifest = await loadManifest();
  const sprite = findCapability(manifest, 'sprite-generator');

  assert.deepEqual(
    validateInput(sprite, {
      operation: 'create-and-generate',
      characterId: 'diagnostic_dummy',
      actionId: 'idle',
      provider: 'fixture',
    }),
    [],
  );
  assert(validateInput(sprite, { operation: 'create' }).length >= 2);

  const spriteResult = await runConnector(manifest, sprite, {
    operation: 'create-and-generate',
    characterId: 'diagnostic_dummy',
    actionId: 'idle',
    provider: 'fixture',
    candidateCount: 1,
    frameCount: 1,
  });
  assert.equal(spriteResult.task.status, 'running');
  assert.equal(spriteResult.task.adapter.remoteJobId, 'mock-job');
  const createRequest = requests.find((item) => item.url === '/v1/jobs');
  assert.equal(createRequest.body.character_id, 'diagnostic_dummy');
  assert.equal(createRequest.body.action_id, 'idle');
  assert.equal(createRequest.body.candidate_count, 1);
  assert.equal(createRequest.body.frame_count, 1);
  assert.equal('taskId' in createRequest.body, false);
  assert.equal(createRequest.headers['idempotency-key'], spriteResult.task.id);

  const refreshedSprite = await refreshTask(manifest, spriteResult.task.id);
  assert.equal(refreshedSprite.task.id, spriteResult.task.id);
  assert.equal(refreshedSprite.task.status, 'attention_required');
  assert.equal(refreshedSprite.task.adapter.remoteStatus, 'review_required');
  const frameOutput = refreshedSprite.task.outputs.find((output) =>
    output.endsWith('/frames/candidate-01/frame-000.png'),
  );
  assert(frameOutput);
  assert(frameOutput.startsWith(`${manifest.workspace.outputDirectory}/${spriteResult.task.id}/`));
  const frameMetadata = await sharp(
    path.resolve(repositoryRoot, frameOutput),
  ).metadata();
  assert.equal(frameMetadata.width, 2);
  assert.equal(frameMetadata.height, 2);
  for (const [jobId, state, nextActions] of [
    ['queued', 'running', ['workbench_get_task']],
    ['not_submitted', 'not_submitted', []],
  ]) {
    const current = await runConnector(manifest, sprite, { operation: 'get', jobId });
    assert.equal(current.task.status, state);
    const summary = await getTaskResult(manifest, { taskId: current.task.id });
    assert.equal(summary.presentation.state, state);
    assert.deepEqual(summary.result.nextActions, nextActions);
  }

  const submissionCount = requests.filter(
    (r) => r.url === '/v1/jobs' || r.url.endsWith('/generate'),
  ).length;
  for (const operation of ['recover', 'attach-provider-job']) {
    const recovered = await runConnector(manifest, sprite, {
      operation,
      jobId: 'mock-job',
      candidateIndex: 1,
      ...(operation === 'attach-provider-job'
        ? { providerJobId: 'existing-provider-job' }
        : {}),
    });
    assert.equal(recovered.task.adapter.remoteJobId, 'mock-job');
  }
  assert.equal(
    requests.filter((r) => r.url === '/v1/jobs' || r.url.endsWith('/generate'))
      .length,
    submissionCount,
  );
  assert.deepEqual(
    requests.find((r) => r.url.endsWith('/attach-provider-job')).body,
    { provider_job_id: 'existing-provider-job' },
  );
  assert(
    validateInput(sprite, {
      operation: 'approve',
      jobId: 'mock-job',
      candidateIndex: 1,
    }).length > 0,
  );
  assert(
    validateInput(sprite, {
      operation: 'review-frame',
      jobId: 'mock-job',
      candidateIndex: 1,
      frameIndex: 0,
      reviewStatus: 'repair_requested',
      issueType: 'made_up',
    }).length > 0,
  );
  assert.deepEqual(planImageGenerationSize(5504, 3072), { width: 2064, height: 1152, size: '2064x1152' });
  assert.deepEqual(planImageGenerationSize(3072, 5504), { width: 1152, height: 2064, size: '1152x2064' });
  for (const [width, height] of [[128, 128], [1920, 1080], [7225, 4118], [1001, 563], [2400, 800]]) {
    const output = planImageGenerationSize(width, height);
    assert.equal(output.width % 16, 0);
    assert.equal(output.height % 16, 0);
    assert.ok(output.width * output.height >= 655360 && output.width * output.height <= 3686400);
    assert.ok(imageAspectMatches(width, height, output.width, output.height));
  }
  assert.throws(() => planImageGenerationSize(0, 100), /无效/);
  assert.throws(() => planImageGenerationSize(400, 100), /3:1/);
  assert.equal(imageAspectMatches(1024, 1024, 2048, 1024), false);
  console.log(JSON.stringify({
    spriteAdapter: 'ok', imageGenerationSizing: 'ok',
    spriteTaskId: refreshedSprite.task.id, outputs: refreshedSprite.task.outputs,
    realProviderRequests: 0,
  }, null, 2));
} finally {
  if (previousSpriteUrl === undefined)
    delete process.env.SPRITE_PIPELINE_API_URL;
  else process.env.SPRITE_PIPELINE_API_URL = previousSpriteUrl;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function spriteJob(status) {
  return {
    job_id: 'mock-job',
    status,
    revision: 2,
    candidates: [
      {
        candidate_index: 1,
        frames: [
          {
            index: 0,
            active_path: 'candidates/candidate_01/frames/frame_000.png',
            sha256: createHash('sha256').update(generatedFrame).digest('hex'),
          },
        ],
      },
    ],
    export: null,
  };
}
