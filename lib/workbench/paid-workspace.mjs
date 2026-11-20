import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safe, storage } from './image-edit-store.mjs';

async function storeToken(root, directory) {
  const relative = path.relative(path.resolve(root), directory);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('付费数据目录必须位于工作区内。');
  const file = path.join(directory, '.paid-workspace-id');
  await safe(root, file);
  let token;
  try {
    token = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true });
    const staging = file + '.' + randomUUID();
    await writeFile(staging, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    try {
      // Concurrent Bridges publish only complete tokens and never replace the winner.
      await link(staging, file);
    } catch (publishError) {
      if (publishError.code !== 'EEXIST') throw publishError;
    } finally {
      await unlink(staging);
    }
    token = await readFile(file, 'utf8');
  }
  if (!/^[0-9a-f]{64}$/.test(token) || token.length !== 64) throw new Error('存储标识格式无效。');
  return token;
}

export async function paidWorkspaceIdentity(root, manifest, workspaceId) {
  try {
    const tasks = path.resolve(root, manifest.workspace.taskDirectory);
    const edits = storage(root, manifest);
    const [taskToken, editToken] = await Promise.all([storeToken(root, tasks), storeToken(root, edits)]);
    return createHash('sha256').update([workspaceId, taskToken, editToken].join(':')).digest('hex');
  } catch (cause) {
    throw Object.assign(new Error('无法读取或建立付费任务数据目录的身份，请检查数据目录及权限。', { cause }),
      { code: 'PAID_WORKSPACE_UNAVAILABLE', status: 503 });
  }
}
