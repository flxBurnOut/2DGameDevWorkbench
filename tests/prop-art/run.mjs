import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  loadManifest,
  findCapability,
  runConnector,
  readTask,
  persistTask,
  refreshTask,
  validateInput,
  repositoryRoot,
} from '../../lib/workbench/runtime.mjs';
import { buildAssetArchive } from '../../lib/workbench/asset-catalog.mjs';
import {
  createProject,
  createObject,
  projectSchema,
} from '../../features/interactable-editor/contract.mjs';
import {
  applyPropArt,
  readPropArtAsset,
} from '../../features/interactable-editor/prop-art.mjs';
import { readSourcePackage } from '../../features/interactable-editor/source-package.mjs';

const image = await sharp({
  create: { width: 128, height: 128, channels: 4, background: '#00000000' },
})
  .composite([
    {
      input: await sharp({
        create: { width: 32, height: 48, channels: 4, background: '#ffd582' },
      })
        .png()
        .toBuffer(),
      left: 48,
      top: 40,
    },
  ])
  .png()
  .toBuffer();
let configured = true,
  status = 'running',
  submits = 0,
  imports = 0,
  disconnect = false,
  submittedBody;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString())
    : null;
  let value;
  if (req.url === '/v1/reference-art/settings') value = { configured };
  else if (req.url === '/v1/reference-art/jobs') {
    submits++;
    submittedBody = body;
    if (disconnect) {
      req.socket.destroy();
      return;
    }
    value = { status: 'running', jobId: `prop-${submits}` };
  } else if (req.url.startsWith('/v1/reference-art/jobs/'))
    value =
      status === 'completed'
        ? { status, image: image.toString('base64') }
        : { status, error: 'Mock provider failed' };
  else if (req.url === '/v1/reference-art/transfer-prop') {
    assert.ok(body.sourceTaskId);
    assert.equal(body.image, undefined);
    imports++;
    value = {objectId: 'reference_' + createHash('sha256').update(body.sourceTaskId).digest('hex').slice(0,24), objectType:'interactable'};
  } else if (req.url === '/v1/reference-art/import') {
    imports++;
    value = { characterId: body.characterId };
  } else if (req.url === '/v1/artworks')
    value = { data: { assets: [], issues: [] } };
  else if (req.url === '/v1/jobs') value = { data: { jobs: [] } };
  else {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const old = process.env.SPRITE_PIPELINE_API_URL;
process.env.SPRITE_PIPELINE_API_URL = `http://127.0.0.1:${server.address().port}`;
const client = new Client({ name: 'prop-art-acceptance', version: '1.0.0' });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert(!r.isError, JSON.stringify(r));
  return r.structuredContent;
};
try {
  const manifest = await loadManifest(),
    capability = findCapability(manifest, 'reference-art');
  const input = {
    operation: 'generate',
    subject: 'prop',
    name: '备用电池',
    prompt: 'blue metal battery with yellow light',
  };
  assert(
    validateInput(capability, { ...input, apiKey: 'never-in-task' }).length,
  );
  assert(
    validateInput(capability, { ...input, prompt: 'x'.repeat(1801) }).length,
  );
  assert(validateInput(capability, { ...input, subject: 'invalid' }).length);
  assert(
    validateInput(capability, {
      operation: 'transfer',
      subject: 'prop',
      sourceTaskId: 'x',
    }).length,
  );
  configured = false;
  assert.equal(
    (await runConnector(manifest, capability, input)).task.status,
    'awaiting_configuration',
  );
  assert.equal(submits, 0);
  configured = true;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['scripts/workbench-mcp.mjs'],
      cwd: repositoryRoot,
      env: { ...process.env },
      stderr: 'pipe',
    }),
  );
  const discovery = await call('workbench_describe_capability', {
    capabilityId: 'reference-art',
  });
  assert(JSON.stringify(discovery).includes('prop'));
  const generated = await call('workbench_run_task', {
    capabilityId: 'reference-art',
    input,
  });
  assert.equal(generated.status, 'running');
  assert.equal(submits, 1);
  assert.match(submittedBody.prompt, /inanimate/);
  assert(submittedBody.prompt.endsWith(input.prompt));
  const task = await readTask(manifest, generated.taskId);
  assert.equal(task.input.prompt, input.prompt);
  task.adapter.lastPolledAt = 0;
  await persistTask(manifest, task);
  assert.equal((await refreshTask(manifest, task.id)).task.status, 'running');
  status = 'completed';
  const pending = await readTask(manifest, task.id);
  pending.adapter.lastPolledAt = 0;
  await persistTask(manifest, pending);
  const completed = (await refreshTask(manifest, task.id)).task;
  assert.equal(completed.status, 'completed');
  assert.equal(submits, 1);
  const presented = await call('workbench_get_result', { taskId: task.id });
  assert.equal(
    presented.viewPath,
    `/tools/interactable-editor?artTask=${task.id}`,
  );
  assert.match(presented.presentation.summary, /物品/);
  assert.equal(presented.presentation.preview.kind, 'image');
  const inventory = await call('workbench_list_assets', { kind: 'prop' });
  assert.equal(inventory.assets.length, 1);
  const row = inventory.assets[0];
  assert.equal(row.kind, 'prop');
  assert.match(row.editorPath, /artTask=/);
  const characters = await call('workbench_list_assets', { kind: 'character' });
  assert.equal(characters.assets.length, 0);
  const archive = await buildAssetArchive(manifest, { assetIds: [row.id] });
  const zip = await JSZip.loadAsync(archive.bytes);
  const png = Object.values(zip.files).find((f) =>
    f.name.endsWith('/prop.png'),
  );
  assert(png);
  assert.deepEqual(await png.async('nodebuffer'), image);
  assert.equal(imports, 0);
  const transferred = await runConnector(manifest, capability, {operation:'transfer', sourceTaskId:task.id});
  assert.equal(transferred.task.status, 'completed');
  const handoff = JSON.parse(await readFile(transferred.task.outputs.find(p => p.endsWith('/result.json')), 'utf8'));
  assert.equal(handoff.href, '/tools/interactable-motion?object=' + handoff.objectId);
  assert.equal(handoff.sourceTaskId, task.id);
  assert.equal(imports, 1);
  const request = async (url) => {
    if (url.startsWith('/api/workbench/tasks/'))
      return Response.json({ task: await readTask(manifest, task.id) });
    const relative = new URL(url, 'http://fixture').searchParams.get('path');
    assert(completed.outputs.includes(relative));
    return new Response(await readFile(relative));
  };
  const asset = await readPropArtAsset(task.id, request);
  const legacyAsset = await readPropArtAsset(task.id, async (url) => {
    const response = await request(url);
    if (!url.includes('result.json')) return response;
    const metadata = await response.json(); delete metadata.subject; return Response.json(metadata);
  });
  assert.equal(legacyAsset.source, asset.source);
  await assert.rejects(readPropArtAsset(task.id, async (url) => {
    const response = await request(url);
    if (!url.includes('result.json')) return response;
    return Response.json({...await response.json(),subject:'character'});
  }), /记录无效/);
  const otherId = task.id + '-other';
  const otherAsset = await readPropArtAsset(otherId, async (url) => {
    if (url.startsWith('/api/workbench/tasks/'))
      return Response.json({
        task: {
          ...completed,
          id: otherId,
          outputs: completed.outputs.map((p) => p.replace(task.id, otherId)),
        },
      });
    return request(url.replaceAll(otherId, task.id));
  });
  assert.notEqual(asset.id, otherAsset.id);
  assert.equal(asset.source, otherAsset.source);
  assert.equal(otherAsset.generation.sourceTaskId, otherId);
  assert.equal(asset.generation.sourceTaskId, task.id);
  const project = createProject();
  project.objects.push(createObject('toggle'));
  project.objects[0].activation.key = 'F';
  const target = {
    projectId: project.projectId,
    definitionId: project.objects[0].definitionId,
    previousAssetId: '',
  };
  const before = structuredClone(project);
  const applied = applyPropArt(project, target, asset);
  assert.deepEqual(project, before);
  assert.equal(applied.objects[0].visual.assetId, asset.id);
  assert.equal(applied.objects[0].activation.key, 'F');
  assert.deepEqual(applied.objects[1], project.objects[1]);
  const again = applyPropArt(
    applied,
    { ...target, previousAssetId: asset.id },
    asset,
  );
  assert.equal(again.assets.length, 1);
  assert.throws(() => applyPropArt(applied, target, asset), /图片已被修改/);
  assert.throws(
    () => applyPropArt(project, { ...target, projectId: 'another' }, asset),
    /项目已变化/,
  );
  assert.throws(
    () => applyPropArt(project, { ...target, definitionId: 'deleted' }, asset),
    /已删除/,
  );
  const path = completed.outputs.find((p) => p.endsWith('/reference.png'));
  await writeFile(path, Buffer.from('altered image'));
  await assert.rejects(readPropArtAsset(task.id, request), /大小无效|已变化/);
  await writeFile(path, image);
  const altered = structuredClone(applied);
  altered.assets[0].source =
    'data:image/png;base64,' + Buffer.from('changed').toString('base64');
  await assert.rejects(
    runConnector(manifest, findCapability(manifest, 'interactable-editor'), {
      operation: 'save-project',
      project: altered,
    }),
    /生成素材已变化/,
  );
  const saved = await call('workbench_run_task', {
    capabilityId: 'interactable-editor',
    input: { operation: 'save-project', project: applied },
  });
  const source = JSON.parse(
    await readFile(
      saved.outputs.find((p) => p.endsWith('/interactable-project.json')),
      'utf8',
    ),
  );
  assert.deepEqual(source.assets[0].generation, asset.generation);
  assert.equal(
    projectSchema.parse(source).objects[0].definitionId,
    target.definitionId,
  );
  const exported = await call('workbench_run_task', {
    capabilityId: 'interactable-editor',
    input: {
      operation: 'export-godot',
      project: applied,
      selectedDefinitionIds: [target.definitionId],
    },
  });
  const roundtrip = await readSourcePackage(
    await readFile(exported.outputs.find((p) => p.endsWith('.zip'))),
  );
  assert.equal(roundtrip.assets[0].source, asset.source);
  assert.deepEqual(roundtrip.assets[0].generation, asset.generation);
  assert.equal(submits, 1);
  status = 'failed';
  const failed = await runConnector(manifest, capability, input);
  failed.task.adapter.lastPolledAt = 0;
  await persistTask(manifest, failed.task);
  assert.equal(
    (await refreshTask(manifest, failed.task.id)).task.status,
    'failed',
  );
  disconnect = true;
  const count = submits;
  const missingReply = (await runConnector(manifest, capability, input)).task;
  assert.equal(missingReply.adapter.referenceStage, 'checking_receipt');
  missingReply.adapter.lastPolledAt = 0;
  await persistTask(manifest, missingReply);
  const unknown = (await refreshTask(manifest, missingReply.id)).task;
  assert.equal(unknown.status, 'attention_required');
  assert.match(unknown.error, /无法确认/);
  assert.equal(submits, count + 1);
  console.log(
    JSON.stringify(
      {
        mcpGeneration: 'passed',
        sharedCredentials: 'passed',
        resumeWithoutResubmit: 'passed',
        propInventoryAndPngDownload: 'passed',
        propAnimationTransfer: 'passed',
        adoptionIntegrityAndIsolation: 'passed',
        sourceAndGodotRoundtrip: 'passed',
        failureAndAmbiguousSubmission: 'passed',
        realPaidCalls: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await new Promise((r) => server.close(r));
  if (old === undefined) delete process.env.SPRITE_PIPELINE_API_URL;
  else process.env.SPRITE_PIPELINE_API_URL = old;
}
