import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.cwd();
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work/agent-acceptance-'));
const pipelineDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'workbench-acceptance-'),
);
const port = await freePort();
const pipelineUrl = `http://127.0.0.1:${port}`;
const python =
  process.env.WORKBENCH_TEST_PYTHON ||
  path.join(
    root,
    'Tools/SpritePipeline/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
const pipeline = spawn(
  python,
  ['tests/agent-acceptance/fixture_server.py', pipelineDirectory, String(port)],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);
let serviceErrors = '';
let startupError;
pipeline.once('error', (error) => {
  startupError = error;
});
pipeline.stderr.on('data', (chunk) => {
  serviceErrors += chunk.toString();
});
let client;
let bridge;
let managedPid;
const report = {
  paidCalls: 0,
  provider: 'fixture',
  diagnosticOnly: true,
  checks: [],
};
const env = {
  ...process.env,
  SPRITE_PIPELINE_API_URL: pipelineUrl,
  NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL: pipelineUrl,
  PIXELLAB_API_KEY: '',
  SPRITE_PIPELINE_API_TOKEN: '',
};

async function connect(overrides = {}) {
  const next = new Client({ name: 'fresh-agent-acceptance', version: '1.0.0' });
  await next.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['scripts/workbench-mcp.mjs'],
      cwd: root,
      env: { ...env, ...overrides },
      stderr: 'pipe',
    }),
  );
  return next;
}
async function call(name, input = {}, expectError = false) {
  const r = await client.callTool({ name, arguments: input });
  assert.equal(Boolean(r.isError), expectError, JSON.stringify(r));
  return r;
}
const value = (r) => r.structuredContent;
const run = (input, error = false) =>
  call(
    'workbench_run_task',
    { capabilityId: 'sprite-generator', input },
    error,
  );

try {
  await waitForService(pipelineUrl);
  client = await connect();
  const tools = await client.listTools();
  const manifest = JSON.parse(
    await readFile(path.join(root, 'workbench/manifest.json'), 'utf8'),
  );
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
    [...manifest.agentAssets.mcpServer.tools].sort((a, b) =>
      a.localeCompare(b),
    ),
  );
  const listed = value(await call('workbench_list_capabilities'));
  assert(listed.capabilities.some((c) => c.id === 'reference-art'));
  assert.equal(listed.conversationGuidance.createsTask, false);
  const engineering = listed.conversationGuidance.engineering;
  assert.equal(engineering.mode, 'external-agent');
  assert.equal(engineering.createsTask, false);
  await access(path.join(root, engineering.skill));
  await access(path.join(root, engineering.guide));
  const motionGuide = listed.conversationGuidance.topics.find(topic => topic.id === 'motion');
  assert.equal(motionGuide.capabilityId, 'sprite-generator');
  const motion = value(await call('workbench_get_guidance', { topic: motionGuide.id }));
  assert.equal(motion.text, await readFile(path.join(root, motionGuide.source), 'utf8'));
  assert.equal(motion.createsTask, false);
  const description = value(
    await call('workbench_describe_capability', {
      capabilityId: 'sprite-generator',
    }),
  );
  assert(description.guidanceTopics.some(topic => topic.id === motionGuide.id));
  assert(
    description.capability.inputSchema.properties.operation.enum.includes(
      'approve',
    ),
  );
  const environment = value(await call('workbench_get_environment'));
  assert(environment.pipeline.online && environment.pipeline.compatible);
  assert.equal(environment.pipeline.keyConfigured, false);
  assert.equal(value(await call('workbench_start_services')).status, 'reused');
  report.checks.push(
    'fresh MCP discovery, live compatibility, missing-key state, reuse service',
  );

  const presets = value(await call('workbench_list_presets'));
  const character = presets.characters.find(
    (c) => c.id === 'diagnostic_dummy' && c.valid,
  );
  const action = presets.actions.find((a) => a.id === 'idle');
  assert(character && action && action.frameCount && character.width);
  const initial = value(
    await run({
      operation: 'create-and-generate',
      characterId: character.id,
      actionId: action.id,
      provider: 'fixture',
      wait: false,
    }),
  );
  report.generationTaskId = initial.taskId;
  // Reconnect to prove no client-local state is needed to continue the job.
  await client.close();
  client = await connect();
  await call('workbench_list_capabilities');
  await call('workbench_describe_capability', {
    capabilityId: 'sprite-generator',
  });
  let task;
  for (let n = 0; n < 40; n++) {
    task = value(
      await call('workbench_get_task', { taskId: initial.taskId }),
    ).task;
    if (task.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(task.status, 'attention_required');
  const jobId = task.adapter.remoteJobId;
  const found = value(await call('workbench_list_tasks', { query: jobId }));
  assert(found.nativeJobs.some((j) => j.job_id === jobId));
  const result = value(
    await call('workbench_get_result', { taskId: initial.taskId }),
  );
  assert(result.outputsVerified);
  const candidate = result.result.candidates[0].candidateIndex;
  const beforeInspect = value(await call('workbench_list_tasks', {query:jobId}));
  const native = value(await call('workbench_get_result', {jobId, candidateIndex:candidate}));
  assert.equal(new URL(native.presentation.viewUrl).searchParams.get('job'),jobId);
  assert.equal(new URL(native.presentation.viewUrl).searchParams.get('candidate'),String(candidate));
  assert.equal(native.presentation.browserOpened,false);
  assert.equal(native.presentation.state,'attention_required');
  const exact = await call('workbench_get_result',{taskId:initial.taskId,candidateIndex:candidate});
  assert(!exact.content[0].text.includes('orderedFrames'));
  assert.equal(exact.structuredContent.result.orderedFrames, undefined);
  assert.equal(exact.structuredContent.result.candidates.length, 1);
  const selectedFrames = await call('workbench_get_result', { taskId: initial.taskId, detail: true, section: '/result/orderedFrames' });
  const framePage = JSON.parse(selectedFrames.content[0].text).detailPage;
  assert.equal(framePage.nextOffset, null);
  const orderedFrames = JSON.parse(framePage.json);
  assert(orderedFrames.length > 0);
  const selection = { jobId, candidateIndex: candidate, detail: true };
  let detailed = value(await call('workbench_get_result', selection)).detailPage;
  assert.ok(detailed.nextOffset > 0);
  await call('workbench_get_result', { ...selection, offset: detailed.nextOffset, snapshot: '0'.repeat(64) }, true);
  await call('workbench_get_result', { ...selection, offset: detailed.nextOffset }, true);
  await call('workbench_get_result', { jobId, section: '/result/candidates' }, true);
  let json = detailed.json;
  while (detailed.nextOffset !== null) {
    detailed = value(await call('workbench_get_result', { ...selection, offset: detailed.nextOffset, snapshot: detailed.snapshot })).detailPage;
    assert.ok(detailed.json.length <= 3200);
    json += detailed.json;
  }
  assert.equal(json.length, detailed.totalCharacters);
  assert.equal(JSON.parse(json).result.candidates[0].frames.length, orderedFrames.length);
  await call('workbench_get_result',{jobId,candidateIndex:999},true);
  await call('workbench_get_result',{taskId:initial.taskId,jobId},true);
  await client.close(); client = await connect();
  await call('workbench_get_result',{jobId,candidateIndex:candidate});
  assert.deepEqual(value(await call('workbench_list_tasks',{query:jobId})),beforeInspect);
  report.checks.push('precise native/task candidate links, compact and full results, reconnect/read-only inspection creates no tasks');

  const image = await call('workbench_read_artifact', {
    taskId: initial.taskId,
    artifactPath: orderedFrames[0],
  });
  assert(
    image.content.some((c) => c.type === 'image' && c.mimeType === 'image/png'),
  );
  await writeFile(
    path.join(directory, 'mcp-preview.png'),
    Buffer.from(image.content.find((c) => c.type === 'image').data, 'base64'),
  );
  await call(
    'workbench_read_artifact',
    { taskId: initial.taskId, artifactPath: '.env' },
    true,
  );
  report.checks.push(
    'real offline generation, reconnect/resume, native-job discovery, image content, artifact boundary',
  );

  await run({ operation: 'export', jobId, candidateIndex: candidate }, true);
  await run({ operation: 'approve', jobId, candidateIndex: candidate }, true);
  const checked = value(
    await run({ operation: 'check', jobId, candidateIndex: candidate }),
  );
  const safety = value(
    await run({ operation: 'safety', jobId, candidateIndex: candidate }),
  );
  const safetyResult = value(
    await call('workbench_get_result', { taskId: safety.taskId }),
  );
  assert(safetyResult.result.safety);
  await run({
    operation: 'review-frame',
    jobId,
    candidateIndex: candidate,
    frameIndex: 0,
    reviewStatus: 'approved',
    reviewNote: 'Offline plumbing test: diagnostic fixture frame.',
    reviewer: 'acceptance-test',
  });
  const approved = value(
    await run({
      operation: 'approve',
      jobId,
      candidateIndex: candidate,
      reviewer: 'acceptance-test',
      reviewNote:
        'Offline deterministic fixture: transport and workflow acceptance, not artistic quality.',
      acknowledgeWarnings: true,
    }),
  );
  assert.equal(approved.status, 'completed');
  const exported = value(
    await run({ operation: 'export', jobId, candidateIndex: candidate }),
  );
  assert.equal(exported.status, 'completed');
  const delivery = value(
    await call('workbench_get_result', { taskId: exported.taskId }),
  );
  assert(
    delivery.outputsVerified &&
      delivery.result.spriteSheet &&
      delivery.result.godotPackage &&
      delivery.result.preview,
  );
  for (const item of delivery.artifacts) await access(item.absolutePath);
  const godotZip = await JSZip.loadAsync(await readFile(path.join(root, delivery.result.godotPackage)), { checkCRC32: true });
  const godotFrames = Object.values(godotZip.files).find((file) => file.name.endsWith('/sprite_frames.tres'));
  assert(godotFrames);
  assert.match(await godotFrames.async('string'), /gd_resource type="SpriteFrames"/);
  assert(Object.values(godotZip.files).some((file) => file.name.endsWith('/animated_sprite.tscn')));
  assert(!godotZip.file('project.godot'));
  const gif = await call('workbench_read_artifact', {
    taskId: exported.taskId,
    artifactPath: delivery.result.preview,
  });
  assert(gif.content.some((c) => c.type === 'image'));
  await run({ operation: 'recover', jobId, candidateIndex: candidate }, true);
  report.checks.push(
    'export gate, review evidence requirement, QA/safety, frame review, approve/export, reject recovery for non-PixelLab fixture',
  );
  report.exportTaskId = exported.taskId;
  report.outputs = exported.outputs;
  report.checkedTaskId = checked.taskId;

  const bridgePort = await freePort();
  bridge = spawn(process.execPath, ['scripts/workbench-http.mjs'], {
    cwd: root,
    env: { ...env, WORKBENCH_RUNTIME_PORT: String(bridgePort) },
    stdio: 'ignore',
    windowsHide: true,
  });
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  await waitForService(bridgeUrl);
  const httpResult = await fetch(`${bridgeUrl}/v1/agent/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: exported.taskId }),
  });
  assert.deepEqual(await httpResult.json(), delivery);
  const cli = spawn(
    process.execPath,
    ['scripts/workbench.mjs', 'agent', 'environment', '--json'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stdout = '';
  cli.stdout.on('data', (c) => {
    stdout += c;
  });
  assert.equal(await new Promise((resolve) => cli.once('exit', resolve)), 0);
  assert.equal(JSON.parse(stdout).pipeline.compatible, true);
  report.checks.push('HTTP and CLI use the same shared handlers');
  await client.close();
  const managedPort = await freePort();
  const managedUrl = `http://127.0.0.1:${managedPort}`;
  const managedData = await mkdtemp(path.join(os.tmpdir(), 'workbench-start-'));
  client = await connect({
    SPRITE_PIPELINE_API_URL: managedUrl,
    NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL: managedUrl,
    SPRITE_PIPELINE_DATA_DIR: managedData,
    SPRITE_PIPELINE_EXPORTS_DIR: path.join(managedData, 'exports'),
    SPRITE_PIPELINE_IMPORT_USER_CREDENTIALS: '0',
    SPRITE_PIPELINE_IMPORT_USER_ASSETS: '0',
  });
  const offline = value(await call('workbench_get_environment'));
  // CI's system Python can run fixture tests without an installed app venv.
  if (offline.pythonInstalled) {
    assert.equal(offline.pipeline.online, false);
    const started = value(await call('workbench_start_services'));
    assert.equal(started.status, 'starting');
    managedPid = started.pid;
    const again = value(await call('workbench_start_services'));
    assert(again.status === 'reused' || again.pid === managedPid);
    await waitForService(managedUrl);
    const ready = value(await call('workbench_get_environment'));
    assert(ready.pipeline.compatible);
    assert.equal(ready.pipeline.keyConfigured, false);
    report.checks.push(
      'cold start local service, no duplicate process, compatible health after startup',
    );
  } else {
    report.checks.push(
      'cold start skipped: CI has system Python without app venv',
    );
  }
  report.status = 'passed';
  await writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        reportPath: path.join(directory, 'report.json'),
        previewPath: path.join(directory, 'mcp-preview.png'),
      },
      null,
      2,
    ),
  );
} finally {
  if (client) await client.close();
  if (Number.isInteger(managedPid)) {
    try {
      process.kill(managedPid);
    } catch {}
  }
  for (const child of [pipeline, bridge]) {
    if (!child || child.exitCode !== null) continue;
    child.kill();
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }
  if (report.status !== 'passed' && serviceErrors)
    console.error(serviceErrors.slice(-2000));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitForService(url) {
  for (let n = 0; n < 600; n++) {
    if (startupError)
      throw new Error(
        'SpritePipeline Python 无法启动，请运行 npm run sprite-pipeline:setup。' +
          startupError.message,
      );
    if (pipeline.exitCode !== null)
      throw new Error('SpritePipeline 已退出：' + serviceErrors.slice(-2000));
    try {
      if (
        (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok
      )
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Service failed to start: ${url}`);
}
