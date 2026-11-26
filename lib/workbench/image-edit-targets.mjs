import { motionFrameSource } from './image-edit-target-motion.mjs';
import { motionScope } from './image-edit-contract.mjs';
import * as z from 'zod/v4';
import { getDocument, listDocuments } from './editor-documents.mjs';
import { decodeImageTarget, digest, encodeImageTarget, failure, hash, id, refFor, sha, taskId } from './image-edit-target-common.mjs';
import { interactableImageTargetSource } from './image-edit-target-interactables.mjs';
import { imageTask, taskImageTargetSource } from './image-edit-target-tasks.mjs';
export { checkTarget, encodeImageTarget, decodeImageTarget } from './image-edit-target-common.mjs';
export { imageTargetRefSchema } from './image-edit-contract.mjs';

// Each source owns target-kind-specific reads, enumeration, and adoption.
// Document sources share one listing pass so pagination and diagnostics stay stable.
const targetSources = [interactableImageTargetSource, taskImageTargetSource,motionFrameSource];
const documentSources = targetSources.filter(source => source.documentKind);
const targetKinds = targetSources.flatMap(source => source.kinds);
const sourceFor = ref => targetSources.find(source => source.kinds.includes(ref.kind));

export async function readImageTarget(root, manifest, targetIdOrRef) {
  const ref = refFor(targetIdOrRef);
  return sourceFor(ref).read(root, manifest, ref);
}

async function listDocumentTargets(root, manifest, scope, add, issues) {
  const sources = documentSources.filter(source => !scope.kind || source.kinds.includes(scope.kind));
  if (!sources.length) return;
  let offset = 0;
  do {
    const page = await listDocuments(root, manifest, { limit: 200, offset });
    for (const record of page.documents) {
      if (scope.documentId && scope.documentId !== record.id) continue;
      const source = sources.find(source => source.documentKind === record.kind);
      if (!source) continue;
      try {
        const { document } = await getDocument(root, manifest, { documentId: record.id });
        source.addDocumentRefs(document, add);
      } catch (error) { issues.push({ source: 'document', id: record.id, message: error.message }); }
    }
    offset = page.nextOffset;
  } while (offset !== null && offset !== undefined);
}

export async function listImageTargets(root, manifest, input = {}) {
  const parsed = z.object({ scope: z.object({ kind: z.enum(targetKinds).optional(), ...z.object(motionScope).partial().shape, documentId: id.optional(), taskId: taskId.optional() }).strict().optional(), query: z.string().max(2000).default(''), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }).strict().parse(input);
  const scope = parsed.scope || {}; const refs = []; const issues = [];
  const add = (ref, name) => {
    if (scope.kind && ref.kind !== scope.kind) return;
    if(scope.workId && ref.workId!==scope.workId)return;
    if (scope.documentId && ref.documentId !== scope.documentId) return;
    if (scope.taskId && ref.taskId !== scope.taskId) return;
    if (parsed.query && !`${name} ${JSON.stringify(ref)}`.toLowerCase().includes(parsed.query.toLowerCase())) return;
    refs.push({ ref, name });
  };
  let documentsListed = false;
  for (const source of targetSources) {
    if (source.documentKind) {
      if (!documentsListed) await listDocumentTargets(root, manifest, scope, add, issues);
      documentsListed = true;
    } else if (!scope.kind || source.kinds.includes(scope.kind)) await source.list(root, manifest, scope, add, issues);
  }
  refs.sort((a, b) => encodeImageTarget(a.ref).localeCompare(encodeImageTarget(b.ref)));
  const targets = [];
  for (const { ref } of refs.slice(parsed.offset, parsed.offset + parsed.limit)) try {
    const { bytes: _bytes, ...target } = await readImageTarget(root, manifest, ref);
    targets.push(target);
  } catch (error) { issues.push({ source: ref.kind, targetId: encodeImageTarget(ref), message: error.message }); }
  return { targets, total: refs.length, nextOffset: parsed.offset + parsed.limit < refs.length ? parsed.offset + parsed.limit : null, ...(issues.length ? { issues } : {}) };
}

export async function applyImageTarget(root, manifest, input) {
  const parsed = z.object({ targetId: z.string().min(1).max(2048), expectedRevision: z.union([z.number().int().positive(), sha]), expectedSha256: sha, expectedSlotFingerprint: sha.optional(), frameRegion:z.object({frame:z.number().int(),source_sha256:sha,spans:z.array(z.object({start:z.number().int().nonnegative(),length:z.number().int().positive()})).min(1).max(8192)}).optional(), bytes: z.custom(value => Buffer.isBuffer(value) || value instanceof Uint8Array), candidate: z.object({ taskId, sha256: sha }).strict(), commandId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/), name: z.string().min(1).max(200).optional() }).strict().parse(input);
  const ref = decodeImageTarget(parsed.targetId);
  const candidate = await imageTask(root, manifest, parsed.candidate.taskId);
  const candidateBytes = Buffer.from(parsed.bytes);
  if (hash(candidateBytes) !== parsed.candidate.sha256 || candidate.info.sha256 !== parsed.candidate.sha256 || !candidateBytes.equals(candidate.bytes)) throw failure('采用图片与候选任务的真实 PNG 不一致。', 409, 'IMAGE_CANDIDATE_CHANGED');
  const fingerprint = digest({ targetId: parsed.targetId, expectedRevision: parsed.expectedRevision, expectedSha256: parsed.expectedSha256, expectedSlotFingerprint: parsed.expectedSlotFingerprint, candidate: parsed.candidate, name: parsed.name });
  const source = sourceFor(ref);
  if (source.integerRevision && !Number.isSafeInteger(parsed.expectedRevision)) throw failure('工程图片采用需要整数版本。');
  return source.apply(root, manifest, ref, parsed, candidate, candidateBytes, fingerprint);
}
