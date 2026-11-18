import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadManifest, repositoryRoot, archiveTaskHistory, listTasks, readTask, refreshTask, persistTask } from '../../lib/workbench/runtime.mjs';

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
console.log('PASS history archive preserves artifacts/evidence, hides old tasks and blocks active tasks');
