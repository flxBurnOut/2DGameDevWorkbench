import * as z from 'zod/v4';
import { documentId, point, command } from './document-contract-common.mjs';

const text = z.string().max(100000);
const tint = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const shape = z.object({ type: z.enum(['rectangle', 'circle', 'capsule']), width: z.number().min(1).max(8192), height: z.number().min(1).max(8192), radius: z.number().min(1).max(8192), offset: point }).partial().strict();
const appearance = z.object({ assetId: z.string().max(96).optional(), animation: text.optional(), staticImage: z.boolean().optional(), visible: z.boolean().optional(), solidEnabled: z.boolean().optional(), tint: tint.optional() }).strict();
const feedback = z.discriminatedUnion('type', [
  z.object({ type: z.literal('show_text'), pages: z.array(text).max(100) }).strict(),
  z.object({ type: z.literal('wait'), seconds: z.number().min(0).max(3600) }).strict(),
  z.object({ type: z.literal('play_animation'), importedTransition: z.literal(true).optional(), animation: text, waitForEnd: z.boolean() }).strict(),
  z.object({ type: z.literal('play_audio'), assetId: documentId, waitForEnd: z.boolean(), volumeDb: z.number().min(-80).max(12) }).strict(),
]);
const entry = z.object({ name: text, pages: z.array(text).max(100).optional(), appearance: appearance.optional(), feedback: z.array(feedback).max(100).optional() }).strict();
const asset = z.object({ id: documentId, name: z.string().min(1).max(240), mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mpeg']), source: z.string().min(1).max(90000000), generation: z.object({ sourceTaskId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict();
const definition = { definitionId: documentId };
export const interactableCommandSchema = z.discriminatedUnion('type', [
  command('rename', { name: z.string().min(1).max(200) }),
  command('add-object', { kind: z.enum(['inspect', 'toggle', 'pickup', 'sequence']), definitionId: documentId.optional(), name: z.string().min(1).max(200).optional() }),
  command('remove-object', definition),
  command('rename-object', { ...definition, name: z.string().min(1).max(200) }),
  command('add-asset', { asset }),
  command('import-motion-asset', { ...definition, assetId: z.string().min(1).max(500), assetRevision: z.string().regex(/^[a-f0-9]{64}$/),
    target: z.enum(['toggle-state', 'sequence-entry']), index: z.number().int().min(0).max(99),
    // Transition playback chosen at writeback; the source frames and export are unchanged.
    durations: z.array(z.number().min(0.01).max(100)).min(1).max(64).optional(), playback: z.enum(['once', 'ping_pong']).optional() }),
  command('bind-asset', { ...definition, assetId: documentId, target: z.enum(['visual', 'toggle-state', 'sequence-entry']).default('visual'), index: z.number().int().min(0).max(99).optional() }),
  command('set-visual', { ...definition, visual: z.object({ width: z.number().min(1).max(8192), height: z.number().min(1).max(8192), offset: point, scale: z.number().min(0.01).max(100), flipH: z.boolean(), flipV: z.boolean(), zIndex: z.number().min(-4096).max(4096), visible: z.boolean(), tint, idleAnimation: text, focusAnimation: text, float: z.boolean(), dot: z.boolean() }).partial().strict() }),
  command('set-shape', { ...definition, target: z.enum(['detection', 'pointer', 'solid']), shape, enabled: z.boolean().optional() }),
  command('set-activation', { ...definition, activation: z.object({ mode: z.enum(['proximity_press', 'pointer_click', 'automatic_enter', 'external_request']), action: z.string().min(1).max(100), key: z.string().min(1).max(32), cancelOnExit: z.boolean(), enabled: z.boolean() }).partial().strict() }),
  command('set-content', { ...definition, content: z.object({ prompt: text, pages: z.array(text).max(100), charactersPerSecond: z.number().min(0).max(300), promptOffset: point }).partial().strict() }),
  command('set-behavior', { ...definition, behavior: z.object({ kind: z.enum(['inspect', 'toggle', 'pickup', 'sequence']), repeat: z.boolean(), initialToggle: z.boolean(), states: z.array(entry).length(2), entries: z.array(entry).min(1).max(100), onEnd: z.enum(['stop', 'loop', 'stay_last']) }).partial().strict() }),
  command('set-feedback', { ...definition, feedback: z.array(feedback).max(100) }),
  command('set-completion', { ...definition, completion: z.enum(['remain', 'hide', 'free']), cooldownSeconds: z.number().min(0).max(3600).optional() }),
]);
