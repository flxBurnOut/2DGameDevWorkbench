import JSZip from 'jszip';
import manifest from '@/workbench/manifest.json';
import { readWorkspaceDraft, saveWorkspaceDraft } from './browser-store';

export type ImportPurpose =
  | 'map'
  | 'interactable'
  | 'scene'
  | 'image'
  | 'animation';
export type LibraryAsset = {
  id: string;
  kind: string;
  origin?: string;
  mapType?: 'project' | 'image';
  attachmentOnly?: boolean;
  title: string;
  revision?: string;
  statusLabel?: string;
  availability: string;
  previewUrl?: string;
  previewKind?: string;
  hasArtwork?: boolean;
};
export type ImportBundle = {
  purpose: ImportPurpose;
  asset: LibraryAsset & {
    taskId?: string;
    projectId?: string;
    definitionId?: string;
    candidateIndex?: number;
    fps?: number;
    loop?: boolean;
    frameDurations?: number[];
    anchor?: [number, number];
    sourceFacing?: 'left' | 'right';
    facing?: 'left' | 'right';
    definitionIds?: string[];
    width?: number;
    height?: number;
  };
  files: { file: File; sha256: string }[];
};
/** Durations are frame weights: the actual time is duration / fps seconds. */
export function libraryAnimationTiming(asset: ImportBundle['asset'], frameCount: number) {
  const { fps, loop } = asset;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 0.1 || fps > 120 || typeof loop !== 'boolean')
    throw new Error('此动画的播放设置超出交互物支持范围（0.1–120 FPS）；原素材仍保留在资产库。');
  const durations = asset.frameDurations ?? Array<number>(frameCount).fill(1);
  if (durations.length !== frameCount || durations.some((duration) => !Number.isFinite(duration) || duration < 0.01 || duration > 100))
    throw new Error('动画帧时长缺失或超出交互物支持范围（每帧 0.01–100）；原素材仍保留在资产库。');
  return { fps, loop, durations };
}
export function purposesFor(asset: LibraryAsset, purposes: ImportPurpose[]) {
  return manifest.assetImports.filter(
    (rule) =>
      !asset.attachmentOnly && purposes.includes(rule.id as ImportPurpose) &&
      rule.kinds.includes(asset.kind) && (asset.origin !== 'map-project' && asset.mapType !== 'project' || rule.id === 'map'),
  );
}
export function importLink(
  target: string,
  purpose: ImportPurpose,
  assetId: string,
) {
  const route = [...manifest.capabilities, ...manifest.editorModules].find(
    (m) => m.id === target,
  )?.ui.route;
  if (
    !route ||
    !manifest.assetImports.some(
      (rule) => rule.id === purpose && rule.targets.includes(target),
    )
  )
    throw new Error('不支持的导入目标。');
  const params = new URLSearchParams({ importAsset: assetId, importPurpose: purpose });
  if (typeof location !== 'undefined') {
    const source = new URL(location.href);
    if (source.pathname === '/assets') {
      source.searchParams.set('asset', assetId); source.searchParams.delete('import');
      params.set('returnTo', source.pathname + source.search);
    }
  }
  return (
    route +
    '?' +
    params
  );
}
export async function loadLibraryAsset(
  assetId: string,
  purpose: ImportPurpose,
): Promise<ImportBundle> {
  const detail = await fetch(
    '/api/workbench/assets?' + new URLSearchParams({ assetId }),
    { cache: 'no-store' },
  );
  const value = (await detail.json()) as {
    asset: LibraryAsset;
    error?: string;
  };
  if (!detail.ok || !value.asset?.revision)
    throw new Error(value.error || '资产详情读取失败。');
  if (!purposesFor(value.asset, [purpose]).length)
    throw new Error('这件素材不适合当前导入用途。');
  const response = await fetch('/api/workbench/assets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetId, purpose, revision: value.asset.revision }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new Error(error.error || '素材导入失败，请确认后台已更新。');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 257 * 1024 * 1024)
    throw new Error('素材包超过导入上限。');
  const zip = await JSZip.loadAsync(bytes);
  let size = 0;
  for (const entry of Object.values(zip.files)) {
    size +=
      (entry as unknown as { _data?: { uncompressedSize: number } })._data
        ?.uncompressedSize || 0;
    if (size > 257 * 1024 * 1024) throw new Error('素材包解压超过上限。');
  }
  const info = zip.file('import.json');
  if (
    !info ||
    (info as unknown as { _data: { uncompressedSize: number } })._data
      .uncompressedSize >
      1024 * 1024
  )
    throw new Error('素材包清单无效。');
  const metadata = JSON.parse(await info.async('string'));
  if (
    metadata.format !== 'forge-asset-import' ||
    metadata.version !== 1 ||
    metadata.purpose !== purpose ||
    metadata.asset?.id !== value.asset.id ||
    metadata.asset.revision !== value.asset.revision ||
    !Array.isArray(metadata.files) ||
    !metadata.files.length ||
    metadata.files.length > 1000
  )
    throw new Error('素材身份或版本不匹配。');
  const files: ImportBundle['files'] = [];
  for (const record of metadata.files) {
    const entry = zip.file(record.path);
    if (!entry || !String(record.path).startsWith('files/'))
      throw new Error('素材包缺少登记文件。');
    const data = Uint8Array.from(await entry.async('uint8array'));
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== record.sha256)
      throw new Error('素材内容已变化，导入未应用。');
    const ext = String(record.name).split('.').pop()?.toLowerCase();
    const type =
      (
        {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          gif: 'image/gif',
          zip: 'application/zip',
          json: 'application/json',
        } as Record<string, string>
      )[ext || ''] || 'application/octet-stream';
    files.push({
      file: new File([data], record.name, { type }),
      sha256: digest,
    });
  }
  return { purpose, asset: metadata.asset, files };
}
export async function mapImportFile(bundle: ImportBundle): Promise<File> {
  const file = bundle.files[0].file;
  if (!file.type.startsWith('image/')) return file;
  // An image-only map becomes a center tile; it has no invented collision polygons.
  const zip = new JSZip();
  zip.file('map.png', await file.arrayBuffer());
  zip.file(
    'map_stitch_state.json',
    JSON.stringify({
      format: 'pixelwork-map-stitch-state',
      version: 2,
      source: { path: 'map.png', fileName: file.name, type: file.type },
      tiles: {},
    }),
  );
  return new File(
    [await zip.generateAsync({ type: 'blob' })],
    'pixelwork-state.zip',
    { type: 'application/zip' },
  );
}
export function clearImportQuery() {
  const url = new URL(location.href);
  for (const key of ['importAsset', 'importPurpose', 'handoff'])
    url.searchParams.delete(key);
  history.replaceState(history.state, '', url);
}
export async function storeEditorHandoff(
  target: 'scene-composer' | 'interactable-editor' | 'map-stitcher',
  purpose: 'map' | 'interactable',
  payload: unknown,
) {
  const key = 'import-' + crypto.randomUUID();
  await saveWorkspaceDraft(key, { target, purpose, payload }, []);
  const route = [...manifest.capabilities, ...manifest.editorModules].find(
    (m) => m.id === target,
  )!.ui.route;
  return route + '?' + new URLSearchParams({ handoff: key });
}
export async function readEditorHandoff(target: string) {
  const key = new URLSearchParams(location.search).get('handoff');
  if (!key) return null;
  if (!/^import-[a-f0-9-]{36}$/.test(key))
    throw new Error('内部移送身份无效。');
  const record = await readWorkspaceDraft<{
    target: string;
    purpose: 'map' | 'interactable';
    payload: unknown;
  }>(key);
  if (!record || record.target !== target)
    throw new Error('内部移送内容不可读取，请回原工具重新移送。');
  return record;
}
