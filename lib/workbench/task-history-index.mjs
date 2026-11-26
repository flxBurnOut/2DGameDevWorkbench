import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomicSnapshot } from './atomic-snapshot.mjs';

const records = /^[a-z0-9][a-z0-9_-]*\.json$/i;
const cache = new Map();
const indexChecks = new Map();
const indexCheckMaxAgeMs = 60_000;
const indexDirectory = directory => path.join(directory, '.summaries-v1');
const stamp = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
const digest = entry => createHash('sha256').update(JSON.stringify(entry)).digest('hex');

// Limit concurrent reads to keep rebuilds of older task directories bounded.
export async function mapTaskRecords(items, visit) {
  let next = 0;
  const values = Array.from({ length: items.length });
  await Promise.all(Array.from({ length: Math.min(items.length, 8) }, async () => {
    while (next < items.length) {
      const index = next++;
      values[index] = await visit(items[index]);
    }
  }));
  return values;
}

function entries(directory) {
  if (!cache.has(directory)) cache.set(directory, new Map());
  return cache.get(directory);
}

async function statIfPresent(file, getInfo = stat) {
  try { return await getInfo(file, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const sameObject = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;

async function summaryDirectoryInfo(index) {
  const info = await statIfPresent(index, lstat);
  return info?.isDirectory() && info.ino ? info : null;
}

async function pruneIndexes(directory, names) {
  const checkedAt = performance.now();
  const previous = indexChecks.get(directory);
  // Retry periodically for summaries published after a task was deleted.
  if (previous?.names?.size === names.length && checkedAt - previous.checkedAt < indexCheckMaxAgeMs &&
      names.every(name => previous.names.has(name))) return;

  // Publish only a clean scan. A newer scan can supersede it while it runs.
  const check = { checkedAt, names: null };
  indexChecks.set(directory, check);
  const existing = new Set(names);
  const remembered = entries(directory);
  for (const name of remembered.keys()) if (!existing.has(name)) remembered.delete(name);
  const index = indexDirectory(directory);
  let directoryInfo, indexed;
  try {
    directoryInfo = await summaryDirectoryInfo(index);
    indexed = directoryInfo ? await readdir(index) : [];
  } catch { return; }
  const orphaned = indexed.filter(name => records.test(name) && !existing.has(name));
  if (!orphaned.length) {
    check.names = existing;
    // Only this scan knows whether there were any disk summaries to reuse.
    return indexed;
  }
  indexChecks.delete(directory);
  await mapTaskRecords(orphaned, async name => {
    try {
      // A writer may have created the task since the directory listing.
      if (await statIfPresent(path.join(directory, name), lstat)) return;
      if (!sameObject(directoryInfo, await summaryDirectoryInfo(index))) return;
      await unlink(path.join(index, name));
    } catch {
      // Cleanup of derived files must not affect task history coverage.
    }
  });
}

async function saveIndex(directory, name, entry) {
  entries(directory).set(name, entry);
  const index = indexDirectory(directory);
  try {
    let initial = await summaryDirectoryInfo(index);
    if (!initial) {
      await mkdir(index, { recursive: true });
      initial = await summaryDirectoryInfo(index);
      if (!initial) return;
    }
    await writeAtomicSnapshot(path.join(index, name), `${JSON.stringify({ entry, sha256: digest(entry) })}\n`, {
      beforeReplace: async () => {
        if (!sameObject(initial, await summaryDirectoryInfo(index))) throw new Error('Summary directory changed');
      },
    });
  } catch {
    // Tasks are authoritative. The next reader can rebuild a missing summary.
  }
}

async function readSavedIndex(index, name) {
  try {
    const initial = await summaryDirectoryInfo(index);
    if (!initial) return null;
    const file = path.join(index, name);
    const original = await lstat(file, { bigint: true });
    if (!original.isFile()) return null;
    const source = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      if (!sameObject(original, await source.stat({ bigint: true })) || !sameObject(initial, await summaryDirectoryInfo(index))) return null;
      return JSON.parse(await source.readFile('utf8'));
    } finally { await source.close(); }
  } catch { return null; }
}

function makeEntry(version, task, project, active) {
  return { version, task: project(task), active: Boolean(active(task)) };
}

export async function writeTaskSummary(file, info, task, { project, active }) {
  if (info) await saveIndex(path.dirname(file), path.basename(file), makeEntry(stamp(info), task, project, active));
}

export async function readTaskAtVersion(file, version) {
  const source = await open(file, 'r').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!source) return null;
  try {
    if (stamp(await source.stat({ bigint: true })) !== version) return null;
    const task = JSON.parse(await source.readFile('utf8'));
    return stamp(await source.stat({ bigint: true })) === version ? task : null;
  } finally { await source.close(); }
}

async function readIndex(directory, name, project, active, indexWasEmpty) {
  const file = path.join(directory, name);
  // The list reader already handles ENOENT if a file disappears after readdir.
  const info = await stat(file, { bigint: true });
  if (!info.isFile()) return null;
  const observedVersion = stamp(info);
  const id = name.slice(0, -5);
  const remembered = entries(directory).get(name);
  if (remembered?.version === observedVersion) return remembered;
  const indexed = indexWasEmpty ? null : await readSavedIndex(indexDirectory(directory), name);
  const saved = indexed?.entry && indexed.sha256 === digest(indexed.entry) ? indexed.entry : null;
  if (saved?.version === observedVersion && saved.task?.id === id && typeof saved.task.status === 'string' && typeof saved.active === 'boolean') {
    entries(directory).set(name, saved);
    return saved;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const source = await open(file, 'r');
    let before, after, bytes;
    try {
      before = await source.stat({ bigint: true });
      if (!before.isFile()) return null;
      bytes = await source.readFile('utf8');
      after = await source.stat({ bigint: true });
    } finally { await source.close(); }

    const version = stamp(before);
    const stable = stamp(after) === version;
    // Rename can drop a link and change ctime while the open inode still
    // contains a complete snapshot. Retry changes that could affect its bytes.
    const unlinked = after.nlink < before.nlink && after.size === before.size && after.mtimeNs === before.mtimeNs;
    if (!stable && !unlinked) continue;

    let task;
    try { task = JSON.parse(bytes); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (task?.id !== id || typeof task.status !== 'string') {
      // Report corruption only for a record still present at this version.
      const current = await statIfPresent(file);
      if (!current?.isFile()) return null;
      if (stamp(current) !== version) continue;
      const invalid = { version, issue: id };
      entries(directory).set(name, invalid);
      return invalid;
    }
    const entry = makeEntry(version, task, project, active);
    if (stable && after.nlink > 0n) await saveIndex(directory, name, entry);
    return entry;
  }
  return { issue: id };
}

export async function readTaskSummaries(directory, { exclude = new Set(), project, active }) {
  const names = (await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter(name => records.test(name));
  const indexWasEmpty = (await pruneIndexes(directory, names))?.length === 0;
  const values = await mapTaskRecords(names.filter(name => !exclude.has(name.slice(0, -5))), async name => {
    try { return await readIndex(directory, name, project, active, indexWasEmpty); }
    catch (error) {
      return error.code === 'ENOENT' ? null : { issue: name.slice(0, -5) };
    }
  });
  const rows = values.filter(value => value?.task);
  return {
    rows,
    active: rows.filter(entry => entry.active),
    unavailable: values.flatMap(value => value?.issue ? [value.issue] : []).sort((a, b) => a.localeCompare(b)),
  };
}
