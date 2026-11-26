import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_VERSION, appearanceAnimation, selectedProject, referencedAssets } from './contract.mjs';

const genericRoot = 'addons/workbench_interaction';
export const assetExtensions = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
};
const quoted = (value) => JSON.stringify(String(value)).replaceAll('\\/', '/');
const raw = (code) => ({ __godot: code });
export function godotValue(value) {
  if (value?.__godot) return value.__godot;
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('数值必须有限');
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(godotValue).join(', ')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([k, v]) => `${quoted(k)}: ${godotValue(v)}`)
      .join(', ')}}`;
  return 'null';
}

function verifiedAssetBytes(asset, bytes) {
  if (asset.generation && createHash('sha256').update(bytes).digest('hex') !== asset.generation.sha256)
    throw new Error(`生成素材已变化：${asset.name}，请使用原始图片或作为新素材导入。`);
  return bytes;
}

export async function readAsset(asset, repositoryRoot) {
  if (asset.source.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
      asset.source,
    );
    if (!match || match[1] !== asset.mime)
      throw new Error(`素材格式不符：${asset.name}`);
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 64 * 1024 * 1024)
      throw new Error(`素材为空或超过 64 MB：${asset.name}`);
    return verifiedAssetBytes(asset, bytes);
  }
  const base = await realpath(repositoryRoot);
  let target;
  try {
    target = await realpath(path.resolve(base, asset.source));
  } catch {
    throw new Error(`素材文件不存在：${asset.name}`);
  }
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`素材必须位于工作区内：${asset.name}`);
  const info = await stat(target);
  if (!info.isFile() || !info.size || info.size > 64 * 1024 * 1024)
    throw new Error(`素材为空或超过 64 MB：${asset.name}`);
  return verifiedAssetBytes(asset, await readFile(target));
}

function shapeResource(shape, name) {
  if (shape.type === 'circle')
    return `[sub_resource type="CircleShape2D" id="${name}"]\nradius = ${shape.radius}\n`;
  if (shape.type === 'capsule')
    return `[sub_resource type="CapsuleShape2D" id="${name}"]\nradius = ${shape.width / 2}\nheight = ${Math.max(shape.height, shape.width)}\n`;
  return `[sub_resource type="RectangleShape2D" id="${name}"]\nsize = Vector2(${shape.width}, ${shape.height})\n`;
}
const vector = (p) => `Vector2(${p.x}, ${p.y})`;
function definitionFile(o, assetPaths, root) {
  const used = referencedAssets({
    objects: [o],
    assets: [...assetPaths.values()].map((a) => a.asset),
  });
  const refs = [
    '[gd_resource type="Resource" format=3]',
    '',
    `[ext_resource type="Script" path="res://${root}/runtime/v1/interactable_definition.gd" id="script"]`,
  ];
  const assets = {};
  for (const [i, asset] of used.entries()) {
    refs.push(
      `[ext_resource type="${asset.mime.startsWith('image') ? 'Texture2D' : 'AudioStream'}" path=${quoted(`res://${assetPaths.get(asset.id).path}`)} id="a${i}"]`,
    );
    assets[asset.id] = raw(`ExtResource("a${i}")`);
  }
  return [
    ...refs,
    '',
    '[resource]',
    'script = ExtResource("script")',
    `definition_id = ${quoted(o.definitionId)}`,
    `display_name = ${quoted(o.displayName)}`,
    `data = ${godotValue(o)}`,
    `assets = ${godotValue(assets)}`,
    '',
  ].join('\n');
}
function sceneFile(o, assetPaths, root) {
  const initial =
    o.behavior.kind === 'toggle'
      ? o.behavior.states[o.behavior.initialToggle ? 1 : 0].appearance
      : {};
  const initialAsset = initial.assetId || o.visual.assetId;
  const initialAnimation = appearanceAnimation(initial, o.visual);
  const initialClip = o.visual.clips.find((c) => c.name === initialAnimation);
  const imageSize = assetPaths.get(initialAsset)?.dimensions;
  const firstFrame = initialClip?.frames[0];
  const frameSize =
    firstFrame?.region || assetPaths.get(firstFrame?.assetId)?.dimensions;
  const dir = `${root}/objects/${o.definitionId}`;
  const lines = [
    '[gd_scene format=3]',
    '',
    `[ext_resource type="Script" path="res://${root}/runtime/v1/workbench_interactable_2d.gd" id="script"]`,
    `[ext_resource type="Resource" path="res://${dir}/definition.tres" id="definition"]`,
  ];
  const imageIds = new Map();
  for (const a of referencedAssets({
    objects: [o],
    assets: [...assetPaths.values()].map((a) => a.asset),
  }).filter((a) => a.mime.startsWith('image'))) {
    const id = `texture${imageIds.size}`;
    imageIds.set(a.id, id);
    lines.push(
      `[ext_resource type="Texture2D" path=${quoted(`res://${assetPaths.get(a.id).path}`)} id="${id}"]`,
    );
  }
  lines.push(
    '',
    shapeResource(o.detection.shape, 'detection'),
    shapeResource(o.solid.shape, 'solid'),
  );
  const animations = [];
  let atlas = 0;
  for (const clip of o.visual.clips) {
    const frames = [];
    for (const f of clip.frames) {
      let ref = `ExtResource("${imageIds.get(f.assetId)}")`;
      if (f.region) {
        const name = `atlas${atlas++}`,
          r = f.region;
        lines.push(
          `[sub_resource type="AtlasTexture" id="${name}"]`,
          `atlas = ${ref}`,
          `region = Rect2(${r.x}, ${r.y}, ${r.width}, ${r.height})`,
          '',
        );
        ref = `SubResource("${name}")`;
      }
      frames.push({ duration: f.duration, texture: raw(ref) });
    }
    animations.push({
      name: clip.name,
      speed: clip.fps,
      loop: clip.loop,
      frames,
    });
  }
  lines.push(
    '[sub_resource type="SpriteFrames" id="frames"]',
    `animations = ${godotValue(animations)}`,
    '',
  );
  lines.push(
    `[node name="Object_${o.definitionId.replaceAll('-', '_')}" type="Area2D"]`,
    `script = ExtResource("script")`,
    'definition = ExtResource("definition")',
    'collision_layer = 0',
    `collision_mask = ${Math.trunc(o.detection.mask)}`,
    'input_pickable = false',
    `z_index = ${Math.trunc(o.visual.zIndex)}`,
    'texture_filter = 1',
    '',
  );
  lines.push(
    '[node name="VisualRoot" type="Node2D" parent="."]',
    `position = ${vector(o.visual.offset)}`,
    `scale = Vector2(${o.visual.scale}, ${o.visual.scale})`,
    `visible = ${initial.visible ?? o.visual.visible}`,
    `modulate = Color(${[1, 3, 5].map((i) => parseInt((initial.tint ?? o.visual.tint).slice(i, i + 2), 16) / 255).join(', ')}, 1)`,
    '',
  );
  lines.push(
    '[node name="Sprite" type="Sprite2D" parent="VisualRoot"]',
    `flip_h = ${o.visual.flipH}`,
    `flip_v = ${o.visual.flipV}`,
  );
  if (initialAsset) {
    lines.push(`texture = ExtResource("${imageIds.get(initialAsset)}")`);
    if (imageSize)
      lines.push(
        `scale = Vector2(${o.visual.width / imageSize.width}, ${o.visual.height / imageSize.height})`,
      );
    if (initialClip) lines.push('visible = false');
  } else lines.push('visible = false');
  lines.push(
    '',
    '[node name="Animated" type="AnimatedSprite2D" parent="VisualRoot"]',
    `visible = ${Boolean(initialClip)}`,
    'sprite_frames = SubResource("frames")',
    `flip_h = ${o.visual.flipH}`,
    `flip_v = ${o.visual.flipV}`,
    '',
  );
  if (initialClip) {
    lines.push(
      `animation = ${quoted(initialAnimation)}`,
      `autoplay = ${quoted(initialAnimation)}`,
    );
    if (frameSize)
      lines.push(
        `scale = Vector2(${o.visual.width / frameSize.width}, ${o.visual.height / frameSize.height})`,
      );
  }
  const w = o.visual.dot ? 10 : o.visual.width,
    h = o.visual.dot ? 10 : o.visual.height;
  lines.push(
    '[node name="Placeholder" type="Polygon2D" parent="VisualRoot"]',
    `visible = ${!initialAsset && !initialClip}`,
    `polygon = PackedVector2Array(${-w / 2}, ${-h / 2}, ${w / 2}, ${-h / 2}, ${w / 2}, ${h / 2}, ${-w / 2}, ${h / 2})`,
    'color = Color(0.3, 0.85, 0.65, 1)',
    '',
    '[node name="DetectionShape" type="CollisionShape2D" parent="."]',
    'shape = SubResource("detection")',
    `position = ${vector(o.detection.shape.offset)}`,
    '',
  );
  lines.push(
    '[node name="PromptAnchor" type="Marker2D" parent="."]',
    `position = ${vector(o.content.promptOffset)}`,
    '',
    '[node name="PromptLabel" type="Label" parent="PromptAnchor"]',
    'visible = false',
    'offset_left = -150.0',
    'offset_right = 150.0',
    'mouse_filter = 2',
    'horizontal_alignment = 1',
    'theme_override_font_sizes/font_size = 16',
    `text = ${quoted(o.content.prompt || o.displayName)}`,
    '',
  );
  lines.push(
    '[node name="AudioStreamPlayer2D" type="AudioStreamPlayer2D" parent="."]',
    '',
    '[node name="SolidBody" type="StaticBody2D" parent="."]',
    `collision_layer = ${Math.trunc(o.solid.layer)}`,
    `collision_mask = ${Math.trunc(o.solid.mask)}`,
    '',
    '[node name="SolidShape" type="CollisionShape2D" parent="SolidBody"]',
    'shape = SubResource("solid")',
    `disabled = ${!(initial.solidEnabled ?? o.solid.enabled)}`,
    `position = ${vector(o.solid.shape.offset)}`,
    '',
  );
  return lines.join('\n');
}

export async function buildGodotPackage(
  input,
  { repositoryRoot, exportId = 'export' } = {},
) {
  const targetProfile = input.targetProfile ?? 'generic';
  if (targetProfile !== 'generic')
    throw new Error('targetProfile must be generic.');
  const root = genericRoot;
  const project = selectedProject(input.project, input.selectedDefinitionIds);
  const assets = referencedAssets(project);
  const zip = new JSZip(),
    assetPaths = new Map();
  // Each asset is stored under one owning object. Shared references use that exact path.
  for (const asset of assets) {
    const owner = project.objects.find(
      (o) => referencedAssets({ objects: [o], assets: [asset] }).length,
    );
    const assetPath = `${root}/objects/${owner.definitionId}/assets/${asset.id}${assetExtensions[asset.mime]}`;
    const bytes = await readAsset(asset, repositoryRoot);
    const dimensions = asset.mime.startsWith('image')
      ? await sharp(bytes).metadata()
      : null;
    zip.file(assetPath, bytes);
    assetPaths.set(asset.id, { path: assetPath, asset, dimensions });
  }
  const templateRoot = fileURLToPath(
    new URL('./godot-templates/', import.meta.url),
  );
  for (const file of await readdir(templateRoot))
    zip.file(
      `${root}/runtime/v1/${file}`,
      await readFile(path.join(templateRoot, file)),
    );
  for (const o of project.objects) {
    zip.file(
      `${root}/objects/${o.definitionId}/definition.tres`,
      definitionFile(o, assetPaths, root),
    );
    zip.file(
      `${root}/objects/${o.definitionId}/object.tscn`,
      sceneFile(o, assetPaths, root),
    );
  }
  const source = {
    ...project,
    assets: assets.map((a) => ({ ...a, source: assetPaths.get(a.id).path })),
  };
  zip.file(
    `${root}/sources/${exportId}/interactable-project.json`,
    JSON.stringify(source, null, 2),
  );
  const metadata = {
    format: 'workbench-interaction-kit',
    kitVersion: KIT_VERSION,
    schemaVersion: 1,
    target: 'Godot 4.7.x',
    targetProfile,
    runtime: `res://${root}/runtime/v1/interaction_runtime_2d.tscn`,
    objects: project.objects.map((o) => ({
      definitionId: o.definitionId,
      name: o.displayName,
      scene: `res://${root}/objects/${o.definitionId}/object.tscn`,
    })),
  };
  zip.file(
    `${root}/packages/${exportId}/package-manifest.json`,
    JSON.stringify(metadata, null, 2),
  );
  zip.file(
    `${root}/packages/${exportId}/INSTALL.md`,
    installInstructions(metadata, root),
  );
  return {
    bytes: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }),
    project,
    source,
    metadata,
  };
}
function installInstructions(metadata, root) {
  return `# Workbench Interaction Kit ${KIT_VERSION}\n\n1. 解压到 Godot 4.7 项目根目录，保持 addons 目录结构。\n2. 在关卡根节点下实例化 res://${root}/runtime/v1/interaction_runtime_2d.tscn。\n3. 实例化下方物件场景。靠近模式将人物物理节点加入 interaction_actor group，确认物件 mask 包含人物 collision layer。默认 E 键通过运行时 InputMap 设置，可改用已有 action。鼠标模式无需人物。\n\n${metadata.objects.map((o) => `- ${o.name}: ${o.scene}`).join('\n')}\n\n每关一个运行时；嵌套关卡使用自己的运行时。DialoguePresenter 的 CanvasLayer.layer 默认 50，可在 Godot 中调整。\n\n## 游戏代码接入\n\n物件方法：request_interaction(source = null) 返回是否受理；set_enabled(bool)、reset_state()、get_state()、apply_state(snapshot)。\n信号：interaction_started、interaction_finished、interaction_cancelled、interaction_completed、picked_up、toggled、sequence_advanced、focus_entered、focus_exited，均携带 context Dictionary（definitionId、instanceId、source、kind、result）。恢复存档不会重发成功信号。Runtime.busy_changed(bool) 可以让游戏自己处理输入冻结。\n\n## 状态记忆\n\n默认 instance 重载重置。session 模式需在游戏根节点保留同一个 InteractionStateStore，并设置各运行时的 shared_state_store；开始新局调用 clear_session()。persistent 使用 user://workbench_interaction_<slot>.cfg；清空该槽调用 clear_slot(slot)。也可用 get_state/apply_state 接入已有存档。动态物件设置稳定 instance_id；静态节点默认以关卡内路径识别，改名后要保留显式 ID 才能继承进度。\n\n## 再次编辑\n\n在工作台导入本 ZIP 可恢复源配置及素材。Godot 中手改 .tscn/.tres 不会反向同步到源 JSON。多个包共用 runtime/v1；升级时使用同一版本的运行时，避免旧包覆盖较新文件。包不包含 project.godot 或 EditorPlugin，不依赖 copyWorms。\n`;
}
