import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomicSnapshot } from './atomic-snapshot.mjs';

const records = /^[a-z0-9][a-z0-9_-]*\.json$/i;
const cache = new Map();
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

async function saveIndex(directory, name, entry) {
  entries(directory).set(name, entry);
  try {
    await mkdir(indexDirectory(directory), { recursive: true });
    await writeAtomicSnapshot(path.join(indexDirectory(directory), name), `${JSON.stringify({ entry, sha256: digest(entry) })}\n`);
  } catch {
    // Tasks are authoritative. The next reader can rebuild a missing summary.
  }
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

async function readIndex(directory, name, project, active) {
  const file = path.join(directory, name);
  const info = await stat(file, { bigint: true, throwIfNoEntry: false });
  if (!info?.isFile()) return null;
  const version = stamp(info);
  const id = name.slice(0, -5);
  const remembered = entries(directory).get(name);
  if (remembered?.version === version) return remembered;
  const indexed = await readFile(path.join(indexDirectory(directory), name), 'utf8').then(JSON.parse).catch(() => null);
  const saved = indexed?.entry && indexed.sha256 === digest(indexed.entry) ? indexed.entry : null;
  if (saved?.version === version && saved.task?.id === id && typeof saved.task.status === 'string' && typeof saved.active === 'boolean') {
    entries(directory).set(name, saved);
    return saved;
  }
  const source = await open(file, 'r');
  try {
    const before = stamp(await source.stat({ bigint: true }));
    let task;
    try { task = JSON.parse(await source.readFile('utf8')); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const after = stamp(await source.stat({ bigint: true }));
    if (before !== after) throw new Error('任务记录正在更新。');
    if (task?.id !== id || typeof task.status !== 'string') {
      const invalid = { version: after, issue: id };
      entries(directory).set(name, invalid);
      return invalid;
    }
    const entry = makeEntry(after, task, project, active);
    await saveIndex(directory, name, entry);
    return entry;
  } finally {
    await source.close();
  }
}

export async function readTaskSummaries(directory, { exclude = new Set(), project, active }) {
  const names = (await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter(name => records.test(name));
  const existing = new Set(names);
  for (const name of entries(directory).keys()) if (!existing.has(name)) entries(directory).delete(name);
  const values = await mapTaskRecords(names.filter(name => !exclude.has(name.slice(0, -5))), async name => {
    try { return await readIndex(directory, name, project, active); }
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
