import { open, stat } from 'node:fs/promises';

// Keep only the fields that participate in catalog folding. Embedded editor media,
// prompts, provider responses and job histories stay in their authoritative files.
export function catalogTask({ id, capabilityId, status, createdAt, updatedAt, outputs, adapter, input }) {
  if (!input || !Array.isArray(outputs)) throw new Error('Invalid catalog task.');
  const { operation, provider, characterId, actionId, diagnosticOnly, jobId, sourceTaskId, subject, name, facing, selectedDefinitionIds, project } = input;
  return { id, capabilityId, status, createdAt, updatedAt, outputs, adapter: { remoteJobId: adapter?.remoteJobId },
    input: { operation, provider, characterId, actionId, diagnosticOnly, jobId, sourceTaskId, subject, name, facing, selectedDefinitionIds,
      ...(project ? { project: { projectId: project.projectId, name: project.name, objects: (project.objects || []).map(object => ({
        definitionId: object.definitionId, displayName: object.displayName, behavior: { kind: object.behavior?.kind },
        visual: { width: object.visual?.width, height: object.visual?.height, assetId: object.visual?.assetId },
        animated: object.visual?.clips?.some(clip => clip.frames?.length),
      })) } } : {}) } };
}

export function catalogResult({ width, height, provider, model, kind, jobId, characterId, candidates, jobRecord }) {
  return { width, height, provider, model, kind, jobId, characterId,
    candidates: Array.isArray(candidates) ? candidates.map(({ candidateIndex, status }) => ({ candidateIndex, status })) : [],
    ...(jobRecord && { jobRecord: { created_at: jobRecord.created_at,
      request: { provider: jobRecord.request?.provider, motion_repair: Boolean(jobRecord.request?.motion_repair) },
      export: { candidate_index: jobRecord.export?.candidate_index },
      character: { display_name: jobRecord.character?.display_name, character_id: jobRecord.character?.character_id,
        object_id: jobRecord.character?.object_id, object_type: jobRecord.character?.object_type },
      action: { action_id: jobRecord.action?.action_id, display_name: jobRecord.action?.display_name, fps: jobRecord.action?.fps, loop: jobRecord.action?.loop },
    } }) };
}

const stamp = info => [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs].join(':');
const cache = new Map();
let totalBytes = 0;

export async function readProjection(file, maxBytes, project) {
  const current = await stat(file, { bigint: true });
  const key = project.name + ':' + file;
  const found = cache.get(key);
  if (found) {
    cache.delete(key);
    if (found.version === stamp(current)) {
      cache.set(key, found);
      return found.value;
    }
    totalBytes -= found.bytes;
  }
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > maxBytes) throw new Error('记录超过读取上限。');
    const value = project(JSON.parse(await handle.readFile('utf8')));
    const version = stamp(info);
    if (version !== stamp(await handle.stat({ bigint: true }))) throw new Error('目录记录正在更新。');
    const bytes = Buffer.byteLength(JSON.stringify(value));
    // Concurrent readers may have filled this entry while we were reading.
    totalBytes += bytes - (cache.get(key)?.bytes || 0);
    cache.set(key, { version, value, bytes });
    while (totalBytes > 16 * 1024 * 1024 || cache.size > 4096) {
      const [oldKey, old] = cache.entries().next().value;
      totalBytes -= old.bytes;
      cache.delete(oldKey);
    }
    return value;
  } finally { await handle.close(); }
}
