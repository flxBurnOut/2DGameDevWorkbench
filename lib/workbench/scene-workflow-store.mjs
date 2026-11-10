import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeAtomicSnapshot } from './atomic-snapshot.mjs';

export const hash = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest('hex');
export const workflowError = (
  message,
  code = 'INVALID_SCENE_WORKFLOW',
  status = 400,
) => Object.assign(new Error(message), { code, status });
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
};
const validId = (value) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);

export class SceneWorkflowStore {
  constructor(root, manifest) {
    this.root = path.resolve(root);
    this.manifest = manifest;
    this.base = path.resolve(
      root,
      manifest.workspace.sceneWorkflowDirectory || 'work/scene-workflows',
    );
    if (!inside(this.root, this.base) || this.base === this.root)
      throw workflowError('场景协作目录必须位于工作区内。');
  }
  directory(id) {
    if (!validId(id)) throw workflowError('场景任务身份无效。');
    return path.join(this.base, id);
  }
  async safe(file, create = false) {
    if (!inside(this.base, file)) throw workflowError('场景任务路径越界。');
    const root = await realpath(this.root);
    let parent = path.dirname(file);
    for (;;) {
      try {
        if (!inside(root, await realpath(parent)))
          throw workflowError('场景任务路径越界。');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const next = path.dirname(parent);
        if (next === parent) throw error;
        parent = next;
      }
    }
    if (create)
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (!inside(root, await realpath(file)))
        throw workflowError('场景任务路径越界。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return file;
  }
  async read(file, optional = false) {
    try {
      await this.safe(file);
      if ((await stat(file)).size > 400 * 1024 * 1024)
        throw workflowError('场景任务记录过大。');
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async write(file, value, immutable = false) {
    await this.safe(file, true);
    const bytes = `${JSON.stringify(value)}\n`;
    if (immutable) {
      try {
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST' || (await readFile(file, 'utf8')) !== bytes)
          throw error;
      }
      return;
    }
    await writeAtomicSnapshot(file, bytes);
  }
  async load(id) {
    const work = await this.read(
      path.join(this.directory(id), 'task.json'),
      true,
    );
    if (!work || work.id !== id || work.schemaVersion !== 1)
      throw workflowError('场景任务不存在。', 'SCENE_WORKFLOW_NOT_FOUND', 404);
    return work;
  }
  async save(work) {
    work.revision++;
    work.updatedAt = new Date().toISOString();
    await this.write(path.join(this.directory(work.id), 'task.json'), work);
  }
  async freeze(id, name, value) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw workflowError('快照名称无效。');
    await this.write(
      path.join(this.directory(id), `${name}.json`),
      value,
      true,
    );
    return hash(value);
  }
  async source(work) {
    const source = await this.read(
      path.join(this.directory(work.id), 'source.json'),
    );
    if (hash(source) !== work.sourceHash)
      throw workflowError('任务源快照发生变化。', 'SCENE_SOURCE_CHANGED', 409);
    return source;
  }
  async plan(work) {
    const record = work.plans.at(-1);
    if (!record || hash(record.plan) !== record.hash)
      throw workflowError('任务方案发生变化。', 'SCENE_PLAN_CHANGED', 409);
    const saved = await this.read(
      path.join(this.directory(work.id), `plan-${record.revision}.json`),
    );
    if (hash(saved) !== hash(record))
      throw workflowError('任务方案快照不匹配。', 'SCENE_PLAN_CHANGED', 409);
    return record;
  }
  candidateManifest(work) {
    const relative = path
      .relative(this.root, this.directory(work.id))
      .split(path.sep)
      .join('/');
    return {
      ...this.manifest,
      workspace: {
        ...this.manifest.workspace,
        documentDirectory: `${relative}/candidate-documents`,
        imageEditDirectory: `${relative}/image-edits`,
      },
    };
  }
  async list(documentId, limit, offset = 0, snapshot) {
    await this.safe(path.join(this.base, '.check'));
    const entries = await readdir(this.base).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const rows = [];
    for (const id of entries.filter(validId)) {
      const work = await this.read(
        path.join(this.directory(id), 'task.json'),
        true,
      );
      if (
        work &&
        work.id === id &&
        (!documentId || work.spec.documentId === documentId)
      )
        rows.push(work);
    }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    // Bind pagination to the exact ordering, not mutable task progress. Moving
    // or adding a row requires a fresh first page rather than silently skipping it.
    const currentSnapshot = hash({ documentId: documentId || null, ids: rows.map((row) => row.id) });
    if (snapshot && snapshot !== currentSnapshot)
      throw workflowError('场景协作历史已变化，请刷新列表后继续查看，避免漏项。', 'SCENE_HISTORY_CHANGED', 409);
    const next = offset + limit;
    return {
      works: rows.slice(offset, next), total: rows.length, offset, limit,
      snapshot: currentSnapshot, nextOffset: next < rows.length ? next : null,
    };
  }
  async pauseRequested(id) {
    return Boolean(
      await this.read(path.join(this.directory(id), 'pause.json'), true),
    );
  }
  async pause(id, commandId) {
    await this.write(path.join(this.directory(id), 'pause.json'), {
      commandId,
    });
  }
  async clearPause(id) {
    await this.write(path.join(this.directory(id), 'pause.json'), null);
  }
}
