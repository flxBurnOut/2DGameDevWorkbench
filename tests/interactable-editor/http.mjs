import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import sharp from 'sharp';
import JSZip from 'jszip';
import {
  createProject,
  createObject,
  normalizeProject,
} from '../../features/interactable-editor/contract.mjs';
import { readSourcePackage } from '../../features/interactable-editor/source-package.mjs';

async function freePort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let api = `${base}/v1`,
  web = null;
const child = spawn(process.execPath, ['scripts/workbench-http.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    WORKBENCH_RUNTIME_PORT: String(port),
    GODOT_47_BIN: 'not-installed',
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
try {
  let healthy = false;
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error(stderr || 'Runtime exited');
    try {
      if ((await fetch(`${base}/health`)).ok) {
        healthy = true;
        break;
      }
    } catch {
      /* booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(healthy, stderr || 'Runtime failed to start');
  if (process.argv.includes('--web')) {
    const webPort = await freePort();
    const webUrl = `http://127.0.0.1:${webPort}`;
    let webLog = '';
    web = spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '--config',
        'dist/server/wrangler.json',
        '--local',
        '--port',
        String(webPort),
        '--ip',
        '127.0.0.1',
        '--inspector-port',
        '0',
        '--var',
        `WORKBENCH_RUNTIME_URL:${base}`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKBENCH_RUNTIME_URL: base,
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_WRITE_LOGS: 'false',
          WRANGLER_LOG_PATH: '.wrangler/logs',
          MINIFLARE_REGISTRY_PATH: '.wrangler/registry',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    for (const stream of [web.stdout, web.stderr])
      stream.on('data', (chunk) => {
        webLog = (webLog + chunk).slice(-6000);
      });
    let loaded = false, lastStatus = null, lastBody = '', lastError = '', serverFailures = 0;
    for (let n = 0; n < 90; n++) {
      if (web.exitCode !== null) throw new Error(webLog);
      try {
        const page = await fetch(`${webUrl}/tools/interactable-editor`, {
          signal: AbortSignal.timeout(2000),
        });
        const html = await page.text();
        lastStatus = page.status;
        lastBody = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').slice(0, 2000) + '\nPayload tail: ' + html.slice(-1800);
        if (page.status >= 500) serverFailures++; else serverFailures = 0;
        if (page.ok && html.includes('ie-workspace')) {
          assert(
            html.includes('导出 copyWorms 兼容版'),
            'Compatible export button must be rendered.',
          );
          loaded = true;
          break;
        }
      } catch (error) {
        lastError = error.message;
      }
      if (serverFailures >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert(loaded, `Production editor readiness failed. Last HTTP status: ${lastStatus}; error: ${lastError}\nResponse: ${lastBody}\nLog tail: ${webLog}`);
    api = `${webUrl}/api/workbench`;
    console.log(
      `Isolated production editor served at ${webUrl}/tools/interactable-editor`,
    );
    const create = await fetch(`${api}/documents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'scene', name: 'Web proxy scene', commandId: 'web-create' }) });
    assert.equal(create.status, 200, await create.clone().text());
    const shared = (await create.json()).document;
    const applied = await fetch(`${api}/documents/${shared.id}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: shared.revision, commandId: 'web-rename', commands: [{ type: 'rename', name: 'Shared web revision' }] }) });
    assert.equal(applied.status, 200, await applied.clone().text());
    const updated = (await applied.json()).document;
    const metadata = await fetch(`${api}/documents/${shared.id}?metadataOnly=true`).then(value => value.json());
    assert.equal(metadata.document.revision, updated.revision);
    assert.equal(metadata.document.content, undefined);
    const old = await fetch(`${api}/documents/${shared.id}?revision=1`).then(value => value.json());
    assert.equal(old.document.name, 'Web proxy scene');
    const conflict = await fetch(`${api}/documents/${shared.id}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, commandId: 'web-stale', commands: [{ type: 'rename', name: 'Stale' }] }) });
    assert.equal(conflict.status, 409);
    const observation = await fetch(`${api}/documents/${shared.id}/observe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: updated.revision }) });
    assert.equal(observation.status, 200, await observation.clone().text());
    assert.equal((await observation.json()).images[0].mimeType, 'image/png');
    const settings = await fetch(`${api}/image-assets/settings`);
    assert.equal(settings.status, 200);
    assert.ok((await settings.json()).providers.some(provider => provider.id === 'gpt-image-2.6'));
    console.log('Production document proxies passed: streamed create/apply, metadata, historical read, CAS conflict, PNG observation and Image 2.6 settings.');
  }
  const png = await sharp({
    create: { width: 12, height: 16, channels: 4, background: '#77ffbb' },
  })
    .png()
    .toBuffer();
  const uploaded = await fetch(`${api}/interactable-assets`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: png,
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const asset = await uploaded.json();
  assert(asset.source.startsWith('work/assets/interactables/'));
  const image = await fetch(
    `${api}/interactable-assets?path=${encodeURIComponent(asset.source)}`,
  );
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  for (const bad of ['../outside.png', 'package.json'])
    assert.equal(
      (
        await fetch(
          `${api}/interactable-assets?path=${encodeURIComponent(bad)}`,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await fetch(`${api}/interactable-assets`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'invalid',
      })
    ).status,
    400,
  );
  const project = createProject();
  project.assets = [
    {
      id: 'http-image',
      name: '测试图片.png',
      mime: 'image/png',
      source: asset.source,
    },
  ];
  project.objects[0].visual.assetId = 'http-image';
  project.objects[0].content.pages = ['中文 "文本"\n第二行'];
  project.objects.push(createObject('pickup'));
  const selected = project.objects[0].definitionId;
  for (const targetProfile of ['generic', 'copyworms']) {
    project.objects[0].copyworms.objectId = 'notice';
    const response = await fetch(`${api}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'interactable-editor',
        input: {
          operation: 'export-godot',
          targetProfile,
          project,
          selectedDefinitionIds: [selected],
        },
      }),
    });
    assert.equal(response.status, 200);
    const task = await response.json();
    assert.equal(task.status, 'completed');
    const output = task.outputs.find((p) => p.endsWith('.zip'));
    assert(output);
    assert(
      output.endsWith(
        targetProfile === 'copyworms'
          ? '/interactables-copyworms.zip'
          : '/interactables.zip',
      ),
    );
    const kitRoot =
      targetProfile === 'copyworms'
        ? 'addons/workbench_interaction_copyworms'
        : 'addons/workbench_interaction';
    const download = await fetch(
      `${api}/artifacts?path=${encodeURIComponent(output)}`,
    );
    assert.equal(download.headers.get('content-type'), 'application/zip');
    const bytes = await download.arrayBuffer();
    const zip = await JSZip.loadAsync(bytes);
    assert(!zip.file('project.godot'));
    assert(zip.file(`${kitRoot}/objects/${selected}/object.tscn`));
    assert(
      !zip.file(
        `${kitRoot}/objects/${project.objects[1].definitionId}/object.tscn`,
      ),
    );
    const imported = await readSourcePackage(bytes);
    assert.equal(imported.objects.length, 1);
    assert.deepEqual(imported.objects[0], normalizeProject(project).objects[0]);
    assert.deepEqual(
      Buffer.from(imported.assets[0].source.split(',')[1], 'base64'),
      png,
    );
    const jsonPath = task.outputs.find((p) =>
      p.endsWith('/interactable-project.json'),
    );
    const portable = await (
      await fetch(`${api}/artifacts?path=${encodeURIComponent(jsonPath)}`)
    ).json();
    assert.deepEqual(normalizeProject(portable), imported);
    const listed = await (await fetch(`${api}/tasks?limit=50`)).json();
    assert(
      listed.tasks.some(
        (t) => t.id === task.taskId && t.status === 'completed',
      ),
    );
    console.log(
      JSON.stringify(
        {
          http: 'passed',
          webProxy: web ? 'passed' : 'not requested',
          sourceRoundTrip: 'passed',
          exportWithoutGodot: 'passed',
          targetProfile,
          taskId: task.taskId,
          status: task.status,
          outputs: task.outputs,
        },
        null,
        2,
      ),
    );
  }
} finally {
  if (web?.exitCode === null) {
    if (process.platform === 'win32')
      await new Promise((resolve) => {
        const killer = spawn(
          'taskkill.exe',
          ['/PID', String(web.pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true },
        );
        killer.once('exit', resolve);
        killer.once('error', resolve);
      });
    else web.kill('SIGTERM');
  }
  child.kill('SIGTERM');
  if (child.exitCode === null)
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
}
