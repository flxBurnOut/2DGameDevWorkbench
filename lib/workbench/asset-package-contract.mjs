import { z } from 'zod';

export const ASSET_PACKAGE_LIMITS = Object.freeze({
  uploadBytes: 768 * 1024 * 1024,
  containerExpandedBytes: 768 * 1024 * 1024,
  // A maximal download may contain STORE source ZIPs, plus the same source
  // inside a Godot attachment. Count their known inner layers separately.
  expandedBytes: 3 * 1024 * 1024 * 1024,
  memberBytes: 512 * 1024 * 1024,
  jsonBytes: 32 * 1024 * 1024,
  files: 24000,
  candidates: 100,
  nesting: 3,
  inspectionLifetimeMs: 24 * 60 * 60 * 1000,
});
export const packageKinds = ['character', 'prop', 'animation', 'map', 'interactable', 'scene'];
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIdentity = z.union([z.string().min(1).max(1000), z.record(z.unknown())]);
export const assetArchiveManifestSchema = z.object({
  format: z.literal('forge-asset-archive'),
  version: z.literal(1),
  packageId: z.string().min(1).max(200),
  exportedAt: z.string().min(1).max(100),
  entries: z.array(z.object({
    key: z.string().min(1).max(500),
    kind: z.enum(packageKinds),
    mapType: z.enum(['project', 'image']).optional(),
    title: z.string().min(1).max(1000).optional(),
    label: z.string().min(1).max(1000).optional(),
    sourceIdentity: sourceIdentity.optional(),
    sourceVersion: z.union([z.string().max(500), z.number().finite(), z.null()]).optional(),
    metadata: z.record(z.unknown()).default({}),
    provenance: z.record(z.unknown()).default({}),
    files: z.array(z.object({
      path: z.string().min(1).max(500),
      role: z.string().min(1).max(100),
      bytes: z.number().int().nonnegative().max(ASSET_PACKAGE_LIMITS.memberBytes),
      mime: z.string().min(1).max(100),
      sha256,
    }).passthrough()).min(1).max(22000),
  }).passthrough()).min(1).max(ASSET_PACKAGE_LIMITS.candidates),
}).passthrough();
const inspectionId = z.string().regex(/^inspection-[a-f0-9]{32}$/);
export const packageCommandId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export const packageCommitSchema = z.object({
  commandId: packageCommandId,
  inspectionIds: z.array(inspectionId).max(100).optional(),
  selections: z.array(z.object({
    inspectionId,
    candidateId: z.string().regex(/^candidate-[a-f0-9]{24}$/),
    parameters: z.object({
      fps: z.number().finite().positive().max(1000).optional(),
      loop: z.boolean().optional(),
      definitionIds: z.array(z.string().min(1).max(100)).min(1).max(200).optional(),
    }).strict().default({}),
  }).strict()).min(1).max(100),
}).strict();
