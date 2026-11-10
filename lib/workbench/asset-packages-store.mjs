import { mkdir, readFile, readdir, realpath, stat, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeAssetPackagePath } from './asset-packages-zip.mjs';
import { ASSET_PACKAGE_LIMITS, packageCommandId } from './asset-package-contract.mjs';

export const assetPackageHash = value => createHash('sha256').update(value).digest('hex');
const importedId = /^imported:[a-f0-9]{32}$/;
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
export async function listImportedAssets(root, manifest = {}) {
  const base = path.join(assetPackageDirectories(root, manifest).persistent, 'batches');
  let batches;
  try { batches = await readdir(base, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const batch of batches.filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))) {
    const commit = await readPackageJson(await confinedPackageFile(base, `${batch.name}/commit.json`), 1024 * 1024);
    if (commit.status !== 'completed' || !Array.isArray(commit.records)) throw new Error('导入事务记录损坏。');
    for (const id of commit.records) {
      if (!importedId.test(id)) throw new Error('导入资产身份损坏。');
      const record = await readPackageJson(await confinedPackageFile(base, `${batch.name}/assets/${id.slice(9)}/record.json`));
      if (record.id !== id || record.storageBatchKey !== batch.name || !Array.isArray(record.files)) throw new Error('导入资产记录损坏。');
      records.push(record);
    }
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}
export async function readImportedAsset(root, id, manifest = {}) {
  if (!importedId.test(id)) throw new Error('导入资产身份无效。');
  return (await listImportedAssets(root, manifest)).find(record => record.id === id) || null;
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

// A directory rename publishes both the selected set and its replay record.
// The filesystem lock also serializes separate bridge processes.
export async function withAssetPackageCommitLock(root, manifest, operation) {
  const { persistent } = assetPackageDirectories(root, manifest);
  await mkdir(persistent, { recursive: true });
  const lock = path.join(persistent, '.commit-lock');
  const token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await mkdir(lock);
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { flag: 'wx' });
      acquired = true;
      break;
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Elect one recovery attempt inside the existing lock. Re-read its
      // owner after election, so a replacement lock is never mistaken for
      // the dead process's lock.
      let recovery;
      try {
        const lockInfo = await stat(lock);
        recovery = path.join(lock, 'recovery');
        await mkdir(recovery);
        let owner;
        try { owner = await readPackageJson(path.join(lock, 'owner.json'), 4096); }
        catch (ownerError) {
          if (ownerError.code !== 'ENOENT') throw ownerError;
          if (Date.now() - lockInfo.mtimeMs < 10000) owner = { pid: process.pid };
        }
        let alive = false;
        if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); alive = true; }
          catch (killError) { if (killError.code !== 'ESRCH') alive = true; }
        }
        if (!alive) {
          const abandoned = path.join(persistent, `.abandoned-lock-${randomUUID()}`);
          await rename(lock, abandoned);
          recovery = null;
          await rm(abandoned, { recursive: true, force: true });
          continue;
        }
      } catch (recoveryError) {
        if (!['EEXIST', 'ENOENT'].includes(recoveryError.code)) throw recoveryError;
        recovery = null;
      } finally { if (recovery) await rm(recovery, { recursive: true, force: true }); }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!acquired) throw Object.assign(new Error('另一个导入正在提交，请使用原命令稍后重试。'), { status: 409 });
  try { return await operation({ persistent, batchKey }); }
  finally {
    const owner = await readPackageJson(path.join(lock, 'owner.json'), 4096).catch(() => null);
    if (owner?.token === token) await rm(lock, { recursive: true, force: true });
  }
}
