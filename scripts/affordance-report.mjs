// Read-only affordance report for a saved shared scene or a scene/Godot package.
// Usage:
//   node scripts/affordance-report.mjs --document <id> [--revision <n>]
//   node scripts/affordance-report.mjs --package <scene-source.zip|godot.zip>
// Options: --player '{"height":48,...}'  --start x,y  --goal x,y  --no-overlay
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadManifest, repositoryRoot } from '../lib/workbench/runtime.mjs';
import { getDocument } from '../lib/workbench/editor-documents.mjs';
import { readScenePackage } from '../features/scene-composer/package.mjs';
import { writeAffordanceReport } from '../lib/workbench/affordance-report.mjs';

const { values } = parseArgs({
  options: {
    document: { type: 'string' },
    revision: { type: 'string' },
    package: { type: 'string' },
    player: { type: 'string' },
    start: { type: 'string' },
    goal: { type: 'string' },
    'no-overlay': { type: 'boolean', default: false },
  },
});
const point = (value, name) => {
  if (!value) return undefined;
  const [x, y] = value.split(',').map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--${name} 需要 x,y 世界坐标。`);
  return { x, y };
};
if (Boolean(values.document) === Boolean(values.package)) throw new Error('请只提供 --document 或 --package 其中一个。');

const manifest = await loadManifest();
let scene;
let source;
if (values.document) {
  const revision = values.revision ? Number(values.revision) : undefined;
  const { document } = await getDocument(repositoryRoot, manifest, { documentId: values.document, ...(revision ? { revision } : {}) });
  if (document.kind !== 'scene') throw new Error('只支持场景文档。');
  scene = document.content;
  source = { documentId: document.id, revision: document.revision, contentHash: document.contentHash };
} else {
  const file = path.resolve(values.package);
  const bytes = await readFile(file);
  scene = await readScenePackage(bytes);
  source = { packagePath: path.relative(repositoryRoot, file), packageSha256: createHash('sha256').update(bytes).digest('hex') };
}
const result = await writeAffordanceReport(repositoryRoot, manifest, scene, source, {
  player: values.player ? JSON.parse(values.player) : undefined,
  start: point(values.start, 'start'),
  goal: point(values.goal, 'goal'),
  overlay: !values['no-overlay'],
});
console.log(JSON.stringify(result, null, 2));
