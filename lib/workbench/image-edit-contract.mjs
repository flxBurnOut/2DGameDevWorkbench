import { MAX_PALETTE_PAIRS } from '../../features/image-edit/edit-intent.mjs';
import { metalPanelOperationSchema } from '../../features/image-edit/metal-panel.mjs';
import * as z from 'zod/v4';

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.:-]+$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.union([z.number().int().positive(), sha]);
const commandId = id;
const point = z.object({ x: z.number().int().min(0).max(3840), y: z.number().int().min(0).max(3840) }).strict();
const rgba = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);
export const imageTargetRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('map-layer'), projectId: id, tileKey: z.string().min(1).max(100), layer: z.enum(['overall', 'surface', 'object', 'black', 'white']) }).strict(),
  z.object({ kind: z.literal('interactable'), documentId: id, definitionId: id, slot: z.enum(['visual', 'toggle-state', 'sequence-entry']).default('visual'), index: z.number().int().min(0).max(99).optional() }).strict(),
  z.object({ kind: z.literal('image-task'), taskId: id }).strict(),
  z.object({ kind: z.literal('scene-layer'), documentId: id, layerId: id }).strict(),
  z.object({ kind: z.literal('scene-instance'), documentId: id, instanceId: id, slot: z.enum(['visual', 'toggle-state', 'sequence-entry']).default('visual'), index: z.number().int().min(0).max(99).optional() }).strict(),
]);
export const imageRegionSpecSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }).strict(),
  z.object({ type: z.literal('rectangle'), x: point.shape.x, y: point.shape.y, width: z.number().int().min(1).max(3840), height: z.number().int().min(1).max(3840) }).strict(),
  z.object({ type: z.literal('polygon'), points: z.array(point).min(3).max(1024) }).strict(),
  z.object({ type: z.literal('mask-runs'), spans: z.array(z.object({ startPixel: z.number().int().min(0).max(8294399), length: z.number().int().min(1).max(8294400) }).strict()).max(65536) }).strict().refine(value => {
    let end = 0, total = 0;
    for (const span of value.spans) {
      total += span.length;
      if (span.startPixel < end || span.startPixel + span.length > 8294400 || total > 8294400) return false;
      end = span.startPixel + span.length;
    }
    return true;
  }, 'Mask runs must be sorted, disjoint and within the image pixel limit.'),
  z.object({ type: z.literal('alpha-bounds'), threshold: z.number().int().min(0).max(255).default(1) }).strict(),
  z.object({ type: z.literal('alpha-selection'), minAlpha: z.number().int().min(0).max(255).default(1), maxAlpha: z.number().int().min(0).max(255).default(255) }).strict(),
  z.object({ type: z.literal('connected-color'), x: point.shape.x, y: point.shape.y, tolerance: z.number().int().min(0).max(255).default(0) }).strict(),
  z.object({ type: z.literal('named'), regionId: id }).strict(),
]);
const rgb = z.string().regex(/^#[a-f0-9]{6}$/i);
const palettePairs = z.array(z.object({ from: rgb, to: rgb }).strict()).min(1).max(MAX_PALETTE_PAIRS)
  .refine(pairs => new Set(pairs.map(pair => pair.from.toLowerCase())).size === pairs.length, 'Duplicate palette source color.');
export const imageEditOperationSchema = z.discriminatedUnion('type', [
  metalPanelOperationSchema,
  z.object({ type: z.literal('clean-alpha'), threshold: z.number().int().min(0).max(16).default(1) }).strict(),
  z.object({ type: z.literal('palette-map'), pairs: palettePairs }).strict(),
  z.object({ type: z.literal('replace-color'), from: z.string().regex(/^#[a-fA-F0-9]{6}$/), to: z.string().regex(/^#[a-fA-F0-9]{6}$/) }).strict(),
  z.object({ type: z.literal('fill'), x: point.shape.x, y: point.shape.y, rgba }).strict(),
  z.object({ type: z.literal('erase') }).strict(),
  z.object({ type: z.literal('translate'), dx: z.number().int().min(-3839).max(3839), dy: z.number().int().min(-3839).max(3839) }).strict(),
  z.object({ type: z.literal('restore-region'), candidateVersion: id }).strict(),
  z.object({ type: z.literal('pixel-patch'), baseRgbaSha256: sha, spans: z.array(z.object({ startPixel: z.number().int().nonnegative(), beforeRgbaBase64: z.string().min(4).max(700000), afterRgbaBase64: z.string().min(4).max(700000) }).strict()).min(1).max(65536) }).strict(),
  z.object({ type: z.literal('ai-edit'), prompt: z.string().trim().min(1).max(12000), references: z.array(z.string().min(1).max(60000000)).max(8).optional() }).strict(),
]);
const targetFields = { targetId: z.string().min(1).max(4096).optional(), target: imageTargetRefSchema.optional() };
const exactTarget = value => Boolean(value.targetId) !== Boolean(value.target);
const guard = { expectedRevision: revision, expectedSha256: sha };
const constraints = z.object({ preserveOutsideRegion: z.literal(true).default(true), preserveDimensions: z.literal(true).default(true), preserveAlpha: z.boolean().default(false) }).strict();
export const imageEditInputs = {
  'image-panel-suggest': z.object({ ...targetFields, ...guard, editId: id, expectedEditRevision: z.number().int().positive(), baseCandidateVersion: id, regionRef: id,
    splitRows: z.array(z.number().int().min(0).max(1023)).max(15), points: z.array(point.extend({ include: z.boolean() }).strict()).max(32), cellSize: z.number().int().min(1).max(16).default(1) }).strict().refine(exactTarget, 'Supply exactly one targetId or target.'),
  'image-inspect': z.object({ ...targetFields, intent: z.string().trim().min(1).max(12000).optional(), scope: z.object({ kind: z.enum(['map-layer', 'interactable', 'image-task', 'scene-layer', 'scene-instance']).optional(), projectId: id.optional(), documentId: id.optional(), taskId: id.optional() }).strict().optional(), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).default(0), view: z.enum(['metadata', 'source', 'candidate', 'diff', 'context']).default('metadata'), editId: id.optional(), candidateVersion: id.optional(), includePixels: z.boolean().default(false) }).strict(),
  'image-resolve': z.object({ ...targetFields, ...guard, region: imageRegionSpecSchema, saveAs: z.string().trim().min(1).max(80).optional(), commandId: commandId.optional() }).strict().refine(exactTarget, 'Supply exactly one targetId or target.').refine(value => !value.saveAs || value.commandId, 'Saving a named region requires commandId.'),
  'image-edit': z.object({ ...targetFields, ...guard, regionRef: id, operation: imageEditOperationSchema, constraints: constraints.default({ preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: false }), commandId, editId: id.optional(), expectedEditRevision: z.number().int().positive().optional(), baseCandidateVersion: id.optional(), name: z.string().trim().min(1).max(80).optional(), previewPolicy: z.enum(['auto', 'user-declined', 'user-dismissed', 'host-unavailable']).optional() }).strict().refine(exactTarget, 'Supply exactly one targetId or target.'),
  'image-apply': z.object({ editId: id, candidateVersion: id, ...guard, commandId }).strict(),
  'image-session-create': z.object({ ...targetFields, ...guard, commandId }).strict().refine(exactTarget, 'Supply exactly one targetId or target.'),
  'image-session-get': z.object({ editId: id, comparison: z.object({ previewWidth: z.number().int().min(1).max(3840).optional() }).strict().optional(), includePixels: z.boolean().default(false), candidateVersion: id.optional() }).strict(),
};
export const imageEditTools = [
  ['workbench_suggest_panel_region', 'image-panel-suggest', 'Suggest a board-face region inside a frozen selection using the optional installed local SAM worker. splitRows and point coordinates are relative to the original selection bounding box (maximum 1024 per side). Review and correct the suggestion before editing. No candidate, adoption or external provider call.'],
  ['workbench_inspect_image_target', 'image-inspect', 'Discover saved image targets or inspect an exact target, immutable source, supported operations and preview. For metadata of one target, intent previews a route without submitting: exact #RRGGBB -> #RRGGBB pairs use local operations, visual descriptions suggest ai-edit. Never selects an ambiguous match or reads browser-only drafts.'],
  ['workbench_resolve_image_region', 'image-resolve', 'Resolve a named, geometric, alpha or connected-color region against an exact image version. Optional saveAs explicitly saves a named region with commandId. No model call or source mutation.'],
  ['workbench_edit_image_region', 'image-edit', 'Create a versioned candidate from a resolved region. Use palette-map with 1–64 unique {from,to} RGB pairs for simultaneous exact replacements. Local operations never call a provider; explicit ai-edit uses GPT Image 2.5 on an immutable full-size base and mask. AI requires supported original dimensions. Optional preserveAlpha=true restores every Alpha byte from the selected edit base after generation, disables alpha cleanup and verifies the delivered PNG. Requires source guards, session revision/base and persistent commandId; duplicate requests query the same task. Never adopts automatically.'],
  ['workbench_apply_image_candidate', 'image-apply', 'Adopt an exact candidate, or candidateVersion=source to restore this session\'s immutable original image. Scene-instance adoption derives one material and rebinds only that instance; scene-layer adoption requires a proven pinned source mapping and updates its embedded ZIP atomically. Requires current target guards and a known session binding; preserves unrelated document changes. Source restoration creates one durable local task per command, never a model call.'],
  ['workbench_get_image_edit', 'image-session-get', 'Read a saved edit session, candidate history and task identities. Optional candidateVersion=source or an exact candidate selects one immutable pixel view. Request comparison:{} with a specific completed candidateVersion to see its immutable before and after at placement scale. For images without a placement, set comparison.previewWidth (default 64). No generation or adoption.'],
];
