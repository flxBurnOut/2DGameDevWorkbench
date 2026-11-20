import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomicSnapshot } from './atomic-snapshot.mjs';

const markerPath = directory => path.join(directory, '.task-publication.json');
const immutable = ['id', 'schemaVersion', 'capabilityId', 'input', 'createdAt', 'command', 'imageEditContext'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fields = (task, keep) => Object.fromEntries(Object.entries(task).filter(([key]) => immutable.includes(key) === keep));

function parent(task, requestSha256) {
  return hash(JSON.stringify([task.id, task.capabilityId, requestSha256, fields(task, false)]));
}

async function artifact(root, realDirectory, filename) {
  const file = await realpath(path.resolve(root, filename));
  const relative = path.relative(realDirectory, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(file)).isFile())
    throw new Error(`任务产物不在原任务目录内：${filename}`);
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return [filename, digest.digest('hex')];
}

export async function saveTaskPublication(root, directory, task, next, requestSha256) {
  const files = [];
  const canonicalDirectory = await realpath(directory);
  for (const filename of next.outputs) files.push(await artifact(root, canonicalDirectory, filename));
  const evidence = { version: 1, parent: parent(task, requestSha256), published: fields(next, false), files };
  await writeAtomicSnapshot(markerPath(directory), `${JSON.stringify({ evidence, sha256: hash(JSON.stringify(evidence)) })}\n`);
}

export async function recoverTaskPublication(root, directory, task, requestSha256) {
  const bytes = await readFile(markerPath(directory), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!bytes) return null;
  const { evidence, sha256 } = JSON.parse(bytes);
  if (evidence?.version !== 1 || hash(JSON.stringify(evidence)) !== sha256)
    throw new Error('任务发布记录损坏。');
  if (evidence.parent !== parent(task, requestSha256())) return null;
  if (!evidence.published || !Array.isArray(evidence.published.outputs) || !Array.isArray(evidence.files) ||
      Object.keys(evidence.published).some(key => immutable.includes(key)) ||
      JSON.stringify(evidence.published.outputs) !== JSON.stringify(evidence.files.map(([filename]) => filename)))
    throw new Error('任务发布记录与原任务不符。');
  const canonicalDirectory = await realpath(directory);
  for (const [filename, expected] of evidence.files) {
    const [, actual] = await artifact(root, canonicalDirectory, filename);
    if (expected !== actual) throw new Error(`任务产物已变化：${filename}`);
  }
  return { ...fields(task, true), ...evidence.published };
}
