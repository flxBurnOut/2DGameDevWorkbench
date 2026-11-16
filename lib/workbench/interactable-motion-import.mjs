import { documentMediaReference } from '../../features/editor-documents/media-references.mjs';
import { fail, selected } from './document-command-utils.mjs';

export function bindMotionAsset(project, command, { asset, frames }) {
  const object = selected(project.objects, [command.definitionId], 'definitionId')[0];
  const kind = command.target === 'toggle-state' ? 'toggle' : 'sequence';
  if (object.behavior.kind !== kind) fail('目标物件的行为类型已变化。');
  const entries = kind === 'toggle' ? object.behavior.states : object.behavior.entries;
  const entry = entries[command.index];
  if (!entry) fail('目标状态或序列条目已不存在。');

  if (asset.motionSource === 'state' && (command.durations || command.playback))
    fail('状态图是静态图片，没有播放节奏。');
  if (command.durations && command.durations.length !== frames.length)
    fail('逐帧时长数量必须与过渡帧数一致。');
  const sourceFrames = frames.map(({ bytes, sha256 }, i) => {
    const id = 'motion_' + sha256;
    const source = 'data:image/png;base64,' + bytes.toString('base64');
    const prior = project.assets.find(value => value.id === id);
    if (!prior) project.assets.push({ id, name: id + '.png', mime: 'image/png', source });
    else if (prior.mime !== 'image/png' || (prior.source !== source && prior.source !== documentMediaReference(sha256, 'image/png')))
      fail('同名的状态链素材已有不同内容。');
    return { assetId: id, duration: command.durations?.[i] ?? 1 };
  });
  // Ping-pong plays forward and back once; neither end frame repeats.
  const clipFrames = command.playback === 'ping_pong' && sourceFrames.length > 2
    ? [...sourceFrames, ...sourceFrames.slice(1, -1).reverse()] : sourceFrames;
  if (asset.motionSource === 'state') {
    Object.assign(entry.appearance, { assetId: clipFrames[0].assetId, animation: '', staticImage: true });
  } else {
    // Entries can be reordered and clips shared or edited. Reuse matching playback
    // and update only this entry's imported feedback, leaving other consumers intact.
    let clip = object.visual.clips.find(c => c.fps === asset.fps && !c.loop &&
      c.frames.length === clipFrames.length && c.frames.every((f, i) =>
        f.assetId === clipFrames[i].assetId && f.duration === clipFrames[i].duration && !f.region));
    if (!clip) {
      const base = 'transition_' + asset.revision.slice(0, 32);
      let name = base;
      for (let suffix = 2; object.visual.clips.some(c => c.name === name); suffix++)
        name = base + '_' + suffix;
      clip = { name, fps: asset.fps, loop: false, frames: clipFrames };
      object.visual.clips.push(clip);
    }
    const feedback = { type: 'play_animation', animation: clip.name, waitForEnd: true, importedTransition: true };
    const previous = entry.feedback.findIndex(step => step.type === 'play_animation' && step.importedTransition);
    if (previous === -1) entry.feedback.push(feedback);
    else entry.feedback[previous] = feedback;
  }
  return {
    type: command.type, definitionId: command.definitionId, target: command.target, index: command.index,
    assetId: asset.id, assetRevision: asset.revision, workId: asset.workId, workRevision: asset.workRevision,
    candidateIndex: asset.candidateIndex, stageIndex: asset.stageIndex, checkpointToken: asset.checkpointToken,
    frameHashes: frames.map(frame => frame.sha256), motionSource: asset.motionSource,
    ...(asset.derivation ? { derivation: asset.derivation } : {}),
    ...(command.durations ? { durations: command.durations } : {}),
    ...(command.playback ? { playback: command.playback } : {}),
  };
}
