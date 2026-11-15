import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  selectedProject,
  normalizeProject,
  describeError,
} from '../../../features/interactable-editor/contract.mjs';
import sharp from 'sharp';
import { readAsset, buildGodotPackage } from '../../../features/interactable-editor/godot-builder.mjs';

export function validateInteractableInput(input) {
  if (!['save-project', 'export-godot'].includes(input.operation))
    return ['operation must be save-project or export-godot.'];
  if (input.operation === 'save-project' && (input.selectedDefinitionIds !== undefined || input.targetProfile !== undefined))
    return ['save-project saves the complete project; selection and targetProfile apply only to export-godot.'];
  if (input.targetProfile !== undefined && input.targetProfile !== 'generic')
    return ['targetProfile must be generic.'];
  try {
    if (input.operation === 'save-project') normalizeProject(input.project);
    else selectedProject(input.project, input.selectedDefinitionIds);
    return [];
  } catch (e) {
    return [describeError(e)];
  }
}
export async function executeInteractable({
  input,
  outputDirectory,
  repositoryRoot,
}) {
  if (input.operation === 'save-project') {
    const project = normalizeProject(input.project);
    const portable = {
      ...project,
      assets: await Promise.all(project.assets.map(async (asset) => {
        const bytes = await readAsset(asset, repositoryRoot);
        if (asset.mime.startsWith('image/')) await sharp(bytes).metadata();
        return { ...asset, source: `data:${asset.mime};base64,${bytes.toString('base64')}` };
      })),
    };
    await writeFile(path.join(outputDirectory, 'interactable-project.json'), JSON.stringify(portable, null, 2));
    return {
      status: 'completed',
      generatedOutputNames: ['interactable-project.json'],
      result: { projectId: project.projectId, name: project.name, saved: true, exported: false,
        objects: project.objects.map((o) => ({ definitionId: o.definitionId, name: o.displayName, kind: o.behavior.kind })),
        hasArtwork: project.objects.some((o) => o.visual.assetId),
      },
      adapter: { id: 'interactable-editor', operation: 'save-project' },
    };
  }
  const result = await buildGodotPackage(input, {
    repositoryRoot,
    exportId: path.basename(outputDirectory),
  });
  const zipName = 'interactables.zip';
  await writeFile(path.join(outputDirectory, zipName), result.bytes);
  // Standalone JSON is portable as well: assets are embedded, never dangling zip paths.
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(result.bytes);
  const portable = {
    ...result.source,
    assets: await Promise.all(
      result.source.assets.map(async (a) => ({
        ...a,
        source: `data:${a.mime};base64,${await zip.file(a.source).async('base64')}`,
      })),
    ),
  };
  await writeFile(
    path.join(outputDirectory, 'interactable-project.json'),
    JSON.stringify(portable, null, 2),
  );
  return {
    status: 'completed',
    generatedOutputNames: [zipName, 'interactable-project.json'],
    result: result.metadata,
    adapter: {
      id: 'interactable-editor',
      operation: 'export-godot',
      targetProfile: result.metadata.targetProfile,
    },
  };
}
