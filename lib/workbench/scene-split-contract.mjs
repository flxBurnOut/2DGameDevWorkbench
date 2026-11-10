import * as z from 'zod/v4';
import { mapSplitSpecsSchema as specs } from './map-split-spec.mjs';

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const revision = z.number().int().positive();
const coordinate = z.number().min(-1e7).max(1e7);
const point = z.object({ x: coordinate, y: coordinate }).strict();
const rect = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: revision.max(30000),
    height: revision.max(30000),
  })
  .strict();
const command = {
  documentId: id,
  expectedRevision: revision,
  commandId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
};
const polygons = z.array(z.array(point).min(3).max(10000)).max(1024);
const transfer = z.array(z.number().int().min(0).max(9999)).max(10000);
const remainderKind = z.enum(['surface', 'background']);
const binding = { candidateId: id, candidateRevision: revision };
const matching = {
  matches: z
    .array(z.object({ oldId: id, newId: id }).strict())
    .max(2000)
    .optional(),
  resolutions: z
    .array(
      z
        .object({
          conflictId: z.string().min(1).max(350),
          choice: z.enum(['current', 'incoming', 'delete']),
        })
        .strict(),
    )
    .max(10000)
    .optional(),
};
export const sceneSplitInputs = {
  'scene-split-prepare': z
    .object({
      ...command,
      mode: z.enum(['auto', 'local', 'vision', 'sam']).default('local'),
      specs: specs.optional(),
      remainderKind: remainderKind.optional(),
      useSam: z.boolean().optional(),
    })
    .strict(),
  'scene-split-get': z
    .object({
      documentId: id,
      candidateId: id.optional(),
      candidateRevision: revision.optional(),
      includeSpecs: z.boolean().optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: revision.max(100).default(20),
    })
    .strict(),
  'scene-split-revise': z
    .object({
      ...command,
      ...binding,
      ...matching,
      specs: specs.optional(),
      upsert: specs.optional(),
      remove: z.array(id).max(2000).optional(),
      remainderKind: remainderKind.optional(),
      review: z
        .object({
          note: z.string().trim().min(1).max(4000),
          elementIds: z.array(id).min(1).max(2000),
        })
        .strict()
        .optional(),
    })
    .strict(),
  'scene-split-inspect': z
    .object({
      documentId: id,
      expectedRevision: revision.optional(),
      candidateId: id.optional(),
      candidateRevision: revision.optional(),
      view: z
        .enum(['source', 'candidate', 'element', 'part', 'mask', 'conflict'])
        .default('source'),
      elementId: id.optional(),
      partId: id.optional(),
      crop: rect.optional(),
      conflictId: id.optional(),
      side: z.enum(['baseline', 'current', 'incoming']).optional(),
      maxEdge: revision.max(2048).default(1024),
      background: z
        .enum(['transparent', 'black', 'white', 'magenta'])
        .default('transparent'),
    })
    .strict(),
  'scene-split-adopt': z.object({ ...command, ...binding }).strict(),
  'scene-split-patch': z
    .object({
      ...command,
      candidateId: id,
      elementId: id,
      changes: z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          x: coordinate.optional(),
          y: coordinate.optional(),
          positionMode: z.enum(['relative', 'world']).optional(),
          hidden: z.boolean().optional(),
          included: z.boolean().optional(),
          locked: z.boolean().optional(),
          remove: z.literal(true).optional(),
          collision: z
            .object({
              enabled: z.boolean(),
              polygons: polygons.optional(),
              mapIndices: transfer.optional(),
            })
            .strict()
            .optional(),
          part: z
            .object({
              id,
              enabled: z.boolean().optional(),
              plane: z.enum(['back', 'front']).optional(),
              remove: z.literal(true).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
};
export const sceneSplitTools = [
  [
    'workbench_prepare_map_split',
    'scene-split-prepare',
    'Freeze the saved scene map and create a shared unverified split candidate. auto uses local SAM automatic proposals when installed, with a reported local pixel fallback. local uses deterministic pixel analysis or explicit specs, sam uses prompted local SAM, and vision explicitly requests one configured visual plan. Query the original candidate or command after interruption.',
  ],
  [
    'workbench_get_map_split',
    'scene-split-get',
    'List a scene’s split candidates or read an exact candidate/revision, elements, conflicts, processing receipts and verification. includeSpecs returns editable map-pixel masks. No inference.',
  ],
  [
    'workbench_inspect_map_split',
    'scene-split-inspect',
    'See only the map source, candidate, named element, part or ownership mask as an image. Optional crop uses original canvas coordinates. Compare on black, white and saturated backgrounds.',
  ],
  [
    'workbench_revise_map_split',
    'scene-split-revise',
    'Refine frozen map ownership atomically using a replacement specs list or selected upsert/remove operations. SAM revisions return running with a durable execution identity; poll the same candidate and resume with the original commandId and parameters after interruption. Resolve migration matches/conflicts or separately record a check of exact element IDs. Read latest candidate revision first.',
  ],
  [
    'workbench_adopt_map_split',
    'scene-split-adopt',
    'Adopt the exact candidate revision into the saved scene. Checks map identity, scene revision, locks and unresolved conflicts. Does not modify the source map project.',
  ],
  [
    'workbench_edit_map_split_element',
    'scene-split-patch',
    'Edit one adopted scene-owned map element by stable ID: placement, visibility, collision polygons and transfer, effect or front/back plane. For texture edits inspect scene-split-part using the shared image editor.',
  ],
];
