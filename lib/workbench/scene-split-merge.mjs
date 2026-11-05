import sharp from 'sharp';
import {
  mergeMapSplit,
  validateMapSplit,
} from '../../features/scene-composer/map-split.mjs';
import { fingerprint } from './image-edit-store.mjs';

const imageBytes = (source) =>
  Buffer.from(source.slice(source.indexOf(',') + 1), 'base64');
const sameGeometry = (a, b) =>
  a &&
  b &&
  a.width === b.width &&
  a.height === b.height &&
  a.x === b.x &&
  a.y === b.y;
const proof = (conflict) =>
  fingerprint([
    conflict.reason,
    conflict.baseline,
    conflict.current,
    conflict.incoming,
    conflict.candidates,
  ]);

// A texture may contain both a local retouch and a separate incoming change.
// Merge straight RGBA pixels only when all three coordinate frames still agree.
async function mergeTexture(conflict, previous, merged) {
  const field = /^parts\.([a-zA-Z0-9_-]+)\.source$/.exec(conflict.field);
  if (
    !field ||
    conflict.reason !== 'concurrent-edit' ||
    conflict.resolution === 'delete'
  )
    return null;
  const findPart = (elements) =>
    elements
      .find((e) => e.id === conflict.elementId)
      ?.parts.find((p) => p.id === field[1]);
  const base = findPart(previous.baseline),
    local = findPart(previous.elements),
    incoming = findPart(merged.baseline),
    output = findPart(merged.elements);
  if (!output || !sameGeometry(base, local) || !sameGeometry(base, incoming))
    return null;
  const decode = (source) =>
    sharp(imageBytes(source), { limitInputPixels: 64_000_000 })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer();
  const [b, l, n] = await Promise.all([
    decode(base.source),
    decode(local.source),
    decode(incoming.source),
  ]);
  if (
    b.length !== l.length ||
    b.length !== n.length ||
    b.length !== base.width * base.height * 4
  )
    throw new Error('分层贴图三方尺寸不同。');
  let baseMask, newMask;
  if (base.mask !== incoming.mask) {
    if (!base.mask || !incoming.mask || local.mask !== base.mask) return null;
    const decodeMask = (source) =>
      sharp(imageBytes(source), { limitInputPixels: 64_000_000 })
        .extractChannel(0)
        .raw()
        .toBuffer();
    [baseMask, newMask] = await Promise.all([
      decodeMask(base.mask),
      decodeMask(incoming.mask),
    ]);
  }
  let disputed = 0,
    changed = false;
  for (let i = 0; i < b.length; i += 4) {
    const original = b.readUInt32LE(i),
      edited = l.readUInt32LE(i),
      updated = n.readUInt32LE(i);
    if (edited === original || edited === updated) continue;
    if (
      updated !== original ||
      (baseMask && baseMask[i / 4] !== newMask[i / 4])
    ) {
      disputed++;
      if (conflict.resolution === 'incoming') continue;
    }
    n.writeUInt32LE(edited, i);
    changed = true;
  }
  if (!changed) output.source = incoming.source;
  else if (n.equals(l)) output.source = local.source;
  else
    output.source =
      'data:image/png;base64,' +
      (
        await sharp(n, {
          raw: { width: base.width, height: base.height, channels: 4 },
        })
          .png()
          .toBuffer()
      ).toString('base64');
  return disputed;
}

export async function mergeSplitRevision(
  previous,
  incoming,
  { matches = [], resolutions = [], priorConflicts = [] } = {},
) {
  if (!previous) return validateMapSplit(incoming);
  let merged = mergeMapSplit(previous, incoming, { matches });
  const old = new Map(priorConflicts.map((c) => [c.id, c])),
    fresh = new Map(merged.conflicts.map((c) => [c.id, c]));
  // Rebase invalidates only decisions whose actual evidence changed.
  const valid = resolutions.filter(
    (r) =>
      old.has(r.conflictId) &&
      fresh.has(r.conflictId) &&
      proof(old.get(r.conflictId)) === proof(fresh.get(r.conflictId)),
  );
  if (valid.length)
    merged = mergeMapSplit(previous, incoming, { matches, resolutions: valid });
  const conflicts = [];
  for (const c of merged.conflicts) {
    if ((await mergeTexture(c, previous, merged)) !== 0) conflicts.push(c);
  }
  merged.conflicts = conflicts;
  return validateMapSplit(merged);
}
