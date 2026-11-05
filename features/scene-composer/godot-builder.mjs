import JSZip from 'jszip';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { buildGodotPackage } from '../interactable-editor/godot-builder.mjs';
import { instanceOrigin, validateScene } from './model.mjs';
import { createScenePackage } from './package.mjs';
import { sceneDisplayOrder, activeMapCollisions, mapSplitElementOrigin } from './render-model.mjs';

const quote = (value) => JSON.stringify(value);
const vec = (p) => `Vector2(${p.x}, ${p.y})`;
const interactionRuntime = 'res://addons/workbench_interaction/runtime/v1/interaction_runtime_2d.tscn';

/** Local web exporter. Uses the existing interaction kit, never an Agent operation. */
export async function buildSceneGodotPackage(input, { repositoryRoot } = {}) {
  const scene = validateScene(input);
  const activeSplit = scene.mapSplit && !scene.mapSplit.stale ? scene.mapSplit : null;
  if (!scene.map || (activeSplit ? !activeSplit.elements.some(element => element.included && element.parts.some(part => part.enabled)) : !scene.map.layers.some(layer => layer.included)))
    throw new Error('请先添加至少一个参与导出的地图层。');
  const zip = new JSZip();
  const root = `scenes/${scene.id}`;
  const instances = scene.instances.filter((i) => i.included);
  const used = scene.materials.filter((m) =>
    instances.some((i) => i.materialId === m.id),
  );
  const paths = new Map();
  for (const m of used) {
    // Namespaced kits isolate definitions, assets and runtime class references across scenes.
    const pack = await buildGodotPackage(
      { project: m.project },
      { repositoryRoot, exportId: m.id },
    );
    const original = await JSZip.loadAsync(pack.bytes);
    const prefix = `${root}/objects/${m.id}`;
    for (const [name, entry] of Object.entries(original.files)) {
      if (
        entry.dir ||
        name.includes('/runtime/') ||
        name.includes('/sources/') ||
        name.includes('/packages/')
      )
        continue;
      const dest = name.replace('addons/workbench_interaction', prefix);
      if (/\.(tscn|tres|gd)$/.test(name)) {
        let text = await entry.async('string');
        text = text.replace(
          /res:\/\/addons\/workbench_interaction\/(?!runtime\/v1\/)/g,
          `res://${prefix}/`,
        );
        zip.file(dest, text);
      } else zip.file(dest, await entry.async('uint8array'));
    }
    // Runtime scripts use global class names: include one shared copy, never duplicate class_name.
    for (const [name, entry] of Object.entries(original.files))
      if (!entry.dir && name.includes('/runtime/'))
        zip.file(name, await entry.async('uint8array'));
    paths.set(
      m.id,
      pack.metadata.objects[0].scene.replace(
        'res://addons/workbench_interaction',
        `res://${prefix}`,
      ),
    );
  }
  const needsRuntime = used.length > 0 || !activeSplit;
  // Preserve the established runtime path for ordinary map-only scenes.
  if (!used.length && needsRuntime) {
    const { createProject } = await import('../interactable-editor/contract.mjs');
    const pack = await buildGodotPackage({ project: createProject() }, { repositoryRoot });
    const original = await JSZip.loadAsync(pack.bytes);
    for (const [name, entry] of Object.entries(original.files))
      if (!entry.dir && name.includes('/runtime/')) zip.file(name, await entry.async('uint8array'));
  }
  const ext = needsRuntime ? [
    `[ext_resource type="PackedScene" path=${quote(interactionRuntime)} id="runtime"]`,
  ] : [];
  for (const [materialId, resource] of paths)
    ext.push(
      `[ext_resource type="PackedScene" path=${quote(resource)} id=${quote('material_' + materialId)}]`,
    );
  const links = (scene.links || []).filter((link) => link.enabled);
  const linkScriptId = 'forge_scene_link_router';
  if (links.length) {
    zip.file(`${root}/scene_link_router.gd`, await readFile(new URL('./godot-templates/scene_link_router.gd', import.meta.url)));
    ext.push(`[ext_resource type="Script" path="res://${root}/scene_link_router.gd" id=${quote(linkScriptId)}]`);
  }
  for (const layer of scene.map.layers.filter((l) => !activeSplit && l.included)) {
    if (!layer.source.startsWith('data:image/png;base64,'))
      throw new Error('地图层必须是内嵌 PNG。');
    const bytes = Buffer.from(layer.source.split(',')[1], 'base64');
    const info = await sharp(bytes, {
      limitInputPixels: 64_000_000,
    }).metadata();
    if (
      info.format !== 'png' ||
      info.width !== layer.width ||
      info.height !== layer.height
    )
      throw new Error('地图层尺寸与场景清单不一致。');
    zip.file(`${root}/map/${layer.id}.png`, bytes);
    ext.push(
      `[ext_resource type="Texture2D" path="res://${root}/map/${layer.id}.png" id="layer_${layer.id}"]`,
    );
  }
  const textureResources = new Map();
  const splitResources = new Map();
  for (const element of activeSplit?.elements.filter(element => element.included) || []) {
    for (const part of element.parts) {
      let resourceId = textureResources.get(part.source);
      if (!resourceId) {
        const bytes = Buffer.from(part.source.slice(part.source.indexOf(',') + 1), 'base64');
        const decoder = sharp(bytes, { limitInputPixels: 64_000_000, animated: false });
        const info = await decoder.metadata();
        if (info.format !== 'png' || info.width !== part.width || info.height !== part.height || (info.pages || 1) !== 1) throw new Error('场景分层纹理尺寸与清单不一致。');
        await decoder.raw().toBuffer();
        resourceId = `forge_split_texture_${textureResources.size}`;
        const filename = `${root}/split/${textureResources.size}.png`;
        zip.file(filename, bytes);
        ext.push(`[ext_resource type="Texture2D" path=${quote(`res://${filename}`)} id=${quote(resourceId)}]`);
        textureResources.set(part.source, resourceId);
      }
      if (part.mask) await sharp(Buffer.from(part.mask.slice(part.mask.indexOf(',') + 1), 'base64'), { limitInputPixels: 64_000_000, animated: false }).raw().toBuffer();
      splitResources.set(`${element.id}:${part.id}`, resourceId);
    }
  }
  const display = sceneDisplayOrder(scene, { includeDisabled: true });
  const actorRank = display.find(entry => entry.kind === 'actor').zIndex;
  const nodes = ['[node name="Scene" type="Node2D"]'];
  const nodeName = (id) => {
    if (!['ActorSlot', 'InteractionRuntime', 'MapCollisions'].includes(id)) return id;
    let name = id + '_';
    while (scene.order.includes(name)) name += '_';
    return name;
  };
  if (needsRuntime) nodes.push('[node name="InteractionRuntime" parent="." instance=ExtResource("runtime")]', `scene_key = ${quote(scene.id)}`);
  // All drawable roots are siblings. Relative template z values are overridden once here.
  for (const entry of display) {
    const { id, zIndex: z } = entry;
    if (entry.kind === 'actor') {
      nodes.push(
        '[node name="ActorSlot" type="Node2D" parent="."]',
        `z_index = ${z}`,
      );
      continue;
    }
    const layer = entry.kind === 'layer' ? entry.layer : null;
    if (layer?.included)
      nodes.push(
        `[node name="${nodeName(id)}" type="Sprite2D" parent="."]`,
        `texture = ExtResource("layer_${id}")`,
        'centered = false',
        'texture_filter = 1',
        `z_index = ${z}`,
        `position = ${vec({ x: scene.map.origin.x + scene.map.offset.x, y: scene.map.origin.y + scene.map.offset.y })}`,
      );
    const i = entry.kind === 'instance' ? instances.find(item => item.id === id) : null;
    if (i)
      nodes.push(
        `[node name="${nodeName(i.id)}" parent="." instance=ExtResource("material_${i.materialId}")]`,
        `instance_id = ${quote(i.id)}`,
        `position = ${vec(instanceOrigin(i))}`,
        `scale = Vector2(${i.scale * (i.flipH ? -1 : 1)}, ${i.scale})`,
        `z_index = ${z}`,
      );
  }
  for (const element of activeSplit?.elements.filter(element => element.included) || []) {
    nodes.push(`[node name=${quote(element.id)} type="Node2D" parent="."]`,
      `position = ${vec(mapSplitElementOrigin(scene, element))}`,
      `metadata/forge_element_id = ${quote(element.id)}`,
      `metadata/forge_element_name = ${quote(element.name)}`,
      `metadata/forge_element_kind = ${quote(element.kind)}`);
    for (const part of element.parts) {
      const entry = display.find(item => item.key === `${element.id}:${part.id}`);
      nodes.push(`[node name=${quote(`Part_${part.id}`)} type="Sprite2D" parent=${quote(element.id)}]`,
        `texture = ExtResource(${quote(splitResources.get(`${element.id}:${part.id}`))})`,
        'centered = false', 'texture_filter = 1', 'z_as_relative = false',
        `z_index = ${entry.zIndex}`, `visible = ${part.enabled ? 'true' : 'false'}`,
        `position = ${vec(part)}`, `metadata/forge_part_id = ${quote(part.id)}`,
        `metadata/forge_part_role = ${quote(part.role)}`, `metadata/forge_part_plane = ${quote(part.plane)}`);
    }
    if (element.collision.polygons.length) {
      nodes.push(`[node name="CollisionBody" type="StaticBody2D" parent=${quote(element.id)}]`);
      element.collision.polygons.forEach((points, index) => nodes.push(
        `[node name="Collision_${index}" type="CollisionPolygon2D" parent=${quote(`${element.id}/CollisionBody`)}]`,
        `disabled = ${element.collision.enabled ? 'false' : 'true'}`,
        `polygon = PackedVector2Array(${points.flatMap(point => [point.x, point.y]).join(', ')})`));
    }
  }
  nodes.push(
    '[node name="MapCollisions" type="StaticBody2D" parent="."]',
    `position = ${vec(scene.map.offset)}`,
  );
  activeMapCollisions(scene).forEach(({ points, index: i }) =>
    nodes.push(
      `[node name="Collision_${i}" type="CollisionPolygon2D" parent="MapCollisions"]`,
      `polygon = PackedVector2Array(${points.flatMap((p) => [p.x, p.y]).join(', ')})`,
    ),
  );
  if (links.length) {
    let nodeName = 'SceneLinkRouter';
    while (scene.order.includes(nodeName) || ['InteractionRuntime', 'MapCollisions', 'ActorSlot'].includes(nodeName)) nodeName += '_';
    nodes.push(`[node name=${quote(nodeName)} type="Node" parent="."]`,
      `script = ExtResource(${quote(linkScriptId)})`,
      `links = ${JSON.stringify(links)}`);
  }
  zip.file(
    `${root}/scene.tscn`,
    `[gd_scene load_steps=${ext.length + 1} format=3]\n\n${ext.join('\n')}\n\n${nodes.join('\n')}\n`,
  );
  zip.file(`${root}/scene-source.zip`, await createScenePackage(scene));
  zip.file(
    `${root}/scene-manifest.json`,
    JSON.stringify(
      {
        format: 'workbench-scene-godot',
        version: 1,
        sceneId: scene.id,
        name: scene.name,
        scene: `res://${root}/scene.tscn`,
        runtime: needsRuntime ? interactionRuntime : null,
        actorZIndex: actorRank,
        links: scene.links || [],
        linkRuntime: links.length ? `res://${root}/scene_link_router.gd` : null,
        instances: instances.map((i) => ({
          instanceId: i.id,
          name: i.name,
          materialId: i.materialId,
        })),
        mapSplit: activeSplit ? {
          candidateId: activeSplit.candidateId, sourceHash: activeSplit.sourceHash, review: activeSplit.review,
          elements: activeSplit.elements.filter(element => element.included).map(element => ({
            elementId: element.id, name: element.name, kind: element.kind, position: mapSplitElementOrigin(scene, element),
            collisionEnabled: element.collision.enabled, mapIndices: element.collision.mapIndices,
            parts: element.parts.map(part => ({ partId: part.id, role: part.role, plane: part.plane, enabled: part.enabled, zIndex: display.find(entry => entry.key === `${element.id}:${part.id}`).zIndex })),
          })),
        } : null,
      },
      null,
      2,
    ),
  );
  zip.file(
    `${root}/INSTALL.md`,
    `# ${scene.name}\n\n将包解压到 Godot 4.7.x 项目根目录，打开 res://${root}/scene.tscn。地图、物件和碰撞已摆放完成。\n\n人物放在 ActorSlot 下，保持人物相对 Z 为 0；或使用 Z=${actorRank}。ActorSlot 只是挂接点，没有附带人物。\n\n地图分层的完整物件是独立 Node2D，metadata/forge_element_id 保留稳定身份；移动父节点会同时移动前片、后片、效果和碰撞。贴图子节点采用全局 Z，按 ActorSlot 前后绘制。Part_* 的 visible 可切换效果；CollisionBody/Collision_* 的 disabled 可切换简化阻挡。分层景物没有默认按键、提示或交互脚本。\n${used.length ? '\n已有交互物保留独立节点和 instance_id；靠近交互的物理节点加入 interaction_actor group，默认碰撞层为 1（与物件 detection mask 对应），按键或点击沿用其配置。拾取、开关等通过物件信号接入游戏。所有场景共用 addons/workbench_interaction/runtime/v1/，导入时保持同一运行时版本。\n' : ''}\nscene-source.zip 可在场景组装中重新打开。隐藏的编辑辅助内容不影响导出，取消“参与导出”的节点不会输出。没有 project.godot，不覆盖项目配置。\n\n重新导出会更新 scenes/${scene.id}/ 内的生成资源。自定义脚本放在外层场景或独立文件中。\n`,
  );
  return {
    bytes: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }),
    scenePath: `res://${root}/scene.tscn`,
  };
}
