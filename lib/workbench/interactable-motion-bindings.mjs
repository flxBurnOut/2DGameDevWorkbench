// Read-only view of which open-motion assets are bound to each toggle state or
// sequence entry. Bindings come from the document's own command history; the
// current content decides whether each binding is still in place.

const sourceOf = (result) => result.motionSource || (String(result.assetId).startsWith('motion-transition:') ? 'transition'
  : String(result.assetId).startsWith('motion-state:') ? 'state' : null);

function binding(result, revision) {
  return {
    assetId: result.assetId, assetRevision: result.assetRevision, workId: result.workId, workRevision: result.workRevision,
    candidateIndex: result.candidateIndex, stageIndex: result.stageIndex ?? null, checkpointToken: result.checkpointToken,
    frameHashes: result.frameHashes || [], documentRevision: revision,
    ...(result.derivation ? { derivation: result.derivation } : {}),
    ...(result.durations ? { durations: result.durations } : {}),
    ...(result.playback ? { playback: result.playback } : {}),
  };
}

function stateCurrent(entry, record) {
  return Boolean(record && entry.appearance?.assetId === 'motion_' + record.frameHashes[0] && entry.appearance.staticImage);
}

function transitionCurrent(object, entry, record) {
  if (!record) return false;
  const step = (entry.feedback || []).find(s => s.type === 'play_animation' && s.importedTransition);
  const clip = step && object.visual.clips.find(c => c.name === step.animation);
  if (!clip) return false;
  const expected = record.playback === 'ping_pong' && record.frameHashes.length > 2
    ? [...record.frameHashes, ...record.frameHashes.slice(1, -1).reverse()] : record.frameHashes;
  return clip.frames.length === expected.length && clip.frames.every((f, i) => f.assetId === 'motion_' + expected[i]);
}

/**
 * @param content current interactable project content
 * @param history [{ revision, commandResults }] in revision order
 */
export function motionSlotBindings(content, history, definitionId) {
  const objects = content.objects.filter(o => (!definitionId || o.definitionId === definitionId) && ['toggle', 'sequence'].includes(o.behavior.kind));
  const latest = new Map();
  for (const { revision, commandResults } of history) {
    for (const result of commandResults || []) {
      if (result?.type !== 'import-motion-asset') continue;
      const source = sourceOf(result);
      if (!source) continue;
      latest.set(`${result.definitionId}:${result.target}:${result.index}:${source}`, binding(result, revision));
    }
  }
  return objects.map(object => {
    const target = object.behavior.kind === 'toggle' ? 'toggle-state' : 'sequence-entry';
    const entries = object.behavior.kind === 'toggle' ? object.behavior.states : object.behavior.entries;
    return {
      definitionId: object.definitionId, name: object.displayName, kind: object.behavior.kind, target,
      ...(object.behavior.kind === 'toggle' ? { initialToggle: Boolean(object.behavior.initialToggle) } : {}),
      slots: entries.map((entry, index) => {
        const state = latest.get(`${object.definitionId}:${target}:${index}:state`) || null;
        const transition = latest.get(`${object.definitionId}:${target}:${index}:transition`) || null;
        return {
          index, name: entry.name,
          state: state && { ...state, current: stateCurrent(entry, state) },
          transition: transition && { ...transition, current: transitionCurrent(object, entry, transition) },
          // A static image placed by other means is reported, never attributed to a work.
          otherImage: !state && entry.appearance?.assetId ? entry.appearance.assetId : null,
        };
      }),
    };
  });
}
