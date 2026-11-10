import JSZip from 'jszip';
import { validateScene } from './model.mjs';
import { documentMediaReferences } from '../editor-documents/media-references.mjs';

export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const references = scene => documentMediaReferences('scene', scene);
export async function createScenePackage(input, { provenance } = {}) {
  const scene = validateScene(input);
  const zip = new JSZip();
  const paths = new Map();
  let total = 0;
  for (const ref of references(scene)) {
    const data = ref.owner[ref.key];
    if (!data.startsWith(`data:${ref.mime};base64,`))
      throw new Error('场景源文件必须包含全部素材，请重新导入缺失的文件。');
    if (!paths.has(data)) {
      const encoded = data.slice(data.indexOf(',') + 1);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
        throw new Error('素材编码无效。');
      total += Math.ceil((encoded.length * 3) / 4);
      if (total > MAX_PACKAGE_BYTES)
        throw new Error('场景素材超过 256 MB，请拆分场景。');
      const file = `media/${paths.size}.bin`;
      zip.file(file, encoded, { base64: true });
      paths.set(data, file);
    }
    ref.owner[ref.key] = paths.get(data);
  }
  zip.file('scene.json', JSON.stringify(scene));
  if (provenance) zip.file('scene-provenance.json', JSON.stringify(provenance, null, 2));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
export async function readScenePackage(bytes) {
  if (bytes.byteLength > MAX_PACKAGE_BYTES)
    throw new Error('场景包超过 256 MB。');
  let zip = await JSZip.loadAsync(bytes);
  // Godot delivery contains the same portable source; never reverse-parse engine scripts.
  if (!zip.file('scene.json')) {
    const sources = Object.keys(zip.files).filter((key) =>
      key.endsWith('/scene-source.zip'),
    );
    if (sources.length !== 1)
      throw new Error('请选择场景源包或本工具导出的单个 Godot 场景包。');
    const source = zip.file(sources[0]);
    if (source._data?.uncompressedSize > MAX_PACKAGE_BYTES)
      throw new Error('场景源包解压过大。');
    zip = await JSZip.loadAsync(await source.async('uint8array'));
  }
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    total += entry._data?.uncompressedSize || 0;
    if (total > MAX_PACKAGE_BYTES) throw new Error('场景包解压超过 256 MB。');
  }
  const entry = zip.file('scene.json');
  if (!entry || entry._data?.uncompressedSize > 32 * 1024 * 1024)
    throw new Error('场景清单缺失或过大。');
  const scene = validateScene(JSON.parse(await entry.async('string')), { allowPackageReferences: true });
  const cache = new Map();
  for (const ref of references(scene)) {
    const file = ref.owner[ref.key];
    if (!/^media\/[0-9]+\.bin$/.test(file) || !zip.file(file))
      throw new Error('场景包缺少素材或路径无效。');
    if (!cache.has(file)) cache.set(file, await zip.file(file).async('base64'));
    ref.owner[ref.key] = `data:${ref.mime};base64,${cache.get(file)}`;
  }
  return validateScene(scene);
}
