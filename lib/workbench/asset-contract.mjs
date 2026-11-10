import * as z from 'zod/v4';
const id = z.string().min(1).max(500);
export const ASSET_KINDS = ['character', 'prop', 'animation', 'map', 'interactable', 'scene'];
export const assetInputs = {
  assets: z
    .object({
      query: z.string().max(500).optional(),
      scope: z.enum(['active', 'trashed']).default('active'),
      kind: z.enum(ASSET_KINDS).optional(),
      mapType: z.enum(['project', 'image']).optional(),
      purposes: z.preprocess((value) => typeof value === 'string' ? value.split(',').filter(Boolean) : value,
        z.array(z.enum(['map', 'interactable', 'scene', 'image', 'animation'])).min(1).max(5).optional()),
      target: z.string().min(1).max(100).optional(),
      characterId: id.optional(),
      actionId: id.optional(),
      candidateIndex: z.number().int().min(1).max(1000).optional(),
      candidateCount: z.number().int().min(1).max(1000).optional(),
      status: z.string().max(80).optional(),
      availability: z.enum(['available', 'missing', 'unknown']).optional(),
      sortBy: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
      limit: z.number().int().min(1).max(100).default(24),
      offset: z.number().int().min(0).default(0),
      snapshot: id.optional(),
    })
    .strict(),
  'asset-manage': z.object({ operation: z.enum(['trash', 'restore']), assetIds: z.array(id).min(1).max(100) }).strict(),
  asset: z.object({ assetId: id }).strict(),
  'asset-manifest': z
    .object({
      assetIds: z.array(id).min(1).max(100),
      projectName: z.string().min(1).max(200).default('游戏资产交接'),
    })
    .strict(),
};
export const assetTools = [
  [
    'workbench_list_assets',
    'assets',
    'List durable artwork, not tasks. Maps include complete projects and saved image assets; mapType=project|image narrows them without hiding legacy IDs. Defaults to active assets; scope=trashed reads the recoverable asset recycle bin. Filter character/action/candidate count/index and sort by creation time for latest generation. One animation candidate is one asset. Follow nextOffset with snapshot; query is a name keyword, not a whole natural-language instruction. Browser-only drafts are not accessible here. Read-only, no generation.',
  ],
  [
    'workbench_get_asset',
    'asset',
    'Inspect one exact assetId from list_assets. Returns dimensions, candidate identity, verified file hashes, source task links, missing-file issues and exact preview/editor links. Does not approve, export or open a browser.',
  ],
  [
    'workbench_get_asset_manifest',
    'asset-manifest',
    'Build a handoff manifest and Markdown from explicit existing assetIds, with file hashes, source relationships and unresolved readiness issues. Returns data only; creates no tasks, copies no source files, and does not modify a game project or validate its engine.',
  ],
];
