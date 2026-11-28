import {
  createObject,
  createProject,
  normalizeProject,
  type Asset,
  type Clip,
} from '@/features/interactable-editor/contract.mjs';
import {
  base64Bytes,
  sha256Hex,
} from '@/features/interactable-motion/png-rgba';
import {
  motionRequest,
  motionUrl,
  type MotionCandidate,
  type MotionWork,
} from '@/components/sprite-generator/open-motion-model';
import {
  nodeImageUrl,
  type GraphEdge,
  type GraphNode,
} from '@/components/interactable-motion/motion-graph';
import type { Playback } from '@/components/interactable-motion/transition-canvas';

export type Rhythm = { durations?: number[]; playback?: Playback };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Materialize hash-bound playback bytes into an independent editor source project. */
export async function motionProject(
  work: MotionWork,
  candidate: MotionCandidate,
  graph: Graph,
  rhythms: Record<number, Rhythm>,
) {
  const job = work.job;
  if (!job || candidate.status !== 'approved')
    throw new Error('请先采用完整候选。');
  const project = createProject(),
    prop = createObject('sequence');
  project.objects = [prop];
  project.name = work.plan?.title || work.character.display_name;
  prop.displayName = work.character.display_name;
  prop.visual.width = prop.visual.height = work.character.cell_width;
  const assets = new Map<string, Asset>();
  async function assetAt(url: string, hash: string, name: string) {
    const prior = assets.get(hash);
    if (prior) return prior.id;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('帧来源已改变，请刷新作品。');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if ((await sha256Hex(bytes)) !== hash)
      throw new Error('素材与采用的版本不一致。');
    const asset = {
      id: 'img_' + hash.slice(0, 24),
      name: name + '.png',
      mime: 'image/png',
      source: 'data:image/png;base64,' + base64Bytes(bytes),
    };
    assets.set(hash, asset);
    return asset.id;
  }
  const states = candidate.state_chain || [];
  if (!states.length || states.length !== graph.nodes.length)
    throw new Error('请先确认所有状态与过渡。');
  const initial = motionUrl(`open-motion/${work.id}/reference`, {
    revision: String(work.revision),
    expected_sha256: states[0].sha256,
  });
  const entries = [];
  for (const node of graph.nodes) {
    const state = states[node.index],
      url = nodeImageUrl(node, work, initial);
    if (!state?.sha256 || !url) throw new Error('当前状态缺少确认的像素。');
    const assetId = await assetAt(url, state.sha256, state.name);
    if (node.index === 0) prop.visual.assetId = assetId;
    entries.push({
      name: node.name,
      pages: [],
      appearance: {
        assetId,
        animation: '',
        visible: true,
        solidEnabled: false,
        tint: '#ffffff',
      },
      feedback: [] as {
        type: 'play_animation';
        animation: string;
        waitForEnd: boolean;
      }[],
    });
  }
  for (const edge of graph.edges) {
    if (!edge.timeline || edge.status !== 'accepted')
      throw new Error('所选过渡尚未确认。');
    const source = candidate.frames.slice(
      edge.timeline.start,
      edge.timeline.start + edge.timeline.count,
    );
    if (source.length !== edge.timeline.count || !source.length)
      throw new Error('该过渡缺少已确认的帧。');
    const rhythm = rhythms[edge.stage],
      frames: Clip['frames'] = [];
    for (const [i, f] of source.entries()) {
      const url = motionUrl(
        `jobs/${job.job_id}/candidates/${candidate.candidate_index}/frames/${f.index}/image`,
        { revision: String(job.revision), expected_sha256: f.sha256 },
      );
      frames.push({
        assetId: await assetAt(
          url,
          f.sha256,
          `stage-${edge.stage + 1}-${i + 1}`,
        ),
        duration: rhythm?.durations?.[i] ?? 1,
      });
    }
    if (rhythm?.playback === 'ping_pong')
      frames.push(...frames.slice(1, -1).reverse());
    const clip = {
      name: `transition_${edge.stage + 1}`,
      fps: job.action.fps,
      loop: rhythm?.playback === 'loop',
      frames,
    };
    prop.visual.clips.push(clip);
    entries[edge.to].feedback.push({
      type: 'play_animation',
      animation: clip.name,
      waitForEnd: !clip.loop,
    });
  }
  prop.behavior.entries = entries.slice(1);
  prop.behavior.onEnd = 'stay_last';
  project.assets = [...assets.values()];
  const current = await motionRequest<MotionWork>('open-motion/' + work.id);
  if (
    current.revision !== work.revision ||
    !current.job?.candidates.some(
      (c) =>
        c.candidate_index === candidate.candidate_index &&
        c.status === 'approved' &&
        c.review_token === candidate.review_token,
    )
  )
    throw new Error('作品已更新，请重新检查后移送。');
  return normalizeProject(project);
}
