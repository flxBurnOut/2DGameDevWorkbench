import { z } from 'zod';

const safeId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const coordinate = z.number().finite().min(-1e7).max(1e7);
const point = z.object({ x: coordinate, y: coordinate });
const polygon = z.array(point).min(3).max(10000);
const pngSource = z.string().min(1).max(90_000_000);
export const mapSplitPartSchema = z.object({
  id: safeId,
  role: z.enum(['art', 'effect']),
  plane: z.enum(['back', 'front']),
  x: coordinate,
  y: coordinate,
  width: z.number().int().positive().max(30000),
  height: z.number().int().positive().max(30000),
  source: pngSource,
  mask: pngSource.optional(),
  enabled: z.boolean(),
});
export const mapSplitElementSchema = z.object({
  id: safeId,
  name: z.string().max(200),
  kind: z.enum(['object', 'background', 'surface']),
  x: coordinate,
  y: coordinate,
  positionMode: z.enum(['relative', 'world']),
  hidden: z.boolean(),
  locked: z.boolean(),
  included: z.boolean(),
  parts: z.array(mapSplitPartSchema).max(128),
  collision: z.object({
    enabled: z.boolean(),
    polygons: z.array(polygon).max(1000),
    mapIndices: z.array(z.number().int().nonnegative().max(9999)).max(10000),
  }),
  sourceKey: z.string().min(1).max(300).optional(),
});
const resolutionSchema = z.object({
  conflictId: safeId,
  choice: z.enum(['current', 'incoming', 'delete']),
});
export const mapSplitSchema = z.object({
  version: z.literal(1),
  candidateId: safeId,
  candidateRevision: z.number().int().positive().optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
  origin: point,
  review: z.enum(['unverified', 'reviewed']),
  stale: z.boolean(),
  baseline: z.array(mapSplitElementSchema).max(4000),
  elements: z.array(mapSplitElementSchema).max(4000),
  conflicts: z
    .array(
      z.object({
        id: safeId,
        elementId: safeId,
        field: z.string().min(1).max(300),
        reason: z.string().min(1).max(100),
        baseline: z.unknown().optional(),
        current: z.unknown().optional(),
        incoming: z.unknown().optional(),
        candidates: z.array(safeId).max(4000).optional(),
        resolution: z.enum(['current', 'incoming', 'delete']).optional(),
      }),
    )
    .max(20000),
  tombstones: z.array(safeId).max(8000).optional(),
  deletedMapCollisions: z
    .array(
      z.object({
        elementId: safeId,
        mapIndices: z
          .array(z.number().int().nonnegative().max(9999))
          .max(10000),
      }),
    )
    .max(8000)
    .optional(),
  matches: z
    .array(
      z.object({ oldId: safeId, newId: safeId, evidence: z.string().max(300) }),
    )
    .max(4000)
    .optional(),
  resolutions: z.array(resolutionSchema).max(20000).optional(),
});

const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);
const canonical = (value) =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
const same = (a, b) => {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
};
const uniqueIds = (entries, label) => {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new Error(`${label}身份重复。`);
};

function checkPng(value, dimensions, allowPackageReferences) {
  if (allowPackageReferences && /^media\/[0-9]+\.bin$/.test(value)) return;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || match[1].length < 32 || match[1].length % 4)
    throw new Error('场景分层纹理与归属蒙版必须是内嵌 PNG。');
  // The browser and server use the same bounded IHDR check. Full decoding is also
  // performed by observation/export before claiming an image is usable.
  const header = Uint8Array.from(atob(match[1].slice(0, 32)), (character) =>
    character.charCodeAt(0),
  );
  const view = new DataView(header.buffer);
  if (
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => header[index] === byte,
    ) ||
    view.getUint32(8) !== 13 ||
    String.fromCharCode(...header.slice(12, 16)) !== 'IHDR'
  )
    throw new Error('场景分层 PNG 头无效。');
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (
    !width ||
    !height ||
    width > 30000 ||
    height > 30000 ||
    width * height > 64_000_000 ||
    (dimensions && (width !== dimensions.width || height !== dimensions.height))
  )
    throw new Error('场景分层纹理或蒙版尺寸与子片不一致。');
}

/** Validate embedded split data without admitting filesystem/network references. */
export function validateMapSplit(
  input,
  { allowPackageReferences = false, mapCollisionCount } = {},
) {
  const split = mapSplitSchema.parse(input);
  const images = new Set();
  let count = 0;
  const visit = (value, key = '', depth = 0) => {
    if (++count > 600000 || depth > 40)
      throw new Error('场景分层数据过大或嵌套过深。');
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('场景分层数据包含无效数字。');
    if (typeof value === 'string') {
      if (value.length > 90_000_000)
        throw new Error('场景分层数据超过大小限制。');
      if (
        ['source', 'mask'].includes(key) ||
        /^(?:data:image\/|media\/)/.test(value)
      ) {
        checkPng(value, null, allowPackageReferences);
        images.add(value);
      }
    } else if (Array.isArray(value))
      value.forEach((entry) => visit(entry, key, depth + 1));
    else if (value && typeof value === 'object') {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error('场景分层快照必须是 JSON 数据。');
      for (const [childKey, entry] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(childKey))
          throw new Error('场景分层数据包含无效字段。');
        visit(entry, childKey, depth + 1);
      }
    } else if (
      value !== undefined &&
      value !== null &&
      !['boolean', 'number'].includes(typeof value)
    )
      throw new Error('场景分层快照必须是 JSON 数据。');
  };
  for (const [label, elements] of [
    ['初次分层', split.baseline],
    ['场景分层', split.elements],
  ]) {
    uniqueIds(elements, label);
    if (elements.reduce((sum, element) => sum + element.parts.length, 0) > 6000)
      throw new Error('场景分层子片过多，请拆分场景。');
    const owned = new Set();
    let polygonPoints = 0;
    for (const element of elements) {
      uniqueIds(element.parts, '场景分层子片');
      for (const part of element.parts) {
        if (part.width * part.height > 64_000_000)
          throw new Error('场景分层子片超过 6400 万像素。');
        checkPng(part.source, part, allowPackageReferences);
        if (part.mask) checkPng(part.mask, part, allowPackageReferences);
      }
      polygonPoints += element.collision.polygons.reduce(
        (sum, points) => sum + points.length,
        0,
      );
      if (polygonPoints > 200000) throw new Error('场景分层碰撞顶点过多。');
      for (const index of element.collision.mapIndices) {
        if (owned.has(index))
          throw new Error('同一个地图碰撞只能转移给一个场景分层物件。');
        if (
          !split.stale &&
          mapCollisionCount !== undefined &&
          index >= mapCollisionCount
        )
          throw new Error('场景分层引用的地图碰撞不存在。');
        owned.add(index);
      }
    }
  }
  const deletedIds = new Set(split.tombstones || []),
    recordedIds = new Set();
  for (const entry of split.deletedMapCollisions || []) {
    if (
      recordedIds.has(entry.elementId) ||
      !deletedIds.has(entry.elementId) ||
      split.elements.some((element) => element.id === entry.elementId)
    )
      throw new Error('已删除物件的地图碰撞归属记录无效或重复。');
    recordedIds.add(entry.elementId);
  }
  const ownedIndices = new Set(
    split.elements.flatMap((element) => element.collision.mapIndices),
  );
  for (const entry of mapSplitDeletedCollisionOwners(split))
    for (const index of entry.mapIndices) {
      if (ownedIndices.has(index))
        throw new Error(
          '同一个地图碰撞只能归属一个当前或已删除的场景分层物件。',
        );
      if (
        !split.stale &&
        mapCollisionCount !== undefined &&
        index >= mapCollisionCount
      )
        throw new Error('已删除物件引用的地图碰撞不存在。');
      ownedIndices.add(index);
    }
  uniqueIds(split.conflicts, '场景分层冲突');
  visit(split);
  if (
    [...images].reduce(
      (sum, value) =>
        sum +
        (value.startsWith('data:')
          ? ((value.length - value.indexOf(',') - 1) * 3) / 4
          : 0),
      0,
    ) >
    256 * 1024 * 1024
  )
    throw new Error('场景分层素材超过 256 MB。');
  return split;
}

/** Empty entries deliberately override a legacy baseline after explicit release. */
export function mapSplitDeletedCollisionOwners(split) {
  const records = new Map(
    (split?.deletedMapCollisions || []).map((entry) => [
      entry.elementId,
      entry.mapIndices,
    ]),
  );
  return [...new Set(split?.tombstones || [])].map((elementId) => ({
    elementId,
    mapIndices: records.has(elementId)
      ? records.get(elementId)
      : split.baseline.find((element) => element.id === elementId)?.collision
          .mapIndices || [],
  }));
}

export function mapSplitCollisionOwner(scene, index) {
  const split = scene.mapSplit && !scene.mapSplit.stale ? scene.mapSplit : null;
  if (!split) return undefined;
  const current = split.elements.find((element) =>
    element.collision.mapIndices.includes(index),
  );
  if (current)
    return { elementId: current.id, name: current.name, deleted: false };
  const removed = mapSplitDeletedCollisionOwners(split).find((entry) =>
    entry.mapIndices.includes(index),
  );
  return removed
    ? {
        elementId: removed.elementId,
        name:
          split.baseline.find((element) => element.id === removed.elementId)
            ?.name || removed.elementId,
        deleted: true,
      }
    : undefined;
}

/** Shared browser/Agent transfer. Returning [] explicitly restores the map body. */
export function splitCollisionTransfer(scene, elementId, indices, replacementPolygons) {
  const element = scene.mapSplit?.elements.find(
    (value) => value.id === elementId,
  );
  if (!scene.map || !element || scene.mapSplit.stale || element.locked)
    throw new Error('请先选择并解锁当前地图的分层物件。');
  if (
    !Array.isArray(indices) ||
    new Set(indices).size !== indices.length ||
    indices.some(
      (index) =>
        !Number.isInteger(index) ||
        index < 0 ||
        index >= scene.map.collisions.length,
    )
  )
    throw new Error('地图碰撞区域索引无效或重复。');
  for (const index of indices) {
    const owner = mapSplitCollisionOwner(scene, index);
    if (owner?.deleted)
      throw new Error('此区域已随删除物件停用，请在候选修订中明确重新归属。');
    if (owner && owner.elementId !== elementId)
      throw new Error('此地图碰撞已归属其他物件，请先在原物件解除归属。');
  }
  if (replacementPolygons !== undefined) {
    if (indices.length && !replacementPolygons.length)
      throw new Error('接管地图阻挡时需要至少一条轮廓。');
    return { enabled: indices.length > 0, mapIndices: [...indices], polygons: clone(replacementPolygons) };
  }
  const prior = element.collision;
  const retained = indices.filter((index) => prior.mapIndices.includes(index));
  const removed = prior.mapIndices.filter((index) => !indices.includes(index));
  const aligned = prior.polygons.length === prior.mapIndices.length;
  if (retained.length && removed.length && !aligned)
    throw new Error(
      '已重组的碰撞轮廓无法按单个区域解除，请先解除全部归属，再明确设置轮廓。',
    );
  const polygons = !retained.length
    ? []
    : aligned
      ? retained.map((index) =>
          clone(prior.polygons[prior.mapIndices.indexOf(index)]),
        )
      : clone(prior.polygons);
  const added = indices.filter((index) => !prior.mapIndices.includes(index));
  return {
    enabled: indices.length > 0,
    mapIndices: [...retained, ...added],
    polygons: [
      ...polygons,
      ...added.map((index) =>
        scene.map.collisions[index].map((point) => ({
          x: point.x - scene.map.origin.x - element.x,
          y: point.y - scene.map.origin.y - element.y,
        })),
      ),
    ],
  };
}

/** Capture current ownership before removing art; the initial merge baseline stays immutable. */
export function removeMapSplitElements(scene, ids) {
  const split = scene.mapSplit;
  if (!split) return [];
  const selected = new Set(ids),
    removed = split.elements.filter((element) => selected.has(element.id));
  if (removed.some((element) => element.locked))
    throw new Error('请先解锁要删除的场景分层物件。');
  if (!removed.length) return [];
  const records = new Map(
    (split.deletedMapCollisions || []).map((entry) => [
      entry.elementId,
      [...entry.mapIndices],
    ]),
  );
  for (const element of removed)
    records.set(element.id, [...element.collision.mapIndices]);
  split.deletedMapCollisions = [...records].map(([elementId, mapIndices]) => ({
    elementId,
    mapIndices,
  }));
  const removedIds = removed.map((element) => element.id),
    deleted = new Set(removedIds);
  split.tombstones = [...new Set([...(split.tombstones || []), ...removedIds])];
  split.elements = split.elements.filter((element) => !deleted.has(element.id));
  scene.order = scene.order.filter((id) => !deleted.has(id));
  split.review = 'unverified';
  return removedIds;
}

const partShape = (part) => ({
  role: part.role,
  plane: part.plane,
  x: part.x,
  y: part.y,
  width: part.width,
  height: part.height,
  mask: part.mask,
});
const silhouette = (element) =>
  canonical(
    element.parts
      .filter((part) => part.role === 'art')
      .map((part) => ({
        ...partShape(part),
        outline: part.mask || part.source,
      })),
  );
function identityMetrics(elements) {
  const imageHashes = new Map();
  const digest = (value) => {
    if (!value) return '';
    if (imageHashes.has(value)) return imageHashes.get(value);
    let a = 2166136261,
      b = 5381;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      a = Math.imul(a ^ code, 16777619) >>> 0;
      b = (Math.imul(b, 33) ^ code) >>> 0;
    }
    const result = `${value.length}:${a.toString(16)}:${b.toString(16)}`;
    imageHashes.set(value, result);
    return result;
  };
  return new Map(
    elements.map((element) => {
      const art = element.parts.filter((part) => part.role === 'art');
      const visibleParts = art.length ? art : element.parts;
      const x = visibleParts.length
        ? Math.min(...visibleParts.map((part) => part.x))
        : 0;
      const y = visibleParts.length
        ? Math.min(...visibleParts.map((part) => part.y))
        : 0;
      const width = Math.max(
        1,
        ...visibleParts.map((part) => part.x + part.width - x),
      );
      const height = Math.max(
        1,
        ...visibleParts.map((part) => part.y + part.height - y),
      );
      const fingerprint = canonical({
        kind: element.kind,
        parts: element.parts.map((part) => ({
          ...partShape(part),
          source: digest(part.source),
          mask: digest(part.mask),
        })),
      });
      const outline =
        art.length && art.every((part) => part.mask)
          ? canonical({
              kind: element.kind,
              parts: art
                .map((part) => ({
                  x: part.x - x,
                  y: part.y - y,
                  width: part.width,
                  height: part.height,
                  mask: digest(part.mask),
                }))
                .sort(
                  (a, b) =>
                    a.x - b.x ||
                    a.y - b.y ||
                    a.width - b.width ||
                    a.height - b.height ||
                    a.mask.localeCompare(b.mask),
                ),
            })
          : null;
      return [
        element,
        {
          fingerprint,
          outline,
          bounds: { x: element.x + x, y: element.y + y, width, height },
        },
      ];
    }),
  );
}
const indexBy = (elements, key) => {
  const index = new Map();
  for (const element of elements) {
    const value = key(element);
    if (!value) continue;
    if (!index.has(value)) index.set(value, []);
    index.get(value).push(element);
  }
  return index;
};
const conflictId = (elementId, field, reason) => {
  let hash = 2166136261;
  for (const character of `${elementId}:${field}:${reason}`)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return `conflict_${hash.toString(16)}`;
};

/** Match once so merged art and the next baseline retain identical part IDs. */
function matchParts(base, incoming) {
  const matched = new Map();
  const remaining = new Map(incoming.parts.map((part) => [part.id, part]));
  for (const part of base.parts) {
    if (remaining.has(part.id)) {
      matched.set(part.id, remaining.get(part.id));
      remaining.delete(part.id);
    }
  }
  for (const old of base.parts) {
    if (matched.has(old.id)) continue;
    const peers = [...remaining.values()].filter(
      (part) => part.role === old.role && part.plane === old.plane,
    );
    const oldPeers = base.parts.filter(
      (part) => part.role === old.role && part.plane === old.plane,
    );
    const exact = peers.filter((part) =>
      same({ ...part, id: '' }, { ...old, id: '' }),
    );
    const fresh =
      peers.length === 1 && oldPeers.length === 1
        ? peers[0]
        : exact.length === 1
          ? exact[0]
          : undefined;
    if (fresh) {
      matched.set(old.id, fresh);
      remaining.delete(fresh.id);
    }
  }
  return matched;
}

/**
 * Three-way merge: previous.baseline is the old original, previous.elements the
 * scene edits, and candidate.elements the new map. Explicit matches are a
 * reviewed, one-to-one identity decision and always retain the old element ID.
 */
export function mergeMapSplit(
  previousInput,
  candidateInput,
  { origin, matches = [], resolutions = [], referencedIds = [] } = {},
) {
  const previous = validateMapSplit(previousInput);
  const candidate = validateMapSplit(candidateInput);
  const sameSource =
    !previous.stale && previous.sourceHash === candidate.sourceHash;
  if (origin) candidate.origin = point.parse(origin);
  const oldById = new Map(
    previous.baseline.map((element) => [element.id, element]),
  );
  const currentById = new Map(
    previous.elements.map((element) => [element.id, element]),
  );
  const incomingById = new Map(
    candidate.elements.map((element) => [element.id, element]),
  );
  // Raster strings are hashed once per distinct image. Matching loops compare
  // small descriptors; exact-pixel matches additionally verify the originals.
  const metrics = identityMetrics([
    ...previous.baseline,
    ...candidate.elements,
  ]);
  const oldSources = indexBy(previous.baseline, (element) => element.sourceKey);
  const newSources = indexBy(
    candidate.elements,
    (element) => element.sourceKey,
  );
  const oldPixels = indexBy(
    previous.baseline,
    (element) => metrics.get(element).fingerprint,
  );
  const newPixels = indexBy(
    candidate.elements,
    (element) => metrics.get(element).fingerprint,
  );
  const oldOutlines = indexBy(
    previous.baseline,
    (element) => metrics.get(element).outline,
  );
  const newOutlines = indexBy(
    candidate.elements,
    (element) => metrics.get(element).outline,
  );
  const paired = new Map();
  const usedIncoming = new Set();
  const matchLog = [];
  const pair = (oldId, newId, evidence) => {
    if (
      !oldById.has(oldId) ||
      !incomingById.has(newId) ||
      paired.has(oldId) ||
      usedIncoming.has(newId)
    )
      throw new Error('分层迁移匹配必须引用存在且一对一的物件。');
    paired.set(oldId, newId);
    usedIncoming.add(newId);
    matchLog.push({ oldId, newId, evidence });
  };
  for (const match of matches)
    pair(match.oldId, match.newId, match.evidence || 'explicit-reviewed-match');
  for (const old of previous.baseline) {
    if (paired.has(old.id)) continue;
    if (incomingById.has(old.id) && !usedIncoming.has(old.id)) {
      pair(old.id, old.id, 'stable-id');
      continue;
    }
    if (!old.sourceKey) continue;
    const oldPeers = oldSources.get(old.sourceKey) || [];
    const newPeers = (newSources.get(old.sourceKey) || []).filter(
      (element) => !usedIncoming.has(element.id),
    );
    if (
      oldPeers.length === 1 &&
      newPeers.length === 1 &&
      old.kind === newPeers[0].kind
    )
      pair(old.id, newPeers[0].id, 'unique-source-key');
  }
  const exactPixels = (a, b) =>
    metrics.get(a).fingerprint === metrics.get(b).fingerprint &&
    a.parts.length === b.parts.length &&
    a.parts.every(
      (part, index) =>
        part.source === b.parts[index].source &&
        part.mask === b.parts[index].mask,
    );
  for (const old of previous.baseline.filter(
    (element) => !paired.has(element.id),
  )) {
    const peers = (newPixels.get(metrics.get(old).fingerprint) || []).filter(
      (element) => !usedIncoming.has(element.id) && exactPixels(old, element),
    );
    const exactPosition = peers.filter(
      (element) => element.x === old.x && element.y === old.y,
    );
    const selected =
      exactPosition.length === 1
        ? exactPosition[0]
        : peers.length === 1
          ? peers[0]
          : null;
    if (!selected) continue;
    const competing = (
      oldPixels.get(metrics.get(old).fingerprint) || []
    ).filter(
      (element) =>
        !paired.has(element.id) &&
        exactPixels(element, selected) &&
        (exactPosition.length !== 1 ||
          (element.x === selected.x && element.y === selected.y)),
    );
    if (competing.length === 1)
      pair(
        old.id,
        selected.id,
        exactPosition.length === 1
          ? 'exact-pixels-shape-and-position'
          : 'unique-exact-pixels-and-shape',
      );
  }
  const alignedPosition = (old, fresh) => {
    const near = (dx, dy) =>
      Math.abs(fresh.x - old.x - dx) <= 1 &&
      Math.abs(fresh.y - old.y - dy) <= 1;
    if (near(0, 0)) return 'aligned-map-position';
    if (
      near(
        previous.origin.x - candidate.origin.x,
        previous.origin.y - candidate.origin.y,
      )
    )
      return 'aligned-world-origin';
    for (const match of matchLog) {
      const before = oldById.get(match.oldId),
        after = incomingById.get(match.newId);
      const bounds = metrics.get(old).bounds;
      const distance = Math.hypot(old.x - before.x, old.y - before.y);
      if (
        distance <=
          Math.max(256, Math.hypot(bounds.width, bounds.height) * 4) &&
        near(after.x - before.x, after.y - before.y)
      )
        return `aligned-neighbor:${before.id}`;
    }
    return null;
  };
  const sameOutline = (a, b) => {
    const first = a.parts.filter((part) => part.role === 'art'),
      second = b.parts.filter((part) => part.role === 'art');
    const aBounds = metrics.get(a).bounds,
      bBounds = metrics.get(b).bounds;
    return (
      first.length === second.length &&
      first.every((part) =>
        second.some(
          (peer) =>
            part.width === peer.width &&
            part.height === peer.height &&
            part.mask === peer.mask &&
            part.x - aBounds.x + a.x === peer.x - bBounds.x + b.x &&
            part.y - aBounds.y + a.y === peer.y - bBounds.y + b.y,
        ),
      )
    );
  };
  for (const old of previous.baseline.filter(
    (element) => !paired.has(element.id),
  )) {
    const outline = metrics.get(old).outline;
    if (!outline) continue;
    const peers = (newOutlines.get(outline) || []).filter(
      (element) =>
        !usedIncoming.has(element.id) &&
        sameOutline(old, element) &&
        alignedPosition(old, element),
    );
    if (peers.length !== 1) continue;
    const selected = peers[0];
    const competing = (oldOutlines.get(outline) || []).filter(
      (element) =>
        !paired.has(element.id) &&
        sameOutline(element, selected) &&
        alignedPosition(element, selected),
    );
    if (competing.length === 1)
      pair(
        old.id,
        selected.id,
        `unique-ownership-outline+${alignedPosition(old, selected)}`,
      );
  }
  // Spatial overlap is a review suggestion, never an identity decision. This
  // retains split/merged or redrawn scenery instead of silently replacing IDs.
  const spatial = new Map(),
    large = [];
  const cells = (bounds) => {
    const x1 = Math.floor(bounds.x / 256),
      x2 = Math.floor((bounds.x + bounds.width) / 256);
    const y1 = Math.floor(bounds.y / 256),
      y2 = Math.floor((bounds.y + bounds.height) / 256);
    if ((x2 - x1 + 1) * (y2 - y1 + 1) > 256) return null;
    const result = [];
    for (let y = y1; y <= y2; y++)
      for (let x = x1; x <= x2; x++) result.push(`${x},${y}`);
    return result;
  };
  for (const element of candidate.elements.filter(
    (element) => !usedIncoming.has(element.id),
  )) {
    const keys = cells(metrics.get(element).bounds);
    if (!keys) {
      large.push(element);
      continue;
    }
    for (const key of keys) {
      if (!spatial.has(key)) spatial.set(key, []);
      spatial.get(key).push(element);
    }
  }
  const possible = new Map();
  for (const old of previous.baseline.filter(
    (element) => !paired.has(element.id),
  )) {
    const descriptor = metrics.get(old),
      bounds = descriptor.bounds;
    const peers = new Set([
      ...(newPixels.get(descriptor.fingerprint) || []).filter((element) =>
        exactPixels(old, element),
      ),
      ...(descriptor.outline ? newOutlines.get(descriptor.outline) || [] : []),
    ]);
    for (const shift of [
      { x: 0, y: 0 },
      {
        x: previous.origin.x - candidate.origin.x,
        y: previous.origin.y - candidate.origin.y,
      },
    ]) {
      const aligned = {
        ...bounds,
        x: bounds.x + shift.x,
        y: bounds.y + shift.y,
      };
      const keys = cells(aligned);
      const neighbors = keys
        ? new Set([...large, ...keys.flatMap((key) => spatial.get(key) || [])])
        : candidate.elements;
      for (const fresh of neighbors) {
        if (fresh.kind !== old.kind) continue;
        const next = metrics.get(fresh).bounds;
        const overlap =
          Math.max(
            0,
            Math.min(aligned.x + aligned.width, next.x + next.width) -
              Math.max(aligned.x, next.x),
          ) *
          Math.max(
            0,
            Math.min(aligned.y + aligned.height, next.y + next.height) -
              Math.max(aligned.y, next.y),
          );
        if (
          overlap /
            Math.min(bounds.width * bounds.height, next.width * next.height) >=
          0.15
        )
          peers.add(fresh);
      }
    }
    possible.set(
      old.id,
      [...peers].filter((element) => !usedIncoming.has(element.id)),
    );
  }
  const suppliedResolutions = resolutions.map((entry) =>
    resolutionSchema.parse(entry),
  );
  if (
    new Set(suppliedResolutions.map((entry) => entry.conflictId)).size !==
    suppliedResolutions.length
  )
    throw new Error('同一个迁移冲突不能重复裁决。');
  const resolutionById = new Map(
    suppliedResolutions.map((entry) => [entry.conflictId, entry.choice]),
  );
  const consumedResolutions = new Set();
  const conflicts = [];
  const deleted = new Set(previous.tombstones || []);
  const conflict = (
    elementId,
    field,
    reason,
    baseline,
    current,
    incoming,
    candidates,
  ) => {
    const id = conflictId(elementId, field, reason);
    const resolution = resolutionById.get(id);
    if (resolution) consumedResolutions.add(id);
    conflicts.push({
      id,
      elementId,
      field,
      reason,
      ...(baseline !== undefined ? { baseline: clone(baseline) } : {}),
      ...(current !== undefined ? { current: clone(current) } : {}),
      ...(incoming !== undefined ? { incoming: clone(incoming) } : {}),
      ...(candidates ? { candidates } : {}),
      ...(resolution ? { resolution } : {}),
    });
    if (resolution === 'delete') {
      deleted.add(elementId);
      return clone(current);
    }
    return clone(resolution === 'incoming' ? incoming : current);
  };
  const scalar = (
    elementId,
    field,
    base,
    current,
    incoming,
    reason = 'concurrent-edit',
  ) => {
    if (same(current, base)) return clone(incoming);
    if (same(incoming, base) || same(current, incoming)) return clone(current);
    return conflict(elementId, field, reason, base, current, incoming);
  };
  const partMatches = new Map(
    [...paired].map(([oldId, newId]) => [
      oldId,
      matchParts(oldById.get(oldId), incomingById.get(newId)),
    ]),
  );
  const mergeParts = (base, current, incoming) => {
    const result = [];
    const remaining = new Map(incoming.parts.map((part) => [part.id, part]));
    for (const oldPart of base.parts) {
      const edited = current.parts.find((part) => part.id === oldPart.id);
      const fresh = partMatches.get(base.id).get(oldPart.id);
      if (fresh) remaining.delete(fresh.id);
      if (!edited) continue; // A scene deletion remains a deletion.
      if (!fresh) {
        if (!same(edited, oldPart))
          result.push(
            conflict(
              base.id,
              `parts.${oldPart.id}`,
              'missing-edited-part',
              oldPart,
              edited,
              undefined,
            ),
          );
        continue;
      }
      const currentTextureEdited =
        edited.source !== oldPart.source || edited.mask !== oldPart.mask;
      const incomingTextureEdited =
        fresh.source !== oldPart.source || fresh.mask !== oldPart.mask;
      const currentSizeEdited =
        edited.width !== oldPart.width || edited.height !== oldPart.height;
      const incomingSizeEdited =
        fresh.width !== oldPart.width || fresh.height !== oldPart.height;
      if (
        ((currentTextureEdited && incomingSizeEdited) ||
          (incomingTextureEdited && currentSizeEdited)) &&
        (edited.width !== fresh.width || edited.height !== fresh.height)
      ) {
        const kept = conflict(
          base.id,
          `parts.${oldPart.id}`,
          'texture-geometry-changed',
          oldPart,
          edited,
          { ...fresh, id: oldPart.id },
        );
        if (kept) result.push(kept);
        continue;
      }
      const part = { id: oldPart.id };
      for (const key of [
        'role',
        'plane',
        'x',
        'y',
        'width',
        'height',
        'source',
        'mask',
        'enabled',
      ]) {
        const value = scalar(
          base.id,
          `parts.${oldPart.id}.${key}`,
          oldPart[key],
          edited[key],
          fresh[key],
        );
        if (value !== undefined) part[key] = value;
      }
      result.push(part);
    }
    for (const part of current.parts.filter(
      (part) => !base.parts.some((oldPart) => oldPart.id === part.id),
    )) {
      if (remaining.has(part.id)) {
        const fresh = remaining.get(part.id);
        remaining.delete(part.id);
        result.push(
          same(part, fresh)
            ? clone(part)
            : conflict(
                base.id,
                `parts.${part.id}`,
                'concurrent-addition',
                undefined,
                part,
                fresh,
              ),
        );
      } else result.push(clone(part));
    }
    result.push(...[...remaining.values()].map(clone));
    return result.filter(Boolean);
  };
  const result = [];
  const suppressedIncoming = new Set();
  for (const base of previous.baseline) {
    const current = currentById.get(base.id);
    const fresh = incomingById.get(paired.get(base.id));
    if (!current || deleted.has(base.id)) {
      deleted.add(base.id);
      continue;
    }
    if (!fresh) {
      const peers = (possible.get(base.id) || []).filter(
        (element) => !usedIncoming.has(element.id),
      );
      if (peers.length) {
        peers.forEach((element) => suppressedIncoming.add(element.id));
        const kept = conflict(
          base.id,
          'element',
          'ambiguous-match',
          base,
          current,
          peers,
          peers.map((element) => element.id),
        );
        // Matching a specific incoming object requires the explicit matches table.
        if (
          resolutionById.get(
            conflictId(base.id, 'element', 'ambiguous-match'),
          ) === 'incoming'
        )
          throw new Error('歧义物件须先用 matches 指定唯一对应，再选择新版。');
        kept.collision.mapIndices = [];
        result.push(kept);
      } else if (!same(current, base) || referencedIds.includes(base.id)) {
        const kept = conflict(
          base.id,
          'element',
          'missing-edited-element',
          base,
          current,
          undefined,
        );
        if (kept) {
          kept.collision.mapIndices = [];
          result.push(kept);
        }
      }
      continue;
    }
    const element = { id: base.id };
    for (const key of [
      'name',
      'kind',
      'positionMode',
      'hidden',
      'locked',
      'included',
      'sourceKey',
    ]) {
      const value = scalar(base.id, key, base[key], current[key], fresh[key]);
      if (value !== undefined) element[key] = value;
    }
    const world = current.positionMode === 'world';
    element.x = world
      ? previous.origin.x + current.x - candidate.origin.x
      : fresh.x + current.x - base.x;
    element.y = world
      ? previous.origin.y + current.y - candidate.origin.y
      : fresh.y + current.y - base.y;
    element.parts = mergeParts(base, current, fresh);
    const editedPolygon = !same(
      current.collision.polygons,
      base.collision.polygons,
    );
    const unsafeShape = editedPolygon && silhouette(base) !== silhouette(fresh);
    element.collision = {
      enabled: scalar(
        base.id,
        'collision.enabled',
        base.collision.enabled,
        current.collision.enabled,
        fresh.collision.enabled,
      ),
      polygons: unsafeShape
        ? conflict(
            base.id,
            'collision.polygons',
            'shape-anchor-changed',
            base.collision.polygons,
            current.collision.polygons,
            fresh.collision.polygons,
          )
        : scalar(
            base.id,
            'collision.polygons',
            base.collision.polygons,
            current.collision.polygons,
            fresh.collision.polygons,
          ),
      // Map indices belong to the incoming map, never the superseded map.
      mapIndices: sameSource
        ? scalar(
            base.id,
            'collision.mapIndices',
            base.collision.mapIndices,
            current.collision.mapIndices,
            fresh.collision.mapIndices,
          )
        : clone(fresh.collision.mapIndices),
    };
    if (
      !sameSource &&
      !same(current.collision.mapIndices, base.collision.mapIndices)
    ) {
      conflict(
        base.id,
        'collision.mapIndices',
        'map-collision-ownership-changed',
        base.collision.mapIndices,
        current.collision.mapIndices,
        fresh.collision.mapIndices,
      );
      // Keeping local geometry cannot claim numeric indices in another map.
      if (
        resolutionById.get(
          conflictId(
            base.id,
            'collision.mapIndices',
            'map-collision-ownership-changed',
          ),
        ) === 'current'
      )
        element.collision.mapIndices = [];
    }
    result.push(element);
  }
  for (const element of previous.elements.filter(
    (element) => !oldById.has(element.id),
  )) {
    if (deleted.has(element.id)) continue;
    const kept = clone(element);
    if (kept.positionMode === 'world') {
      kept.x += previous.origin.x - candidate.origin.x;
      kept.y += previous.origin.y - candidate.origin.y;
    }
    // A scene-only addition has no claim on collision indices of another map.
    if (!sameSource && kept.collision.mapIndices.length) {
      conflict(
        kept.id,
        'collision.mapIndices',
        'map-collision-ownership-changed',
        undefined,
        kept.collision.mapIndices,
        [],
      );
      kept.collision.mapIndices = [];
    }
    result.push(kept);
  }
  const remappedIncoming = candidate.elements.map((element) => {
    const oldId = matchLog.find((match) => match.newId === element.id)?.oldId;
    const mapped = clone(element);
    if (oldId) {
      mapped.id = oldId;
      // Part IDs remain addressable across map revisions as well.
      const ids = new Map(
        [...partMatches.get(oldId)].map(([id, part]) => [part.id, id]),
      );
      mapped.parts = mapped.parts.map((part) => {
        return { ...part, id: ids.get(part.id) ?? part.id };
      });
    }
    return mapped;
  });
  const occupied = new Set(result.map((element) => element.id));
  for (const element of remappedIncoming) {
    const original = candidate.elements[remappedIncoming.indexOf(element)];
    if (
      usedIncoming.has(original.id) ||
      suppressedIncoming.has(original.id) ||
      deleted.has(element.id)
    )
      continue;
    if (occupied.has(element.id)) {
      const at = result.findIndex((entry) => entry.id === element.id);
      result[at] = conflict(
        element.id,
        'element',
        'concurrent-addition',
        undefined,
        result[at],
        element,
      );
      continue;
    }
    occupied.add(element.id);
    result.push(clone(element));
  }
  if (consumedResolutions.size !== suppliedResolutions.length)
    throw new Error('迁移裁决引用的冲突不存在或已发生变化，请重新读取候选。');
  // Unresolved identity conflicts retain their old original for a later match;
  // ambiguous incoming objects remain in conflict previews, not as fake deletions.
  const baseline = remappedIncoming.filter(
    (_element, index) => !suppressedIncoming.has(candidate.elements[index].id),
  );
  for (const entry of conflicts.filter(
    (entry) =>
      entry.field === 'element' &&
      !entry.resolution &&
      ['ambiguous-match', 'missing-edited-element'].includes(entry.reason),
  )) {
    if (!baseline.some((element) => element.id === entry.elementId)) {
      const retained = clone(oldById.get(entry.elementId));
      retained.collision.mapIndices = [];
      baseline.push(retained);
    }
  }
  const liveElements = result.filter((element) => element && !deleted.has(element.id));
  const liveIndices = new Set(liveElements.flatMap(element => element.collision.mapIndices));
  const deletedOwners = new Map(mapSplitDeletedCollisionOwners(previous).map(owner => [owner.elementId, owner]));
  const merged = {
    ...candidate,
    stale: false,
    baseline,
    elements: liveElements,
    conflicts,
    tombstones: [...deleted],
    // Indices are local to the new map. Carry deletion intent and use only a
    // proven incoming owner's indices; an explicit prior release remains empty.
    deletedMapCollisions: [...deleted].map((elementId) => {
      const oldOwnership = deletedOwners.get(elementId);
      return {
        elementId,
        mapIndices: sameSource
          ? (oldOwnership?.mapIndices ?? currentById.get(elementId)?.collision.mapIndices ?? [])
              .filter(index => !liveIndices.has(index))
          : oldOwnership?.mapIndices.length === 0
            ? []
            : [
                ...(baseline.find((element) => element.id === elementId)
                  ?.collision.mapIndices || []),
              ],
      };
    }),
    matches: matchLog,
    resolutions: suppliedResolutions,
  };
  if (conflicts.some((entry) => !entry.resolution))
    merged.review = 'unverified';
  return validateMapSplit(merged);
}

/** Mutates only the scene-owned split and its node identities/order. */
export function installMapSplit(scene, input) {
  if (!scene.map) throw new Error('请先添加地图，再采用场景分层。');
  const split = validateMapSplit(input, {
    mapCollisionCount: scene.map.collisions.length,
  });
  const occupied = new Set([
    'actor',
    'Scene',
    'ActorSlot',
    'MapCollisions',
    'InteractionRuntime',
    ...scene.map.layers.map((layer) => layer.id),
    ...scene.instances.map((instance) => instance.id),
  ]);
  if (split.elements.some((element) => occupied.has(element.id)))
    throw new Error('场景分层物件与已有节点身份重复。');
  const oldIds = new Set(
    scene.mapSplit?.elements.map((element) => element.id) || [],
  );
  const newIds = new Set(split.elements.map((element) => element.id));
  const order = scene.order.filter((id) => !oldIds.has(id) || newIds.has(id));
  for (const element of [...split.elements].reverse()) {
    if (order.includes(element.id)) continue;
    const mapIds = new Set(scene.map.layers.map((layer) => layer.id));
    const firstMap = order.findIndex((id) => mapIds.has(id));
    if (element.kind === 'object')
      order.splice(Math.max(0, order.indexOf('actor')), 0, element.id);
    else if (firstMap >= 0) order.splice(firstMap, 0, element.id);
    else order.push(element.id);
  }
  scene.order = order;
  scene.mapSplit = split;
  return scene.mapSplit;
}

export function applyMapSplit(scene, candidate, options = {}) {
  if (!scene.map) throw new Error('请先添加地图，再采用场景分层。');
  const incoming = validateMapSplit(candidate, {
    mapCollisionCount: scene.map.collisions.length,
  });
  const split = scene.mapSplit
    ? mergeMapSplit(scene.mapSplit, incoming, options)
    : { ...incoming, stale: false, baseline: clone(incoming.elements) };
  return installMapSplit(scene, split);
}
