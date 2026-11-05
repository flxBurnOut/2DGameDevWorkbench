import { initialState, stateAppearance } from '../interactable-editor/simulator.mjs';
import { instanceOrigin } from './model.mjs';
import { mapSplitDeletedCollisionOwners } from './map-split.mjs';

export function mapSplitElementOrigin(scene, element) {
  const mapOrigin = scene.map ? { x: scene.map.origin.x + scene.map.offset.x, y: scene.map.origin.y + scene.map.offset.y } : scene.mapSplit?.origin || { x: 0, y: 0 };
  return { x: mapOrigin.x + element.x, y: mapOrigin.y + element.y };
}

export function mapSplitElementRect(scene, element) {
  const origin = mapSplitElementOrigin(scene, element);
  if (!element.parts.length) return { ...origin, width: 1, height: 1 };
  const x = Math.min(...element.parts.map(part => part.x));
  const y = Math.min(...element.parts.map(part => part.y));
  return { x: origin.x + x, y: origin.y + y,
    width: Math.max(1, ...element.parts.map(part => part.x + part.width - x)),
    height: Math.max(1, ...element.parts.map(part => part.y + part.height - y)) };
}

/** Map indices are ownership, independent of the new owner's enable/export flag. */
export function activeMapCollisions(scene) {
  const split = scene.mapSplit && !scene.mapSplit.stale ? scene.mapSplit : null;
  const transferred = new Set(split ? [...split.elements.flatMap(element => element.collision.mapIndices), ...mapSplitDeletedCollisionOwners(split).flatMap(entry => entry.mapIndices)] : []);
  return (scene.map?.collisions || []).map((points, index) => ({ index, points })).filter(entry => !transferred.has(entry.index));
}

/** One front-first order for canvas, saved observations and Godot global Z. */
export function sceneDisplayOrder(scene, { includeDisabled = false } = {}) {
  const active = Boolean(scene.mapSplit && !scene.mapSplit.stale);
  const actorRank = scene.order.indexOf('actor');
  const entries = [];
  const elements = new Map((scene.mapSplit?.elements || []).map(element => [element.id, element]));
  for (const [rank, id] of scene.order.entries()) {
    if (id === 'actor') { entries.push({ key: id, id, kind: 'actor', rank }); continue; }
    const layer = scene.map?.layers.find(entry => entry.id === id);
    if (layer && !active) entries.push({ key: id, id, kind: 'layer', layer, rank });
    const instance = scene.instances.find(entry => entry.id === id);
    if (instance) entries.push({ key: id, id, kind: 'instance', instance, rank });
    const element = active ? elements.get(id) : null;
    if (!element) continue;
    const origin = mapSplitElementOrigin(scene, element);
    element.parts.forEach((part, partIndex) => {
      if (!includeDisabled && !part.enabled) return;
      const planeRank = part.plane === 'front' ? Math.min(rank, actorRank - 0.25) : Math.max(rank, actorRank + 0.25);
      entries.push({ key: `${id}:${part.id}`, id, kind: 'map-split-part', element, part, rank: planeRank, parentRank: rank, partIndex,
        rect: { x: origin.x + part.x, y: origin.y + part.y, width: part.width, height: part.height } });
    });
  }
  entries.sort((a, b) => a.rank - b.rank || (a.parentRank ?? a.rank) - (b.parentRank ?? b.rank) || (a.partIndex || 0) - (b.partIndex || 0));
  return entries.map(({ rank: _rank, parentRank: _parentRank, partIndex: _partIndex, ...entry }, index) => ({ ...entry,
    zIndex: entries.length <= 4096 ? entries.length - index - 1 : 4095 - index,
  }));
}

export function mapSplitPartRenderEntries(scene, { includeHidden = true, includedOnly = false } = {}) {
  return sceneDisplayOrder(scene).filter(entry => entry.kind === 'map-split-part' &&
    (includeHidden || !entry.element.hidden) && (!includedOnly || entry.element.included));
}

// Shared by the interactive canvas and versioned server observations.
export function instanceRect(instance, material) {
  const v = material.project.objects[0].visual;
  const p = instanceOrigin(instance);
  const sx = instance.scale * (instance.flipH ? -1 : 1);
  const width = v.width * v.scale * instance.scale;
  const height = v.height * v.scale * instance.scale;
  return { x: p.x + v.offset.x * sx - width / 2, y: p.y + v.offset.y * instance.scale - height / 2, width, height };
}

export function objectRenderState(instance, material, { time = 0, simulated, preview = false } = {}) {
  const object = material.project.objects[0];
  const visual = object.visual;
  const appearance = stateAppearance(object, simulated?.state || initialState(object));
  const completedHidden = Boolean(simulated?.state.completed && object.completion !== 'remain');
  const visible = (simulated?.visible ?? appearance.visible ?? visual.visible) && !completedHidden;
  const enabled = simulated?.enabled ?? object.activation.enabled;
  const clipName = simulated?.animation?.name || appearance.animation || visual.idleAnimation;
  const clip = visual.clips.find((entry) => entry.name === clipName);
  let frame = clip?.frames[0];
  if (clip) {
    const total = clip.frames.reduce((sum, entry) => sum + entry.duration, 0);
    let tick = Math.max(0, time - (simulated?.animation?.started || 0)) * clip.fps;
    tick = clip.loop ? tick % total : Math.min(tick, total - 0.00001);
    for (const entry of clip.frames) {
      frame = entry;
      if (tick < entry.duration) break;
      tick -= entry.duration;
    }
  }
  const assetId = frame?.assetId || appearance.assetId || visual.assetId;
  const asset = material.project.assets.find((entry) => entry.id === assetId);
  const origin = instanceOrigin(instance);
  const floatOffset = visual.float ? Math.sin(time * 2) * 5 : 0;
  const width = (!asset && visual.dot ? 10 : visual.width) * visual.scale * instance.scale;
  const height = (!asset && visual.dot ? 10 : visual.height) * visual.scale * instance.scale;
  const rgb = [1, 3, 5].map((index) => parseInt((appearance.tint || visual.tint).slice(index, index + 2), 16) / 255);
  return {
    object, visual, appearance, completedHidden, visible, enabled, frame, assetId,
    asset,
    origin,
    // Render-time bounds are distinct from the stable selection rectangle.
    renderRect: { x: origin.x + visual.offset.x * instance.scale * (instance.flipH ? -1 : 1) - width / 2, y: origin.y + (visual.offset.y + floatOffset) * instance.scale - height / 2, width, height },
    opacity: visible ? 1 : preview ? 0 : 0.2,
    outerTransform: `translate(${origin.x} ${origin.y}) scale(${instance.scale * (instance.flipH ? -1 : 1)} ${instance.scale})`,
    innerTransform: `translate(${visual.offset.x} ${visual.offset.y + floatOffset}) scale(${visual.scale * (visual.flipH ? -1 : 1)} ${visual.scale * (visual.flipV ? -1 : 1)})`,
    rgb,
    // Match the existing interactable preview and Godot placeholder base color.
    placeholderFill: `rgb(${[0.3, 0.85, 0.65].map((value, index) => Math.round(255 * value * rgb[index])).join(' ')})`,
  };
}
