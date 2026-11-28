import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import {
  committedState,
  initialState,
  stateAppearance,
} from '../../features/interactable-editor/simulator.mjs';
import { createTestViteServer } from '../helpers/vite-server.mjs';

// The Python test supplies an isolated, reviewed two-transition animation over HTTP.
const workId = process.argv[2];
assert.match(workId, /^[a-f0-9]{32}$/);
const root = process.cwd();
const vite = await createTestViteServer({
  root,
  configFile: false,
  appType: 'custom',
  resolve: { alias: { '@': root } },
  logLevel: 'error',
  server: { middlewareMode: true },
});
const nativeFetch = globalThis.fetch;
try {
  const route = await vite.ssrLoadModule(
    '/app/api/workbench/open-motion/route.ts',
  );
  const { motionRequest, motionUrl } = await vite.ssrLoadModule(
    '/components/sprite-generator/open-motion-model.ts',
  );
  const { workGraph } = await vite.ssrLoadModule(
    '/components/interactable-motion/motion-graph.ts',
  );
  const { motionProject } = await vite.ssrLoadModule(
    '/features/interactable-motion/delivery.ts',
  );
  const origin = new URL(
    process.env.WORKBENCH_FRONTEND_URL || 'http://localhost:3000',
  ).origin;
  globalThis.fetch = async (url, init) => {
    if (typeof url !== 'string' || !url.startsWith('/api/workbench/'))
      return nativeFetch(url, init);
    const request = new Request(new URL(url, origin), init);
    request.headers.set('origin', origin);
    return route[request.method](request);
  };
  const source = 'open-motion/' + workId;
  const work = await motionRequest(source);
  const { interactableMotionHref } = await vite.ssrLoadModule(
    '/lib/workbench/motion-routes.ts',
  );
  const legacyLink = new URL(
    interactableMotionHref('?job=' + work.job.job_id + '&candidate=2', {
      work: work.id,
      revision: work.revision,
    }),
    origin,
  );
  assert.equal(legacyLink.pathname, '/tools/interactable-motion');
  assert.deepEqual(Object.fromEntries(legacyLink.searchParams), {
    candidate: '2',
    work: work.id,
    version: String(work.revision),
  });
  const graph = workGraph(work);
  const candidate = work.job.candidates[0];
  const project = await motionProject(work, candidate, graph, {});
  const object = project.objects[0],
    hashes = new Map(
      project.assets.map((a) => [
        a.id,
        createHash('sha256')
          .update(Buffer.from(a.source.split(',')[1], 'base64'))
          .digest('hex'),
      ]),
    );
  let state = initialState(object);
  assert.equal(
    hashes.get(object.visual.assetId),
    candidate.state_chain[0].sha256,
  );
  assert.equal(object.behavior.entries.length, 2);
  for (const edge of graph.edges) {
    const clip = object.visual.clips.find(
      (c) =>
        c.name === object.behavior.entries[edge.stage].feedback[0].animation,
    );
    assert.deepEqual(
      clip.frames.map((f) => hashes.get(f.assetId)),
      candidate.frames
        .slice(edge.timeline.start, edge.timeline.start + edge.timeline.count)
        .map((f) => f.sha256),
    );
    state = committedState(object, state);
    assert.equal(
      hashes.get(stateAppearance(object, state).assetId),
      candidate.state_chain[edge.to].sha256,
    );
  }
  const damaged = structuredClone(candidate);
  damaged.frames[0].sha256 = '0'.repeat(64);
  await assert.rejects(() => motionProject(work, damaged, graph, {}));
  const exported = await motionRequest(source + '/export', {
    expected_revision: work.revision,
    candidate_index: 1,
  });
  const artifact = (kind) =>
    fetch(
      motionUrl('jobs/' + exported.job.job_id + '/exports/' + kind, {
        revision: String(exported.job.revision),
      }),
    );
  const zipResponse = await artifact('godot');
  assert.equal(zipResponse.status, 200);
  const zip = await JSZip.loadAsync(await zipResponse.arrayBuffer());
  const resource = Object.keys(zip.files).find(
    (name) => path.basename(name) === 'sprite_frames.tres',
  );
  assert.match(
    await zip.file(resource).async('string'),
    /gd_resource type="SpriteFrames"/,
  );
  for (const [kind, mime] of [
    ['sheet', 'image/png'],
    ['preview', 'image/gif'],
  ]) {
    const response = await artifact(kind);
    assert.equal(response.headers.get('content-type'), mime);
    assert.ok((await response.arrayBuffer()).byteLength > 50);
  }
  console.log(
    'Two playable transitions, exact source bytes, stale-frame rejection and all three exports passed.',
  );
} finally {
  globalThis.fetch = nativeFetch;
  await vite.close();
}
