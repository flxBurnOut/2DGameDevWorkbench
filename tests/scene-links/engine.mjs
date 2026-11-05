import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import sharp from 'sharp';
import { createObject, createProject } from '../../features/interactable-editor/contract.mjs';
import { addInstance, addMaterial, createScene, replaceMap } from '../../features/scene-composer/model.mjs';
import { buildSceneGodotPackage } from '../../features/scene-composer/godot-builder.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const godot = option('--godot') || process.env.GODOT_47_BIN;
if (!godot) throw new Error('Supply --godot or GODOT_47_BIN pointing to an actual Godot 4.7.x executable. No engine checks were run.');
const rendered = process.argv.includes('--rendered');
const output = path.resolve(root, option('--output') || `work/scene-link-engine/${Date.now()}-${randomUUID().slice(0, 8)}`);
const relative = path.relative(root, output);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Acceptance output must stay inside this workspace.');
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // Never overwrite a previous acceptance project or another game.
const project = path.join(output, 'project');
await mkdir(project);
const run = args => {
  const result = spawnSync(godot, args, { windowsHide: true, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, APPDATA: path.join(output, 'appdata') } });
  const log = (result.stdout || '') + (result.stderr || '');
  return { ...result, log };
};
const versionProbe = run(['--version']);
assert.ifError(versionProbe.error);
assert.equal(versionProbe.status, 0, versionProbe.log);
const version = versionProbe.log.trim();
assert.match(version, /^4\.7\./, `Engine must be 4.7.x, got ${version}`);
let packageSha256 = null;
const input = option('--input');
if (input && (await stat(input)).isDirectory()) {
  await cp(path.resolve(input), project, { recursive: true, errorOnExist: true, force: false });
} else {
  const bytes = input ? await readFile(input) : await fixture();
  packageSha256 = createHash('sha256').update(bytes).digest('hex');
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    total += entry._data?.uncompressedSize || 0;
    const target = path.resolve(project, name);
    const rel = path.relative(project, target);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !name.includes('\\') && !name.includes(':'), 'Unsafe package entry');
    assert.ok(total <= 512 * 1024 * 1024, 'Acceptance package exceeds 512 MiB.');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await entry.async('nodebuffer'), { flag: 'wx' });
  }
}
const sceneFolders = (await readdir(path.join(project, 'scenes'), { withFileTypes: true })).filter(entry => entry.isDirectory());
assert.equal(sceneFolders.length, 1, 'Supply one exported scene package.');
const sceneId = sceneFolders[0].name;
const metadata = JSON.parse(await readFile(path.join(project, 'scenes', sceneId, 'scene-manifest.json'), 'utf8'));
assert.ok(metadata.links?.some(link => link.enabled && link.action === 'set_toggle'), 'Exported scene needs an enabled toggle link.');
const sourceId = option('--source') || 'switch';
const targetId = option('--target') || 'gate';
await writeFile(path.join(project, 'acceptance.json'), JSON.stringify({ scene: metadata.scene, sourceId, targetId, rendered }));
await cp(new URL('./engine.gd', import.meta.url), path.join(project, 'engine.gd'));
await writeFile(path.join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Forge isolated scene link acceptance"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n[display]\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=900\n[rendering]\nrenderer/rendering_method="gl_compatibility"\ntextures/default_filters/use_nearest_mipmap_filter=false\n');
for (const { name, args } of [
  { name: 'import', args: ['--headless', '--path', project, '--editor', '--import'] },
  { name: 'runtime', args: [...(rendered ? ['--position', '-32000,-32000', '--resolution', '1280x900', '--rendering-method', 'gl_compatibility'] : ['--headless']), '--audio-driver', 'Dummy', '--path', project, '--script', 'res://engine.gd'] },
]) {
  const result = run(args);
  await writeFile(path.join(output, `${name}.log`), result.log);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.log);
  assert.doesNotMatch(result.log, /SCRIPT ERROR|Parse Error|ERROR:/);
  if (name === 'runtime') assert.match(result.log, /SCENE_LINK_ENGINE_TESTS \d+ checks, 0 failures/);
}
const engine = JSON.parse(await readFile(path.join(project, 'engine-report.json'), 'utf8'));
const report = { engineVersion: version, executable: godot, packageSha256, fixtureArt: !input, input: input ? path.resolve(input) : null, sceneId, rendered, ...engine, output };
await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

async function fixture() {
  const scene = createScene('Scene link engine fixture');
  scene.id = 'link-engine-fixture';
  const png = await sharp({ create: { width: 320, height: 240, channels: 4, background: '#162b3a' } }).png().toBuffer();
  replaceMap(scene, { name: 'fixture', origin: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, source: 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', warnings: [], collisions: [], layers: [{ id: 'map_overall', name: 'background', source: `data:image/png;base64,${png.toString('base64')}`, width: 320, height: 240, hidden: false, included: true, locked: true }] });
  for (const [id, x] of [['switch', 80], ['gate', 240]]) {
    const project = createProject();
    const object = createObject('toggle');
    object.definitionId = id + '-definition';
    object.activation.mode = 'external_request';
    object.content.pages = [];
    object.behavior.states.forEach(state => { state.pages = []; state.feedback = []; });
    object.visual.width = 48; object.visual.height = 80;
    if (id === 'gate') {
      object.solid.enabled = true;
      object.solid.shape.type = 'rectangle'; object.solid.shape.width = 48; object.solid.shape.height = 80;
      Object.assign(object.behavior.states[0].appearance, { visible: true, solidEnabled: true });
      Object.assign(object.behavior.states[1].appearance, { visible: false, solidEnabled: false });
    }
    project.objects = [object];
    // This legal material ID is also the map layer ID in the same TSCN.
    const material = addMaterial(scene, project, object.definitionId, id === 'switch' ? 'map_overall' : undefined);
    const instance = addInstance(scene, material.id, x, 180);
    scene.order = scene.order.map(value => value === instance.id ? id : value);
    instance.id = id;
  }
  scene.links = [{ id: 'switch-gate', sourceInstanceId: 'switch', event: 'toggled', targetInstanceId: 'gate', action: 'set_toggle', value: 'source_toggle', enabled: true }];
  return (await buildSceneGodotPackage(scene, { repositoryRoot: root })).bytes;
}
