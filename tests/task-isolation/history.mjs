import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { loadManifest, repositoryRoot, archiveTaskHistory, listTaskPage, listTasks, readTask, refreshTask, persistTask } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest();
assert(manifest.workspace.taskDirectory.startsWith('work/test-runs/'), 'History tests must never archive production tasks');
assert(manifest.workspace.outputDirectory.startsWith('outputs/test-runs/'));
const directory = path.join(repositoryRoot, manifest.workspace.taskDirectory);
await mkdir(directory, { recursive: true });
const save = (id, status) => writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, status, updatedAt: new Date().toISOString() }));
await save('old', 'completed');
await archiveTaskHistory(manifest, { checkOnly: true });
assert.equal((await listTasks(manifest)).length, 1);
assert.equal((await archiveTaskHistory(manifest)).count, 1);
assert.equal((await archiveTaskHistory(manifest)).count, 0);
assert.deepEqual(await listTasks(manifest), []);
assert.equal((await readTask(manifest, 'old')).id, 'old');
await save('new', 'running');
await assert.rejects(archiveTaskHistory(manifest), /仍在制作/);
assert.deepEqual((await listTasks(manifest)).map((task) => task.id), ['new']);
await persistTask(manifest, {
  id: 'new', capabilityId: 'image-assets', status: 'running', updatedAt: new Date().toISOString(), input: {}, outputs: [],
  adapter: { backgroundExecution: true, backgroundPid: process.pid, backgroundExpiresAt: 0, backgroundToken: 'stale-fixture' },
});
assert.equal((await refreshTask(manifest, 'new')).task.status, 'attention_required');
assert.equal((await archiveTaskHistory(manifest)).count, 1);
assert.deepEqual(await listTasks(manifest), []);
assert.equal((await refreshTask(manifest, 'new')).task.status, 'attention_required', 'Archived evidence is still inspectable');

const large = `data:image/png;base64,${'a'.repeat(2 * 1024 * 1024)}`;
const legacy = { id: 'legacy-large', capabilityId: 'image-assets', status: 'completed', updatedAt: '2020-01-01', input: { image: large, name: 'first title' }, outputs: [] };
const modern = { ...legacy, id: 'modern-large', updatedAt: '2020-01-02', input: { ...legacy.input, name: 'later title' } };
const original = path.join(directory, `${legacy.id}.json`);
await writeFile(original, JSON.stringify(legacy));
await persistTask(manifest, modern);
const fs = createRequire(import.meta.url)('node:fs/promises');
const open = fs.open, readFile = fs.readFile;
const reads = [];
const recordRead = file => { if (path.dirname(String(file)) === directory && !path.basename(file).startsWith('.')) reads.push(path.basename(file)); };
let beforeDetailRead;
fs.open = async (...args) => {
  recordRead(args[0]);
  if (beforeDetailRead && args[0] === original) {
    const update = beforeDetailRead;
    beforeDetailRead = undefined;
    await update();
  }
  return open(...args);
};
fs.readFile = (...args) => { recordRead(args[0]); return readFile(...args); };
syncBuiltinESMExports();
try {
  const page = await listTaskPage(manifest, { limit: 1, detail: false });
  assert.deepEqual(page.tasks.map(row => row.input), [{ name: 'later title' }]);
  assert.deepEqual(reads, [`${legacy.id}.json`], 'Only the missing legacy summary reads its task body.');
  reads.length = 0;
  const same = await listTaskPage(manifest, { limit: 1, since: page.revision, detail: false });
  assert.equal(same.unchanged, true);
  assert.deepEqual(reads, [], 'An unchanged task page reads no task JSON bodies.');
  const detail = await listTaskPage(manifest, { limit: 1, offset: 1, snapshot: page.snapshot });
  assert.equal(detail.tasks[0].input.image, large);
  assert.deepEqual(reads, [`${legacy.id}.json`], 'Only selected detailed rows read their bodies.');
  await writeFile(original, JSON.stringify({ ...legacy, input: { ...legacy.input, name: 'updated title' } }));
  await assert.rejects(listTaskPage(manifest, { limit: 1, offset: 1, snapshot: page.snapshot, detail: false }), { code: 'STALE_TASK_SNAPSHOT' });
  const updated = await listTaskPage(manifest, { detail: false, query: 'updated title' });
  assert.equal(updated.tasks[0].id, legacy.id);

  const replaceBeforeRead = record => async () => {
    await writeFile(original + '.next', JSON.stringify(record));
    await rename(original + '.next', original);
  };
  const selection = { detail: true, query: legacy.id };
  const beforeCheckpoint = await listTaskPage(manifest, selection);
  const checkpoint = { ...legacy, adapter: { progress: 2 } };
  beforeDetailRead = replaceBeforeRead(checkpoint);
  const duringCheckpoint = await listTaskPage(manifest, selection);
  assert.equal(duringCheckpoint.tasks[0].detailChanged, true);
  assert.deepEqual(duringCheckpoint.tasks[0].adapter, checkpoint.adapter);
  const afterCheckpoint = await listTaskPage(manifest, { ...selection, since: beforeCheckpoint.revision, snapshot: beforeCheckpoint.snapshot });
  assert.equal(afterCheckpoint.snapshot, beforeCheckpoint.snapshot);
  assert.notEqual(afterCheckpoint.revision, beforeCheckpoint.revision);
  assert.equal(afterCheckpoint.tasks[0].detailChanged, undefined);
  beforeDetailRead = replaceBeforeRead({ ...checkpoint, status: 'failed' });
  await assert.rejects(listTaskPage(manifest, { ...selection, status: 'completed' }), { code: 'STALE_TASK_SNAPSHOT' });
  await writeFile(path.join(directory, 'invalid.json'), '{ partial');
  assert.deepEqual((await listTaskPage(manifest, { detail: false })).coverage, { complete: false, unavailableTaskIds: ['invalid'] });
  await assert.rejects(archiveTaskHistory(manifest), /部分任务记录无法读取/);
  await unlink(original);
  await unlink(path.join(directory, 'invalid.json'));
  const removed = await listTaskPage(manifest, { detail: false });
  assert.deepEqual(removed.tasks.map(row => row.id), [modern.id]);
  assert.equal(removed.coverage.complete, true);

  // Simulate a slower process delivering its outdated projection after a new
  // authoritative write. A different runtime has no in-memory cache to help it.
  const summary = path.join(directory, '.summaries-v1', `${modern.id}.json`);
  const oldSummary = await readFile(summary, 'utf8');
  await persistTask(manifest, { ...modern, input: { ...modern.input, name: 'newest title' } });
  await writeFile(summary, oldSummary);
  const fresh = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {loadManifest,listTaskPage} from './lib/workbench/runtime.mjs';
    console.log(JSON.stringify(await listTaskPage(await loadManifest(), { detail: false })));
  `], { cwd: repositoryRoot, env: process.env, encoding: 'utf8', windowsHide: true }));
  assert.equal(fresh.tasks[0].input.name, 'newest title');
  assert.notEqual(await readFile(summary, 'utf8'), oldSummary);

  await persistTask(manifest, { id: 'unsupported-active', capabilityId: 'removed-capability', status: 'running', outputs: [] });
  for (const detail of [false, true]) {
    const page = await listTaskPage(manifest, { detail, refresh: true });
    assert.equal(page.tasks.find(task => task.id === modern.id).input.name, 'newest title');
    assert.match(page.tasks.find(task => task.id === 'unsupported-active').refreshError, /Unknown capability/);
  }
} finally {
  fs.open = open;
  fs.readFile = readFile;
  syncBuiltinESMExports();
}
console.log('PASS history archive preserves artifacts/evidence, hides old tasks and blocks active tasks');
