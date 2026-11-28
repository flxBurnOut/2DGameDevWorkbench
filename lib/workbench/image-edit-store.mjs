import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { validateImageProcessingSize } from './adapters/image-assets-processing.mjs';
import { writeAtomicSnapshot } from './atomic-snapshot.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const error = (message, code = 'INVALID_IMAGE_EDIT', status = 400, details = {}) => Object.assign(new Error(message), { code, status, ...details });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => hash(JSON.stringify(canonical(value)));
const recordFile = (directory, kind, id) => path.join(directory, kind, `${hash(id)}.json`);
const inside = (base, target) => { const relative = path.relative(base, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
function storage(root, manifest) {
  const directory = path.resolve(root, manifest.workspace.imageEditDirectory || `${path.posix.dirname(manifest.workspace.taskDirectory.replaceAll('\\', '/'))}/image-edits`);
  if (!inside(path.resolve(root), directory)) throw error('Image edit storage must stay inside the workspace.');
  return directory;
}
async function safe(root, file) {
  const base = await realpath(root);
  let ancestor = file;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      if (resolved !== path.resolve(base, path.relative(path.resolve(root), ancestor))) throw error('Image edit storage cannot cross a symlink.', 'UNSAFE_IMAGE_EDIT_PATH');
      break;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error('Invalid image edit storage path.');
      ancestor = parent;
    }
  }
  return file;
}
async function json(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } }
async function atomic(root, file, value) {
  await safe(root, file); await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (cause) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(cause.code) || attempt >= 19) throw cause; await new Promise(resolve => setTimeout(resolve, 25)); }
    }
  } finally { await rm(temporary, { force: true }); }
}
// As with shared documents and maps, the canonical Bridge owns mutations.
// MCP/CLI and the browser forward every image operation (including refresh reads)
// to it. Durable command intents, not stale filesystem leases, survive restarts.
// Running multiple independent Bridges over the same storage is unsupported.
const locks = new Map();
async function lock(_root, directory, name, fn) {
  const key = `${directory}\0${name}`, previous = locks.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(fn);
  locks.set(key, pending);
  try { return await pending; }
  finally { if (locks.get(key) === pending) locks.delete(key); }
}
const sessionFile = (directory, id) => path.join(directory, 'sessions', `${hash(id)}.json`);
async function session(root, directory, id) {
  const file = await safe(root, sessionFile(directory, id));
  const value = await json(file);
  if (!value || value.editId !== id) throw error('Image edit session not found.', 'IMAGE_EDIT_NOT_FOUND', 404);
  return value;
}
const saveSession = (root, directory, value) => atomic(root, sessionFile(directory, value.editId), value);
async function blob(root, directory, bytes, extension) {
  const sha256 = hash(bytes), file = path.join(directory, 'blobs', `${sha256}.${extension}`);
  await safe(root, file); await mkdir(path.dirname(file), { recursive: true });
  await lock(root,directory,'blob:'+file,async()=>{
    try {
      if (hash(await readFile(file)) !== sha256) throw error('Image edit blob is corrupt.', 'CORRUPT_IMAGE_EDIT', 500);
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      await writeAtomicSnapshot(file,bytes);
    }
  });
  return { sha256, file: path.relative(root, file).replaceAll('\\', '/') };
}
async function readBlob(root, reference) {
  const file = path.resolve(root, reference.file);
  if (!inside(path.resolve(root), file)) throw error('Invalid image edit blob.');
  await safe(root, file); const bytes = await readFile(file);
  if (hash(bytes) !== reference.sha256) throw error('Image edit source has changed on disk.', 'CORRUPT_IMAGE_EDIT', 409);
  return bytes;
}
async function decode(bytes) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 8294400 }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  validateImageProcessingSize(info.width, info.height);
  return { pixels: data, width: info.width, height: info.height, rgbaSha256: hash(data) };
}
async function command(root, directory, operation, input, execute, resume) {
  const file = path.join(directory, 'commands', `${hash(input.commandId)}.json`), requestHash = fingerprint({ operation, input });
  return lock(root, directory, `command:${input.commandId}`, async () => {
    const previous = await json(await safe(root, file));
    const state = previous || { commandId: input.commandId, requestHash, operation, startedAt: new Date().toISOString() };
    const persist = async changes => { Object.assign(state, changes); await atomic(root, file, state); };
    const saveResult = result => persist({ result: operation === 'image-edit' ? { editId: result.edit.editId, candidateVersion: result.candidateVersion, taskId: result.taskId, status: result.status } : result });
    if (previous) {
      if (previous.requestHash !== requestHash) throw error('commandId was used with a different request.', 'COMMAND_ID_REUSED', 409);
      if (previous.result && !(operation === 'image-edit' && resume)) return { ...previous.result, replayed: true };
      if (resume) { const result = await resume(previous, persist); await saveResult(result); return { ...result, replayed: true }; }
      throw error('Previous submission was interrupted. Inspect its saved session; do not submit a new command.', 'IMAGE_SUBMISSION_UNKNOWN', 409, { editId: previous.editId, taskId: previous.taskId });
    }
    await persist({});
    const result = await execute(state, persist);
    // The ledger stores identities, not another copy of the growing history.
    await saveResult(result);
    return { ...result, replayed: false };
  });
}

export { hash, error, fingerprint, recordFile, storage, safe, json, atomic, lock, sessionFile, session, saveSession, blob, readBlob, decode, command };
