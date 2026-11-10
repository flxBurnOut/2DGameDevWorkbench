import JSZip from 'jszip';

export const MAX_GODOT_BYTES = 256 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export async function digest(bytes) {
  return [
    ...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
  ]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export function safePackagePath(name) {
  if (
    typeof name !== 'string' ||
    name.length > 500 ||
    /[\\:]/.test(name) ||
    Array.from({length:name.length},(_,i)=>name.charCodeAt(i)).some(code=>code<32) ||
    name.startsWith('/') ||
    name
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
      )
  )
    throw new Error('导出包包含无效的文件路径。');
  return name;
}
export async function readGodotZip(bytes) {
  if (bytes.byteLength > MAX_GODOT_BYTES)
    throw new Error('Godot 包超过 256 MB。');
  const zip = await JSZip.loadAsync(bytes);
  const files = new Map(),
    names = new Set();
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const name = safePackagePath(entry.name);
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== name)
      throw new Error('导出包包含越界路径。');
    if (
      names.has(name.toLowerCase()) ||
      (Number(entry.unixPermissions) & 0o170000) === 0o120000
    )
      throw new Error('导出包包含重名文件或符号链接。');
    if (
      files.size >= 6000 ||
      total + (entry._data?.uncompressedSize ?? 0) > MAX_GODOT_BYTES
    )
      throw new Error('Godot 包解压后超过限制。');
    const data = await entry.async('uint8array');
    total += data.length;
    if (total > MAX_GODOT_BYTES) throw new Error('Godot 包解压后超过 256 MB。');
    names.add(name.toLowerCase());
    files.set(name, data);
  }
  if (!files.size) throw new Error('Godot 包为空。');
  return files;
}

/** Makes current exports ready for an existing project's root. Never executes packaged scripts. */
export async function prepareGodotPackage(bytes) {
  let files = await readGodotZip(bytes);
  const text = (name) => decoder.decode(files.get(name));
  const json = (name) => JSON.parse(text(name));
  let kind,
    entryScenes = [],
    spriteFrames = [],
    runtime = null,
    details = {};
  const sceneManifest = [...files.keys()].find((p) =>
    /^scenes\/[^/]+\/scene-manifest.json$/.test(p),
  );
  const objectManifest = [...files.keys()].find((p) =>
    /^addons\/workbench_interaction(?:_copyworms)?\/packages\/[^/]+\/package-manifest.json$/.test(
      p,
    ),
  );
  const spriteResource = [...files.keys()].find((p) =>
    /^forge_sprites\/.+\/sprite_frames.tres$/.test(p),
  );
  const portable = [...files.keys()].find((p) =>
    /^forge_packages\/[^/]+\/manifest.json$/.test(p),
  );
  if (portable) {
    const m = json(portable);
    if (m.format !== 'forge-godot-export' || m.version !== 1)
      throw new Error('不支持此 Godot 交付格式。');
    ({ kind, entryScenes, spriteFrames, runtime, details } = m);
    // Rebuild hashes and structural checks; metadata in an uploaded ZIP is not trusted evidence.
    files.delete(portable);
  } else if (sceneManifest) {
    const m = json(sceneManifest);
    if (m.format !== 'workbench-scene-godot')
      throw new Error('场景包清单无效。');
    kind = 'scene';
    entryScenes = [m.scene];
    // Earlier scene manifests did not declare the runtime. Split scenery can
    // be delivered on its own; ordinary map-only exports include the runtime.
    const legacyRuntime = 'res://addons/workbench_interaction/runtime/v1/interaction_runtime_2d.tscn';
    runtime = Object.hasOwn(m, 'runtime') ? m.runtime
      : (m.mapSplit && m.instances?.length === 0 && !files.has(legacyRuntime.slice(6)) ? null : legacyRuntime);
    details = {
      sceneId: m.sceneId,
      instances: m.instances,
      actorSlot: 'ActorSlot',
      actorZIndex: m.actorZIndex,
      runtimeIncludedInScene: Boolean(runtime),
    };
  } else if (objectManifest) {
    const m = json(objectManifest);
    if (m.format !== 'workbench-interaction-kit')
      throw new Error('交互物包清单无效。');
    kind = 'interactable';
    entryScenes = m.objects.map((o) => o.scene);
    runtime = m.runtime;
    details = {
      objects: m.objects,
      targetProfile: m.targetProfile,
      compatibility: m.compatibility,
      runtimeIncludedInScene: false,
    };
  } else if (spriteResource) {
    kind = 'animation';
    spriteFrames = ['res://' + spriteResource];
    entryScenes = [...files.keys()]
      .filter(
        (p) =>
          p.startsWith('forge_sprites/') && p.endsWith('/animated_sprite.tscn'),
      )
      .map((p) => 'res://' + p);
    const exportPath = spriteResource.replace(
      '/sprite_frames.tres',
      '/export.json',
    );
    const contract = files.has(exportPath) ? json(exportPath) : null;
    details = {
      singleAction: true,
      preserveOtherActions: true,
      animation: contract?.animation,
      frameCount: contract?.frame_count,
      fps: contract?.fps,
      loop: contract?.loop,
      candidateIndex: contract?.candidate_index,
      jobId: contract?.job_id,
      frameRegions: contract?.source_region_px,
    };
  } else if (
    files.has('map_scene.tscn') &&
    files.has('map_export.json') &&
    json('map_export.json').format === 'frame-ronin-engine-package'
  ) {
    kind = 'map';
    const identity = await digest(
      encoder.encode(
        (
          await Promise.all(
            [...files.entries()]
              .filter(([p]) => p.endsWith('.png') || p === 'regions.json')
              .sort(([a], [b]) => a.localeCompare(b))
              .map(async ([p, b]) => p + ':' + (await digest(b))),
          )
        ).join('\n'),
      ),
    );
    const root = 'forge_maps/map-' + identity.slice(0, 20);
    const renamed = new Map();
    for (const [name, data] of files) {
      if (name === 'project.godot' || name === 'INSTALL.md') continue;
      let contents = data;
      if (/\.(tscn|tres|gd)$/.test(name)) {
        let source = decoder
          .decode(data)
          .replace(
            /res:\/\/([^"\s)]+)/g,
            (_, p) => 'res://' + root + '/' + safePackagePath(p),
          );
        // Per-map region helper is a preloadable script, not a conflicting global class.
        if (name === 'frame_ronin_regions.gd')
          source = source.replace(/^class_name FrameRoninRegions\r?\n/m, '');
        contents = encoder.encode(source);
      }
      renamed.set(root + '/' + name, contents);
    }
    const regions = json('regions.json');
    files = renamed;
    entryScenes = ['res://' + root + '/map_scene.tscn'];
    details = {
      coordinateSystem: regions.coordinateSystem,
      canvas: regions.canvas,
      collisionCount: regions.regions?.filter((r) => r.layer === 'collision')
        .length,
      sourcePackage: files.has(root + '/source_state.zip')
        ? root + '/source_state.zip'
        : null,
    };
  } else
    throw new Error(
      '没有找到可用的 Godot 场景或 SpriteFrames。请先在原工具导出 Godot 包。',
    );
  if (
    !['map', 'scene', 'interactable', 'animation'].includes(kind) ||
    !Array.isArray(entryScenes) ||
    !Array.isArray(spriteFrames)
  )
    throw new Error('Godot 包身份无效。');
  const entries = [
    ...entryScenes,
    ...spriteFrames,
    ...(runtime ? [runtime] : []),
  ];
  if (
    !entries.length ||
    entries.some(
      (p) =>
        typeof p !== 'string' ||
        !p.startsWith('res://') ||
        !files.has(p.slice(6)),
    )
  )
    throw new Error('Godot 包入口资源缺失。');
  const inventory = [];
  for (const [name, data] of files) {
    if (
      name
        .toLowerCase()
        .split('/')
        .some((p) =>
          [
            'project.godot',
            '.godot',
            '.git',
            '.env',
            'agents.md',
            'agent.md',
            '.codex',
            '.agents',
          ].includes(p),
        )
    )
      throw new Error('Godot 素材包不能包含项目配置、缓存或 Agent 指令。');
    if (
      !/^(scenes|addons\/workbench_interaction(?:_copyworms)?|forge_sprites|forge_maps|forge_packages)\//.test(
        name,
      )
    )
      throw new Error('Godot 包包含未知的根目录：' + name);
    if (/\.(tscn|tres|gd)$/.test(name)) {
      for (const match of decoder
        .decode(data)
        .matchAll(/res:\/\/([^"'\s)]+)/g)) {
        const ref = safePackagePath(match[1]);
        if (!files.has(ref)) throw new Error('Godot 资源引用缺失：' + ref);
      }
    }
    inventory.push({
      path: name,
      sha256: await digest(data),
      bytes: data.length,
    });
  }
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  const id =
    kind +
    '-' +
    (await digest(encoder.encode(JSON.stringify(inventory)))).slice(0, 24);
  const manifest = {
    format: 'forge-godot-export',
    version: 1,
    packageId: id,
    kind,
    engine: 'Godot 4.7.x',
    entryScenes,
    spriteFrames,
    runtime,
    details,
    files: inventory,
  };
  const output = new JSZip();
  for (const [name, data] of files)
    output.file(name, data, { date: new Date('2000-01-01T00:00:00Z'), createFolders:false });
  output.file(
    'forge_packages/' + id + '/manifest.json',
    JSON.stringify(manifest, null, 2),
    { date: new Date('2000-01-01T00:00:00Z'), createFolders:false },
  );
  return {
    bytes: await output.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    }),
    manifest,
  };
}

/** The editing readers keep their original map origin/layer contract. */
export function unwrapGodotMapZip(zip) {
  const maps = Object.keys(zip.files).filter((p) =>
    /^forge_maps\/[^/]+\/map_export.json$/.test(p),
  );
  if (!maps.length) return zip;
  if (maps.length !== 1) throw new Error('请选择只包含一张地图的源包。');
  const prefix = maps[0].slice(0, -'map_export.json'.length),
    result = new JSZip();
  for (const [name, entry] of Object.entries(zip.files))
    if (!entry.dir && name.startsWith(prefix)) {
      const local = safePackagePath(name.slice(prefix.length));
      result.file(local, entry.async('uint8array'));
    }
  return result;
}
