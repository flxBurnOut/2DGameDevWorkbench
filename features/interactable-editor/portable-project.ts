import { normalizeProject, type InteractableProject } from './contract.mjs';
import { dataUrl } from './browser-storage';
import { browserDocumentMedia } from '../editor-documents/browser-media';
import { parseDocumentMediaReference } from '../editor-documents/media-references.mjs';

export async function portableProject(project: InteractableProject) {
  const clean = normalizeProject(project);
  for (const asset of clean.assets) {
    if (asset.source.startsWith('data:')) continue;
    if (parseDocumentMediaReference(asset.source)) {
      asset.source = await browserDocumentMedia.dataUrl(asset.source, asset.mime);
      continue;
    }
    const response = await fetch(
      `/api/workbench/interactable-assets?path=${encodeURIComponent(asset.source)}`,
    );
    if (!response.ok)
      throw new Error(`无法读取素材 ${asset.name}，请重新导入源文件。`);
    asset.source = await dataUrl(
      (await response.blob()).slice(0, undefined, asset.mime),
    );
  }
  return clean;
}
