// Scene collisions may override the imported map without changing its source ZIP.
// Keep the original polygons so image/extension readers can still prove provenance.
export function sourceMapCollisions(map) {
  return map.collisionOverride?.sourceCollisions ?? map.collisions;
}

export function updateMapCollisionOverride(before, after) {
  const previous = before?.map, current = after?.map;
  if (!previous || !current || previous.source !== current.source) return;
  const baseline = sourceMapCollisions(previous);
  if (JSON.stringify(current.collisions) === JSON.stringify(baseline)) {
    delete current.collisionOverride;
  } else if (previous.collisionOverride || JSON.stringify(previous.collisions) !== JSON.stringify(current.collisions)) {
    current.collisionOverride = { sourceCollisions: structuredClone(baseline) };
  }
}
