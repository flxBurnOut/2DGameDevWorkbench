import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import { readScenePackage } from '../../features/scene-composer/package.mjs';
import { buildSceneGodotPackage } from '../../features/scene-composer/godot-builder.mjs';
import {
  activeMapCollisions,
  mapSplitElementOrigin,
  sceneDisplayOrder,
} from '../../features/scene-composer/render-model.mjs';
import { splitFixture } from './map-split-fixture.mjs';

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const godot = process.env.GODOT_47_BIN;
assert.ok(godot, 'Set GODOT_47_BIN to the actual Godot 4.7.x executable.');
const repositoryRoot = process.cwd();
const output = path.resolve(
  option('--output') || `work/test-runs/split-${randomUUID().slice(0, 8)}`,
);
const relative = path.relative(repositoryRoot, output);
assert.ok(
  relative && !relative.startsWith('..') && !path.isAbsolute(relative),
  'Engine evidence must stay in this workspace.',
);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // Evidence is new; never overwrite another test or user project.
const project = path.join(output, 'project');
await mkdir(project);
// Godot's Windows project-list/cache paths can use known folders even when
// APPDATA is overridden. Portable mode keeps every editor write in this run.
// https://docs.godotengine.org/en/stable/tutorials/io/data_paths.html#self-contained-mode
let executable = godot;
if (process.platform === 'win32') {
  const engineDirectory = path.join(output, 'engine');
  await mkdir(engineDirectory);
  executable = path.join(engineDirectory, 'Godot.exe');
  await copyFile(godot, executable);
  await writeFile(path.join(engineDirectory, '_sc_'), '');
}
const run = (args) => {
  const result = spawnSync(executable, args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, APPDATA: path.join(output, 'u') },
  });
  return { ...result, log: (result.stdout || '') + (result.stderr || '') };
};
const versionProbe = run(['--version']);
assert.ifError(versionProbe.error);
assert.equal(versionProbe.status, 0, versionProbe.log);
const engineVersion = versionProbe.log.trim();
assert.match(
  engineVersion,
  /^4\.7\./,
  `Engine must be 4.7.x, got ${engineVersion}`,
);
const input = option('--input');
const verifyDuplicate = process.argv.includes('--verify-duplicate-detection');
assert.ok(
  !verifyDuplicate || !input,
  'Duplicate collision injection is only for the isolated fixture.',
);
const inputBytes = input ? await readFile(input) : null;
const scene = inputBytes
  ? await readScenePackage(inputBytes)
  : await splitFixture();
const inputZip = inputBytes ? await JSZip.loadAsync(inputBytes) : null;
const inputManifests = inputZip
  ? Object.keys(inputZip.files).filter((name) =>
      /^scenes\/[^/]+\/scene-manifest\.json$/.test(name),
    )
  : [];
let built;
if (inputZip && !inputZip.file('scene.json') && inputManifests.length === 1) {
  const metadata = JSON.parse(
    await inputZip.file(inputManifests[0]).async('string'),
  );
  assert.equal(metadata.format, 'workbench-scene-godot');
  assert.ok(
    inputZip.file(metadata.scene.slice(6)),
    'Original delivery scene is missing.',
  );
  // Engine delivery inputs are tested byte-for-byte. Rebuilding is only for a
  // portable source ZIP or this harness's synthetic fixture.
  built = { bytes: inputBytes, scenePath: metadata.scene };
} else built = await buildSceneGodotPackage(scene, { repositoryRoot });
await writeFile(path.join(output, 'scene-godot.zip'), built.bytes);
const zip = await JSZip.loadAsync(built.bytes);
let total = 0;
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  total += entry._data?.uncompressedSize || 0;
  const target = path.resolve(project, name),
    rel = path.relative(project, target);
  assert.ok(
    rel &&
      !rel.startsWith('..') &&
      !path.isAbsolute(rel) &&
      !name.includes('\\') &&
      !name.includes(':'),
    'Unsafe ZIP entry',
  );
  assert.ok(total <= 512 * 1024 * 1024, 'Engine package exceeds 512 MiB.');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await entry.async('nodebuffer'), { flag: 'wx' });
}
const display = sceneDisplayOrder(scene, { includeDisabled: true });
if (verifyDuplicate) {
  const sceneFile = path.join(project, built.scenePath.slice(6));
  const text = await readFile(sceneFile, 'utf8');
  await writeFile(
    sceneFile,
    text +
      `\n[node name="InjectedDuplicate" type="CollisionPolygon2D" parent="MapCollisions"]\npolygon = PackedVector2Array(${scene.map.collisions[0].flatMap((point) => [point.x, point.y]).join(', ')})\n`,
  );
}
const split = scene.mapSplit && !scene.mapSplit.stale ? scene.mapSplit : null;
assert.ok(
  split?.elements.some((element) => element.included),
  'Supply an adopted active split scene source/Godot package.',
);
const expected = {
  scene: built.scenePath,
  rendered: process.argv.includes('--rendered'),
  actorZIndex: display.find((entry) => entry.kind === 'actor').zIndex,
  mapPosition: {
    x: scene.map.origin.x + scene.map.offset.x,
    y: scene.map.origin.y + scene.map.offset.y,
  },
  mapWidth: Math.max(...scene.map.layers.map((layer) => layer.width)),
  mapHeight: Math.max(...scene.map.layers.map((layer) => layer.height)),
  originalMapLayerIds: scene.map.layers.map((layer) => layer.id),
  mapCollisionIndices: activeMapCollisions(scene).map((entry) => entry.index),
  mapCollisionPolygons: activeMapCollisions(scene).map((entry) =>
    entry.points.map((point) => ({
      x: point.x + scene.map.offset.x,
      y: point.y + scene.map.offset.y,
    })),
  ),
  elements: split.elements
    .filter((element) => element.included)
    .map((element) => ({
      ...element,
      position: mapSplitElementOrigin(scene, element),
      parts: element.parts.map(({ source: _source, mask: _mask, ...part }) => ({
        ...part,
        zIndex: display.find(
          (entry) => entry.key === `${element.id}:${part.id}`,
        ).zIndex,
      })),
    })),
};
await writeFile(
  path.join(project, 'acceptance.json'),
  JSON.stringify(expected),
);
await copyFile(
  new URL('./map-split-engine.gd', import.meta.url),
  path.join(project, 'engine.gd'),
);
await writeFile(
  path.join(project, 'project.godot'),
  'config_version=5\n[application]\nconfig/name="ForgeSplitTest"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n[display]\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=900\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
);
for (const { name, args } of [
  {
    name: 'import',
    args: ['--headless', '--path', project, '--editor', '--import'],
  },
  {
    name: 'runtime',
    args: [
      ...(expected.rendered
        ? [
            '--position',
            '-32000,-32000',
            '--resolution',
            '1280x900',
            '--rendering-method',
            'gl_compatibility',
          ]
        : ['--headless']),
      '--audio-driver',
      'Dummy',
      '--path',
      project,
      '--script',
      'res://engine.gd',
    ],
  },
]) {
  const result = run(args);
  await writeFile(path.join(output, `${name}.log`), result.log);
  assert.ifError(result.error);
  if (verifyDuplicate && name === 'runtime') {
    assert.equal(result.status, 1, result.log);
    assert.doesNotMatch(result.log, /SCRIPT ERROR|Parse Error/);
    assert.match(
      result.log,
      /Original position is clear of all map and object collision/,
    );
    continue;
  }
  assert.equal(result.status, 0, result.log);
  assert.doesNotMatch(result.log, /SCRIPT ERROR|Parse Error|ERROR:/);
  if (name === 'runtime')
    assert.match(result.log, /MAP_SPLIT_ENGINE_TESTS \d+ checks, 0 failures/);
}
const engine = JSON.parse(
  await readFile(path.join(project, 'engine-report.json'), 'utf8'),
);
if (verifyDuplicate) {
  assert.ok(engine.physics.some((entry) => entry.oldPositionClear === false));
  assert.ok(
    engine.failures.includes(
      'Original position is clear of all map and object collision',
    ),
  );
} else if (!input)
  assert.ok(engine.physics.some((entry) => entry.oldPositionClear === true));
assert.deepEqual(
  await readScenePackage(built.bytes),
  scene,
  'Embedded scene source must preserve the exact split, IDs and edit state.',
);
const report = {
  engineVersion,
  executable,
  originalExecutable: godot,
  input: input ? path.resolve(input) : null,
  fixtureArt: !input,
  inputSha256: inputBytes
    ? createHash('sha256').update(inputBytes).digest('hex')
    : null,
  packageSha256: createHash('sha256').update(built.bytes).digest('hex'),
  sceneId: scene.id,
  candidateId: split.candidateId,
  sourceHash: split.sourceHash,
  rendered: expected.rendered,
  verifiedDuplicateDetection: verifyDuplicate,
  ...engine,
  output,
};
await writeFile(
  path.join(output, 'report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
