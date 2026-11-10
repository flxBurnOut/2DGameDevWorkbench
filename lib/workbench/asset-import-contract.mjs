import * as z from 'zod/v4';
export const assetImportInput = z
  .object({
    assetId: z.string().min(1).max(500),
    purpose: z.string().min(1).max(40),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function importPurposes(manifest, asset) {
  if (asset.attachmentOnly) return [];
  return (manifest.assetImports || []).filter((rule) =>
    rule.kinds.includes(asset.kind) && (!(asset.origin === 'map-project' || asset.mapType === 'project') || rule.id === 'map'),
  );
}
