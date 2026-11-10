import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProject, createObject } from '../../features/interactable-editor/contract.mjs';
import { createScene, replaceMap } from '../../features/scene-composer/model.mjs';
import { parseDocumentMediaReference } from '../../features/editor-documents/media-references.mjs';
import { applyDocumentCommands, createDocument, getDocument, listDocuments, restoreDocument, saveDocument, documentDirectory, documentRequest, validateDocument, simulateDocument } from '../../lib/workbench/editor-documents.mjs';

const testRoot = path.resolve('work/test-runs', process.env.WORKBENCH_TEST_RUN);
await mkdir(testRoot, { recursive: true });
const root = await mkdtemp(path.join(testRoot, 'documents-'));
const outsideRoot = await mkdtemp(path.join(testRoot, 'outside-documents-'));
const manifest = { workspace: { taskDirectory: 'work/tasks', documentDirectory: 'work/editor-documents', outputDirectory: 'outputs' } };
let assertions = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
const reject = async (fn, code) => { await assert.rejects(fn, error => !code || error.code === code); assertions++; };
const png = await sharp({ create: { width: 8, height: 12, channels: 4, background: '#ff8800' } }).png().toBuffer();
const source = `data:image/png;base64,${png.toString('base64')}`;
try {
  const first = await createDocument(root, manifest, { kind: 'scene', commandId: 'create-scene', name: 'Shared room' });
  const id = first.document.id;
  check(first.document.revision, 1);
  check(first.document.content.id, id);
  check(first.document.content.revision, 1);
  check((await createDocument(root, manifest, { name: 'Shared room', commandId: 'create-scene', kind: 'scene' })).document.id, id);
  check((await createDocument(root, manifest, { name: 'Shared room', commandId: 'create-scene', kind: 'scene' })).replayed, true);
  const object = createObject('toggle'); object.definitionId = 'switch';
  const project = { ...createProject(), projectId: 'material-project', assets: [{ id: 'visual', name: 'switch.png', mime: 'image/png', source }], objects: [object] };
  object.visual.assetId = 'visual';
  const edit = { documentId: id, expectedRevision: 1, commandId: 'place-switch', commands: [
    { type: 'import-material', project, definitionId: 'switch', materialId: 'switch-material' },
    { type: 'add-instance', materialId: 'switch-material', x: 40, y: 80, instanceId: 'switch-instance' },
    { type: 'scale-instances', ids: ['switch-instance'], scale: 2 },
    { type: 'flip-instances', ids: ['switch-instance'], flipH: true },
    { type: 'move-instances', ids: ['switch-instance'], dx: 20, dy: -4 },
  ] };
  const placed = await applyDocumentCommands(root, manifest, edit);
  check(placed.document.revision, 2);
  check(placed.document.content.instances[0].x, 60);
  check(placed.document.content.instances[0].y, 76);
  check(placed.document.content.instances[0].scale, 2);
  check(placed.document.content.instances[0].flipH, true);
  const metadata = await getDocument(root, manifest, { documentId: id, metadataOnly: true });
  check(metadata.document.content, undefined);
  check(metadata.document.contentHash, placed.document.contentHash);
  const validated = await validateDocument(root, manifest, { documentId: id });
  check(validated.valid, true);
  check(validated.counts.instances, 1);
  const simulation = await simulateDocument(root, manifest, { documentId: id, events: [{ type: 'request', instanceId: 'switch-instance' }], expectEvents: [{ name: 'toggled', instanceId: 'switch-instance' }] });
  check(simulation.passed, true);
  check(simulation.states[0].state.toggleState, true);
  check((await getDocument(root, manifest, { documentId: id })).document.contentHash, placed.document.contentHash);
  check((await getDocument(root, manifest, { documentId: id, revision: 1 })).document.content.instances.length, 0);
  check((await applyDocumentCommands(root, manifest, edit)).replayed, true);
  await reject(() => applyDocumentCommands(root, manifest, { ...edit, commands: [{ type: 'rename', name: 'Different' }] }), 'COMMAND_ID_REUSED');
  await reject(() => applyDocumentCommands(root, manifest, { ...edit, commandId: 'stale' }), 'REVISION_CONFLICT');
  await reject(() => applyDocumentCommands(root, manifest, { ...edit, expectedRevision: 2, commandId: 'atomic-fail', commands: [{ type: 'rename', name: 'Must not persist' }, { type: 'move-instances', ids: ['missing'], dx: 5 }] }), 'INVALID_COMMAND');
  check((await getDocument(root, manifest, { documentId: id })).document.name, 'Shared room');
  const races = await Promise.allSettled(['one', 'two'].map(commandId => applyDocumentCommands(root, manifest, { documentId: id, expectedRevision: 2, commandId, commands: [{ type: 'rename', name: commandId }] })));
  check(races.filter(result => result.status === 'fulfilled').length, 1);
  check(races.filter(result => result.status === 'rejected')[0].reason.code, 'REVISION_CONFLICT');
  const restored = await restoreDocument(root, manifest, { documentId: id, expectedRevision: 3, commandId: 'restore-room', revision: 1 });
  check(restored.document.revision, 4);
  check(restored.document.restoredFrom, 1);
  check(restored.document.content.instances.length, 0);
  check((await applyDocumentCommands(root, manifest, edit)).currentRevision, 4);
  await reject(() => saveDocument(root, manifest, { documentId: id, expectedRevision: 4, commandId: 'identity-swap', content: { ...restored.document.content, id: 'replacement' } }));
  await reject(() => applyDocumentCommands(root, manifest, { documentId: id, expectedRevision: 4, commandId: 'eval', commands: [{ type: 'eval', code: 'process.exit()' }] }));
  const current = await getDocument(root, manifest, { documentId: id });
  check(current.document.revision, 4);
  check((await listDocuments(root, manifest, { kind: 'scene' })).total, 1);

  // Importing a local file embeds its bytes, so later file edits never alter history.
  await mkdir(path.join(root, 'outputs/imported'), { recursive: true });
  await writeFile(path.join(root, 'outputs/imported/switch.png'), png);
  const localProject = structuredClone(project); localProject.projectId = 'interactive-doc'; localProject.assets[0].source = 'outputs/imported/switch.png';
  const saved = await createDocument(root, manifest, { kind: 'interactable', commandId: 'create-interactive', content: localProject });
  await writeFile(path.join(root, 'outputs/imported/switch.png'), 'changed');
  check((await getDocument(root, manifest, { documentId: 'interactive-doc' })).document.content.assets[0].source, source);
  const definitionId = 'switch';
  const changed = await applyDocumentCommands(root, manifest, { documentId: 'interactive-doc', expectedRevision: 1, commandId: 'behavior-edit', commands: [
    { type: 'add-asset', asset: { id: 'new-visual', name: 'new.png', mime: 'image/png', source } },
    { type: 'bind-asset', definitionId, assetId: 'new-visual' },
    { type: 'set-content', definitionId, content: { prompt: 'Use switch', pages: ['The room lights up.'] } },
    { type: 'set-shape', definitionId, target: 'solid', shape: { width: 42, height: 12 }, enabled: true },
    { type: 'set-behavior', definitionId, behavior: { initialToggle: true } },
  ] });
  check(changed.document.content.projectId, 'interactive-doc');
  check(changed.document.content.objects[0].visual.assetId, 'new-visual');
  check(changed.document.content.objects[0].behavior.initialToggle, true);
  check(changed.document.content.objects[0].solid.shape.width, 42);
  check(changed.document.content.objects[0].behavior.states, saved.document.content.objects[0].behavior.states);
  const objectSimulation = await simulateDocument(root, manifest, { documentId: 'interactive-doc', events: [{ type: 'request', instanceId: 'switch' }, { type: 'advance-text' }, { type: 'advance-text' }], expectEvents: [{ name: 'toggled', instanceId: 'switch' }] });
  check(objectSimulation.passed, true);
  check(objectSimulation.states[0].state.toggleState, false);
  await reject(() => applyDocumentCommands(root, manifest, { documentId: 'interactive-doc', expectedRevision: 2, commandId: 'bad-binding', commands: [{ type: 'bind-asset', definitionId, assetId: 'missing' }] }), 'INVALID_COMMAND');
  const generationProject = structuredClone(project); generationProject.projectId = 'bad-hash'; generationProject.assets[0].generation = { sourceTaskId: 'task-one', sha256: '0'.repeat(64) };
  await reject(() => createDocument(root, manifest, { kind: 'interactable', commandId: 'bad-hash', content: generationProject }));
  await reject(() => getDocument(root, manifest, { documentId: 'bad-hash' }), 'DOCUMENT_NOT_FOUND');
  const externalProject = structuredClone(project); externalProject.projectId = 'outside-asset'; externalProject.assets[0].source = '../outside.png';
  await reject(() => createDocument(root, manifest, { kind: 'interactable', commandId: 'outside-asset', content: externalProject }));
  await writeFile(path.join(outsideRoot, 'source.png'), png);
  await symlink(outsideRoot, path.join(root, 'outputs/linked-assets'), 'junction');
  const linkedProject = structuredClone(project); linkedProject.projectId = 'linked-asset'; linkedProject.assets[0].source = 'outputs/linked-assets/source.png';
  await reject(() => createDocument(root, manifest, { kind: 'interactable', commandId: 'linked-asset', content: linkedProject }));
  await symlink(outsideRoot, path.join(root, 'work/linked-storage'), 'junction');
  const linkedManifest = { workspace: { ...manifest.workspace, taskDirectory: 'work/linked-storage/tasks' } };
  await reject(() => createDocument(root, linkedManifest, { kind: 'scene', commandId: 'linked-storage' }), 'UNSAFE_DOCUMENT_PATH');
  check(await readdir(outsideRoot), ['source.png']);
  const storedEntries = await readdir(documentDirectory(root, manifest));
  check(storedEntries.filter(name => /^document-[a-f0-9]{40}$/.test(name)).length, 2);
  check(storedEntries.includes('media'), true);
  const lockedScene = structuredClone(placed.document.content); lockedScene.id = 'locked-doc'; lockedScene.instances[0].locked = true;
  await createDocument(root, manifest, { kind: 'scene', commandId: 'locked-create', content: lockedScene });
  await reject(() => applyDocumentCommands(root, manifest, { documentId: 'locked-doc', expectedRevision: 1, commandId: 'locked-move', commands: [{ type: 'move-instances', ids: ['switch-instance'], x: 10 }] }), 'INVALID_COMMAND');
  await reject(() => applyDocumentCommands(root, manifest, { documentId: 'locked-doc', expectedRevision: 1, commandId: 'locked-order', commands: [{ type: 'reorder', ids: ['switch-instance'], action: 'front' }] }), 'INVALID_COMMAND');
  const movedLocked = structuredClone(lockedScene); movedLocked.instances[0].x++;
  await reject(() => documentRequest(root, manifest, 'document-save', { documentId: 'locked-doc', expectedRevision: 1, commandId: 'locked-save', content: movedLocked }, { agent: true }), 'LOCKED_NODE');
  check((await saveDocument(root, manifest, { documentId: 'locked-doc', expectedRevision: 1, commandId: 'manual-locked-save', content: movedLocked })).document.revision, 2);
  await testBridge();
  process.stdout.write(`${JSON.stringify({ editorDocuments: 'ok', assertions, immutableSnapshots: true, revisionConflicts: true, bridgeMcpCli: true }, null, 2)}\n`);
} finally { await rm(root, { recursive: true, force: true }); await rm(outsideRoot, { recursive: true, force: true }); }

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function testBridge() {
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, WORKBENCH_RUNTIME_URL: base, WORKBENCH_RUNTIME_PORT: String(port) };
  const child = spawn(process.execPath, ['scripts/workbench-http.mjs'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const client = new Client({ name: 'editor-document-tests', version: '1' });
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(stderr || `Bridge exited ${child.exitCode}`);
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const scene = createScene('HTTP Room'); scene.id = `http-${process.env.WORKBENCH_TEST_RUN}`;
    const post = async (url, input) => { const response = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() }; };
    check((await post('/v1/documents', { kind: 'scene', content: scene, commandId: 'http-create' })).status, 200);
    const raced = await Promise.all(['http-one', 'http-two'].map(commandId => post(`/v1/documents/${scene.id}/apply`, { expectedRevision: 1, commandId, commands: [{ type: 'rename', name: commandId }] })));
    check(raced.map(result => result.status).sort((a, b) => a - b), [200, 409]);
    check(raced.find(result => result.status === 409).body.code, 'REVISION_CONFLICT');
    check(raced.find(result => result.status === 409).body.currentRevision, 2);
    // A separate CLI process must reach the same Bridge authority.
    const cli = spawn(process.execPath, ['scripts/workbench.mjs', 'agent', 'document-get', '--input-json', JSON.stringify({ documentId: scene.id }), '--json'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let cliError = ''; cli.stdout.on('data', data => { stdout += data; }); cli.stderr.on('data', data => { cliError += data; });
    const exitCode = await new Promise(resolve => cli.on('exit', resolve));
    check(exitCode, 0); assert.equal(cliError, '');
    check(JSON.parse(stdout).document.revision, 2);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['scripts/workbench-mcp.mjs'], env, stderr: 'pipe' }));
    const tools = await client.listTools();
    check(tools.tools.some(tool => tool.name === 'workbench_apply_document_commands'), true);
    const mcp = await client.callTool({ name: 'workbench_apply_document_commands', arguments: { documentId: scene.id, expectedRevision: 2, commandId: 'mcp-rename', commands: [{ type: 'rename', name: 'MCP Room' }] } });
    assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
    check(mcp.structuredContent.document.revision, 3);
    check((await (await fetch(`${base}/v1/documents/${scene.id}`)).json()).document.name, 'MCP Room');
    const stale = await client.callTool({ name: 'workbench_apply_document_commands', arguments: { documentId: scene.id, expectedRevision: 1, commandId: 'mcp-stale', commands: [{ type: 'rename', name: 'stale' }] } });
    check(stale.isError, true);
    check(stale.structuredContent.error.code, 'REVISION_CONFLICT');
    const restored = await post(`/v1/documents/${scene.id}/restore`, { expectedRevision: 3, commandId: 'http-restore', revision: 1 });
    check(restored.body.document.revision, 4);
    check(restored.body.document.name, 'HTTP Room');
    const historical = await (await fetch(`${base}/v1/documents/${scene.id}?revision=3`)).json();
    check(historical.document.name, 'MCP Room');
    const sha = createHash('sha256').update(JSON.stringify(historical.document.content)).digest('hex');
    check(sha, historical.document.contentHash);
    const metadata = await (await fetch(`${base}/v1/documents/${scene.id}?metadata=true`)).json();
    check(metadata.document.content, undefined);
    check(metadata.document.revision, 4);
    const observed = await client.callTool({ name: 'workbench_observe_document', arguments: { documentId: scene.id, revision: 4, region: { x: 0, y: 0, width: 128, height: 128 }, overlay: true } });
    assert.equal(observed.isError, undefined, JSON.stringify(observed));
    check(observed.structuredContent.revision, 4);
    check(observed.content.filter(block => block.type === 'image').length, 2);
    check(observed.structuredContent.images.some(image => image.data !== undefined), false);
    check(observed.structuredContent.images[0].width, 128);
    const artifact = observed.structuredContent.images[0];
    const bytes = Buffer.from(await (await fetch(`${base}/v1/artifacts?path=${encodeURIComponent(artifact.artifactPath)}`)).arrayBuffer());
    check(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    const valid = await client.callTool({ name: 'workbench_validate_document', arguments: { documentId: scene.id, revision: 4 } });
    check(valid.structuredContent.valid, true);
    const mediaScene = createScene('HTTP media'); mediaScene.id = `http-media-${process.env.WORKBENCH_TEST_RUN}`;
    replaceMap(mediaScene, { name: 'Map', origin: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, collisions: [], warnings: [],
      source: 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
      layers: [{ id: 'map_overall', name: 'Map', source, width: 8, height: 12, locked: false, hidden: false, included: true }] });
    const created = await post('/v1/documents?media=references', { kind: 'scene', content: mediaScene, commandId: 'http-media-create' });
    check(created.status, 200);
    const reference = created.body.document.content.map.layers[0].source, media = parseDocumentMediaReference(reference);
    assert.ok(media); assertions++;
    const mediaUrl = `${base}/v1/document-media/${media.key}`;
    const mediaHead = await fetch(mediaUrl, { method: 'HEAD' });
    check(mediaHead.status, 200); check(mediaHead.headers.get('content-length'), String(png.length));
    check(Buffer.from(await (await fetch(mediaUrl)).arrayBuffer()), png);
    const uploaded = await fetch(mediaUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
    check(uploaded.status, 200); check((await uploaded.json()).media.created, false);
    check((await fetch(`${base}/v1/document-media/${'f'.repeat(64)}.png`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png })).status, 400);
    const saved = await post(`/v1/documents/${mediaScene.id}/save?media=references`, { expectedRevision: 1, commandId: 'http-media-save', content: { ...created.body.document.content, name: 'HTTP compact edit' } });
    check(saved.status, 200); check(saved.body.document.content.map.layers[0].source, reference);
    check((await (await fetch(`${base}/v1/documents/${mediaScene.id}`)).json()).document.content.map.layers[0].source, source);
  } finally {
    await client.close(); child.kill('SIGTERM');
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  }
}
