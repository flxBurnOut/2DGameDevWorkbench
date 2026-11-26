import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getDocument, applyDocumentCommands } from './editor-documents.mjs';
import { inspectImageBytes, MAX_IMAGE_BYTES } from './adapters/image-assets-source.mjs';
import { documentKind } from './document-kinds.mjs';

const inputSchema = z.object({
  documentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/),
  expectedRevision: z.number().int().positive(),
  commandId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/),
  sourceTaskId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,199}$/i),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  definitionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/).optional(),
}).strict();
const inside = (base, target) => {
  const relative = path.relative(base, target);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function confinedRead(base, filename, maxBytes) {
  const actualBase = await realpath(base);
  const actual = await realpath(filename);
  if (!inside(actualBase, actual)) throw new Error('素材路径超出允许的目录。');
  const info = await stat(actual);
  if (!info.isFile() || info.size > maxBytes) throw new Error('素材记录过大或不是文件。');
  return readFile(actual);
}

export async function readGeneratedImage(root, manifest, taskId, expectedSha) {
  if (!/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(taskId)) throw new Error('图片任务身份无效。');
  const tasks = path.resolve(root, manifest.workspace.taskDirectory);
  const task = JSON.parse(await confinedRead(tasks, path.join(tasks, `${taskId}.json`), 128 * 1024 * 1024));
  if (task.id !== taskId || task.capabilityId !== 'image-assets' || task.status !== 'completed' || !Array.isArray(task.outputs))
    throw new Error('只能采用已完成的图片素材任务。');
  const kind = task.input.operation === 'generate-prop' ? 'prop' : task.input.operation === 'generate-background' ? 'background' : ['edit-image', 'process-image'].includes(task.input.operation) ? task.input.kind || 'background' : null;
  if (!kind) throw new Error('图片任务操作无效。');
  const prefix = path.posix.join(manifest.workspace.outputDirectory.replaceAll('\\', '/'), taskId);
  if (!['image.png', 'result.json'].every((name) => task.outputs.includes(`${prefix}/${name}`))) throw new Error('图片任务缺少完整产物记录。');
  const directory = path.resolve(root, prefix);
  const outputRoot = await realpath(path.resolve(root, manifest.workspace.outputDirectory));
  if (!inside(outputRoot, await realpath(directory))) throw new Error('图片任务输出路径无效。');
  const metadata = JSON.parse(await confinedRead(directory, path.join(directory, 'result.json'), 1024 * 1024));
  const bytes = await confinedRead(directory, path.join(directory, 'image.png'), MAX_IMAGE_BYTES);
  const info = await inspectImageBytes(bytes, { pngOnly: true, transparency: kind === 'prop' });
  if (metadata.kind !== kind || metadata.image !== 'image.png' || metadata.sha256 !== expectedSha || info.sha256 !== expectedSha || metadata.width !== info.width || metadata.height !== info.height)
    throw new Error('图片内容或结果记录已变化，请重新检查原任务。');
  return { task, kind, bytes, width: info.width, height: info.height, generation: { sourceTaskId: taskId, sha256: info.sha256 }, name: String(task.input.name || (kind === 'prop' ? '透明物品' : '场景背景')).slice(0, 80) };
}

/** Adopts saved image evidence; never generates or modifies the original task. */
export async function adoptDocumentImage(root, manifest, input) {
  const parsed = inputSchema.parse(input);
  // Reconstruct commands from the exact original base, including on retries.
  const { document } = await getDocument(root, manifest, { documentId: parsed.documentId, revision: parsed.expectedRevision });
  const image = await readGeneratedImage(root, manifest, parsed.sourceTaskId, parsed.sha256);
  const commands = await documentKind(document.kind).imageCommands(document, image, parsed);
  return applyDocumentCommands(root, manifest, { documentId: parsed.documentId, expectedRevision: parsed.expectedRevision, commandId: parsed.commandId, commands });
}
