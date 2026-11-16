import * as z from 'zod/v4';
import { documentId, commandId, revision } from './document-contract-common.mjs';
import { interactableCommandSchema } from './interactable-document-contract.mjs';
import { simulationEventsSchema } from '../../features/editor-documents/simulation-replay.mjs';

export { documentId } from './document-contract-common.mjs';
export { interactableCommandSchema } from './interactable-document-contract.mjs';

const mutation = { documentId, expectedRevision: revision, commandId };
export const documentInputs = {
  documents: z.object({ kind: z.literal('interactable').optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }).strict(),
  'document-get': z.object({ documentId, revision: revision.optional(), metadataOnly: z.boolean().optional() }).strict(),
  'document-create': z.object({ kind: z.literal('interactable'), documentId: documentId.optional(), commandId, name: z.string().min(1).max(200).optional(), content: z.unknown().optional() }).strict(),
  'document-save': z.object({ ...mutation, content: z.unknown() }).strict(),
  'document-apply': z.object({ ...mutation, commands: z.array(interactableCommandSchema).min(1).max(100) }).strict(),
  'document-restore': z.object({ ...mutation, revision }).strict(),
  'document-validate': z.object({ documentId, revision: revision.optional() }).strict(),
  'document-simulate': z.object({ documentId, revision: revision.optional(), events: simulationEventsSchema, expectEvents: z.array(z.object({ name: z.enum(['focus_entered', 'focus_exited', 'interaction_started', 'interaction_finished', 'interaction_completed', 'interaction_cancelled', 'picked_up', 'toggled', 'sequence_advanced', 'play_animation', 'play_audio', 'state_changed']), instanceId: documentId.optional(), count: z.number().int().min(1).max(1000).default(1) }).strict()).max(100).optional(), expectStates: z.array(z.object({ instanceId: documentId, completed: z.boolean().optional(), toggleState: z.boolean().optional(), sequenceIndex: z.number().int().min(0).max(100).optional(), successCount: z.number().int().min(0).max(1000000).optional(), enabled: z.boolean().optional(), visible: z.boolean().optional(), solidEnabled: z.boolean().optional() }).strict()).max(200).optional() }).strict(),
  'document-motion-bindings': z.object({ documentId, definitionId: documentId.optional() }).strict(),
  'document-adopt-image': z.object({ ...mutation, sourceTaskId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), definitionId: documentId.optional() }).strict(),
};
export const documentTools = [
  ['workbench_list_documents', 'documents', 'List saved shared interactable documents. Browser drafts must be saved before they are visible. No generation or export.'],
  ['workbench_get_document', 'document-get', 'Read a saved document and its stable IDs, exact revision and self-contained content. Optional revision reads an immutable historical snapshot.'],
  ['workbench_create_document', 'document-create', 'Create a shared interactable document from valid existing content or an empty template. commandId makes retries idempotent. No generation or export.'],
  ['workbench_save_document', 'document-save', 'Save complete validated document content, preserving document identity. Requires expectedRevision and an idempotency commandId. Prefer apply_document_commands for typed AI edits.'],
  ['workbench_apply_document_commands', 'document-apply', 'Apply a single-document transaction of documented typed interactable commands. Read the document first and supply expectedRevision plus a unique commandId; all commands commit together or none do. Assets are snapshotted; no eval, generation or export.'],
  ['workbench_restore_document', 'document-restore', 'Restore a saved historical revision as a new current revision. Requires expectedRevision and commandId; history is retained.'],
  ['workbench_validate_document', 'document-validate', 'Validate a saved document at an exact revision, including embedded media. Read-only; no generation, export or Godot engine validation.'],
  ['workbench_simulate_document', 'document-simulate', 'Replay up to 200 validated inputs on a saved interactable revision. Optional expectEvents checks emitted events; expectStates checks exact instance toggle/completion/count/enabled/visible/solidEnabled fields. Returns chronological events and effective states. No expectations means passed only describes an error-free bounded replay, not behavior acceptance. No document mutation or Godot physics claim; standalone interactable instance IDs are definition IDs.'],
  ['workbench_get_motion_bindings', 'document-motion-bindings', 'Read-only: for each toggle state and sequence entry, report the state image and entry transition last bound with import-motion-asset (work, revision, candidate, stage, frame hashes, derivation) and whether the current content still uses it. No mutation.'],
  ['workbench_adopt_document_image', 'document-adopt-image', 'Explicitly adopt one completed image-assets task into a document using its exact task ID and SHA256. Prop adoption needs an interactable definitionId. Requires expectedRevision and commandId. No generation, export or replacement of state-specific art.'],
];
