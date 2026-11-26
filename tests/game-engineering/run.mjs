import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { getConversationGuidance } from '../../lib/workbench/agent-api.mjs';

const root = process.cwd();
const skill = '.agents/skills/forge-game-engineering';
const python = process.env.WORKBENCH_TEST_PYTHON || path.join(root, 'Tools/SpritePipeline/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
await mkdir('work', { recursive: true });
const dir = await mkdtemp(path.join(root, 'work/engineering-test-'));
const fixtures = path.join(dir, 'fixtures');
await mkdir(fixtures);
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function run(command, args, env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${command}\n${output}`)); }, 120_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`${command} exited ${code}\n${output}`));
      else resolve(output);
    });
  });
}
const manifest = JSON.parse(await readFile('workbench/manifest.json', 'utf8'));
const guide = await getConversationGuidance(manifest);
assert.deepEqual(guide.engineering, manifest.agentAssets.engineering);
assert.equal(guide.engineering.createsTask, false);
assert.equal(guide.engineering.mode, 'external-agent');
await access(guide.engineering.skill);
await access(guide.engineering.guide);
assert(!manifest.capabilities.some((c) => c.id === 'forge-game-engineering'));
console.log('PASS manifest-driven engineering discovery without a production capability');

const colors = ['#ff0000', '#00ff00', '#0000ff'];
const images = await Promise.all(colors.map((background) => sharp({ create: { width: 32, height: 32, channels: 4, background } }).png().toBuffer()));
const atlas = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#00000000' } }).composite([
  { input: images[0], left: 0, top: 0 },
  { input: images[1], left: 32, top: 0 },
  { input: images[2], left: 0, top: 32 },
]).png().toBuffer();
await writeFile(path.join(fixtures, 'atlas.png'), atlas);
await writeFile(path.join(fixtures, 'red.png'), images[0]);
await writeFile(path.join(fixtures, 'blue.png'), images[2]);
const input = {
  version: 1, sourceFacing: 'right', offset: [0, -10], initialAnimation: 'idle',
  animations: [
    { name: 'attack', fps: 20, loop: false, source: { assetId: 'fixture:attack:2', candidateIndex: 2, diagnosticOnly: true },
      frames: [[32, 0, 32, 32], [0, 32, 32, 32], [0, 0, 32, 32]].map((region) => ({ path: path.join(fixtures, 'atlas.png'), sha256: hash(atlas), region })),
      frameEvents: { '1': 'swing_sound' } },
    { name: 'idle', fps: 10, loop: true, source: { assetId: 'fixture:idle:1', candidateIndex: 1, diagnosticOnly: true },
      frames: [
        { path: path.join(fixtures, 'blue.png'), sha256: hash(images[2]) },
        { path: path.join(fixtures, 'red.png'), sha256: hash(images[0]), duration: 2 },
      ] },
  ],
};
await writeFile(path.join(fixtures, 'sprite.json'), JSON.stringify(input, null, 2));
console.log(await run(python, ['-X', 'utf8', 'tests/game-engineering/test_staging.py', '-v'], { WORKBENCH_ENGINEERING_FIXTURES: fixtures }));
const stage = `${skill}/scripts/stage_assets.py`;
const spriteOut = path.join(dir, 'sprite');
await run(python, ['-X', 'utf8', stage, 'sprite', path.join(fixtures, 'sprite.json'), '--output', spriteOut, '--resource-root', 'Assets/Hero']);
const report = { staging: 'passed', discovery: 'passed', engine: 'not-run', directory: dir, fixturesOnly: true, paidCalls: 0 };
const godot = process.env.GODOT_47_BIN;
if (godot) {
  const version = (await run(godot, ['--version'])).trim();
  assert.match(version, /^4\.7\./, `Engine must be 4.7.x, got ${version}`);
  const project = path.join(dir, 'project');
  await mkdir(project);
  await cp(path.join(spriteOut, 'Assets'), path.join(project, 'Assets'), { recursive: true });
  await cp(`${skill}/assets/sprite_frames_merge.gd`, path.join(project, 'sprite_frames_merge.gd'));
  await cp('tests/game-engineering/probe.gd', path.join(project, 'probe.gd'));
  await writeFile(path.join(project, 'project.godot'), '[application]\nconfig/name="Forge engineering acceptance fixture"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  const imported = await run(godot, ['--headless', '--path', project, '--editor', '--import']);
  await writeFile(path.join(dir, 'godot-import.log'), imported);
  assert.doesNotMatch(imported, /SCRIPT ERROR|Parse Error|ERROR:/);
  const played = await run(godot, ['--headless', '--path', project, '--script', 'res://probe.gd']);
  await writeFile(path.join(dir, 'godot-runtime.log'), played);
  assert.doesNotMatch(played, /SCRIPT ERROR|Parse Error|ERROR:/);
  assert.match(played, /ENGINEERING_ENGINE_OK/);
  report.engine = 'passed'; report.godotVersion = version;
  console.log(played);
} else {
  console.log('SKIP Godot runtime: set GODOT_47_BIN to a Godot 4.7.x executable. Staging success is not engine validation.');
}
await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`Engineering acceptance: ${path.join(dir, 'report.json')}`);
