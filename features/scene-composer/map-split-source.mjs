import { mapSplitDeletedCollisionOwners } from './map-split.mjs';

// Shared by browser edits, typed commands and full document saves. A changed
// source layer must not leave the old derived artwork or collision indices live.
export function updateSplitSourceState(before, after) {
  const split = after?.mapSplit;
  const old = before?.mapSplit;
  if (!old || !split || old.candidateId !== split.candidateId || split.stale)
    return;
  const previous = before.map,
    current = after.map;
  if (
    !previous ||
    !current ||
    !Array.isArray(current.layers) ||
    !Array.isArray(after.order)
  )
    return;
  const layers = (scene, map) => {
    const byId = new Map(
      map.layers.filter((l) => l.included).map((l) => [l.id, l]),
    );
    return scene.order.map((id) => byId.get(id)).filter(Boolean);
  };
  const left = layers(before, previous),
    right = layers(after, current);
  const transferred =
    split.elements.some((e) => e.collision.mapIndices.length) ||
    mapSplitDeletedCollisionOwners(split).some(
      (entry) => entry.mapIndices.length,
    );
  if (
    previous.source !== current.source ||
    left.length !== right.length ||
    left.some(
      (a, i) =>
        a.id !== right[i].id ||
        a.source !== right[i].source ||
        a.width !== right[i].width ||
        a.height !== right[i].height,
    ) ||
    (transferred &&
      JSON.stringify(previous.collisions) !==
        JSON.stringify(current.collisions))
  ) {
    split.stale = true;
    split.review = 'unverified';
    return;
  }
  // When the whole map is translated, the current world pose becomes the
  // reference for a later migration of an explicitly world-pinned object.
  split.origin = {
    x: current.origin.x + current.offset.x,
    y: current.origin.y + current.offset.y,
  };
  if (
    old.candidateRevision === split.candidateRevision &&
    old.review === 'reviewed' &&
    split.review === 'reviewed' &&
    (JSON.stringify(old.elements) !== JSON.stringify(split.elements) ||
      JSON.stringify(before.order) !== JSON.stringify(after.order))
  )
    split.review = 'unverified';
}
