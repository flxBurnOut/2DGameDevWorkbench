// Browser heartbeats and server validation share the same non-secret identities.
export const previewIdentityKeys = Object.freeze([
  'imageFrame', 'imageStage',
  'task', 'job', 'work', 'version', 'candidate', 'character', 'asset', 'project',
  'object', 'artTask', 'imageTask', 'imageEdit', 'imageCandidate', 'document',
  'tab', 'importAsset', 'importPurpose', 'handoff', 'origin', 'fit',
  'saved',
]);

export function previewSnapshotPath(value) {
  const url = new URL(value, 'http://workbench.local');
  for (const key of new Set(url.searchParams.keys())) {
    if (!previewIdentityKeys.includes(key)) url.searchParams.delete(key);
  }
  return url.pathname + url.search;
}

export function canonicalView(value) {
  const url = new URL(value, 'http://workbench.local');
  url.searchParams.sort();
  return url.pathname + url.search;
}
export function followDecision({ currentPath, targetPath, following, busy, editing, handled }) {
  if (!following) return 'paused';
  if (canonicalView(currentPath) === canonicalView(targetPath)) return 'displayed';
  if (handled) return 'ignore';
  if (busy) return 'busy';
  if (editing) return 'editing';
  return 'navigate';
}
