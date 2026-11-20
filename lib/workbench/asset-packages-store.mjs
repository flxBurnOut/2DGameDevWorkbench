import { lstat, mkdir, readFile, readdir, realpath, stat, rename, writeFile, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeAssetPackagePath } from './asset-packages-zip.mjs';
import { ASSET_PACKAGE_LIMITS, packageCommandId } from './asset-package-contract.mjs';

export const assetPackageHash = value => createHash('sha256').update(value).digest('hex');
const importedId = /^imported:[a-f0-9]{32}$/;
const publishedBatchName = /^[a-f0-9]{64}$/;
const batchKey = commandId => assetPackageHash(packageCommandId.parse(commandId));
const safeTestRun = () => {
  const value = process.env.WORKBENCH_TEST_RUN;
  if (value && !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value)) throw new Error('WORKBENCH_TEST_RUN 无效。');
  return value;
};
export function assetPackageDirectories(root, manifest = {}) {
  const testRun = safeTestRun();
  const persistent = testRun ? `work/test-runs/${testRun}/imported-assets` : manifest.workspace?.importedAssetDirectory || 'work/imported-assets';
  const staging = testRun ? `work/test-runs/${testRun}/asset-package-imports` : manifest.workspace?.packageImportDirectory || 'work/asset-package-imports';
  return { persistent: path.join(root, safeAssetPackagePath(persistent)), staging: path.join(root, safeAssetPackagePath(staging)) };
}
export async function readPackageJson(file, maxBytes = ASSET_PACKAGE_LIMITS.jsonBytes) {
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes) throw new Error('素材包记录过大或无效。');
  return JSON.parse(await readFile(file, 'utf8'));
}
export async function confinedPackageFile(base, relative) {
  safeAssetPackagePath(relative);
  const [resolvedBase, resolved] = await Promise.all([realpath(base), realpath(path.join(base, relative))]);
  const within = path.relative(resolvedBase, resolved);
  if (!within || within.startsWith('..') || path.isAbsolute(within) || !(await stat(resolved)).isFile()) throw new Error('导入文件越过素材目录。');
  return resolved;
}
export async function readAssetPackageCommit(root, manifest, commandId) {
  try { return await readPackageJson(path.join(assetPackageDirectories(root, manifest).persistent, 'batches', batchKey(commandId), 'commit.json'), 1024 * 1024); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function publishedBatches(base) {
  try {
    return (await readdir(base, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && publishedBatchName.test(entry.name))
      .map(entry => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function readBatchCommit(base, batch) {
  const commit = await readPackageJson(await confinedPackageFile(base, batch + '/commit.json'), 1024 * 1024);
  if (commit.status !== 'completed' || !Array.isArray(commit.records)) throw new Error('导入事务记录损坏。');
  return commit;
}
export async function listImportedAssets(root, manifest = {}) {
  const base = path.join(assetPackageDirectories(root, manifest).persistent, 'batches');
  const records = [];
  for (const batch of await publishedBatches(base)) {
    const commit = await readBatchCommit(base, batch);
    for (const id of commit.records) {
      if (!importedId.test(id)) throw new Error('导入资产身份损坏。');
      records.push(await readBatchAsset(base, batch, id));
    }
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}
async function readBatchAsset(base, batch, id) {
  const record = await readPackageJson(await confinedPackageFile(base, `${batch}/assets/${id.slice(9)}/record.json`));
  if (record.id !== id || record.storageBatchKey !== batch || !Array.isArray(record.files)) throw new Error('导入资产记录损坏。');
  return record;
}
export async function readImportedAsset(root, id, manifest = {}, batchHint) {
  if (!importedId.test(id)) throw new Error('导入资产身份无效。');
  if (batchHint && !publishedBatchName.test(batchHint)) throw new Error('导入批次无效。');
  const base = path.join(assetPackageDirectories(root, manifest).persistent, 'batches');
  const batches = batchHint ? [batchHint] : await publishedBatches(base);
  for (const batch of batches) {
    try {
      const commit = await readBatchCommit(base, batch);
      if (commit.records.includes(id)) return await readBatchAsset(base, batch, id);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A batch can disappear between enumeration and lookup. A surviving
      // batch with a missing receipt or record is still a storage error.
      try { await lstat(path.join(base, batch)); }
      catch (missing) { if (missing.code === 'ENOENT') continue; throw missing; }
      throw error;
    }
  }
  return null;
}
export async function resolveImportedAssetFile(root, record, relativePath, manifest = {}) {
  if (!importedId.test(record.id) || !/^[a-f0-9]{64}$/.test(record.storageBatchKey) || !record.files.some(file => file.path === relativePath)) throw new Error('未登记的导入文件。');
  const base = path.join(assetPackageDirectories(root, manifest).persistent, 'batches', record.storageBatchKey, 'assets', record.id.slice(9), 'files');
  const resolved = await confinedPackageFile(base, relativePath);
  const file = record.files.find(file => file.path === relativePath);
  const info = await stat(resolved);
  if (info.size !== file.bytes || info.size > ASSET_PACKAGE_LIMITS.memberBytes) throw new Error('导入文件大小已变化。');
  return resolved;
}
export async function writeImportedAssetMetadata(root, id, updater, manifest = {}) {
  const record = await readImportedAsset(root, id, manifest);
  if (!record) throw new Error('导入资产不存在。');
  const updated = typeof updater === 'function' ? updater(structuredClone(record)) : { ...record, ...updater };
  if (updated.id !== record.id || updated.storageBatchKey !== record.storageBatchKey || JSON.stringify(updated.files) !== JSON.stringify(record.files)) throw new Error('导入文件及身份不可更改。');
  const file = path.join(assetPackageDirectories(root, manifest).persistent, 'batches', record.storageBatchKey, 'assets', id.slice(9), 'record.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(updated));
  await rename(temporary, file);
  return updated;
}

const ownerFilePattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/;
const oldEnough = info => Date.now() - info.mtimeMs >= 10000;

async function removeEmptyLock(directory) {
  try { await rmdir(directory); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

async function recoverCommitLock(lock) {
  const info = await lstat(lock);
  if (!info.isDirectory()) return;
  const names = await readdir(lock);
  const owners = names.filter(name => name !== 'recovery');
  if (!owners.length) {
    if (!oldEnough(info)) return;
  } else {
    const [name] = owners;
    if (owners.length !== 1 || (name !== 'owner.json' && !ownerFilePattern.test(name))) return;
    const file = path.join(lock, name);
    const fileInfo = await lstat(file);
    if (!fileInfo.isFile()) return;
    let owner;
    if (fileInfo.size <= 4096) {
      try { owner = await readPackageJson(file, 4096); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      if (name !== 'owner.json' && name !== `${owner.token}.json`) return;
      try { process.kill(owner.pid, 0); return; }
      catch (error) { if (error.code !== 'ESRCH') return; }
    } else if (name !== 'owner.json' || !oldEnough(fileInfo)) return;
    // Legacy recoverers elected themselves with an empty recovery directory.
    // A dead owner can be reclaimed even when that directory was left behind.
    if (names.includes('recovery')) await removeEmptyLock(path.join(lock, 'recovery'));
    await unlink(file);
  }
  if (!owners.length && names.includes('recovery')) await removeEmptyLock(path.join(lock, 'recovery'));
  // New holders are always published with a unique owner file. A delayed
  // recoverer cannot unlink their token or remove their nonempty directory.
  await removeEmptyLock(lock);
}

export async function withAssetPackageCommitLock(root, manifest, operation) {
  const { persistent } = assetPackageDirectories(root, manifest);
  await mkdir(persistent, { recursive: true });
  const lock = path.join(persistent, '.commit-lock');
  const token = randomUUID();
  const ownerFile = `${token}.json`;
  const staging = path.join(persistent, `.commit-lock-${token}.tmp`);
  let acquired = false;
  await mkdir(staging);
  try {
    // Stage the owner outside the lock, then publish the complete directory.
    await writeFile(path.join(staging, ownerFile), JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { flag: 'wx', flush: true });
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await rename(staging, lock);
        acquired = true;
        break;
      } catch (error) {
        // Windows reports EPERM when the destination directory exists.
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        try { await recoverCommitLock(lock); }
        catch (recoveryError) { if (recoveryError.code !== 'ENOENT') throw recoveryError; }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!acquired) throw Object.assign(new Error('另一个导入正在提交，请使用原命令稍后重试。'), { status: 409 });
    return await operation({ persistent, batchKey });
  } finally {
    if (acquired) {
      await unlink(path.join(lock, ownerFile));
      await removeEmptyLock(lock);
    } else await rm(staging, { recursive: true, force: true });
  }
}
