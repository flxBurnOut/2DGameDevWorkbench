import {unwrapGodotMapZip} from '../godot-export/package.mjs';
import {offerGodotExport} from '@/lib/workbench/godot-export';
import JSZip from 'jszip';
import {
  listWorkItems,
  readWorkspaceDraft,
  saveWorkspaceDraft,
  updateWorkspaceDraft,
} from '@/lib/workbench/browser-store';
import type { WorkItem } from '@/lib/workbench/work-items';
import { workbenchModules } from '@/lib/workbench/modules';
import {
  dataUrl,
  importProject,
  loadDraft,
} from '@/features/interactable-editor/browser-storage';
import {
  normalizeProject,
  type InteractableProject,
} from '@/features/interactable-editor/contract.mjs';
import {
  createPixelworkStatePackage,
  type FrameRoninEditorSnapshot,
} from '@/features/map-stitcher/state-package';
import { loadMapProject } from '@/features/map-stitcher/godot-import';
import { loadMapWorkspace } from '@/features/map-stitcher/workspace-draft';
import { renderStitchedMap } from '@/features/map-stitcher/layer-engine';
import { canUseSeparatedComposite } from '@/features/map-stitcher/map-production';
import { buildRegionManifest } from '@/features/map-stitcher/engine-export';
import {
  canvasToBlob,
  downloadBlob,
} from '@/features/map-stitcher/image-utils';
import {
  createScene,
  wholeMapSplitHint,
  replaceMap,
  validateScene,
  type Scene,
  type SceneMap,
} from './model.mjs';
import { createScenePackage, readScenePackage } from './package.mjs';
import type { SharedDocument } from '../editor-documents/client';
import { readDocument } from '../editor-documents/client';
import { documentFingerprint, type DocumentSyncCache } from '../editor-documents/sync-controller.mjs';
import { browserRequestJournal } from '../editor-documents/browser-journal';
import { browserDocumentMedia } from '../editor-documents/browser-media';
import { parseDocumentMediaReference } from '../editor-documents/media-references.mjs';
import { sharedSceneContent } from './shared-content.mjs';

type SavedScene = { scene: Scene; backupRevision: number | null };
export async function prepareSceneDraft(scene: Scene) {
  const key = `document-sync:scene:${scene.id}`;
  const cache = await readWorkspaceDraft<DocumentSyncCache>(key);
  const original = sharedSceneContent(scene), fingerprint = await documentFingerprint(original);
  if (cache?.pending?.fingerprint === fingerprint && !await browserRequestJournal('document-sync:scene', scene.id).pending()) {
    const pending = cache.pending;
    await browserRequestJournal('document-sync:scene', scene.id).begin({
      operation: pending.expectedRevision ? 'save' : 'create',
      input: { documentId: scene.id, kind: 'scene', content: original, commandId: pending.commandId, expectedRevision: pending.expectedRevision },
    });
  }
  const next = validateScene(await browserDocumentMedia.compact('scene', scene));
  if (cache && cache.fingerprint === fingerprint && cache.mediaVersion !== 2) {
    const compactFingerprint = await documentFingerprint(sharedSceneContent(next));
    await updateWorkspaceDraft<DocumentSyncCache>(key, latest => latest?.fingerprint === fingerprint
      ? { ...latest, fingerprint: compactFingerprint, mediaVersion: 2 } : latest || cache);
  }
  return next;
}
export async function migrateSceneSyncCache(cache: DocumentSyncCache | undefined, scene: Scene) {
  if (!cache) return cache;
  if (cache.pending && !await browserRequestJournal('document-sync:scene', scene.id).pending())
    throw new Error('旧保存请求尚未确认且原草稿已变化，请保留本机备份后读取共享版本。');
  if (cache.mediaVersion === 2 || !cache.revision || !cache.fingerprint) return cache;
  // Compare the historical embedded baseline before changing its representation.
  const { document } = await readDocument<Scene>(scene.id, cache.revision);
  const original = sharedSceneContent(document.content);
  const compact = sharedSceneContent(await browserDocumentMedia.compact('scene', original));
  const fingerprint = await documentFingerprint(compact);
  if ([await documentFingerprint(original), fingerprint].includes(cache.fingerprint))
    return { ...cache, fingerprint, mediaVersion: 2 };
  return cache;
}
export async function compactMap(map: SceneMap): Promise<SceneMap> {
  const scene = createScene(); scene.map = map;
  return (await browserDocumentMedia.compact('scene', scene)).map!;
}
export const sceneHref = (id: string) =>
  `${workbenchModules.find((module) => module.id === 'scene-composer')!.href}?scene=${encodeURIComponent(id)}`;
export function sceneItem(scene: Scene): WorkItem {
  const now = new Date().toISOString();
  return {
    id: scene.id,
    capabilityId: 'scene-composer',
    title: scene.name,
    detail: `${scene.instances.length} 个物件 · 本机场景`,
    state: 'saved',
    updatedAt: now,
    savedAt: now,
    href: sceneHref(scene.id),
    draftKey: `scene:${scene.id}`,
    userInitiated: true,
  };
}
export async function saveScene(scene: Scene, backupRevision: number | null) {
  const compact = validateScene(await browserDocumentMedia.compact('scene', scene));
  await saveWorkspaceDraft(
    `scene:${scene.id}`,
    { scene: compact, backupRevision },
    [sceneItem(scene)],
    'scene-current',
  );
}
export async function loadScene(id?: string) {
  const key = id
    ? `scene:${id}`
    : await readWorkspaceDraft<string>('scene-current');
  if (!key) return undefined;
  const saved = await readWorkspaceDraft<SavedScene>(key);
  if (!saved) {
    if (id) throw new Error('找不到这个场景的本机保存，请打开场景源文件。');
    return undefined;
  }
  return {
    scene: await prepareSceneDraft(saved.scene),
    backupRevision: saved.backupRevision ?? null,
  };
}
export async function readLocalMaps() {
  return (await listWorkItems()).filter(
    (i) => i.capabilityId === 'map-stitcher' && i.draftKey,
  );
}
export async function readLocalObjectProjects() {
  const items = (await listWorkItems()).filter(
    (i) => i.capabilityId === 'interactable-editor' && i.draftKey,
  );
  return [...new Map(items.map((i) => [i.draftKey, i])).values()];
}
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
export async function readObjects(fileOrItem: File | WorkItem) {
  const project =
    fileOrItem instanceof File
      ? await importProject(fileOrItem)
      : fileOrItem.draftKey
        ? await readWorkspaceDraft<InteractableProject>(fileOrItem.draftKey)
        : await loadDraft(fileOrItem.scopeId);
  if (!project) throw new Error('交互物草稿不存在。');
  return browserDocumentMedia.compact('interactable', await portableProject(project));
}
export async function captureMap(
  snapshot: FrameRoninEditorSnapshot,
  name?: string,
): Promise<SceneMap> {
  const source = snapshot.tiles.find((t) => t.key === '0,0')?.images.overall;
  if (!source) throw new Error('请先在地图工具中添加地图。');
  const separated = canUseSeparatedComposite(snapshot.tiles);
  const layers: SceneMap['layers'] = [];
  const candidates = separated
    ? (['surface', 'object'] as const)
    : (['overall'] as const);
  const types = [
    ...candidates,
    ...(snapshot.shapes.some(
      (s) =>
        s.layer === 'top' &&
        snapshot.tiles.some((t) => t.key === s.tileKey && !t.hidden),
    )
      ? ['top' as const]
      : []),
  ];
  let canvas:
    | { originX: number; originY: number; width: number; height: number }
    | undefined;
  for (const type of types) {
    const rendered = await renderStitchedMap(
      snapshot.tiles,
      type,
      snapshot.shapes,
      source.width,
      source.height,
    );
    canvas ??= rendered;
    layers.push({
      id: `map_${type}`,
      name: {
        overall: '地图底图',
        surface: '地图地表',
        object: '地图物件层',
        top: '地图前景',
      }[type],
      source: await dataUrl(await canvasToBlob(rendered.canvas)),
      width: rendered.width,
      height: rendered.height,
      locked: true,
      hidden: false,
      included: true,
    });
    rendered.canvas.width = rendered.canvas.height = 0;
  }
  const regions = buildRegionManifest(
    snapshot.tiles,
    snapshot.shapes,
    source.width,
    source.height,
    canvas!,
  );
  return compactMap({
    name: name || source.name.replace(/\.[^.]+$/, ''),
    origin: { x: canvas!.originX, y: canvas!.originY },
    offset: { x: 0, y: 0 },
    layers,
    collisions: regions.regions
      .filter((r) => r.layer === 'collision')
      .map((r) => r.points),
    source: await dataUrl((await createPixelworkStatePackage(snapshot)).blob),
    warnings: separated ? [] : [wholeMapSplitHint],
  });
}
function release(snapshot: FrameRoninEditorSnapshot) {
  for (const tile of snapshot.tiles)
    for (const asset of Object.values(tile.images))
      if (asset) URL.revokeObjectURL(asset.url);
}
export async function readMap(fileOrItem: File | WorkItem): Promise<SceneMap> {
  if (!(fileOrItem instanceof File)) {
    const draft = await loadMapWorkspace(fileOrItem.id);
    if (!draft) throw new Error('地图草稿不存在。');
    try {
      return await captureMap(draft.snapshot, fileOrItem.title);
    } finally {
      release(draft.snapshot);
    }
  }
  if (fileOrItem.size > 256 * 1024 * 1024)
    throw new Error('地图包超过 256 MB。');
  // Preserve the original world origin in engine-only packages; the map editor's
  // recovery importer intentionally rebases them into a single editable tile.
  if (fileOrItem.name.endsWith('.zip')) {
    const zip = unwrapGodotMapZip(await JSZip.loadAsync(fileOrItem));
    let total = 0;
    for (const entry of Object.values(zip.files)) {
      total +=
        (entry as unknown as { _data?: { uncompressedSize: number } })._data
          ?.uncompressedSize || 0;
      if (total > 256 * 1024 * 1024) throw new Error('地图包解压超过 256 MB。');
    }
    if (zip.file('map_export.json') && !zip.file('source_state.zip')) {
      const manifest = JSON.parse(
        await zip.file('map_export.json')!.async('string'),
      );
      const regions = JSON.parse(
        await zip.file('regions.json')!.async('string'),
      );
      if (manifest.format !== 'frame-ronin-engine-package')
        throw new Error('地图清单格式无效。');
      const types =
        manifest.layers.includes('surface') &&
        manifest.layers.includes('object')
          ? ['surface', 'object']
          : ['overall'];
      if (manifest.layers.includes('top')) types.push('top');
      const layers: SceneMap['layers'] = [];
      for (const type of types) {
        const entry = zip.file(`assets/map_${type}.png`);
        if (!entry) throw new Error('地图包缺少视觉层。');
        layers.push({
          id: `map_${type}`,
          name: `地图 ${type}`,
          source: `data:image/png;base64,${await entry.async('base64')}`,
          width: manifest.canvas.width,
          height: manifest.canvas.height,
          locked: true,
          hidden: false,
          included: true,
        });
      }
      return compactMap({
        name: fileOrItem.name,
        origin: { x: manifest.canvas.originX, y: manifest.canvas.originY },
        offset: { x: 0, y: 0 },
        layers,
        collisions: regions.regions
          .filter((r: { layer: string }) => r.layer === 'collision')
          .map((r: { points: { x: number; y: number }[] }) => r.points),
        source: await dataUrl(
          fileOrItem.slice(0, undefined, 'application/zip'),
        ),
        warnings: ['此包缺少完整地图编辑源，保留合成图层、原点和碰撞。'],
      });
    }
  }
  const loaded = await loadMapProject(fileOrItem);
  try {
    const map = await captureMap(
      loaded,
      fileOrItem.name.replace(/\.[^.]+$/, ''),
    );
    map.warnings.push(...loaded.warnings);
    return map;
  } finally {
    release(loaded);
  }
}
export async function startSceneFromMap(snapshot: FrameRoninEditorSnapshot) {
  const map = await captureMap(snapshot);
  const scene = createScene(map.name.slice(0, 120));
  replaceMap(scene, map);
  await saveScene(scene, null);
  return `${sceneHref(scene.id)}&fit=1`;
}
export async function downloadScene(scene: Scene) {
  const bytes = await createScenePackage(await browserDocumentMedia.hydrate('scene', scene));
  downloadBlob(
    new Blob([bytes], { type: 'application/zip' }),
    `${scene.name.replace(/[\\/:*?"<>|]/g, '_')}.scene.zip`,
  );
}
export async function importScene(file: File) {
  return browserDocumentMedia.compact('scene', await readScenePackage(await file.arrayBuffer()));
}
export async function exportScene(scene: Scene, document?: SharedDocument<Scene>) {
  if (document && (document.id !== scene.id || document.kind !== 'scene')) throw new Error('导出来源与当前场景不匹配。');
  const body = document ? JSON.stringify({ documentId: document.id, revision: document.revision }) : new Blob([await createScenePackage(await browserDocumentMedia.hydrate('scene', scene))]);
  const response = await fetch('/api/workbench/scene-composer/export', {
    method: 'POST',
    headers: { 'content-type': document ? 'application/json' : 'application/zip' },
    body,
    signal: AbortSignal.timeout(370000),
  });
  const result = (await response.json()) as {
    error?: string;
    status: string;
    exportId: string;
    outputs: string[];
    source: { kind: string; sceneId: string; snapshotHash: string; documentId?: string; documentRevision?: number; documentContentHash?: string };
  };
  if (!response.ok || result.status !== 'completed')
    throw new Error(result.error || '场景导出失败。');
  if (!result.source || result.source.sceneId !== scene.id || !/^[a-f0-9]{64}$/.test(result.source.snapshotHash) ||
      (document ? result.source.kind !== 'shared-document' || result.source.documentId !== document.id || result.source.documentRevision !== document.revision || result.source.documentContentHash !== document.contentHash
        : result.source.kind !== 'local-snapshot')) throw new Error('导出回执的来源版本或哈希不匹配，未交付其他版本。');
  const output = result.outputs.find((p) => p.endsWith('/scene-godot.zip'));
  if (!output) throw new Error('导出结果缺少场景包。');
  offerGodotExport({name:scene.name,url:`/api/workbench/artifacts?path=${encodeURIComponent(output)}`});
  return result;
}
