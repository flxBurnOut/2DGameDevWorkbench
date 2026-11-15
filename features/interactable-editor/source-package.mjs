import { normalizeProject } from './contract.mjs';

// Shared by the browser importer and round-trip tests; no filesystem or engine required.
export async function readSourcePackage(bytes) {
  // Loaded on use so the ZIP reader stays out of the editor's first download.
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const candidates = Object.keys(zip.files).filter((p) =>
    p.endsWith('/interactable-project.json'),
  );
  if (candidates.length !== 1)
    throw new Error('请选择工作台导出的单个交互物 ZIP');
  const project = JSON.parse(await zip.file(candidates[0]).async('string'));
  let total = 0;
  for (const asset of project.assets ?? []) {
    if (
      typeof asset.source !== 'string' ||
      asset.source.startsWith('/') ||
      asset.source.includes('\\') ||
      asset.source.split('/').includes('..')
    )
      throw new Error('包内素材路径无效');
    const entry = zip.file(asset.source);
    if (!entry) throw new Error(`包内缺少素材：${asset.name}`);
    const encoded = await entry.async('base64');
    const size =
      (encoded.length * 3) / 4 -
      (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    total += size;
    if (size > 64 * 1024 * 1024 || total > 256 * 1024 * 1024)
      throw new Error('项目解压素材过大');
    asset.source = `data:${asset.mime};base64,${encoded}`;
  }
  return normalizeProject(project);
}
