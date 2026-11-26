import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MAX_IMAGE_BYTES } from './adapters/image-assets-source.mjs';
import { confinedRead, failure, inside, pixels, publicTarget, sha, summary, taskId } from './image-edit-target-common.mjs';

export async function imageTask(root, manifest, selectedTaskId) {
  taskId.parse(selectedTaskId);
  const tasks = path.resolve(root, manifest.workspace.taskDirectory);
  const task = JSON.parse(await confinedRead(root, tasks, path.join(tasks, `${selectedTaskId}.json`), 128 * 1024 * 1024));
  const operation = task.input?.operation;
  const kind = operation === 'generate-prop' ? 'prop' : operation === 'generate-background' ? 'background' : ['edit-image', 'process-image'].includes(operation) ? task.input.kind || 'background' : null;
  if (task.id !== selectedTaskId || task.capabilityId !== 'image-assets' || task.status !== 'completed' || !['prop', 'background'].includes(kind) || !Array.isArray(task.outputs)) throw failure('图片目标需要已完成的 image-assets 任务。');
  const prefix = `${manifest.workspace.outputDirectory.replaceAll('\\', '/')}/${selectedTaskId}`;
  if (!['image.png', 'result.json'].every(name => task.outputs.includes(`${prefix}/${name}`))) throw failure('图片任务缺少实际图片或结果记录。');
  const outputRoot = path.resolve(root, manifest.workspace.outputDirectory);
  const directory = path.resolve(root, prefix);
  const actualDirectory = await realpath(directory);
  if (!inside(await realpath(outputRoot), actualDirectory)) throw failure('图片任务目录越界。');
  const metadata = JSON.parse(await confinedRead(root, directory, path.join(directory, 'result.json'), 1024 * 1024));
  if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width < 1 || metadata.height < 1) throw failure('图片任务缺少完整的真实尺寸记录。');
  const bytes = await confinedRead(root, directory, path.join(directory, 'image.png'), MAX_IMAGE_BYTES);
  const info = await pixels(bytes, { width: metadata.width, height: metadata.height, sha256: sha.parse(metadata.sha256), mime: 'image/png' });
  if (metadata.image !== 'image.png' || metadata.kind !== kind || (metadata.hasAlpha !== undefined && metadata.hasAlpha !== info.hasAlpha) || (metadata.hasTransparency !== undefined && metadata.hasTransparency !== info.hasTransparency)) throw failure('图片任务结果记录与实际 PNG 不符。', 409, 'IMAGE_SOURCE_CHANGED');
  return { task, metadata, bytes, info, kind, name: String(task.input.name || metadata.name || (kind === 'prop' ? '物品图片' : '背景图片')).slice(0, 200) };
}

async function taskTarget(root, manifest, ref) {
  const image = await imageTask(root, manifest, ref.taskId);
  return { ...summary(ref, image.info, { revision: image.info.sha256, kind: image.kind, name: image.name, locked: false, editable: true, immutableSource: true, adoptionMode: 'saved_variant', source: { taskId: ref.taskId }, viewPath: `/tools/interactable-editor?imageTask=${encodeURIComponent(ref.taskId)}` }), bytes: image.bytes };
}

async function listTargets(root, manifest, scope, add, issues) {
  let entries = [];
  try { entries = await readdir(path.resolve(root, manifest.workspace.taskDirectory)); } catch (error) { if (error.code !== 'ENOENT') issues.push({ source: 'image-task', message: error.message }); }
  for (const entry of entries.filter(entry => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}\.json$/.test(entry))) {
    const selectedTaskId = entry.slice(0, -5);
    if (scope.taskId && scope.taskId !== selectedTaskId) continue;
    try {
      const tasks = path.resolve(root, manifest.workspace.taskDirectory);
      const record = JSON.parse(await confinedRead(root, tasks, path.join(tasks, entry), 128 * 1024 * 1024));
      if (record.id === selectedTaskId && record.capabilityId === 'image-assets' && record.status === 'completed') add({ kind: 'image-task', taskId: selectedTaskId }, String(record.input?.name || selectedTaskId));
    } catch (error) { issues.push({ source: 'image-task', id: selectedTaskId, message: error.message }); }
  }
}

async function applyTarget(root, manifest, ref, parsed, candidate) {
  const source = await taskTarget(root, manifest, ref);
  if (source.revision !== parsed.expectedRevision || source.sha256 !== parsed.expectedSha256) throw failure('独立图片源已变化。', 409, 'IMAGE_TARGET_CONFLICT');
  if (source.width !== candidate.info.width || source.height !== candidate.info.height) throw failure('局部调整不能改变源图尺寸。');
  const target = await taskTarget(root, manifest, { kind: 'image-task', taskId: candidate.task.id });
  return { target: publicTarget(target), revision: target.revision, currentRevision: source.revision, replayed: false, adoption: { status: 'saved_variant', assetId: `image:${candidate.task.id}`, sourceTaskId: candidate.task.id, sourceTargetId: source.targetId, sha256: target.sha256, commandId: parsed.commandId, sourceChanged: false } };
}

export const taskImageTargetSource = { kinds: ['image-task'], read: taskTarget, list: listTargets, apply: applyTarget };
