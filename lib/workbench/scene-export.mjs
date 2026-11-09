import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { documentInputs } from './document-contract.mjs';
import {
  readScenePackage,
  createScenePackage,
  MAX_PACKAGE_BYTES,
} from '../../features/scene-composer/package.mjs';
import { buildSceneGodotPackage } from '../../features/scene-composer/godot-builder.mjs';
import { loadManifest } from './runtime.mjs';

export async function exportSceneRequest(request, repositoryRoot, manifest) {
  manifest ||= await loadManifest();
  const type = (request.headers['content-type'] || '').split(';')[0];
  if (!['application/zip', 'application/json'].includes(type)) throw new Error('请指定已保存的共享版本或上传场景源 ZIP。');
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > (type === 'application/json' ? 16384 : MAX_PACKAGE_BYTES)) throw new Error('场景导出请求过大。');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (type === 'application/json') return exportSceneDocument(repositoryRoot, manifest, documentInputs['document-export'].parse(JSON.parse(bytes.toString('utf8'))));
  const scene = await readScenePackage(bytes);
  return exportSceneContent(repositoryRoot, manifest, scene, bytes);
}

export async function exportSceneContent(repositoryRoot, manifest, scene, bytes, evidence = {}) {
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const source = {
    version: 1,
    kind: evidence.documentId ? 'shared-document' : 'local-snapshot',
    sceneId: scene.id,
    snapshotHash: sha256(JSON.stringify(scene)),
    ...(evidence.documentId ? {
      documentId: evidence.documentId, documentRevision: evidence.documentRevision, documentContentHash: evidence.documentContentHash,
    } : { localRevision: scene.revision }),
  };
  bytes = await createScenePackage(scene, { provenance: source });
  const sourcePackageSha256 = sha256(bytes);
  const result = await buildSceneGodotPackage(scene, { repositoryRoot, sourcePackage: bytes, provenance: { ...source, sourcePackageSha256 } });
  const exportId = `scene-export-${randomUUID()}`;
  const outputDirectory = manifest.workspace.outputDirectory;
  const directory = path.join(repositoryRoot, outputDirectory, exportId);
  const records = path.join(repositoryRoot, manifest.workspace.sceneExportDirectory);
  await mkdir(directory, { recursive: true });
  await mkdir(records, { recursive: true });
  await writeFile(path.join(directory, 'scene-source.zip'), bytes);
  await writeFile(path.join(directory, 'scene-godot.zip.tmp'), result.bytes);
  await rename(
    path.join(directory, 'scene-godot.zip.tmp'),
    path.join(directory, 'scene-godot.zip'),
  );
  const record = {
    exportId,
    sceneId: scene.id,
    sceneName: scene.name,
    instanceCount: scene.instances.length,
    materialCount: scene.materials.length,
    mapName: scene.map?.name || null,
    revision: scene.revision,
    source,
    sourcePackageSha256,
    engineValidated: false,
    status: 'completed',
    createdAt: new Date().toISOString(),
    outputs: [
      `${outputDirectory}/${exportId}/scene-godot.zip`,
      `${outputDirectory}/${exportId}/scene-source.zip`,
    ],
    scenePath: result.scenePath,
    ...evidence,
  };
  await writeFile(
    path.join(records, `${exportId}.json.tmp`),
    JSON.stringify(record, null, 2),
  );
  await rename(path.join(records, `${exportId}.json.tmp`), path.join(records, `${exportId}.json`));
  return record;
}

export async function exportSceneDocument(root, manifest, input) {
  if (!input || typeof input.documentId !== 'string' || !Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new Error('导出需要明确的共享场景身份和已保存版本。');
  const { getDocument } = await import('./editor-documents.mjs');
  const { document } = await getDocument(root, manifest, { documentId: input.documentId, revision: input.revision });
  if (document.kind !== 'scene') throw new Error('此导出接口仅支持场景文档。');
  return exportSceneContent(root, manifest, document.content, undefined, {
    documentId: document.id, documentRevision: document.revision, documentContentHash: document.contentHash, engineValidated: false,
  });
}
