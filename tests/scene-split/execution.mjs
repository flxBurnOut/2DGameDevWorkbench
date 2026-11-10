import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import {
  createScene,
  replaceMap,
} from '../../features/scene-composer/model.mjs';
import {
  createDocument,
  getDocument,
  saveDocument,
} from '../../lib/workbench/editor-documents.mjs';
import { sceneSplitRequest } from '../../lib/workbench/scene-splits.mjs';
import { agentRequest } from '../../lib/workbench/agent-api.mjs';
import { loadManifest } from '../../lib/workbench/runtime.mjs';

const root = path.resolve(
  'work',
  'test-runs',
  process.env.WORKBENCH_TEST_RUN,
  'scene-split-execution',
);
const tool = path.join(root, 'Tools', 'VisualStructure');
await mkdir(tool, { recursive: true });
await writeFile(path.join(root, 'package.json'), '{"type":"commonjs"}');
const manifest = await loadManifest();
manifest.workspace = {
  ...manifest.workspace,
  taskDirectory: 'work/tasks',
  documentDirectory: 'work/editor-documents',
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const weights = path.join(root, 'fixture.weights');
await writeFile(weights, 'fixture');
await writeFile(
  path.join(tool, 'runtime-profile.json'),
  JSON.stringify({ runtimeDirectory: '.', weightsSha256: sha('fixture') }),
);
await writeFile(
  path.join(tool, 'worker.py'),
  `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'), sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{const job=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--job')+1]));
fs.writeFileSync(path.join(root,'sam-started'),'started');
while(fs.existsSync(path.join(root,'hold-sam')))await new Promise(r=>setTimeout(r,10));
if(fs.existsSync(path.join(root,'fail-sam')))throw Error('fixture local segmentation failure');
const meta=await sharp(job.source).metadata(), mask=Buffer.alloc(meta.width*meta.height);
const [x,y]=job.parts[0].points[0]||[1,1];mask[y*meta.width+x]=255;
const png=await sharp(mask,{raw:{width:meta.width,height:meta.height,channels:1}}).png().toBuffer();
fs.mkdirSync(job.output);fs.writeFileSync(path.join(job.output,'map_part.png'),png);
fs.writeFileSync(path.join(job.output,'receipt.json'),JSON.stringify({source_sha256:job.source_sha256,weights_sha256:job.weights_sha256,width:meta.width,height:meta.height,paid_calls:0,parts:[{id:'map_part',sha256:sha(png)}]}));
})().catch(e=>{fs.writeFileSync(path.join(root,'sam-error'),e.stack);console.error(e.message);process.exitCode=1});`,
);
const scene = createScene('Async split regression');
replaceMap(scene, {
  name: 'fixture',
  origin: { x: 0, y: 0 },
  offset: { x: 0, y: 0 },
  warnings: [],
  collisions: [],
  source: 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
  layers: [
    {
      id: 'map_overall',
      name: 'map',
      width: 32,
      height: 16,
      hidden: false,
      locked: false,
      included: true,
      source:
        'data:image/png;base64,' +
        (
          await sharp({
            create: {
              width: 32,
              height: 16,
              channels: 4,
              background: '#223344',
            },
          })
            .png()
            .toBuffer()
        ).toString('base64'),
    },
  ],
});
await createDocument(root, manifest, {
  documentId: scene.id,
  kind: 'scene',
  commandId: 'create',
  content: scene,
});
const server = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const bytes of req) body += bytes;
    const operation = req.url.split('/').at(-1);
    const result = await sceneSplitRequest(
      root,
      manifest,
      operation,
      JSON.parse(body),
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(error.status || 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message, code: error.code }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const names = [
  'WORKBENCH_RUNTIME_URL',
  'FORGE_STRUCTURE_PYTHON',
  'FORGE_STRUCTURE_WEIGHTS',
  'OPENAI_API_KEY',
  'SCENE_EXPERT_OPENAI_URL',
];
const previousEnv = Object.fromEntries(
  names.map((name) => [name, process.env[name]]),
);
const originalFetch = globalThis.fetch;
let paidCalls = 0;
try {
  process.env.WORKBENCH_RUNTIME_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.FORGE_STRUCTURE_PYTHON = process.execPath;
  process.env.FORGE_STRUCTURE_WEIGHTS = weights;
  process.env.OPENAI_API_KEY = 'fixture-only';
  process.env.SCENE_EXPERT_OPENAI_URL = 'http://127.0.0.1:19085/v1/responses';
  globalThis.fetch = async (url, options) => {
    if (url !== 'http://127.0.0.1:19085/v1/responses')
      return originalFetch(url, options);
    paidCalls++;
    assert.equal(
      paidCalls,
      1,
      'Paid location is never repeated during local recovery.',
    );
    return Response.json({
      id: 'fixture-location',
      status: 'completed',
      model: JSON.parse(options.body).model,
      usage: { input_tokens: 123, output_tokens: 45 },
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                objects: [
                  {
                    id: 'one',
                    name: 'one',
                    kind: 'object',
                    reason: 'fixture',
                    regions: [
                      {
                        box: { left: 0, top: 0, right: 500, bottom: 500 },
                        positivePoints: [{ x: 100, y: 100 }],
                        negativePoints: [],
                        role: 'art',
                        plane: 'back',
                      },
                    ],
                    collision: [],
                  },
                ],
                warnings: [],
              }),
            },
          ],
        },
      ],
    });
  };
  const post = (operation, input) =>
    agentRequest(manifest, `scene-split-${operation}`, input);
  const binding = { documentId: scene.id, expectedRevision: 1 };
  const spec = {
    id: 'one',
    name: 'one',
    kind: 'object',
    parts: [
      {
        id: 'art',
        role: 'art',
        plane: 'back',
        selection: { type: 'rect', x: 1, y: 1, width: 1, height: 1 },
      },
    ],
  };
  const prepared = (
    await post('prepare', { ...binding, commandId: 'prepare', specs: [spec] })
  ).candidate;
  const wait = async (candidateId) => {
    for (let i = 0; i < 400; i++) {
      const { candidate } = await post('get', {
        documentId: scene.id,
        candidateId,
        includeSpecs: true,
      });
      if (candidate.status !== 'running') return candidate;
      await delay(10);
    }
    assert.fail('Candidate did not finish.');
  };
  const interrupted = { ...binding, mode: 'auto', commandId: 'restart-local-auto' };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { sceneSplitRequest } from './lib/workbench/scene-splits.mjs';
    const [root, manifest, input] = JSON.parse(process.argv[1]);
    const { candidate } = await sceneSplitRequest(root, manifest, 'scene-split-prepare', input);
    process.stdout.write(candidate.candidateId, () => process.exit(0));
  `, JSON.stringify([root, { workspace: manifest.workspace }, interrupted])], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const interruptedId = child.stdout;
  const stopped = await post('get', { documentId: scene.id, candidateId: interruptedId, includeSpecs: true });
  assert.equal(stopped.candidate.status, 'attention_required');
  assert.equal(stopped.candidate.recoveryRequest.input.commandId, interrupted.commandId);
  const restarted = await post('prepare', interrupted);
  assert.equal(restarted.candidate.execution.id, stopped.candidate.execution.id);
  assert.equal((await wait(interruptedId)).status, 'ready');
  await writeFile(path.join(root, 'hold-sam'), 'hold');
  const upsert = [1, 2].map((x) => ({
    ...spec,
    id: `sam_${x}`,
    parts: [
      {
        ...spec.parts[0],
        selection: { type: 'sam', points: [{ x, y: 1, include: true }] },
      },
    ],
  }));
  const request = {
    ...binding,
    candidateId: prepared.candidateId,
    candidateRevision: 1,
    commandId: 'async-revision',
    upsert,
  };
  // The model cannot finish until this client releases the barrier; even the
  // shipping Agent HTTP forwarding path must return before that happens.
  const started = (await post('revise', request)).candidate;
  assert.equal(started.status, 'running');
  assert.equal(started.execution.commandId, request.commandId);
  const duplicate = (await post('revise', request)).candidate;
  assert.equal(duplicate.execution.id, started.execution.id);
  assert.equal(
    (
      await post('get', {
        documentId: scene.id,
        candidateId: started.candidateId,
      })
    ).candidate.status,
    'running',
  );
  await assert.rejects(
    post('revise', { ...request, commandId: 'competing-revision' }),
    { code: 'SPLIT_BUSY' },
  );
  const current = (await getDocument(root, manifest, { documentId: scene.id }))
    .document;
  current.content.name = 'independent save while SAM runs';
  await saveDocument(root, manifest, {
    documentId: scene.id,
    expectedRevision: 1,
    commandId: 'independent-save',
    content: current.content,
  });
  await unlink(path.join(root, 'hold-sam'));
  const completed = await wait(started.candidateId);
  assert.equal(
    completed.status,
    'ready',
    completed.status === 'ready'
      ? ''
      : await readFile(path.join(root, 'sam-error'), 'utf8').catch(() =>
          JSON.stringify(completed.error),
        ),
  );
  assert.equal(completed.revision, 2);
  assert.equal(completed.sourceRevision, 1);
  assert.equal(completed.usage.localSamCalls, 2);
  assert.equal((await post('revise', request)).replayed, true);
  await assert.rejects(
    post('adopt', {
      ...binding,
      candidateId: started.candidateId,
      candidateRevision: 2,
      commandId: 'stale-adoption',
    }),
    { code: 'REVISION_CONFLICT' },
  );

  await writeFile(path.join(root, 'fail-sam'), 'fail');
  const visionRequest = {
    ...binding,
    expectedRevision: 2,
    commandId: 'vision-recovery',
    mode: 'vision',
    useSam: true,
  };
  const visionStarted = (await post('prepare', visionRequest)).candidate;
  const failed = await wait(visionStarted.candidateId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'MAP_SPLIT_SAM_FAILED');
  assert.deepEqual(failed.recoveryRequest.input, visionRequest);
  assert.equal(failed.receipt.responseId, 'fixture-location');
  await unlink(path.join(root, 'fail-sam'));
  const recoveredStart = (await post('prepare', visionRequest)).candidate;
  assert.equal(recoveredStart.execution.id, visionStarted.execution.id);
  const recovered = await wait(visionStarted.candidateId);
  assert.equal(recovered.status, 'ready', JSON.stringify(recovered.error));
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.usage.paidCalls, 1);
  assert.equal(recovered.usage.input_tokens, 123);
  assert.equal(paidCalls, 1);

  const parts = Array.from({ length: 129 }, (_, i) => ({
    ...spec.parts[0],
    id: `part_${i}`,
    selection: {
      type: 'rect',
      x: i % 32,
      y: Math.floor(i / 32),
      width: 1,
      height: 1,
    },
  }));
  await assert.rejects(
    post('prepare', {
      ...binding,
      expectedRevision: 2,
      commandId: 'too-many-parts',
      specs: [{ ...spec, parts }],
    }),
  );
  const grouped = (
    await post('prepare', {
      ...binding,
      expectedRevision: 2,
      commandId: 'grouped-overflow',
      specs: [
        { ...spec, parts: parts.slice(0, 64) },
        { ...spec, parts: parts.slice(64) },
      ],
    })
  ).candidate;
  assert.equal(
    grouped.status,
    'failed',
    'Full candidate validation rejects combined declarations before ready.',
  );
  assert.equal(grouped.revision, 0);
  await writeFile(
    path.join(root, 'receipt.json'),
    JSON.stringify(
      {
        asyncRevision: completed.execution,
        paidLocalRecovery: recovered.execution,
        mockedPaidCalls: paidCalls,
        invalidCandidateStatus: grouped.status,
      },
      null,
      2,
    ),
  );
  console.log(
    'Scene split execution passed through Agent HTTP forwarding: nonblocking SAM revisions, command replay, source version guards, persisted paid location/local failure recovery, and ready-state part limits. Real paid calls: 0.',
  );
} finally {
  globalThis.fetch = originalFetch;
  for (const name of names) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
