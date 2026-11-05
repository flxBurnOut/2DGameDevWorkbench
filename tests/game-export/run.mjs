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
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
  prepareGodotPackage,
  readGodotZip,
  unwrapGodotMapZip,
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
import {
  createScene,
  addMaterial,
  addInstance,
} from '../../features/scene-composer/model.mjs';
import { buildSceneGodotPackage } from '../../features/scene-composer/godot-builder.mjs';
import { splitFixture } from '../scene-composer/map-split-fixture.mjs';
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
const rawMap = new JSZip();
rawMap.file('project.godot', 'do not copy');
rawMap.file('assets/map_overall.png', png);
rawMap.file(
  'map_export.json',
  JSON.stringify({
    format: 'frame-ronin-engine-package',
    version: 1,
    target: 'godot',
    layers: ['overall'],
    canvas: { originX: -16, originY: 32, width: 16, height: 16 },
  }),
);
rawMap.file(
  'regions.json',
  JSON.stringify({
    format: 'frame-ronin-regions',
    version: 1,
    coordinateSystem: 'pixel-world-y-down',
    canvas: { originX: -16, originY: 32, width: 16, height: 16 },
    regions: [
      {
        layer: 'collision',
        points: [
          { x: -16, y: 32 },
          { x: 0, y: 32 },
          { x: 0, y: 48 },
        ],
      },
    ],
  }),
);
rawMap.file(
  'map_scene.tscn',
  '[gd_scene load_steps=2 format=3]\n[ext_resource type="Texture2D" path="res://assets/map_overall.png" id="1"]\n[node name="Map" type="Node2D"]\n[node name="Image" type="Sprite2D" parent="."]\nposition = Vector2(-16, 32)\ntexture = ExtResource("1")\n',
);
rawMap.file(
  'frame_ronin_regions.gd',
  'class_name FrameRoninRegions\nextends RefCounted\nconst MANIFEST = "res://regions.json"\n',
);
const mapBytes = await rawMap.generateAsync({ type: 'nodebuffer' });
const object = await buildGodotPackage(
  { project: createProject() },
  { repositoryRoot, exportId: 'delivery-fixture' },
);
let delivery, installed;
test('map export removes project config, namespaces all references and keeps collisions and pixels', async () => {
  const p = await prepareGodotPackage(mapBytes),
    files = await readGodotZip(p.bytes),
    scene = Buffer.from(
      files.get(p.manifest.entryScenes[0].slice(6)),
    ).toString();
  assert.equal(p.manifest.kind, 'map');
  assert.equal(
    [...files.keys()].some((p) => p.endsWith('project.godot')),
    false,
  );
  assert.match(scene, /position = Vector2\(-16, 32\)/);
  assert.match(scene, /res:\/\/forge_maps\/map-/);
  assert.equal(
    hash([...files].find(([n]) => n.endsWith('map_overall.png'))[1]),
    hash(png),
  );
  assert.equal(p.manifest.details.collisionCount, 1);
  assert.doesNotMatch(
    Buffer.from([...files].find(([n]) => n.endsWith('.gd'))[1]).toString(),
    /class_name/,
  );
  assert.equal(Object.values((await JSZip.loadAsync(p.bytes)).files).some(f=>f.dir),false,'No nondeterministic auto-created directory entries');
  const second = await prepareGodotPackage(p.bytes);
  assert.equal(hash(p.bytes), hash(second.bytes));
  const restored = unwrapGodotMapZip(await JSZip.loadAsync(p.bytes));
  assert.equal(
    await restored.file('regions.json').async('string'),
    await rawMap.file('regions.json').async('string'),
  );
  await writeFile(path.join(sandbox, 'map-standard.zip'), p.bytes);
});
test('interactable profiles keep real runtime and scene references', async () => {
  for (const profile of ['generic', 'copyworms']) {
    const b = await buildGodotPackage(
      { project: createProject(), targetProfile: profile },
      { repositoryRoot },
    );
    const p = await prepareGodotPackage(b.bytes);
    assert.equal(p.manifest.details.targetProfile, profile);
    assert.equal(p.manifest.entryScenes.length, 1);
    assert.ok(p.manifest.runtime);
  }
});
test('complete scenes preserve placement, actor slot and one shared runtime', async () => {
  const scene = createScene('地图交互物接入验收');
  scene.map = {
    name: '地图',
    origin: { x: -16, y: 32 },
    offset: { x: 3, y: 4 },
    layers: [
      {
        id: 'map_overall',
        name: '地图',
        source: 'data:image/png;base64,' + png.toString('base64'),
        width: 16,
        height: 16,
        locked: true,
        hidden: false,
        included: true,
      },
    ],
    collisions: [
      [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 8, y: 8 },
      ],
    ],
    source: 'data:application/zip;base64,UEs=',
    warnings: [],
  };
  scene.order.push('map_overall');
  const material = addMaterial(
    scene,
    object.project,
    object.project.objects[0].definitionId,
  );
  addInstance(scene, material.id, 42, 24);
  const b = await buildSceneGodotPackage(scene, { repositoryRoot }),
    p = await prepareGodotPackage(b.bytes),
    before = await readGodotZip(b.bytes),
    after = await readGodotZip(p.bytes);
  const entry = p.manifest.entryScenes[0].slice(6);
  assert.deepEqual(after.get(entry), before.get(entry));
  assert.equal(p.manifest.details.actorSlot, 'ActorSlot');
  assert.equal(
    [...after.keys()].filter((n) =>
      n.endsWith('/runtime/v1/interaction_runtime_2d.tscn'),
    ).length,
    1,
  );
  await writeFile(path.join(sandbox, 'scene.zip'), p.bytes);
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
    'scenes/x/../escape.gd',
    'scenes/X.gd',
    'scenes/.git/config',
  ]) {
    const z = await JSZip.loadAsync(object.bytes);
    z.file(bad, 'bad');
    if (bad === 'scenes/X.gd') z.file('scenes/x.gd', 'duplicate');
    await assert.rejects(async () =>
      prepareGodotPackage(await z.generateAsync({ type: 'nodebuffer' })),
    );
  }
  const z = await JSZip.loadAsync(object.bytes);
  z.file(
    'scenes/missing.tscn',
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
    projectRevision: detail.inspection.projectRevision,
  });
  assert.equal(installed.installed, true);
  assert.equal(installed.status, 'assets_installed');
  const again = await installGameExport(repositoryRoot, manifest, {
    ...delivery,
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
    projectRevision: detail.inspection.projectRevision,
  });
  assert.equal(blocked.installed, false);
  assert.equal(
    await readFile(path.join(game, scene), 'utf8'),
    'custom gameplay scene',
  );
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
    ...delivery,
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
    const response = await fetch(url + '/v1/game-export/deliver', {
      method: 'POST',
      headers: {
        'content-type': 'application/zip',
        'x-forge-game-token': settings.token,
        'x-forge-project': encodeURIComponent(game),
      },
      body: mapBytes,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).kind, 'map');
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
    const result = await completeGameExport(repositoryRoot, manifest, {
      ...delivery, status: 'integrated', summary: 'Version gate fixture only.', files: ['Main.gd'],
      engine: {status: 'passed', version, evidence: 'Synthetic gate input; no engine execution claimed by this test.'},
    });
    assert.equal(result.integration.engine.baselineValidated, expected);
  }
});
test('a scenery-only scene from an older exporter installs into a clean game', async () => {
  const scene = await splitFixture();
  const built = await buildSceneGodotPackage(scene, { repositoryRoot });
  const zip = await JSZip.loadAsync(built.bytes);
  const name = `scenes/${scene.id}/scene-manifest.json`;
  const older = JSON.parse(await zip.file(name).async('string'));
  assert.equal(older.runtime, null);
  delete older.runtime;
  zip.file(name, JSON.stringify(older));
  const target = path.join(sandbox, '独立景物关卡');
  await mkdir(target);
  await writeFile(path.join(target, 'project.godot'), config);
  const receipt = await deliverGodotPackage(repositoryRoot, manifest, { bytes: await zip.generateAsync({ type: 'nodebuffer' }), projectPath: target });
  const details = await getGameExport(repositoryRoot, manifest, receipt);
  const installed = await installGameExport(repositoryRoot, manifest, { ...receipt, projectRevision: details.inspection.projectRevision });
  assert.equal(installed.installed, true);
  assert.deepEqual(await readFile(path.join(target, built.scenePath.slice(6))), await zip.file(built.scenePath.slice(6)).async('nodebuffer'));
  assert.ok(!(await readdir(target)).includes('addons'));
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
