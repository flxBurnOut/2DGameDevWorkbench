import * as z from 'zod/v4';
export const assetImportInput = z
  .object({
    assetId: z.string().min(1).max(500),
    purpose: z.string().min(1).max(40),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const interactableImageMimes = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export function imageMimeFromHeader(bytes) {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const header = new TextDecoder().decode(bytes);
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  return null;
}
export function importPurposeIssue(asset, purpose) {
  if (asset.attachmentOnly) return '此素材仅保留原始附件，不能用于所选导入方式。';
  if (purpose !== 'image' || !['prop', 'character'].includes(asset.kind) || interactableImageMimes.includes(asset.primaryMime)) return '';
  if (asset.primaryMime === 'image/gif') return 'GIF 可预览和下载；交互物外观目前仅支持 PNG、JPG、WebP。';
  if (!asset.primaryMime) return '此素材的原图格式尚未确认；交互物外观目前仅支持 PNG、JPG、WebP，请刷新素材来源后重试。';
  return '交互物外观目前仅支持 PNG、JPG、WebP；此原图仍保留在资产库。';
}
export function importPurposes(manifest, asset) {
  if (asset.attachmentOnly) return [];
  return (manifest.assetImports || []).filter((rule) =>
    rule.kinds.includes(asset.kind) && !importPurposeIssue(asset, rule.id),
  );
}
