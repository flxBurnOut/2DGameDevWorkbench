import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import JSZip from 'jszip';
import {
  createProject,
  createObject,
  normalizeProject,
  projectSchema,
} from '../../features/interactable-editor/contract.mjs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { buildGodotPackage } from '../../features/interactable-editor/godot-builder.mjs';
import { InteractionSimulation } from '../../features/interactable-editor/simulator.mjs';
import { readSourcePackage } from '../../features/interactable-editor/source-package.mjs';

const root = process.cwd(),
  out = path.join(root, 'outputs', `interactable-tests-${Date.now()}`);
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile('workbench/manifest.json', 'utf8'));
const described = structuredClone(
  manifest.capabilities.find((c) => c.id === 'interactable-editor').inputSchema
    .properties.project,
);
delete described.description;
const expected = zodToJsonSchema(projectSchema, { $refStrategy: 'none' });
delete expected.$schema;
assert.deepEqual(
  described,
  expected,
  'Run npm run schema:interactable after changing the project contract.',
);
const p = createProject();
p.objects = ['inspect', 'toggle', 'pickup', 'sequence'].map(createObject);
p.objects[2].solid.enabled = true;
p.objects.forEach((o, i) => {
  o.definitionId = `test-${o.behavior.kind}`;
  o.displayName = `中文 "物件" ${i}\n第二行`;
  o.activation.mode = 'external_request';
});
p.objects[3].behavior.entries.push(
  structuredClone(p.objects[3].behavior.entries[0]),
);
const png = await (
  await import('sharp')
)
  .default({
    create: {
      width: 16,
      height: 8,
      channels: 4,
      background: { r: 80, g: 220, b: 150, alpha: 1 },
    },
  })
  .png()
  .toBuffer();
const wav = Buffer.alloc(44 + 1600);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(1600, 40);
p.assets = [
  {
    id: 'image',
    name: 'test.png',
    mime: 'image/png',
    source: 'data:image/png;base64,' + png.toString('base64'),
  },
  {
    id: 'sound',
    name: 'test.wav',
    mime: 'audio/wav',
    source: 'data:audio/wav;base64,' + wav.toString('base64'),
  },
];
for (const o of p.objects) {
  o.visual.assetId = 'image';
  o.visual.clips = [
    {
      name: 'burst',
      fps: 20,
      loop: false,
      frames: [0, 1].map((i) => ({
        assetId: 'image',
        region: { x: i * 8, y: 0, width: 8, height: 8 },
        duration: 1,
      })),
    },
  ];
}
// Keep an explicit audio reference in a non-executed sequence entry for dependency coverage.
p.objects[0].behavior.entries[0].feedback = [
  { type: 'play_audio', assetId: 'sound', waitForEnd: true, volumeDb: 0 },
];
const result = await buildGodotPackage(
  { project: p },
  { repositoryRoot: root, exportId: 'tests' },
);
const zip = await JSZip.loadAsync(result.bytes);
const original = structuredClone(p);
p.objects[0].copyworms.objectId = 'notice';
const compatible = await buildGodotPackage(
  { project: p, targetProfile: 'copyworms' },
  { repositoryRoot: root },
);
const compatibleZip = await JSZip.loadAsync(compatible.bytes);
assert.equal(compatible.metadata.targetProfile, 'copyworms');
assert(compatibleZip.file(compatible.metadata.runtime.replace('res://', '')));
assert(
  !Object.keys(compatibleZip.files).some((name) =>
    name.startsWith('addons/workbench_interaction/'),
  ),
);
assert(!compatibleZip.file('project.godot'));
const compatibleDefinition = await compatibleZip
  .file(
    'addons/workbench_interaction_copyworms/objects/test-inspect/definition.tres',
  )
  .async('string');
assert(compatibleDefinition.includes('"action": "ui_accept"'));
assert(compatibleDefinition.includes('"actorGroup": "player"'));
assert(compatibleDefinition.includes('"mask": 4'));
assert.deepEqual(
  (await readSourcePackage(compatible.bytes)).objects,
  normalizeProject(p).objects,
);
assert.equal(
  p.objects[0].activation.action,
  original.objects[0].activation.action,
);
assert.equal(p.objects[0].detection.mask, original.objects[0].detection.mask);
await assert.rejects(
  buildGodotPackage(
    { project: p, targetProfile: 'invalid' },
    { repositoryRoot: root },
  ),
  /targetProfile/,
);
assert(!zip.file('project.godot'));
assert(Object.keys(zip.files).every((n) => !n.endsWith('.uid')));
for (const o of p.objects)
  assert(
    (
      await zip
        .file(
          `addons/workbench_interaction/objects/${o.definitionId}/definition.tres`,
        )
        .async('string')
    ).includes('中文'),
  );
for (const [name, file] of Object.entries(zip.files)) {
  if (file.dir) continue;
  const dest = path.join(out, name);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, await file.async('nodebuffer'));
}
const sim = new InteractionSimulation([p.objects[2], p.objects[2]]);
assert(sim.request(sim.objects[0]));
assert.equal(sim.objects[0].state.completed, true);
assert.equal(sim.objects[1].state.completed, false);
assert(!sim.request(sim.objects[0]));
const sequence = new InteractionSimulation([p.objects[3]]);
sequence.request();
assert.equal(sequence.objects[0].state.sequenceIndex, 1);
sequence.request();
assert(sequence.objects[0].state.completed);
assert.throws(
  () => normalizeProject({ ...p, objects: [p.objects[0], p.objects[0]] }),
  /ID/,
);
await writeFile(
  path.join(out, 'project.godot'),
  '[application]\nconfig/name="Workbench interaction tests"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
);
await writeFile(
  path.join(out, 'run.gd'),
  await readFile('tests/interactable-editor/regression.gd'),
);
const godot =
  process.env.GODOT_47_BIN || process.argv[process.argv.indexOf('--godot') + 1];
if (!godot || godot === process.argv[0]) {
  console.log(
    JSON.stringify({
      javascript: 'passed',
      godot: 'not requested',
      output: out,
    }),
  );
} else {
  let engineChecks = 0;
  const environmentWarnings = new Set();
  for (const args of [
    ['--headless', '--path', out, '--editor', '--import'],
    ['--headless', '--path', out, '--script', 'run.gd'],
  ]) {
    const r = spawnSync(godot, args, {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, APPDATA: out },
    });
    const log = (r.stdout ?? '') + (r.stderr ?? '');
    engineChecks = Number(
      /INTERACTION_TESTS (\d+) checks, 0 failures/.exec(log)?.[1] ??
        engineChecks,
    );
    if (log.includes('Failed to read the root certificate store.'))
      environmentWarnings.add(
        'Windows root certificate store unavailable; offline tests do not use TLS.',
      );
    await writeFile(
      path.join(out, args.includes('--import') ? 'import.log' : 'runtime.log'),
      log,
    );
    if (
      r.error ||
      r.status !== 0 ||
      /SCRIPT ERROR|Parse Error|ERROR:/.test(
        log.replace(
          /ERROR: Failed to read the root certificate store\.[^\n]*\n[^\n]*get_system_ca_certificates[^\n]*\n?/g,
          '',
        ),
      )
    ) {
      console.error(log);
      throw r.error ?? new Error(`Godot test failed (${r.status})`);
    }
  }
  console.log(
    JSON.stringify({
      javascript: 'passed',
      godot: 'passed',
      engineChecks,
      environmentWarnings: [...environmentWarnings],
      output: out,
    }),
  );
}
