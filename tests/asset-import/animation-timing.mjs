import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const server = await createTestViteServer({ root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'error', resolve: { alias: { '@': resolve(process.cwd()) } }, server: { middlewareMode: true } });
try {
  const { libraryAnimationTiming } = await server.ssrLoadModule('/lib/workbench/asset-import.ts');
  const { createProject, normalizeProject } = await server.ssrLoadModule('/features/interactable-editor/contract.mjs');
  const timing = libraryAnimationTiming({ fps: 12, loop: false, frameDurations: [0.5, 2, 1.25] }, 3);
  assert.equal(timing.durations.reduce((seconds, weight) => seconds + weight / timing.fps, 0), 0.3125, 'Nonuniform frame weights preserve the original playback length');
  const project = createProject();
  project.assets = timing.durations.map((_, index) => ({ id: `frame_${index}`, name: `frame_${index}.png`, mime: 'image/png', source: 'data:image/png;base64,AA==' }));
  project.objects[0].visual.clips = [{ name: 'imported', fps: timing.fps, loop: timing.loop, frames: project.assets.map((asset, index) => ({ assetId: asset.id, duration: timing.durations[index] })) }];
  project.objects[0].visual.idleAnimation = 'imported';
  assert.deepEqual(normalizeProject(project).objects[0].visual.clips[0].frames.map(frame => frame.duration), [0.5, 2, 1.25], 'The actual interactable contract retains imported timing');
  assert.deepEqual(libraryAnimationTiming({ fps: 9, loop: true }, 2).durations, [1, 1], 'Legacy uniform frames keep their original semantics');
  for (const asset of [{ fps: 1000, loop: true }, { fps: 12, loop: false, frameDurations: [1] }, { fps: 12, loop: false, frameDurations: [1, 0] }, { fps: 12, loop: false, frameDurations: [1, Infinity] }, { fps: 12, loop: false, frameDurations: [1, 101] }]) assert.throws(() => libraryAnimationTiming(asset, 2), /支持范围|时长/);
  console.log('Animation import timing: nonuniform playback, actual interactable validation, legacy frame defaults and unsupported timing rejection passed.');
} finally { await server.close(); }
