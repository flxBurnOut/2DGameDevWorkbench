import { z } from 'zod';
import { makeId, normalizeProject, referencedAssets, selectedProject } from '../interactable-editor/contract.mjs';
import { sceneLinkSchema, MAX_SCENE_LINKS, validateSceneLinks, sceneLinkDiagnostics } from './links.mjs';
import { mapSplitSchema, validateMapSplit } from './map-split.mjs';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const coordinate = z.number().finite().min(-1e7).max(1e7);
const point = z.object({ x: coordinate, y: coordinate });
const source = z.string().min(1);
export const wholeMapSplitHint = '当前使用整体图，可在场景中使用“一键地图粗分”拆出独立物件并调整遮挡。';
const flags = {
  locked: z.boolean(),
  hidden: z.boolean(),
  included: z.boolean(),
};
const mapLayer = z.object({
  id,
  name: z.string().max(200),
  source,
  width: z.number().int().positive().max(30000),
  height: z.number().int().positive().max(30000),
  ...flags,
});
export const sceneSchema = z.object({
  format: z.literal('workbench-scene'),
  version: z.literal(1),
  id,
  name: z.string().min(1).max(120),
  revision: z.number().int().nonnegative(),
  map: z
    .object({
      name: z.string(),
      origin: point,
      offset: point,
      layers: z.array(mapLayer).max(8),
      collisions: z.array(z.array(point).min(3).max(10000)).max(10000),
      source,
      warnings: z.array(z.string()),
    })
    .nullable(),
  mapSplit: mapSplitSchema.optional(),
  materials: z
    .array(z.object({ id, name: z.string(), project: z.unknown() }))
    .max(1000),
  instances: z
    .array(
      z.object({
        id,
        materialId: id,
        name: z.string().max(200),
        x: coordinate,
        y: coordinate,
        scale: z.number().min(0.05).max(32),
        flipH: z.boolean(),
        anchor: point,
        ...flags,
      }),
    )
    .max(2000),
  order: z.array(id).max(6010),
  links: z.array(sceneLinkSchema).max(MAX_SCENE_LINKS).default([]),
  view: z.object({
    x: coordinate,
    y: coordinate,
    zoom: z.number().min(0.02).max(16),
    grid: z.number().int().min(1).max(256),
    aidsVersion: z.number().int().min(0).max(1).default(0),
    showGrid: z.boolean(),
    showNames: z.boolean(),
    showShapes: z.boolean(),
    showActor: z.boolean(),
  }),
});

export function createScene(name = '未命名场景') {
  return {
    format: 'workbench-scene',
    version: 1,
    id: makeId('scene'),
    name,
    revision: 0,
    map: null,
    materials: [],
    instances: [],
    order: ['actor'],
    links: [],
    view: {
      x: 0,
      y: 0,
      zoom: 1,
      grid: 1,
      aidsVersion: 1,
      showGrid: true,
      showNames: true,
      showShapes: true,
      showActor: true,
    },
  };
}
export function validateScene(input, { allowPackageReferences = false } = {}) {
  const scene = sceneSchema.parse(input);
  if (scene.map) {
    const oldHint = '当前使用整体图；烘焙在图片里的物件需要回地图工具分层后才能单独调整遮挡。';
    scene.map.warnings = scene.map.warnings.map(message => message === oldHint ? wholeMapSplitHint : message);
  }
  if (scene.mapSplit) {
    if (!scene.map) throw new Error('场景分层缺少原地图。');
    scene.mapSplit = validateMapSplit(scene.mapSplit, { allowPackageReferences, mapCollisionCount: scene.map.collisions.length });
    if (scene.mapSplit.elements.some(element => ['Scene', 'ActorSlot', 'MapCollisions', 'InteractionRuntime'].includes(element.id))) throw new Error('场景分层物件使用了引擎保留的节点身份。');
    if (scene.mapSplit.elements.reduce((sum, element) => sum + element.parts.length, 0) + scene.instances.length + 1 > 8191) throw new Error('场景绘制子片过多，请拆分场景。');
  }
  if (scene.view.aidsVersion < 1) Object.assign(scene.view, {
    aidsVersion: 1, showGrid: true, showNames: true, showShapes: true, showActor: true,
  });
  scene.materials = scene.materials.map((m) => ({
    ...m,
    project: normalizeProject(m.project),
  }));
  if (scene.materials.some((m) => m.project.objects.length !== 1))
    throw new Error('每个场景素材必须包含一个交互物。');
  const materialIds = new Set(scene.materials.map((m) => m.id));
  if (materialIds.size !== scene.materials.length)
    throw new Error('场景素材身份重复。');
  if (scene.instances.some((i) => !materialIds.has(i.materialId)))
    throw new Error('场景物件缺少素材。');
  const nodes = [
    'actor',
    ...(scene.map?.layers.map((l) => l.id) || []),
    ...scene.instances.map((i) => i.id),
    ...(scene.mapSplit?.elements.map(element => element.id) || []),
  ];
  if (
    new Set(nodes).size !== nodes.length ||
    scene.order.length !== nodes.length ||
    new Set(scene.order).size !== nodes.length ||
    scene.order.some((key) => !nodes.includes(key))
  )
    throw new Error('场景节点顺序不完整或身份重复。');
  return validateSceneLinks(scene);
}
export function materialFor(scene, instance) {
  return scene.materials.find((m) => m.id === instance.materialId);
}
export function sceneMaterialProject(project, definitionId) {
  const selected = selectedProject(project, [definitionId]);
  selected.assets = referencedAssets(selected);
  return selected;
}
export function addMaterial(scene, project, definitionId, materialId = makeId('material')) {
  const selected = sceneMaterialProject(project, definitionId);
  const material = {
    id: materialId,
    name: selected.objects[0].displayName,
    project: selected,
  };
  scene.materials.push(material);
  return material;
}
export function addInstance(scene, materialId, x, y, instanceId = makeId('instance')) {
  const material = scene.materials.find((m) => m.id === materialId);
  if (!material) throw new Error('请先添加交互物素材。');
  const v = material.project.objects[0].visual;
  const instance = {
    id: instanceId,
    materialId,
    name: material.name,
    x: Math.round(x),
    y: Math.round(y),
    scale: 1,
    flipH: false,
    anchor: { x: v.offset.x, y: v.offset.y + (v.height * v.scale) / 2 },
    locked: false,
    hidden: false,
    included: true,
  };
  scene.instances.push(instance);
  scene.order.splice(scene.order.indexOf('actor') + 1, 0, instance.id);
  return instance;
}
export function removeInstances(scene, ids) {
  const selected = new Set(ids);
  const removedLinks = (scene.links || []).filter(link => selected.has(link.sourceInstanceId) || selected.has(link.targetInstanceId));
  scene.instances = scene.instances.filter(instance => !selected.has(instance.id));
  scene.order = scene.order.filter(id => !selected.has(id));
  scene.links = (scene.links || []).filter(link => !removedLinks.includes(link));
  return removedLinks.map(link => link.id);
}
export function reorder(scene, ids, action, target) {
  const chosen = new Set(ids);
  const moving = scene.order.filter((key) => chosen.has(key));
  if (!moving.length || chosen.has(target)) return;
  const nodes = [...scene.instances, ...(scene.map?.layers || []), ...(scene.mapSplit?.elements || [])];
  if (nodes.some(node => chosen.has(node.id) && node.locked))
    throw new Error('请先解锁要调整顺序的节点。');
  const first = scene.order.indexOf(moving[0]);
  const last = scene.order.indexOf(moving.at(-1));
  const remaining = scene.order.filter((key) => !chosen.has(key));
  const oldOrder = scene.order;
  let at;
  if (action === 'front') at = 0;
  else if (action === 'back') at = remaining.length;
  else if (action === 'forward') at = Math.max(0, first - 1);
  else if (action === 'backward')
    at = Math.min(remaining.length, last - moving.length + 2);
  else if (action === 'index')
    at = Math.max(0, Math.min(remaining.length, Number(target) - 1));
  else {
    at = remaining.indexOf(target);
    if (at < 0) return;
    if (action === 'after') at++;
  }
  remaining.splice(at, 0, ...moving);
  scene.order = remaining;
  const oldActor = oldOrder.indexOf('actor'), newActor = remaining.indexOf('actor');
  for (const element of scene.mapSplit?.elements || []) {
    if (!chosen.has(element.id) || chosen.has('actor')) continue;
    const inFront = remaining.indexOf(element.id) < newActor;
    const crossedActor = inFront !== (oldOrder.indexOf(element.id) < oldActor);
    const onePlane = element.parts.every(part => part.plane === element.parts[0].plane);
    if (target === 'actor' || (onePlane && (crossedActor || action === 'front' || action === 'back'))) {
      for (const part of element.parts) part.plane = inFront ? 'front' : 'back';
    }
  }
}
export function replaceInstances(scene, ids, materialId) {
  const material = scene.materials.find((m) => m.id === materialId);
  if (!material) throw new Error('新素材不存在。');
  const v = material.project.objects[0].visual;
  for (const instance of scene.instances)
    if (ids.includes(instance.id)) {
      instance.materialId = materialId;
      instance.anchor = {
        x: v.offset.x,
        y: v.offset.y + (v.height * v.scale) / 2,
      };
    }
}
export function replaceMap(scene, map) {
  map = structuredClone(map);
  const oldIds = new Set(scene.map?.layers.map((l) => l.id) || []);
  const newIds = new Set(map.layers.map((l) => l.id));
  for (const layer of map.layers) {
    const old = scene.map?.layers.find((l) => l.id === layer.id);
    if (old)
      Object.assign(layer, {
        locked: old.locked,
        hidden: old.hidden,
        included: old.included,
      });
  }
  scene.order = scene.order.filter(
    (key) => !oldIds.has(key) || newIds.has(key),
  );
  for (const layer of [...map.layers].reverse())
    if (!scene.order.includes(layer.id)) {
      if (layer.id === 'map_top') scene.order.unshift(layer.id);
      else scene.order.push(layer.id);
    }
  scene.map = map;
  // The old baseline and scene edits are retained for the next three-way merge.
  // Stale split art must never conceal the newly selected map.
  if (scene.mapSplit) scene.mapSplit.stale = true;
}
export function instanceOrigin(instance) {
  return {
    x:
      instance.x -
      instance.anchor.x * instance.scale * (instance.flipH ? -1 : 1),
    y: instance.y - instance.anchor.y * instance.scale,
  };
}
export function changeAnchor(instance, anchor) {
  const origin = instanceOrigin(instance);
  instance.anchor = anchor;
  instance.x = origin.x + anchor.x * instance.scale * (instance.flipH ? -1 : 1);
  instance.y = origin.y + anchor.y * instance.scale;
}
export function sceneBounds(scene) {
  const m = scene.map;
  if (!m?.layers.length) return { x: -400, y: -250, width: 800, height: 500 };
  return {
    x: m.origin.x + m.offset.x,
    y: m.origin.y + m.offset.y,
    width: Math.max(...m.layers.map((l) => l.width)),
    height: Math.max(...m.layers.map((l) => l.height)),
  };
}
export function sceneWarnings(scene) {
  const result = (scene.map?.warnings || []).filter(message => {
    if (message === wholeMapSplitHint) return !scene.mapSplit || scene.mapSplit.stale;
    return !scene.map.collisions.length || message !== '此背景尚未配置地图碰撞。请设置并检查碰撞后再验证游戏行为。';
  });
  result.push(...sceneLinkDiagnostics(scene).map(diagnostic => diagnostic.message));
  if (scene.mapSplit?.stale) result.push('地图已替换；旧分层和编辑已保留，等待新分层候选自动迁移。');
  else if (scene.mapSplit) {
    if (scene.mapSplit.review !== 'reviewed') result.push('地图分层未经核验，建议用 Agent 检查漏分、边缘和前后关系。');
    const unresolved = scene.mapSplit.conflicts.filter(conflict => !conflict.resolution).length;
    if (unresolved) result.push(`地图分层有 ${unresolved} 项迁移冲突等待裁决。`);
  }
  const b = sceneBounds(scene);
  const outside = scene.instances.filter(
    (i) =>
      i.x < b.x || i.y < b.y || i.x > b.x + b.width || i.y > b.y + b.height,
  );
  if (outside.length)
    result.push(
      `地图范围外有 ${outside.length} 个物件：${outside.map((i) => i.name).join('、')}`,
    );
  const base = scene.order.findIndex((key) =>
    ['map_overall', 'map_surface'].includes(key),
  );
  if (
    base >= 0 &&
    scene.instances.some((i) => scene.order.indexOf(i.id) > base)
  )
    result.push('有物件位于地图底图后，可能被遮住；可通过节点列表选择并前移。');
  return result;
}
