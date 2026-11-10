// Read-only affordance report for one saved scene: decodes the scene's art and
// collision, runs the pure surface comparison and reachability analysis, and
// writes a report plus an overlay image. It never edits a document or calls a model.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { validateScene, sceneBounds, instanceOrigin } from '../../features/scene-composer/model.mjs';
import {
  activeMapCollisions,
  mapSplitElementOrigin,
  objectRenderState,
  sceneDisplayOrder,
} from '../../features/scene-composer/render-model.mjs';
import {
  compareSurfaces,
  createGrid,
  physicalSurfaces,
  polygonBounds,
  rasterizePolygon,
  rasterizeRect,
  resolvePlayer,
  resolveSurfaceOptions,
  unionRect,
  visualSurfaces,
} from '../../features/scene-composer/affordance.mjs';
import { analyzeReachability } from '../../features/scene-composer/reachability.mjs';
import { imageResource, observeScene } from './scene-observation.mjs';

export const AFFORDANCE_REPORT_VERSION = 1;
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function decodeRgba(png, width, height, { flipH = false, flipV = false } = {}) {
  let image = sharp(png).ensureAlpha();
  if (width && height) image = image.resize(width, height, { fit: 'fill', kernel: 'nearest' });
  if (flipH) image = image.flop();
  if (flipV) image = image.flip();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function alphaMask(rgba, x0, y0, ownership) {
  const alpha = new Uint8Array(rgba.width * rgba.height);
  for (let i = 0; i < alpha.length; i++)
    alpha[i] = ownership && ownership[i] < 128 ? 0 : rgba.data[i * 4 + 3];
  return { x0: Math.round(x0), y0: Math.round(y0), width: rgba.width, height: rgba.height, alpha };
}

function shapeBounds(shape, instance, origin) {
  const sx = instance.scale * (instance.flipH ? -1 : 1);
  const width = (shape.type === 'circle' ? shape.radius * 2 : shape.width) * instance.scale;
  const height = (shape.type === 'circle' ? shape.radius * 2 : shape.type === 'capsule' ? Math.max(shape.height, shape.width) : shape.height) * instance.scale;
  return { x: origin.x + shape.offset.x * sx - width / 2, y: origin.y + shape.offset.y * instance.scale - height / 2, width, height };
}

/** Art and collision in world coordinates, export view (included nodes only). */
export async function collectSceneGeometry(root, manifest, scene) {
  const diagnostics = [];
  const candidates = [];
  const solids = [];
  const display = sceneDisplayOrder(scene);
  const actorIndex = display.findIndex((entry) => entry.kind === 'actor');
  const inFront = (entry) => actorIndex >= 0 && display.indexOf(entry) < actorIndex;
  const split = scene.mapSplit && !scene.mapSplit.stale ? scene.mapSplit : null;
  const load = (source) => imageResource(root, manifest, source);

  if (split) {
    for (const entry of display) {
      if (entry.kind !== 'map-split-part') continue;
      const { element, part, rect } = entry;
      if (!element.included || element.kind === 'background') continue;
      // Decision: only parts drawn behind the player can be perceived as standable.
      if (part.role !== 'art' || part.plane !== 'back') continue;
      const resource = await load(part.source);
      const rgba = await decodeRgba(resource.png);
      const ownership = part.mask ? (await sharp((await load(part.mask)).png).greyscale().raw().toBuffer()) : null;
      candidates.push({
        key: `${element.id}:${part.id}`,
        elementId: element.id,
        source: 'map-split',
        label: element.kind === 'surface' ? 'ground' : 'unlabeled',
        mask: alphaMask(rgba, rect.x, rect.y, ownership),
      });
    }
    for (const element of split.elements) {
      if (!element.included || !element.collision.enabled) continue;
      const origin = mapSplitElementOrigin(scene, element);
      for (const points of element.collision.polygons)
        solids.push({ owner: element.id, points: points.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y })) });
    }
  } else if (scene.map) {
    const bounds = sceneBounds(scene);
    for (const entry of display) {
      if (entry.kind !== 'layer' || !entry.layer.included) continue;
      if (inFront(entry)) continue;
      const resource = await load(entry.layer.source);
      const rgba = await decodeRgba(resource.png, entry.layer.width, entry.layer.height);
      let transparent = 0;
      for (let i = 3; i < rgba.data.length; i += 4) if (rgba.data[i] < 128) transparent++;
      if (transparent / (rgba.width * rgba.height) < 0.02) {
        diagnostics.push({ code: 'opaque-layer', layerId: entry.layer.id, message: '整张不透明的地图层无法区分可站区域；请先做地图分层再分析画面。' });
        continue;
      }
      candidates.push({ key: entry.layer.id, source: 'map-layer', label: 'unlabeled', mask: alphaMask(rgba, bounds.x, bounds.y) });
    }
  }
  if (scene.map)
    for (const { index, points } of activeMapCollisions(scene))
      solids.push({ owner: `map:${index}`, points: points.map((p) => ({ x: p.x + scene.map.offset.x, y: p.y + scene.map.offset.y })) });

  for (const entry of display) {
    if (entry.kind !== 'instance' || !entry.instance.included) continue;
    const { instance } = entry;
    const material = scene.materials.find((m) => m.id === instance.materialId);
    if (!material) continue;
    const state = objectRenderState(instance, material, { preview: true });
    const { object } = state;
    if (object.solid?.enabled)
      solids.push({ owner: instance.id, rect: shapeBounds(object.solid.shape, instance, instanceOrigin(instance)) });
    if (!state.visible || !state.asset || inFront(entry)) continue;
    const r = state.renderRect;
    const width = Math.max(1, Math.round(Math.abs(r.width)));
    const height = Math.max(1, Math.round(Math.abs(r.height)));
    const resource = await load(state.asset.source);
    const rgba = await decodeRgba(resource.png, width, height, {
      flipH: Boolean(instance.flipH) !== Boolean(state.visual.flipH),
      flipV: Boolean(state.visual.flipV),
    });
    candidates.push({ key: instance.id, elementId: instance.id, source: 'instance', label: 'unlabeled', mask: alphaMask(rgba, r.x, r.y) });
  }
  if (!candidates.length)
    diagnostics.push({ code: 'no-visual-candidates', message: '没有可用于推断的画面候选；可站面对比只剩碰撞一侧。' });
  return { candidates, solids, diagnostics };
}

export async function analyzeScene(root, manifest, scene, input = {}) {
  const player = resolvePlayer(input.player);
  const options = resolveSurfaceOptions(input.surface);
  const { candidates, solids, diagnostics } = await collectSceneGeometry(root, manifest, scene);
  const rects = [
    scene.map ? sceneBounds(scene) : null,
    ...candidates.map(({ mask }) => ({ x: mask.x0, y: mask.y0, width: mask.width, height: mask.height })),
    ...solids.map((solid) => solid.rect || polygonBounds(solid.points)),
  ];
  const bounds = unionRect(rects);
  if (!bounds) throw new Error('场景没有地图、物件或碰撞，无法分析。');
  const grid = createGrid(bounds);
  for (const solid of solids) {
    if (solid.rect) rasterizeRect(grid, solid.rect);
    else rasterizePolygon(grid, solid.points);
  }
  const physical = physicalSurfaces(grid, player, options);
  const visual = visualSurfaces(candidates, bounds, player, options);
  const ground = visual.filter((segment) => segment.meta?.label === 'ground');
  const reachability = analyzeReachability(grid, physical, player, { sampleStep: options.sampleStep, start: input.start, goal: input.goal });
  return {
    player,
    options,
    bounds: { x: grid.x0, y: grid.y0, width: grid.width, height: grid.height },
    inputs: {
      candidates: candidates.map(({ key, elementId, source, label, mask }) => ({ key, elementId: elementId ?? null, source, label, rect: { x: mask.x0, y: mask.y0, width: mask.width, height: mask.height } })),
      solids: solids.map((solid) => ({ owner: solid.owner, kind: solid.rect ? 'rect' : 'polygon' })),
    },
    surfaces: { physical, visual },
    consistency: {
      // "all" treats every visual top as a claim; "ground" only trusts art
      // already labelled as ground. Unlabeled tops need semantic labels.
      all: compareSurfaces(visual, physical, options),
      ground: compareSurfaces(ground, physical, options),
    },
    reachability,
    diagnostics,
  };
}

function overlaySvg(analysis, viewport) {
  const [sx, , , sy, tx, ty] = viewport.worldToImage;
  const X = (x) => (x * sx + tx).toFixed(1);
  const Y = (y) => (y * sy + ty).toFixed(1);
  const line = (points, color, width, dash = '') =>
    `<polyline points="${points.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ''} stroke-linecap="round"/>`;
  const span = (s, color, dash) => line([{ x: s.x0, y: s.y }, { x: s.x1, y: s.y }], color, 4, dash);
  const parts = [];
  // Reachable marks sit just below the surface line so they never hide it.
  for (const p of analysis.reachability.reachedPoints || []) parts.push(`<circle cx="${X(p.x)}" cy="${(Number(Y(p.y)) + 4).toFixed(1)}" r="1.2" fill="#7c3aed"/>`);
  for (const segment of analysis.surfaces.visual) parts.push(line(segment.points, segment.meta?.label === 'ground' ? '#2563eb' : '#93c5fd', 1.5));
  for (const segment of analysis.surfaces.physical) parts.push(line(segment.points, '#16a34a', 2.5));
  for (const s of analysis.consistency.all.phantom) parts.push(span(s, '#f97316', ''));
  for (const s of analysis.consistency.all.fake) parts.push(span(s, '#dc2626', '6 4'));
  for (const [point, color] of [[analysis.reachability.start, '#7c3aed'], [analysis.reachability.goal, analysis.reachability.goalReachable ? '#7c3aed' : '#dc2626']])
    if (point) parts.push(`<circle cx="${X(point.x)}" cy="${Y(point.y)}" r="6" fill="none" stroke="${color}" stroke-width="2.5"/>`);
  const legend = [
    ['#16a34a', '碰撞可站面'], ['#2563eb', '画面可站面（地表）'], ['#93c5fd', '画面可站面（未标注）'],
    ['#f97316', '幽灵地面'], ['#dc2626', '假地面'], ['#7c3aed', '可达点 / 起终点'],
  ].map(([color, label], i) => `<rect x="8" y="${8 + i * 18}" width="12" height="12" fill="${color}"/><text x="26" y="${18 + i * 18}" font-size="12" font-family="sans-serif" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke">${label}</text>`);
  const box = `<rect x="2" y="2" width="170" height="${legend.length * 18 + 10}" rx="4" fill="#ffffff" fill-opacity="0.85"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.widthPx}" height="${viewport.heightPx}">${parts.join('')}${box}${legend.join('')}</svg>`;
}

function round(value) {
  return typeof value === 'number' ? Number(value.toFixed(4)) : value;
}

/** Summary numbers only; full segment lists stay in the report file. */
export function summarize(analysis) {
  const pick = (c) => ({
    visualLength: c.visualLength, physicalLength: c.physicalLength, fakeLength: c.fakeLength, phantomLength: c.phantomLength,
    precision: round(c.precision), recall: round(c.recall), fakeSpans: c.fake.length, phantomSpans: c.phantom.length,
  });
  const r = analysis.reachability;
  return {
    candidates: analysis.inputs.candidates.length,
    solids: analysis.inputs.solids.length,
    physicalSegments: analysis.surfaces.physical.length,
    visualSegments: analysis.surfaces.visual.length,
    consistency: { all: pick(analysis.consistency.all), ground: pick(analysis.consistency.ground) },
    reachability: { coverage: r.coverage, goalReachable: r.goalReachable, reachableLength: r.reachableLength, totalLength: r.totalLength, simulations: r.simulations, unmappedLandings: r.unmappedLandings },
    diagnostics: analysis.diagnostics.map((d) => d.code),
  };
}

/**
 * source: { documentId, revision, contentHash } or { packagePath, packageSha256 }.
 * Writes outputs/affordance-reports/<scene>/<run>/report.json (+ overlay.png).
 */
export async function writeAffordanceReport(root, manifest, scene, source, input = {}) {
  const validated = validateScene(scene);
  const analysis = await analyzeScene(root, manifest, validated, input);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const relative = path.posix.join(manifest.workspace.outputDirectory.replaceAll('\\', '/'), 'affordance-reports', validated.id, runId);
  const directory = path.resolve(root, relative);
  await mkdir(directory, { recursive: true });
  const files = [];
  if (input.overlay !== false) {
    const observation = await observeScene(root, manifest, {
      kind: 'scene', id: validated.id, revision: Math.max(1, source.revision ?? validated.revision ?? 1),
      contentHash: source.contentHash, content: validated,
    }, { mode: 'export', overlay: false, maxWidth: 2048, maxHeight: 2048, region: analysis.bounds });
    const base = Buffer.from(observation.images.find((image) => image.role === 'scene').data, 'base64');
    const png = await sharp(base).composite([{ input: Buffer.from(overlaySvg(analysis, observation.viewport)) }]).png().toBuffer();
    await writeFile(path.join(directory, 'overlay.png'), png);
    files.push({ role: 'overlay', path: `${relative}/overlay.png`, sha256: sha(png), worldToImage: observation.viewport.worldToImage });
  }
  const report = {
    reportVersion: AFFORDANCE_REPORT_VERSION,
    createdAt: new Date().toISOString(),
    source: { sceneId: validated.id, sceneName: validated.name, ...source },
    readOnly: true,
    summary: summarize(analysis),
    ...analysis,
    files,
    limitations: [
      '原型只读：不修改场景、不调用模型。',
      '画面可站面由几何规则推断；"未标注"候选（树冠、装饰等）尚无语义标签，all 口径会把它们都当作可站声明。',
      '可达性使用简化积分器，尚未经 Godot 回放验证；不处理单向平台、斜坡与危险区。',
    ],
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(path.join(directory, 'report.json'), text);
  return { directory: relative, reportSha256: sha(text), summary: report.summary, files };
}
