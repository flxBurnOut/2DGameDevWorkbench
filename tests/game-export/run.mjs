import {gameHandoff} from '../../features/godot-export/handoff.mjs';
import {createServer as createHttpServer} from 'node:http';
import {browseGameProjects} from '../../lib/workbench/game-project-browser.mjs';
import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
  prepareGodotPackage,
  readGodotZip,
} from '../../features/godot-export/package.mjs';
import {
  selectGameProject,
  deliverGodotPackage,
  listGameExports,
  getGameExport,
  installGameExport,
  completeGameExport,
  inspectGameProject,
} from '../../lib/workbench/game-export.mjs';
import { buildGodotPackage } from '../../features/interactable-editor/godot-builder.mjs';
import { createProject } from '../../features/interactable-editor/contract.mjs';
import { loadManifest, repositoryRoot, agentRequest, runConnector, findCapability } from '../../lib/workbench/runtime.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const manifest = await loadManifest();
await mkdir(path.join(repositoryRoot, 'work'), { recursive: true });
const sandbox = await mkdtemp(
  path.join(repositoryRoot, 'work', 'game-export-test-'),
);
const game = path.join(sandbox, '游戏项目'),
  conflictGame = path.join(sandbox, '带自定义文件的游戏');
const config =
  'config_version=5\n[application]\nconfig/name="游戏项目"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\nrun/main_scene="res://Main.tscn"\n[autoload]\n';
for (const target of [game, conflictGame]) {
  await mkdir(target);
  await writeFile(path.join(target, 'project.godot'), config);
  await writeFile(
    path.join(target, 'Main.tscn'),
    '[gd_scene format=3]\n[node name="Main" type="Node2D"]\n',
  );
}
const hash = (b) => createHash('sha256').update(b).digest('hex');
const png = await sharp({
  create: { width: 16, height: 16, channels: 4, background: '#388bff' },
})
  .png()
  .toBuffer();
let spritePackage;
const tests = [],
  test = (name, fn) => tests.push([name, fn]);
const object = await buildGodotPackage(
  { project: createProject() },
  { repositoryRoot, exportId: 'delivery-fixture' },
);
let delivery, installed;
test('interactable profiles keep real runtime and scene references', async () => {
  for (const profile of ['generic']) {
    const b = await buildGodotPackage(
      { project: createProject(), targetProfile: profile },
      { repositoryRoot },
    );
    const p = await prepareGodotPackage(b.bytes);
    assert.equal(p.manifest.details.targetProfile, profile);
    assert.equal(p.manifest.entryScenes.length, 1);
    assert.ok(p.manifest.runtime);
    const before = await readGodotZip(b.bytes);
    const after = await readGodotZip(p.bytes);
    for (const [name, bytes] of before) assert.deepEqual(after.get(name), bytes);
    assert.equal(Object.values((await JSZip.loadAsync(p.bytes)).files).some(f => f.dir), false);
    assert.equal(hash((await prepareGodotPackage(p.bytes)).bytes), hash(p.bytes));
  }
});
test('removed delivery kinds and namespaces cannot enter a retained package', async () => {
  const prepared = await prepareGodotPackage(object.bytes);
  const manifestPath = `forge_packages/${prepared.manifest.packageId}/manifest.json`;
  for (const kind of ['map', 'scene']) {
    const zip = await JSZip.loadAsync(prepared.bytes);
    zip.file(manifestPath, JSON.stringify({ ...prepared.manifest, kind }));
    await assert.rejects(
      () => zip.generateAsync({ type: 'nodebuffer' }).then(prepareGodotPackage),
      /包身份无效/,
    );
  }
  for (const name of ['scenes/legacy/scene.tscn', 'forge_maps/legacy/tile.png']) {
    const zip = await JSZip.loadAsync(object.bytes);
    zip.file(name, 'unsupported');
    await assert.rejects(
      () => zip.generateAsync({ type: 'nodebuffer' }).then(prepareGodotPackage),
      /未知的根目录/,
    );
  }
});
test('sprite delivery preserves selected action bytes, FPS, frame order and candidate identity', async () => {
  const zip = new JSZip(),
    root = 'forge_sprites/actor/job_c02';
  const frames =
    '[gd_resource type="SpriteFrames" load_steps=2 format=3]\n[ext_resource type="Texture2D" path="res://' +
    root +
    '/sprite-sheet.png" id="sheet"]\n[resource]\nanimations = [{"name": &"walk", "speed": 12.0, "loop": true, "frames": []}]\n';
  zip.file(root + '/sprite_frames.tres', frames);
  zip.file(root + '/sprite-sheet.png', png);
  zip.file(
    root + '/animated_sprite.tscn',
    '[gd_scene format=3]\n[ext_resource type="SpriteFrames" path="res://' +
      root +
      '/sprite_frames.tres" id="frames"]\n[node name="Sprite" type="AnimatedSprite2D"]\nsprite_frames = ExtResource("frames")\n',
  );
  zip.file(
    root + '/export.json',
    JSON.stringify({
      format: 'sprite-pipeline-godot',
      job_id: 'fixture_export',
      animation: 'walk',
      fps: 12,
      loop: true,
      candidate_index: 2,
      frame_count: 2,
      source_region_px: [
        [16, 0, 16, 16],
        [0, 0, 16, 16],
      ],
    }),
  );
  const p = await prepareGodotPackage(
    await zip.generateAsync({ type: 'nodebuffer' }),
  );
  const f = await readGodotZip(p.bytes);
  assert.equal(
    Buffer.from(f.get(root + '/sprite_frames.tres')).toString(),
    frames,
  );
  assert.equal(p.manifest.details.candidateIndex, 2);
  spritePackage = p.bytes;
  const handoff = gameHandoff({title:'行走候选 2',deliveryId:'delivery-fixture',project:{path:game,name:'测试游戏'}},p.manifest);
  assert.ok(handoff.prompt.includes(game) && handoff.prompt.includes('delivery-fixture'));
  assert.ok(handoff.prompt.includes('walk') && handoff.prompt.includes('候选 2') && handoff.prompt.includes('FPS 12'));
  assert.ok(handoff.prompt.includes('保留其他动作') && handoff.prompt.includes('不要重建人物系统') && handoff.prompt.includes('workbench_complete_game_export'));
  assert.equal(p.manifest.details.fps, 12);
  assert.deepEqual(p.manifest.details.frameRegions, [
    [16, 0, 16, 16],
    [0, 0, 16, 16],
  ]);
});
test('unsafe packages and unresolved dependencies fail before writing a project', async () => {
  for (const bad of [
    '../escape.gd',
    'addons/workbench_interaction/x/../escape.gd',
    'addons/workbench_interaction/X.gd',
    'addons/workbench_interaction/.git/config',
  ]) {
    const z = await JSZip.loadAsync(object.bytes);
    z.file(bad, 'bad');
    if (bad === 'addons/workbench_interaction/X.gd') z.file('addons/workbench_interaction/x.gd', 'duplicate');
    await assert.rejects(async () =>
      prepareGodotPackage(await z.generateAsync({ type: 'nodebuffer' })),
    );
  }
  const z = await JSZip.loadAsync(object.bytes);
  z.file(
    'addons/workbench_interaction/missing.tscn',
    '[ext_resource path="res://outside/missing.png"]',
  );
  await assert.rejects(
    async () =>
      prepareGodotPackage(await z.generateAsync({ type: 'nodebuffer' })),
    /引用缺失/,
  );
});
test('export remembers selected game, writes inbox only and deduplicates repeated delivery', async () => {
  await selectGameProject(repositoryRoot, manifest, game);
  delivery = await deliverGodotPackage(repositoryRoot, manifest, {
    bytes: object.bytes,
    title: '交互物验收',
  });
  assert.equal(delivery.status, 'awaiting_agent');
  assert.equal(
    await readFile(path.join(game, 'project.godot'), 'utf8'),
    config,
  );
  assert.deepEqual((await readdir(game)).sort(), [
    'Main.tscn',
    'forge_imports',
    'project.godot',
  ]);
  const duplicate = await deliverGodotPackage(repositoryRoot, manifest, {
    bytes: object.bytes,
    title: '交互物验收',
  });
  assert.equal(duplicate.deliveryId, delivery.deliveryId);
  assert.equal(duplicate.reused, true);
  assert.equal((await listGameExports(repositoryRoot, manifest)).total, 1);
});
test('inspection and idempotent install place resources, preserve config and do not claim gameplay completion', async () => {
  const detail = await getGameExport(repositoryRoot, manifest, delivery);
  assert.ok(detail.inspection.files.includes('Main.tscn'));
  assert.equal(detail.conflicts.length, 0);
  installed = await installGameExport(repositoryRoot, manifest, {
    ...delivery,
    installPlanRevision: detail.installPlanRevision,
    projectRevision: detail.inspection.projectRevision,
  });
  assert.equal(installed.installed, true);
  assert.equal(installed.status, 'assets_installed');
  const again = await installGameExport(repositoryRoot, manifest, {
    ...delivery,
    installPlanRevision: detail.installPlanRevision,
    projectRevision: detail.inspection.projectRevision,
  });
  assert.deepEqual(again.changedFiles, []);
  assert.equal(
    await readFile(path.join(game, 'project.godot'), 'utf8'),
    config,
  );
});
test('managed updates back up old resources and protect manually edited files', async () => {
  const changed = new JSZip();
  const first = await readGodotZip(object.bytes);
  const scene = installed.entryScenes[0].slice(6);
  for (const [name, data] of first)
    changed.file(
      name,
      name === scene ? Buffer.from(data).toString() + '\n; version 2\n' : data,
    );
  const update = await deliverGodotPackage(repositoryRoot, manifest, {
    bytes: await changed.generateAsync({ type: 'nodebuffer' }),
    title: '新版',
  });
  let detail = await getGameExport(repositoryRoot, manifest, update);
  assert.equal(
    detail.installPlan.find((f) => f.path === scene).action,
    'update',
  );
  await installGameExport(repositoryRoot, manifest, {
    ...update,
    installPlanRevision: detail.installPlanRevision,
    projectRevision: detail.inspection.projectRevision,
  });
  assert.equal(
    hash(await readFile(path.join(update.inboxPath, 'backups', scene))),
    hash(first.get(scene)),
  );
  await writeFile(path.join(game, scene), 'custom gameplay scene');
  detail = await getGameExport(repositoryRoot, manifest, delivery);
  assert.ok(detail.conflicts.includes(scene));
  const blocked = await installGameExport(repositoryRoot, manifest, {
    ...delivery,
    installPlanRevision: detail.installPlanRevision,
    projectRevision: detail.inspection.projectRevision,
  });
  assert.equal(blocked.installed, false);
  assert.equal(
    await readFile(path.join(game, scene), 'utf8'),
    'custom gameplay scene',
  );
  // Restore the original package for the later completion fixtures.
  await writeFile(path.join(game, scene), first.get(scene));
  detail = await getGameExport(repositoryRoot, manifest, delivery);
  installed = await installGameExport(repositoryRoot, manifest, {
    ...delivery,
    installPlanRevision: detail.installPlanRevision,
    deliveryRevision: detail.deliveryRevision,
    projectRevision: detail.inspection.projectRevision,
  });
});
test('project changes, source tampering, invalid target and junction escape are rejected', async () => {
  await assert.rejects(() => inspectGameProject(sandbox), /project.godot/);
  const detail = await getGameExport(repositoryRoot, manifest, delivery);
  await assert.rejects(
    () =>
      installGameExport(repositoryRoot, manifest, {
        ...delivery,
        projectRevision: '0'.repeat(64),
      }),
    /版本已变化/,
  );
  const target = path.join(sandbox, 'external');
  await mkdir(target);
  await symlink(
    target,
    path.join(conflictGame, 'addons'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const linked = await deliverGodotPackage(repositoryRoot, manifest, {
    bytes: object.bytes,
    projectPath: conflictGame,
  });
  await assert.rejects(
    () => getGameExport(repositoryRoot, manifest, linked),
    /路径包含链接/,
  );
  assert.deepEqual(await readdir(target), []);
  const bytes = await readFile(path.join(detail.inboxPath, 'package.zip'));
  await writeFile(path.join(detail.inboxPath, 'package.zip'), 'changed');
  await assert.rejects(
    () => getGameExport(repositoryRoot, manifest, delivery),
    /交付包已改变/,
  );
  await writeFile(path.join(detail.inboxPath, 'package.zip'), bytes);
});
test('Agent completion records actual file evidence and explicit engine-not-run', async () => {
  await assert.rejects(
    () =>
      completeGameExport(repositoryRoot, manifest, {
        ...delivery,
        status: 'integrated',
        summary: 'done',
        files: [],
        engine: { status: 'not_run', evidence: 'not installed' },
      }),
    /实际接入/,
  );
  await writeFile(
    path.join(game, 'Main.gd'),
    'extends Node2D\n# Isolated acceptance fixture; actual project integration remains Agent-owned.\n',
  );
  const result = await completeGameExport(repositoryRoot, manifest, {
    ...installed,
    status: 'integrated',
    summary: '隔离夹具已连接入口；未运行引擎。',
    files: ['Main.gd'],
    engine: {
      status: 'not_run',
      evidence: 'No engine was invoked in this contract test.',
    },
  });
  assert.equal(result.status, 'integrated');
  assert.equal(result.integration.engine.status, 'not_run');
  assert.equal(
    result.integration.files[0].sha256,
    hash(await readFile(path.join(game, 'Main.gd'))),
  );
  assert.equal(
    (await listGameExports(repositoryRoot, manifest)).deliveries.some(
      (d) => d.deliveryId === delivery.deliveryId,
    ),
    false,
  );
});
test('HTTP rejects unauthenticated project writes and exposes remembered settings', async () => {
  await selectGameProject(repositoryRoot, manifest, game);
  const reserve = createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const pipeline = createHttpServer((req,res)=>{
    if(req.method!=='GET'||req.url!=='/v1/jobs/fixture_export/exports/godot'){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'content-type':'application/zip'});res.end(spritePackage);
  });
  await new Promise(r=>pipeline.listen(0,'127.0.0.1',r));
  const child = spawn(process.execPath, ['scripts/workbench-http.mjs'], {
    cwd: repositoryRoot,
    env: { ...process.env, WORKBENCH_RUNTIME_PORT: String(port), SPRITE_PIPELINE_API_URL:'http://127.0.0.1:'+pipeline.address().port },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error('HTTP startup timeout')),
        15000,
      );
      child.stdout.on('data', (b) => {
        if (b.toString().includes('ready at')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', () => reject(Error('HTTP exited')));
    });
    const url = 'http://127.0.0.1:' + port;
    assert.equal(
      (
        await fetch(url + '/v1/game-export/select', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectPath: game }),
        })
      ).status,
      400,
    );
    const settings = await (
      await fetch(url + '/v1/game-export/settings')
    ).json();
    assert.equal(settings.project.path, game);
    const agent = (operation, input) => fetch(url + '/v1/agent/' + operation, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-game-token': settings.token }, body: JSON.stringify(input),
    });
    const inspected = await (await agent('game-export', { deliveryId: delivery.deliveryId })).json();
    assert.match(inspected.installPlanRevision, /^[a-f0-9]{64}$/);
    const stale = await agent('install-game-export', { deliveryId: delivery.deliveryId, packageSha256: inspected.packageSha256,
      projectRevision: inspected.inspection.projectRevision, deliveryRevision: inspected.deliveryRevision, installPlanRevision: '0'.repeat(64) });
    assert.equal(stale.status, 409);
    const spriteRequest = input=>fetch(url+'/v1/game-export/package',{method:'POST',headers:{'content-type':'application/json','x-forge-game-token':settings.token},body:JSON.stringify(input)});
    const matched = await spriteRequest({jobId:'fixture_export',candidateIndex:2});
    assert.equal(matched.status,200);assert.equal((await prepareGodotPackage(new Uint8Array(await matched.arrayBuffer()))).manifest.details.candidateIndex,2);
    const wrong = await spriteRequest({jobId:'fixture_export',candidateIndex:1});
    assert.equal(wrong.status,400);assert.match((await wrong.json()).error,/候选不一致/);
    assert.equal((await spriteRequest({jobId:'fixture_export',candidateIndex:'2'})).status,400);
    assert.equal((await spriteRequest({jobId:'../escape',candidateIndex:2})).status,400);
    const browse=await fetch(url+'/v1/game-export/browse',{method:'POST',headers:{'content-type':'application/json','x-forge-game-token':settings.token},body:JSON.stringify({directory:game})});assert.equal(browse.status,200);assert.equal((await browse.json()).project.path,game);
    const oldPicker=await fetch(url+'/v1/game-export/pick',{method:'POST',headers:{'content-type':'application/json','x-forge-game-token':settings.token},body:'{}'});assert.equal(oldPicker.status,400);assert.match((await oldPicker.json()).error,/页面内浏览/);

    assert.equal(
      (
        await fetch(url + '/v1/game-export/select', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forge-game-token': settings.token,
          },
          body: JSON.stringify({ projectPath: game }),
        })
      ).status,
      200,
    );
    const deliver = projectPath => fetch(url + '/v1/game-export/deliver', {
      method: 'POST',
      headers: {
        'content-type': 'application/zip',
        'x-forge-game-token': settings.token,
        'x-forge-project': encodeURIComponent(projectPath),
      },
      body: object.bytes,
    });
    const response = await deliver(game);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).kind, 'interactable');

    const blockedGame = path.join(sandbox, 'blocked-delivery');
    const inbox = path.join(blockedGame, 'forge_imports');
    await mkdir(path.join(inbox, '.gitignore'), { recursive: true });
    await writeFile(path.join(blockedGame, 'project.godot'), config);
    const blocked = await deliver(blockedGame);
    assert.equal(blocked.status, 409);
    const failure = await blocked.json();
    assert.equal(failure.code, 'INSTALL_LOCK_IGNORE_UNAVAILABLE');
    assert.match(failure.error, /forge_imports\/\.gitignore.*普通文件.*权限.*仅下载 ZIP/);
    assert.equal((await readdir(inbox)).some(name => /^(?:install\.lock|delivery-)/.test(name)), false);
  } finally {
    child.kill();
    await new Promise(r=>pipeline.close(r));
  }
});
test('MCP discovers all delivery tools and verifies the same delivery through stdio', async () => {
  const client = new Client({ name: 'game-export-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['scripts/workbench-mcp.mjs'],
    cwd: repositoryRoot,
    env: process.env,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of [
      'workbench_list_game_exports',
      'workbench_get_game_export',
      'workbench_export_to_game',
      'workbench_install_game_export',
      'workbench_complete_game_export',
    ])
      assert.ok(tools.some((t) => t.name === name));
    const result = await client.callTool({
      name: 'workbench_get_game_export',
      arguments: { deliveryId: delivery.deliveryId },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.project.path, game);

    const { packageSha256, deliveryRevision, inspection, installPlanRevision } = result.structuredContent;
    assert.match(installPlanRevision, /^[a-f0-9]{64}$/);
    const args = { deliveryId: delivery.deliveryId, packageSha256, deliveryRevision, projectRevision: inspection.projectRevision, installPlanRevision };
    const staleInput = { ...args, installPlanRevision: '0'.repeat(64) };
    const stale = await client.callTool({ name: 'workbench_install_game_export', arguments: staleInput });
    assert.equal(stale.structuredContent.error.status, 409);
    const cli = spawnSync(process.execPath, ['scripts/workbench.mjs', 'agent', 'install-game-export', '--input-json', JSON.stringify(staleInput)], {
      cwd: repositoryRoot, encoding: 'utf8',
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /版本已变化/);
    const ignore = path.join(game, 'forge_imports', '.gitignore');
    const existing = await readFile(ignore);
    await unlink(ignore);
    await mkdir(ignore);
    try {
      const blocked = await client.callTool({
        name: 'workbench_install_game_export',
        arguments: args,
      });
      assert.equal(blocked.isError, true);
      const failure = blocked.structuredContent.error;
      assert.equal(failure.status, 409);
      assert.equal(failure.code, 'INSTALL_LOCK_IGNORE_UNAVAILABLE');
      assert.match(failure.message, /forge_imports\/\.gitignore.*普通文件.*权限.*仅下载 ZIP/);
    } finally {
      await rmdir(ignore);
      await writeFile(ignore, existing);
    }
  } finally {
    await client.close();
  }
});
test('MCP-compatible asset delivery uses an exact saved export and rejects stale versions', async () => {
  const previous=process.env.SPRITE_PIPELINE_API_URL;process.env.SPRITE_PIPELINE_API_URL='http://127.0.0.1:1';
  try {
    const project=createProject();
    await runConnector(manifest,findCapability(manifest,'interactable-editor'),{operation:'export-godot',project});
    const assetId='interactable:'+project.projectId+':'+project.objects[0].definitionId;
    const {asset}=await agentRequest(manifest,'asset',{assetId});
    await assert.rejects(()=>agentRequest(manifest,'export-to-game',{assetId,revision:'0'.repeat(64),projectPath:game}),/版本已变化/);
    const result=await agentRequest(manifest,'export-to-game',{assetId,revision:asset.revision,projectPath:game});
    assert.equal(result.status,'awaiting_agent');assert.equal(result.source.assetId,assetId);assert.equal(result.project.path,game);
  } finally {if(previous===undefined)delete process.env.SPRITE_PIPELINE_API_URL;else process.env.SPRITE_PIPELINE_API_URL=previous;}
});
test('in-page directory browser is read-only and recognizes only valid game roots',async()=>{
  const before=await readdir(sandbox);
  const listing=await browseGameProjects(path.join(sandbox,'workbench'),{});
  assert.equal(listing.directory,sandbox);assert.ok(listing.folders.some(f=>f.path===game));assert.equal(listing.project,null);assert.equal(listing.readOnly,true);
  const selected=await browseGameProjects(repositoryRoot,{directory:game});assert.equal(selected.project.path,game);assert.equal(selected.project.name,'游戏项目');assert.equal(selected.folders.some(f=>f.name==='project.godot'),false);
  const fromFile=await browseGameProjects(repositoryRoot,{directory:path.join(game,'project.godot')});assert.equal(fromFile.directory,game);
  await assert.rejects(()=>browseGameProjects(repositoryRoot,{directory:'relative/project'}),/绝对路径/);
  await assert.rejects(()=>browseGameProjects(repositoryRoot,{directory:path.join(sandbox,'missing')}),/不存在/);
  await assert.rejects(()=>browseGameProjects(repositoryRoot,{directory:game,command:'unexpected'}),/无效/);
  assert.deepEqual(await readdir(sandbox),before);
});
test('4.7 baseline rejects historical engine evidence and warns on older projects', async () => {
  for (const [version, expected] of [['4.6.2', false], ['4.7.stable.official', true]]) {
    const projectPath = path.join(sandbox, 'version-' + version);
    await mkdir(projectPath);
    await writeFile(path.join(projectPath, 'project.godot'), config.replace('"4.7"', '"' + version + '"'));
    const inspected = await inspectGameProject(projectPath);
    assert.equal(inspected.versionWarning === null, expected);
    const detail = await getGameExport(repositoryRoot, manifest, delivery);
    const result = await completeGameExport(repositoryRoot, manifest, {
      ...detail, status: 'integrated', summary: 'Version gate fixture only.', files: ['Main.gd'],
      engine: {status: 'passed', version, evidence: 'Synthetic gate input; no engine execution claimed by this test.'},
    });
    assert.equal(result.integration.engine.baselineValidated, expected);
  }
});
let passed = 0;
try {
  for (const [name, fn] of tests) {
    await fn();
    passed++;
    console.log('PASS ' + name);
  }
} finally {
  await writeFile(
    path.join(sandbox, 'report.json'),
    JSON.stringify(
      {
        passed,
        total: tests.length,
        sandbox,
        productionGeneration: false,
        engine: 'not_run',
      },
      null,
      2,
    ),
  );
}
console.log(`${passed} game-export checks passed. Report: ${sandbox}`);
