import { mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as z from 'zod/v4';
import { repositoryRoot } from './workbench-manifest.mjs';

const row = z.looseObject({ id: z.string().min(1), title: z.string(), kind: z.string(), aliases: z.array(z.string()).optional() });
const schema = z.object({ version: z.literal(1), entries: z.array(z.object({ ids: z.array(z.string()).min(1), trashedAt: z.iso.datetime(), asset: row })) });
const directory = (manifest) => path.resolve(repositoryRoot, manifest.workspace.assetTrashDirectory);
export async function readAssetTrash(manifest) {
  try {
    return schema.parse(JSON.parse(await readFile(path.join(directory(manifest), 'index.json'), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: [] };
    throw new Error('资产回收站记录无法读取，请修复记录后重试；未更改任何源文件。', { cause: error });
  }
}
export function trashEntry(index, asset) {
  const ids = [asset.id, ...(asset.aliases || [])];
  return index.entries.find((entry) => entry.ids.some((id) => ids.includes(id)));
}
// A cross-process lock and one atomic replacement prevent lost batch updates.
// A leftover lock after a crash fails closed instead of guessing whether a writer is alive.
export async function updateAssetTrash(manifest, update) {
  const root = directory(manifest);
  await mkdir(root, { recursive: true });
  const lock = path.join(root, '.lock');
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('回收站正在更新或上次写入中断，请稍后重试；持续失败时请检查本地服务。');
    throw error;
  }
  const temporary = path.join(root, `${randomUUID()}.tmp`);
  try {
    const index = await readAssetTrash(manifest);
    const result = await update(index);
    await writeFile(temporary, JSON.stringify(schema.parse(index)), { flag: 'wx' });
    await rename(temporary, path.join(root, 'index.json'));
    return result;
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(lock);
  }
}
