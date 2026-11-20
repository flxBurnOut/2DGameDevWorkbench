// Pure modules of the interactable motion panel: exact PNG codec, deterministic
// frame tools, state-graph model and the slot-binding view. No services, no providers.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createTestViteServer } from '../helpers/vite-server.mjs';
import { motionSlotBindings } from '../../lib/workbench/interactable-motion-bindings.mjs';
import { bindMotionAsset } from '../../lib/workbench/interactable-motion-import.mjs';
import { createObject, createProject } from '../../features/interactable-editor/contract.mjs';

const server = await createTestViteServer({
  root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': resolve(process.cwd()) } }, server: { middlewareMode: true },
});
const tests = [];
const test = (name, run) => tests.push({ name, run });
try {
  const png = await server.ssrLoadModule('/features/interactable-motion/png-rgba.ts');
  const tools = await server.ssrLoadModule('/features/interactable-motion/frame-tools.ts');
  const graph = await server.ssrLoadModule('/components/interactable-motion/motion-graph.ts');
  const { workbenchModules } = await server.ssrLoadModule('/lib/workbench/modules.ts');
  const { workspaceGroups } = await server.ssrLoadModule('/lib/workbench/navigation.ts');
  const archive = new URL('../../examples/n2-pilot-20261110/lamp/seed-2202/', import.meta.url);
  const frame = n => readFile(new URL('f' + String(n).padStart(2, '0') + '.png', archive));

  test('PNG codec reads provider frames and other colour types exactly and round-trips semi-transparent pixels', async () => {
    for (const bytes of [await frame(1), await frame(5)]) {
      const decoded = await png.decodePng(bytes);
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(decoded.width, info.width);
      assert.deepEqual(Buffer.from(decoded.pixels), data);
      const again = await png.decodePng(await png.encodePng(decoded));
      assert.deepEqual(again.pixels, decoded.pixels);
    }
    const pixels = Uint8Array.from({ length: 4 * 16 }, (_, i) => (i * 37) % 256);
    const encoded = await png.encodePng({ width: 4, height: 4, pixels });
    assert.deepEqual((await png.decodePng(encoded)).pixels, pixels);
    const { data } = await sharp(Buffer.from(encoded)).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual(Uint8Array.from(data), pixels, 'an independent decoder reads the same RGBA bytes');
    const rgb = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#336699' } }).png().toBuffer();
    const palette = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 0.5 } } }).png({ palette: true }).toBuffer();
    assert.deepEqual(Array.from((await png.decodePng(rgb)).pixels.slice(0, 4)), [0x33, 0x66, 0x99, 255]);
    const indexed = await png.decodePng(palette);
    const reference = (await sharp(palette).ensureAlpha().raw().toBuffer());
    assert.deepEqual(Buffer.from(indexed.pixels), reference);
    assert.equal(png.base64Bytes(png.bytesFromBase64('AAEC/w==')), 'AAEC/w==');
  });

  test('backfill, alignment and cleanup only change pixels inside the region they report', async () => {
    const reference = await png.decodePng(await frame(1));
    const source = await png.decodePng(await frame(4));
    const { width, height } = reference;
    const fixed = tools.boxMask(width, height, [{ x0: 0, y0: 90, x1: 128, y1: 128 }]);
    const occluded = tools.boxMask(width, height, [{ x0: 60, y0: 90, x1: 70, y1: 100 }]);
    const out = tools.backfillFixed(reference.pixels, source.pixels, fixed, occluded);
    for (let i = 0; i < width * height; i++) {
      const px = a => a.slice(i * 4, i * 4 + 4).join();
      if (!fixed[i] || occluded[i]) assert.equal(px(out), px(source.pixels), `pixel ${i} outside the authorized fixed region changed`);
      else assert.equal(px(out), px(reference.pixels));
    }
    const patch = tools.framePatch(3, 'a'.repeat(64), source.pixels, out);
    const covered = new Uint8Array(width * height);
    let end = -1;
    for (const span of patch.region.spans) { assert.ok(span.start >= end); covered.fill(1, span.start, span.start + span.length); end = span.start + span.length; }
    const changed = tools.changedMask(source.pixels, out);
    assert.ok(changed.every((v, i) => !v || covered[i]), 'every changed pixel is inside the submitted region');
    assert.equal(tools.framePatch(0, 'a'.repeat(64), source.pixels, source.pixels), null);

    const shifted = tools.translate(reference.pixels, width, height, 2, -1);
    const all = tools.boxMask(width, height, [{ x0: 0, y0: 0, x1: width, y1: height }]);
    const offset = tools.detectOffset(reference.pixels, shifted, width, height, all);
    assert.deepEqual([offset.x, offset.y, offset.after < offset.before], [-2, 1, true]);
    const realigned = tools.translate(shifted, width, height, offset.x, offset.y);
    assert.equal(tools.maskedDifference(reference.pixels, realigned, tools.boxMask(width, height, [{ x0: 2, y0: 0, x1: width - 2, y1: height - 1 }])), 0);

    // T3 must skip shifts that would crop visible foreground pixels off the canvas edge.
    const edgeRef = new Uint8Array(4 * 32 * 32);
    const edgeFrame = new Uint8Array(4 * 32 * 32);
    edgeRef.set([200, 100, 50, 255], (10 * 32 + 10) * 4);
    edgeFrame.set([200, 100, 50, 255], (10 * 32 + 11) * 4);
    edgeFrame.set([90, 90, 220, 255], (15 * 32 + 0) * 4); // visible pixel at x=0
    const edgeFixed = tools.boxMask(32, 32, [{ x0: 8, y0: 8, x1: 14, y1: 14 }]);
    const edgeOffset = tools.detectOffset(edgeRef, edgeFrame, 32, 32, edgeFixed, 2);
    assert.equal(edgeOffset.x, 0, 'detectOffset must not crop visible pixel at x=0');

    const noisy = new Uint8Array(4 * 25);
    noisy.set([9, 9, 9, 255], 4 * 12); // isolated pixel
    noisy.set([9, 9, 9, 10], 0);   // faint pixel
    for (const i of [20, 21, 22]) noisy.set([1, 2, 3, 255], 4 * i);
    const clean = tools.cleanup(noisy, 5, 5, { alphaBelow: 32, isolated: true });
    assert.deepEqual([clean[4 * 12 + 3], clean[3], clean[4 * 21 + 3]], [0, 0, 255]);
  });

  test('palette, rotation, seam and playback helpers are deterministic', async () => {
    const reference = await png.decodePng(await frame(1));
    const { width, height } = reference;
    let colour = null;
    for (let i = 0; i < width * height && !colour; i++) if (reference.pixels[i * 4 + 3]) colour = Array.from(reference.pixels.slice(i * 4, i * 4 + 3));
    const hex = '#' + colour.map(v => v.toString(16).padStart(2, '0')).join('');
    const mapped = tools.paletteMap(reference.pixels, null, [{ source: hex, target: '#ff00ff' }]);
    for (let i = 0; i < width * height; i++) assert.equal(mapped[i * 4 + 3], reference.pixels[i * 4 + 3]);
    assert.ok(tools.maskCount(tools.changedMask(reference.pixels, mapped)) > 0);
    const moving = tools.boxMask(width, height, [{ x0: 40, y0: 20, x1: 90, y1: 70 }]);
    const pivot = { x: 64, y: 64 };
    assert.deepEqual(tools.rotatePart(reference.pixels, width, height, moving, pivot, 0), reference.pixels, 'angle 0 reproduces the start state exactly');
    const turned = tools.rotatePart(reference.pixels, width, height, moving, pivot, 30);
    const outside = tools.subtractMask(tools.boxMask(width, height, [{ x0: 0, y0: 0, x1: width, y1: height }]), tools.boxMask(width, height, [{ x0: 0, y0: 0, x1: 128, y1: 110 }]));
    assert.equal(tools.maskedDifference(reference.pixels, turned, outside), 0);
    assert.deepEqual(tools.rotationAngles(5, 0, 40), [0, 10, 20, 30, 40]);
    assert.equal(tools.seamDifference(reference.pixels, reference.pixels).changed, 0);
    assert.deepEqual(tools.maskSpans(Uint8Array.from([1, 1, 0, 1, 0, 0, 0, 1])), [{ start: 0, length: 2 }, { start: 3, length: 1 }, { start: 7, length: 1 }]);
    assert.deepEqual(tools.maskSpans(Uint8Array.from([1, 1, 0, 1, 0, 0, 0, 1]), 1), [{ start: 0, length: 4 }, { start: 7, length: 1 }]);
    const canvas = await server.ssrLoadModule('/components/interactable-motion/transition-canvas.tsx');
    assert.deepEqual(canvas.playbackOrder(4, 'ping_pong'), [0, 1, 2, 3, 2, 1]);
    assert.deepEqual(canvas.playbackOrder(4, 'once'), [0, 1, 2, 3]);
  });

  test('state drafts serialize to a description and skeleton; works map to nodes, edges and one primary action', () => {
    const toggle = graph.defaultDraft('toggle', ['关', '开']);
    assert.deepEqual(toggle.states.map(s => s.name), ['关', '开']);
    assert.deepEqual(graph.draftProblems(toggle), ['描述原图之后每个状态的外观']);
    toggle.states[1].appearance = '拉杆转到右侧，底座不动';
    assert.deepEqual(graph.draftProblems(toggle), []);
    const { description, ending } = graph.draftDescription(toggle);
    assert.match(description, /「关」 → 「开」/);
    assert.equal(ending, '停在「开」');
    assert.deepEqual(graph.draftSkeleton(toggle).states.map(s => s.name), ['关', '开']);
    assert.deepEqual(graph.draftSkeleton({ ...toggle, returnToStart: true }).states.map(s => s.name), ['关', '开', '关']);
    const sequence = graph.defaultDraft('sequence', ['一', '二', '三', '四', '五', '六']);
    assert.equal(sequence.states.length, graph.draftLimits.states);
    assert.ok(graph.draftProblems({ ...sequence, returnToStart: true }).some(p => p.includes('回到初始状态')));
    assert.ok(graph.draftProblems({ ...toggle, states: [toggle.states[0], { ...toggle.states[1], name: '关' }] }).includes('状态名称不能重复'));

    const empty = graph.workGraph(null, 1, toggle);
    assert.deepEqual(empty.edges.map(e => [e.from, e.to, e.status]), [[0, 1, 'draft']]);
    assert.equal(graph.panelStatus(null, 1, toggle, '').missing[0], '选择交互物对象');
    assert.equal(graph.panelStatus(null, 1, toggle, 'lamp').action, 'plan');

    const stage = (name, endpoint) => ({ name, goal: name, prompt: name, frame_count: 4, first_frame: 'original', last_frame: 'previous', acceptance: [], checkpoint: { endpoint, rhythm: 'r', reason: 'r' } });
    const work = {
      id: 'w', revision: 2, latest_revision: 2, status: 'ready', message: '', spec: { object_id: 'lamp', loop: false }, end_targets: [{ stage: 1, sha256: 'b'.repeat(64), note: 'n' }],
      plan: { title: 't', questions: [], stages: [stage('s1', '半亮'), stage('s2', '全亮')], quality: { interactable: { initial_state: '灰', target_state: '全亮' } } },
      job: null,
    };
    let result = graph.workGraph(work, 1, toggle);
    assert.deepEqual(result.nodes.map(n => [n.name, n.source]), [['灰', 'reference'], ['半亮', 'text'], ['全亮', 'target']]);
    assert.deepEqual(result.edges.map(e => e.status), ['planned', 'planned']);
    assert.equal(graph.panelStatus(work, 1, toggle, 'lamp').action, 'generate');
    const candidate = {
      candidate_index: 1, status: 'running', frames: [], warnings: [], hard_failures: [],
      state_chain: [{ name: '灰', stage: null, sha256: 'a'.repeat(64) }, { name: '半亮', stage: 0, sha256: 'c'.repeat(64) }],
      plan_execution: { stages: [{ state: 'accepted', actual_frame_count: 4 }, { state: 'awaiting_review', actual_frame_count: 5 }], timeline: [] },
    };
    work.job = { job_id: 'j', candidates: [candidate], plan_control: { enabled: false, message: '' } };
    result = graph.workGraph(work, 1, toggle);
    assert.deepEqual(result.nodes.map(n => n.source), ['reference', 'confirmed', 'target']);
    assert.equal(result.nodes[1].image.path, 'candidates/1/stages/0/state-image');
    assert.deepEqual(result.edges.map(e => [e.status, e.frames]), [['accepted', 4], ['awaiting_review', 4]]);
    const status = graph.panelStatus(work, 1, toggle, 'lamp');
    assert.equal(status.action, 'review-stage');
    assert.equal(status.missing[0], '确认第 2 段过渡');
    candidate.plan_execution.stages[1].state = 'accepted';
    candidate.status = 'approved';
    assert.equal(graph.panelStatus(work, 1, toggle, 'lamp').action, 'writeback');
    assert.equal(graph.panelStatus({ ...work, revision: 1 }, 1, toggle, 'lamp').action, 'none');
    assert.equal(graph.panelHref({ work: 'w', version: undefined }, { documentId: 'doc', definitionId: 'lever' }), '/tools/interactable-motion?work=w&document=doc&definition=lever');
  });

  test('saved state drafts restore a return to the initial state and bind targets to the preceding stages', () => {
    const draft = graph.defaultDraft('toggle', ['关', '开'], true);
    draft.states[0].appearance = '亮'.repeat(graph.draftLimits.appearance);
    draft.states[1] = { name: '关', appearance: '灯面熄灭', targetPng: 'fixture' };
    draft.loop = true;
    draft.hold = '停留半秒';
    draft.returnToStart = true;
    const skeleton = graph.draftSkeleton(draft);
    assert.deepEqual(skeleton.states.map(s => s.name), ['开', '关', '开']);
    assert.equal(skeleton.states[2].appearance.length, graph.draftLimits.appearance);
    assert.equal(graph.draftTransitionCount(draft), 2);
    const work = { spec: { interactable_skeleton: skeleton, loop: true, return_to_reference: true } };
    const restored = graph.draftFromWork(work);
    assert.deepEqual(restored, { ...draft, states: draft.states.map(({ name, appearance }) => ({ name, appearance })) });
    assert.deepEqual(graph.pendingDraftTargets(work, draft), [{ name: '关', png: 'fixture', stage: 0 }]);
    assert.deepEqual(graph.pendingDraftTargets({ ...work, end_targets: [{ stage: 0 }] }, draft), []);
  });

  test('historical state and target URLs carry their exact work revision and pixel hash', () => {
    const work = { id: 'w', revision: 2, latest_revision: 3 };
    const sha256 = 'a'.repeat(64);
    for (const path of ['candidates/1/stages/0/state-image', 'targets/1']) {
      const url = new URL(graph.nodeImageUrl({ index: 1, image: { path, sha256 } }, work, ''), 'http://example.test');
      assert.equal(url.searchParams.get('path'), `open-motion/w/${path}`);
      assert.equal(url.searchParams.get('revision'), '2');
      assert.equal(url.searchParams.get('expected_sha256'), sha256);
    }
  });

  test('toggle writeback suggestions require the graph to start in the bound initial state', async () => {
    const { proposedSlots } = await server.ssrLoadModule('/components/interactable-motion/writeback-tab.tsx');
    const entries = ['关', '开'];
    const toggle = graph.defaultDraft('toggle', entries, true);
    const chain = graph.workGraph(null, 1, toggle);
    const choices = [
      { assetId: 'reference', source: 'state', stage: null },
      { assetId: 'end', source: 'state', stage: 0 },
      { assetId: 'forward', source: 'transition', stage: 0 },
      { assetId: 'reverse-other-stage', source: 'transition', derived: 'reverse', stage: 1 },
    ];
    const automatic = (value, assets = choices) =>
      proposedSlots('toggle', entries, true, value.nodes, value.edges, assets).map(slot => [slot.index, slot.suggested]);
    assert.deepEqual(automatic(chain), [[1, 'reference'], [0, 'end'], [0, 'forward'], [1, undefined]]);
    assert.deepEqual(automatic(chain, [...choices, { assetId: 'back', source: 'transition', derived: 'reverse', stage: 0 }]).at(-1), [1, 'back']);
    const reversed = graph.workGraph(null, 1, graph.defaultDraft('toggle', entries));
    assert.deepEqual(automatic(reversed), [[1, undefined], [0, undefined], [0, undefined], [1, undefined]]);
  });

  test('slot bindings report the last import per slot and whether the content still uses it', () => {
    const project = createProject();
    project.objects = [createObject('toggle')];
    const [object] = project.objects;
    const hashes = ['1', '2', '3'].map(c => c.repeat(64));
    const frames = hashes.map(sha256 => ({ sha256, bytes: Buffer.from(sha256) }));
    const asset = (motionSource, extra = {}) => ({ id: `motion-${motionSource}:j:1:1`, revision: 'f'.repeat(64), motionSource, fps: 8, workId: 'w', workRevision: 1, candidateIndex: 1, stageIndex: 0, checkpointToken: 'e'.repeat(64), ...extra });
    const command = (motionSource, extra = {}) => ({ type: 'import-motion-asset', definitionId: object.definitionId, target: 'toggle-state', index: 1, ...extra });
    const results = [
      bindMotionAsset(project, command('state'), { asset: asset('state'), frames: frames.slice(2) }),
      bindMotionAsset(project, command('transition', { durations: [1, 1, 3], playback: 'ping_pong' }), { asset: asset('transition', { derivation: 'reverse' }), frames }),
    ];
    const clip = object.visual.clips.at(-1);
    assert.deepEqual(clip.frames.map(f => f.duration), [1, 1, 3, 1]);
    const [view] = motionSlotBindings(project, [{ revision: 2, commandResults: results }], object.definitionId);
    assert.equal(view.kind, 'toggle');
    assert.deepEqual([view.slots[1].state.current, view.slots[1].transition.current, view.slots[1].transition.derivation], [true, true, 'reverse']);
    assert.equal(view.slots[0].state, null);
    object.behavior.states[1].appearance.assetId = 'other';
    clip.frames.pop();
    const [after] = motionSlotBindings(project, [{ revision: 2, commandResults: results }]);
    assert.deepEqual([after.slots[1].state.current, after.slots[1].transition.current], [false, false]);
    assert.throws(() => bindMotionAsset(project, command('state', { durations: [2] }), { asset: asset('state'), frames: frames.slice(2) }), /静态图片/);
  });

  test('the panel is a registered editor module listed before the interactable editor', () => {
    const panel = workbenchModules.find(m => m.id === 'interactable-motion');
    assert.equal(panel.href, '/tools/interactable-motion');
    assert.equal(panel.executable, false);
    const line = workspaceGroups.find(g => g.id === 'interactable');
    assert.deepEqual(line.tools.map(t => t.id), ['interactable-motion', 'interactable-editor']);
    assert.deepEqual(workspaceGroups.flatMap(g => g.tools.map(t => t.name)), ['角色原图', '角色动画', '交互物动画', '交互物编辑']);
  });

  for (const { name, run } of tests) {
    await run();
    console.log(`ok - ${name}`);
  }
} finally {
  await server.close();
}
