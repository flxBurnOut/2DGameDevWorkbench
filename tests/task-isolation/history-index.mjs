import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';
import { archiveTaskHistory, listTaskPage, loadManifest, persistTask, repositoryRoot } from '../../lib/workbench/runtime.mjs';

const manifest = await loadManifest();
assert(manifest.workspace.taskDirectory.startsWith('work/test-runs/'));
const isolated = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
await mkdir(isolated, { recursive: true });
const directory = await mkdtemp(path.join(isolated, 'history-index-'));
manifest.workspace.taskDirectory = directory;
const taskFile = id => path.join(directory, `${id}.json`);
const index = path.join(directory, '.summaries-v1');
const summaryFile = id => path.join(index, `${id}.json`);
const record = (id, label = id) => ({ id, status: 'completed', input: { label } });
const list = () => listTaskPage(manifest, { detail: false });
const checkArchive = () => archiveTaskHistory(manifest, { checkOnly: true });
const fs = createRequire(import.meta.url)('node:fs/promises');

async function listWhileDirectoryChanges(listed, change) {
  const readdir = fs.readdir;
  let changed = false;
  fs.readdir = async (file, ...args) => {
    const names = await readdir(file, ...args);
    if (file === listed && !changed) {
      changed = true;
      await change();
    }
    return names;
  };
  syncBuiltinESMExports();
  try {
    await list();
    assert(changed, 'The fixture must change the directory after enumeration.');
  }
  finally {
    fs.readdir = readdir;
    syncBuiltinESMExports();
  }
}

async function duringRead(id, change, operation) {
  const open = fs.open;
  let changed = false;
  fs.open = async (file, ...args) => {
    const source = await open(file, ...args);
    if (file === taskFile(id) && !changed) {
      const read = source.readFile.bind(source);
      source.readFile = async (...options) => {
        const bytes = await read(...options);
        changed = true;
        await change(source);
        return bytes;
      };
    }
    return source;
  };
  syncBuiltinESMExports();
  try {
    const result = await operation();
    assert(changed, 'The fixture must change the task between descriptor stats.');
    return result;
  } finally {
    fs.open = open;
    syncBuiltinESMExports();
  }
}

async function replaceDuringRead(id, before, after, operation) {
  const file = taskFile(id);
  const replacement = `${file}.next`;
  await writeFile(file, before);
  await writeFile(replacement, JSON.stringify(after));
  return duringRead(id, async source => {
    if (process.platform !== 'win32') {
      await rename(replacement, file);
      return;
    }
    // Windows may hold the directory entry until the reader closes. Simulate
    // the unlinked descriptor metadata and publish when the handle closes.
    const stat = source.stat.bind(source);
    const close = source.close.bind(source);
    source.stat = async options => {
      const info = await stat(options);
      info.nlink = 0n;
      info.ctimeNs += 1n;
      return info;
    };
    source.close = async () => {
      await close();
      await rename(replacement, file);
    };
  }, operation);
}

try {
  const coldFile = taskFile('cold');
  await mkdir(index);
  await writeFile(coldFile, JSON.stringify(record('cold')));
  const lookups = mock.method(fs, 'lstat');
  const creates = mock.method(fs, 'mkdir');
  const reads = mock.method(fs, 'open');
  syncBuiltinESMExports();
  try {
    assert.equal((await list()).tasks[0].input.label, 'cold');
    assert(!lookups.mock.calls.some(call => call.arguments[0] === summaryFile('cold')));
    assert(!creates.mock.calls.some(call => call.arguments[0] === index));
    // A different writer can populate the previously empty index before the
    // next poll while leaving the set of task filenames unchanged.
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { loadManifest, persistTask } from './lib/workbench/runtime.mjs';
      const manifest = await loadManifest();
      manifest.workspace.taskDirectory = process.argv[1];
      await persistTask(manifest, { id: 'cold', status: 'completed', input: { label: 'external' } });
    `, directory], { cwd: repositoryRoot, windowsHide: true });
    reads.mock.resetCalls();
    assert.equal((await list()).tasks[0].input.label, 'external');
    assert(reads.mock.calls.some(call => call.arguments[0] === summaryFile('cold')));
    assert(!reads.mock.calls.some(call => call.arguments[0] === coldFile));
  } finally {
    lookups.mock.restore();
    creates.mock.restore();
    reads.mock.restore();
    syncBuiltinESMExports();
  }
  await unlink(coldFile);
  await unlink(summaryFile('cold'));

  const archived = ['archived', 'archived-removed'];
  for (const id of ['deleted', 'retained', ...archived]) await persistTask(manifest, record(id));
  await writeFile(path.join(directory, '.archived.json'), JSON.stringify(archived));
  const pending = `${summaryFile('deleted')}.writer.tmp`;
  await writeFile(pending, 'writer');
  await unlink(taskFile('deleted'));

  // Prune an orphan from a previous process without invalidating live or archived summaries.
  const fresh = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile, unlink } from 'node:fs/promises';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import { loadManifest, listTaskPage, persistTask } from './lib/workbench/runtime.mjs';
    import path from 'node:path';
    const manifest = await loadManifest();
    const directory = manifest.workspace.taskDirectory = process.argv[1];
    const index = path.join(directory, '.summaries-v1');
    const retained = path.join(index, 'retained.json');
    const before = await readFile(retained, 'utf8');
    const fs = createRequire(import.meta.url)('node:fs/promises');
    const open = fs.open;
    const lstat = fs.lstat;
    const readdir = fs.readdir;
    const list = options => listTaskPage(manifest, { detail: false, ...options });
    const bodyReads = [];
    let indexLists = 0;
    let indexStats = 0;
    let reverseNames = false;
    fs.open = (file, ...args) => {
      if (path.dirname(file) === directory) bodyReads.push(path.basename(file));
      return open(file, ...args);
    };
    fs.lstat = (file, ...args) => {
      if (file === index) indexStats++;
      return lstat(file, ...args);
    };
    fs.readdir = async (file, ...args) => {
      if (file === index) indexLists++;
      const names = await readdir(file, ...args);
      return file === directory && reverseNames ? names.toReversed() : names;
    };
    syncBuiltinESMExports();
    const page = await list();
    await assert.rejects(readFile(path.join(index, 'deleted.json'), 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(retained, 'utf8'), before);
    await list(); // Cache a clean scan after the first cleanup.
    const settledReads = { indexLists, indexStats };
    const conditional = await list({ since: page.revision });
    await list();
    assert.deepEqual({ indexLists, indexStats }, settledReads);
    await persistTask(manifest, { id: 'retained', status: 'completed', input: { label: 'checkpoint' } });
    const afterWrite = indexStats;
    reverseNames = true; // Filesystem enumeration order may change after a checkpoint.
    assert.equal((await list()).tasks[0]?.input.label, 'checkpoint');
    assert.equal(indexLists, settledReads.indexLists);
    assert.equal(indexStats, afterWrite);
    // This archived source has never populated this process's summary cache.
    await unlink(path.join(directory, 'archived-removed.json'));
    await list();
    assert.equal(indexLists - settledReads.indexLists, 1);
    console.log(JSON.stringify({ taskIds: page.tasks.map(task => task.id), bodyReads, unchanged: conditional.unchanged }));
  `, directory], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(fresh, { taskIds: ['retained'], bodyReads: [], unchanged: true });
  await assert.rejects(readFile(summaryFile('archived-removed'), 'utf8'), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(summaryFile('archived'), 'utf8')).entry.task.id, 'archived');
  assert.equal(await readFile(pending, 'utf8'), 'writer');

  const late = summaryFile('late');
  const staged = `${late}.writer.tmp`;
  await writeFile(staged, 'late writer');
  let now = Math.ceil(performance.now()) + 60_000;
  let attempts = 0;
  const remove = fs.unlink;
  const clock = mock.method(performance, 'now', () => now);
  const delayed = mock.method(fs, 'unlink', async (file, ...args) => {
    if (file === late && attempts++ === 0) throw Object.assign(new Error('Fixture summary is busy.'), { code: 'EBUSY' });
    return remove(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await list();
    assert.equal(await readFile(staged, 'utf8'), 'late writer');
    // Another process may finish writing a summary after its source is gone.
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { rename } from 'node:fs/promises';
      await rename(process.argv[1], process.argv[2]);
    `, staged, late], { cwd: repositoryRoot, windowsHide: true });
    now += 59_999;
    await list();
    assert.equal(attempts, 0);
    assert.equal(await readFile(late, 'utf8'), 'late writer');
    now++;
    assert.deepEqual((await list()).coverage, { complete: true, unavailableTaskIds: [] });
    assert.equal(attempts, 1);
    await list();
    assert.equal(attempts, 2);
    await assert.rejects(readFile(late, 'utf8'), { code: 'ENOENT' });
  } finally {
    clock.mock.restore();
    delayed.mock.restore();
    syncBuiltinESMExports();
  }

  await persistTask(manifest, record('revived', 'old version'));
  await list();
  await unlink(taskFile('revived'));
  await listWhileDirectoryChanges(directory, () => persistTask(manifest, record('revived', 'published after listing')));
  assert.equal(JSON.parse(await readFile(summaryFile('revived'), 'utf8')).entry.task.input.label, 'published after listing');

  const first = record('atomic', 'original');
  const second = record('atomic', 'replacement');
  const racingPage = await replaceDuringRead(first.id, JSON.stringify(first), second, list);
  assert.deepEqual(racingPage.coverage, { complete: true, unavailableTaskIds: [] });
  assert(['original', 'replacement'].includes(racingPage.tasks.find(task => task.id === first.id)?.input.label));
  assert.equal((await list()).tasks.find(task => task.id === first.id)?.input.label, 'replacement');
  const racingArchive = await replaceDuringRead(first.id, JSON.stringify(first), second, checkArchive);
  assert.equal(racingArchive.count, 3);

  const repaired = record('repaired');
  const repairedPage = await replaceDuringRead(repaired.id, '{ partial', repaired, list);
  assert.deepEqual(repairedPage.coverage, { complete: true, unavailableTaskIds: [] });
  assert(repairedPage.tasks.some(task => task.id === repaired.id));

  const legacy = record('legacy');
  await writeFile(taskFile(legacy.id), JSON.stringify(legacy));
  const changed = record(legacy.id, 'rewritten in place');
  const retried = await duringRead(legacy.id, () => writeFile(taskFile(legacy.id), JSON.stringify(changed)), list);
  assert.equal(retried.tasks.find(task => task.id === legacy.id)?.input.label, changed.input.label);

  await writeFile(taskFile('corrupt'), '{ partial');
  await writeFile(taskFile('wrong-id'), JSON.stringify(record('mismatched-id')));
  assert.deepEqual((await list()).coverage, { complete: false, unavailableTaskIds: ['corrupt', 'wrong-id'] });
  await assert.rejects(checkArchive(), /部分任务记录无法读取/);

  const unrelated = path.join(directory, 'another-directory');
  await mkdir(unrelated);
  const unrelatedFile = path.join(unrelated, 'unrelated.json');
  await writeFile(unrelatedFile, '{}');
  await writeFile(summaryFile('unrelated'), '{}');
  await unlink(taskFile('wrong-id'));
  await listWhileDirectoryChanges(index, async () => {
    await rename(index, `${index}.saved`);
    await symlink(unrelated, index, process.platform === 'win32' ? 'junction' : 'dir');
  });
  assert.equal(await readFile(unrelatedFile, 'utf8'), '{}');
  await list();
  assert.equal(await readFile(unrelatedFile, 'utf8'), '{}');
  const protectedFile = path.join(unrelated, 'retained.json');
  await writeFile(protectedFile, 'same-name file owned by the other directory');
  await persistTask(manifest, record('retained', 'saved to task'));
  assert.equal(await readFile(protectedFile, 'utf8'), 'same-name file owned by the other directory');
  // Reopen in a process with an empty cache. No disk summary below the link
  // should be opened, even if it has the right filename.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import { loadManifest, listTaskPage } from './lib/workbench/runtime.mjs';
    const manifest = await loadManifest();
    manifest.workspace.taskDirectory = process.argv[1];
    const linked = path.join(process.argv[1], '.summaries-v1');
    const fs = createRequire(import.meta.url)('node:fs/promises');
    const opened = [];
    for (const method of ['open', 'readFile']) {
      const original = fs[method];
      fs[method] = (file, ...args) => {
        if (path.dirname(String(file)) === linked) opened.push(String(file));
        return original(file, ...args);
      };
    }
    syncBuiltinESMExports();
    const page = await listTaskPage(manifest, { detail: false });
    assert.equal(page.tasks.find(row => row.id === 'retained').input.label, 'saved to task');
    assert.deepEqual(opened, []);
  `, directory], { cwd: repositoryRoot, windowsHide: true });
  assert.equal(await readFile(protectedFile, 'utf8'), 'same-name file owned by the other directory');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('PASS task summaries prune deleted sources and preserve coverage during atomic replacement');
