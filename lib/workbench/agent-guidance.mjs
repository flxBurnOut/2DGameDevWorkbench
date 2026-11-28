import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function guidanceTopics(manifest) {
  return (manifest.agentAssets.guidanceTopics || []).map(
    ({ id, title, source, capabilityId }) => ({
      id, title, source, ...(capabilityId ? { capabilityId } : {}),
    }),
  );
}

// Only manifest-registered topics are readable; caller input is never a file path.
export async function readGuidance(repositoryRoot, manifest, { topic = 'overview' } = {}) {
  if (typeof topic !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(topic)) {
    throw new Error('Invalid guidance topic. Read the topic index first.');
  }
  const topics = guidanceTopics(manifest);
  const selected = topic === 'overview'
    ? { source: manifest.agentAssets.conversationGuide }
    : topics.find(entry => entry.id === topic);
  if (!selected) throw new Error(`Unknown guidance topic: ${topic}. Read the topic index first.`);

  const root = await realpath(repositoryRoot);
  const file = await realpath(path.resolve(root, selected.source));
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Guidance source must stay inside the repository.');
  }
  const text = await readFile(file, 'utf8');
  return {
    topic, source: selected.source, text,
    sha256: createHash('sha256').update(text).digest('hex'),
    ...(topic === 'overview' ? { topics } : {}),
    createsTask: false,
    providerCalled: false,
  };
}
