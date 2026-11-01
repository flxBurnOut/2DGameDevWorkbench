import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProject, createObject } from '../../features/interactable-editor/contract.mjs';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest();
const portServer = net.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
let providerCalls = 0;
const provider = http.createServer((_request, response) => { providerCalls++; response.writeHead(503).end(); });
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, WORKBENCH_RUNTIME_PORT: String(port), WORKBENCH_RUNTIME_URL: base, OPENAI_API_KEY: 'test-image-edit-only', MAP_STITCHER_OPENAI_API_URL: `http://127.0.0.1:${provider.address().port}/v1/images/edits` };
let child, stderr = '', bridgeOutput = '', lastReadiness = '';
async function start() {
  child = spawn(process.execPath, ['scripts/workbench-http.mjs'], { cwd: repositoryRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { bridgeOutput += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  for (let index = 0; index < 300; index++) {
    if (child.exitCode !== null) throw new Error(stderr);
    try { const response = await fetch(`${base}/health`); if (response.ok) return; lastReadiness = `${response.status} ${await response.text()}`; } catch (error) { lastReadiness = `${error.message} ${error.cause?.code || ''}`; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Isolated Bridge did not become ready: ${lastReadiness} ${stderr} ${bridgeOutput}`);
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } }
async function post(operation, input) {
  const response = await fetch(`${base}/v1/agent/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}
async function cli(operation, input) {
  const processChild = spawn(process.execPath, ['scripts/workbench.mjs', 'agent', operation, '--input-json', JSON.stringify(input), '--json'], { cwd: repositoryRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', error = ''; processChild.stdout.on('data', data => { stdout += data; }); processChild.stderr.on('data', data => { error += data; });
  const [code] = await once(processChild, 'exit'); return { code, stdout, error };
}
const client = new Client({ name: 'image-edit-transport-tests', version: '1' });
let assertions = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
try {
  await start();
  const rgba = Buffer.alloc(8 * 8 * 4, 255); rgba.set([9, 7, 5, 0], 0); rgba.set([20, 40, 60, 1], 4);
  const png = await sharp(rgba, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
  const object = createObject('inspect'); object.definitionId = 'target'; object.visual.assetId = 'source';
  const project = { ...createProject(), projectId: 'transport-image-project', objects: [object], assets: [{ id: 'source', name: 'source.png', mime: 'image/png', source: `data:image/png;base64,${png.toString('base64')}` }] };
  check((await post('document-create', { kind: 'interactable', content: project, commandId: 'transport-create' })).status, 200);
  const ref = { kind: 'interactable', documentId: project.projectId, definitionId: object.definitionId, slot: 'visual' };
  const inspected = await post('image-inspect', { target: ref, view: 'source', includePixels: true }); check(inspected.status, 200);
  check(Buffer.from(inspected.body.rgbaBase64, 'base64'), rgba); check(inspected.body.imageMimeType, 'image/png');
  const target = inspected.body.target, guard = { targetId: target.targetId, expectedRevision: target.revision, expectedSha256: target.sha256 };
  check((await post('image-inspect', { scope: { documentId: project.projectId } })).body.targets.length, 1);
  const region = await post('image-resolve', { ...guard, region: { type: 'rectangle', x: 1, y: 0, width: 1, height: 1 } }); check(region.status, 200);
  const input = { ...guard, regionRef: region.body.regionRef, operation: { type: 'clean-alpha', threshold: 1 }, commandId: 'transport-edit' };
  const both = await Promise.all([post('image-edit', input), post('image-edit', input)]);
  check(both.map(result => result.status), [200, 200]); check(both[0].body.taskId, both[1].body.taskId);
  check(both[0].body.status, 'completed');
  const edited = both[0].body;
  const diff = await post('image-inspect', { targetId: target.targetId, view: 'diff', editId: edited.edit.editId, candidateVersion: edited.candidateVersion });
  check(diff.body.diff.changedOutsideRegion, 0); check(diff.body.diff.changedPixelCount, 1);
  const countTasks = () => readdir(path.resolve(repositoryRoot, manifest.workspace.taskDirectory));
  const before = await countTasks();
  await stop(); await start();
  const replay = await post('image-edit', input); check(replay.body.taskId, edited.taskId); check(replay.body.replayed, true); check(await countTasks(), before);
  const fromCli = await cli('image-session-get', { editId: edited.edit.editId }); check(fromCli.code, 0); check(JSON.parse(fromCli.stdout).edit.candidates[0].taskId, edited.taskId);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['scripts/workbench-mcp.mjs'], env, stderr: 'pipe' }));
  const tools = await client.listTools();
  for (const name of ['workbench_inspect_image_target', 'workbench_resolve_image_region', 'workbench_edit_image_region', 'workbench_apply_image_candidate', 'workbench_get_image_edit']) check(tools.tools.some(tool => tool.name === name), true);
  const mcp = await client.callTool({ name: 'workbench_inspect_image_target', arguments: { targetId: target.targetId, view: 'source' } });
  check(mcp.isError, undefined); check(mcp.content.filter(block => block.type === 'image').length, 1); check(mcp.structuredContent.imageBase64, undefined);
  const comparison = await client.callTool({ name: 'workbench_get_image_edit', arguments: { editId: edited.edit.editId, candidateVersion: edited.candidateVersion, comparison: { previewWidth: 48 } } });
  check(comparison.isError, undefined);
  check(comparison.content.filter(block => block.type === 'image').length, 2);
  check(comparison.structuredContent.edit.comparison.candidateVersion, edited.candidateVersion);
  check(comparison.structuredContent.edit.comparison.beforePng, undefined);
  const selectedPath = `/tools/interactable-editor?${new URLSearchParams({ imageEdit: edited.edit.editId, imageCandidate: edited.candidateVersion, document: project.projectId, object: object.definitionId })}`;
  const previewParams = new URLSearchParams(selectedPath.split('?')[1]); previewParams.sort();
  const previewPath = `/tools/interactable-editor?${previewParams}`;
  check(edited.presentation.viewPath, selectedPath);
  const present = await client.callTool({ name: 'workbench_present', arguments: { editId: edited.edit.editId, candidateVersion: edited.candidateVersion } });
  check(present.isError, undefined); check(present.structuredContent.viewPath, previewPath);
  check(present.structuredContent.displayed, false, 'A queued request is not proof of display.');
  const selectedEdit = await client.callTool({ name: 'workbench_get_image_edit', arguments: { editId: edited.edit.editId, candidateVersion: edited.candidateVersion } });
  check(selectedEdit.isError, undefined); check(selectedEdit.structuredContent.presentation.viewPath, selectedPath);
  check(selectedEdit.structuredContent.frontendPresentation.viewPath, previewPath);
  check(selectedEdit.structuredContent.frontendPresentation.displayed, false);
  const result = await client.callTool({ name: 'workbench_get_result', arguments: { taskId: edited.taskId } });
  check(result.isError, undefined); check(result.structuredContent.presentation.viewPath, selectedPath);
  const adopted = await client.callTool({ name: 'workbench_apply_image_candidate', arguments: { editId: edited.edit.editId, candidateVersion: edited.candidateVersion, expectedRevision: target.revision, expectedSha256: target.sha256, commandId: 'transport-adopt' } });
  check(adopted.isError, undefined); check(adopted.structuredContent.revision, 2);
  const reused = await post('image-edit', { ...input, operation: { type: 'erase' } }); check(reused.status, 409); check(reused.body.code, 'COMMAND_ID_REUSED');
  const noAi = await post('image-edit', { ...input, expectedRevision: adopted.structuredContent.target.revision, expectedSha256: adopted.structuredContent.target.sha256, commandId: 'unsupported-small-ai', operation: { type: 'ai-edit', prompt: 'Small source must not call a provider' } }); check(noAi.status, 400); check(noAi.body.code, 'IMAGE_AI_SIZE_UNSUPPORTED'); check(providerCalls, 0);
  const current = await post('document-get', { documentId: project.projectId });
  current.body.document.content.objects[0].visual.assetId = '';
  check((await post('document-save', { documentId: project.projectId, expectedRevision: current.body.document.revision, commandId: 'transport-remove-live-image', content: current.body.document.content })).status, 200);
  check((await post('image-inspect', { target: ref, view: 'source' })).status, 404);
  for (const candidateVersion of ['source', edited.candidateVersion]) {
    const history = await client.callTool({ name: 'workbench_get_image_edit', arguments: { editId: edited.edit.editId, candidateVersion, includePixels: true } });
    check(history.isError, undefined);
    check(history.structuredContent.edit.selectedVersion, candidateVersion);
    const images = history.content.filter(block => block.type === 'image');
    check(images.length, 1); check(images[0].mimeType, 'image/png');
    check(history.structuredContent.edit.pixels.imageBase64, undefined);
    const expected = Buffer.from(rgba); if (candidateVersion !== 'source') expected.fill(0, 4, 8);
    check(Buffer.from(history.structuredContent.edit.pixels.rgbaBase64, 'base64'), expected);
    check(await sharp(Buffer.from(images[0].data, 'base64')).ensureAlpha().raw().toBuffer(), expected);
  }
  await client.close(); await stop();
  const offlineBefore = await countTasks();
  const offline = await cli('image-edit', { ...input, commandId: 'offline-no-fallback' });
  assert.notEqual(offline.code, 0); assertions++; check(await countTasks(), offlineBefore); check(providerCalls, 0);
  const report = { batch: '7D', test: 'image-edit-transport', assertions, providerCalls, namespace: process.env.WORKBENCH_TEST_RUN, scenarios: ['HTTP local flow', 'concurrent command replay', 'Bridge restart replay', 'CLI forwarding', 'MCP five tools and image content', 'exact edit/candidate presentation and task result link', 'adoption', 'unsupported AI size preflight', 'immutable source/candidate native MCP images after live source removal', 'Bridge unavailable no direct fallback'] };
  const reportDirectory = path.resolve(repositoryRoot, 'work/test-runs', process.env.WORKBENCH_TEST_RUN); await mkdir(reportDirectory, { recursive: true }); await writeFile(path.join(reportDirectory, 'image-edit-transport.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await client.close().catch(() => {}); await stop(); await new Promise(resolve => provider.close(resolve)); }
