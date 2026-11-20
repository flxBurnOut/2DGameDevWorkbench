import { z } from 'zod';

export const KIT_VERSION = '1.0.0';
export const KINDS = ['inspect', 'toggle', 'pickup', 'sequence'];
export const KIND_LABELS = {
  inspect: '查看',
  toggle: '切换',
  pickup: '拾取',
  sequence: '序列',
};
export const TRIGGERS = [
  'proximity_press',
  'pointer_click',
  'automatic_enter',
  'external_request',
];
const id = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/,
    'ID 只能包含字母、数字、横线和下划线',
  );
const number = (fallback, min = -8192, max = 8192) =>
  z.number().finite().min(min).max(max).default(fallback);
const text = (fallback = '') => z.string().max(100000).default(fallback);
const point = z.object({ x: number(0), y: number(0) }).default({});
const shape = z
  .object({
    type: z.enum(['rectangle', 'circle', 'capsule']).default('rectangle'),
    width: number(120, 1),
    height: number(100, 1),
    radius: number(60, 1),
    offset: point,
  })
  .default({});
const appearance = z
  .object({
    assetId: text(),
    animation: text(),
    staticImage: z.boolean().optional(),
    visible: z.boolean().default(true),
    solidEnabled: z.boolean().default(false),
    tint: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#ffffff'),
  })
  .default({});
const feedback = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('show_text'),
    pages: z.array(z.string().max(100000)).max(100).default([]),
  }),
  z.object({ type: z.literal('wait'), seconds: number(0.5, 0, 3600) }),
  z.object({
    type: z.literal('play_animation'),
    importedTransition: z.literal(true).optional(),
    animation: text(),
    waitForEnd: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('play_audio'),
    assetId: text(),
    waitForEnd: z.boolean().default(true),
    volumeDb: number(0, -80, 12),
  }),
]);
const entry = z.object({
  name: text('步骤'),
  pages: z.array(z.string()).max(100).default([]),
  appearance,
  feedback: z.array(feedback).max(100).default([]),
});
export const objectSchema = z.object({
  definitionId: id,
  displayName: z.string().min(1).max(200).default('新交互物'),
  visual: z
    .object({
      assetId: text(),
      width: number(64, 1),
      height: number(64, 1),
      offset: point,
      scale: number(1, 0.01, 100),
      flipH: z.boolean().default(false),
      flipV: z.boolean().default(false),
      zIndex: number(0, -4096, 4096),
      visible: z.boolean().default(true),
      tint: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#ffffff'),
      idleAnimation: text(),
      focusAnimation: text(),
      float: z.boolean().default(false),
      dot: z.boolean().default(false),
      clips: z
        .array(
          z.object({
            name: id,
            fps: number(8, 0.1, 120),
            loop: z.boolean().default(true),
            frames: z
              .array(
                z.object({
                  assetId: id,
                  region: z
                    .object({
                      x: number(0, 0),
                      y: number(0, 0),
                      width: number(32, 1),
                      height: number(32, 1),
                    })
                    .optional(),
                  duration: number(1, 0.01, 100),
                }),
              )
              .min(1)
              .max(1000),
          }),
        )
        .max(100)
        .default([]),
    })
    .default({}),
  detection: z
    .object({
      shape,
      actorGroup: z.string().min(1).max(100).default('interaction_actor'),
      mask: number(1, 0, 4294967295),
      priority: number(0, -10000, 10000),
    })
    .default({}),
  pointer: shape,
  solid: z
    .object({
      enabled: z.boolean().default(false),
      shape,
      layer: number(1, 0, 4294967295),
      mask: number(1, 0, 4294967295),
    })
    .default({}),
  activation: z
    .object({
      mode: z.enum(TRIGGERS).default('proximity_press'),
      action: z.string().min(1).max(100).default('workbench_interact'),
      key: z.string().min(1).max(32).default('E'),
      cancelOnExit: z.boolean().default(false),
      enabled: z.boolean().default(true),
    })
    .default({}),
  content: z
    .object({
      prompt: text(),
      pages: z.array(z.string().max(100000)).max(100).default([]),
      charactersPerSecond: number(40, 0, 300),
      promptOffset: z.object({ x: number(0), y: number(-65) }).default({}),
    })
    .default({}),
  behavior: z
    .object({
      kind: z.enum(KINDS).default('inspect'),
      repeat: z.boolean().default(true),
      initialToggle: z.boolean().default(false),
      states: z
        .array(entry)
        .length(2)
        .default([{ name: '关闭' }, { name: '开启' }]),
      entries: z
        .array(entry)
        .min(1)
        .max(100)
        .default([{ name: '第一步' }]),
      onEnd: z.enum(['stop', 'loop', 'stay_last']).default('stop'),
    })
    .default({}),
  feedback: z.array(feedback).max(100).default([]),
  cooldownSeconds: number(0, 0, 3600),
  completion: z.enum(['remain', 'hide', 'free']).default('remain'),
  memory: z
    .object({
      scope: z.enum(['instance', 'session', 'persistent']).default('instance'),
      namespace: id.default('workbench'),
      slot: id.default('default'),
    })
    .default({}),
});
export const assetSchema = z.object({
  id,
  name: z.string().min(1).max(240),
  mime: z.enum([
    'image/png',
    'image/jpeg',
    'image/webp',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/mpeg',
  ]),
  source: z.string().min(1).max(90000000),
  generation: z.object({
    sourceTaskId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,199}$/i),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
});
export const projectSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  projectId: id,
  name: z.string().min(1).max(200).default('交互物项目'),
  assets: z.array(assetSchema).max(2000).default([]),
  objects: z.array(objectSchema).min(1).max(200),
});

export function makeId(prefix = 'object') {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}
export function createObject(kind = 'inspect') {
  return objectSchema.parse({
    definitionId: makeId(),
    displayName: `新${KIND_LABELS[kind]}物件`,
    behavior: { kind, repeat: kind !== 'pickup' },
    completion: kind === 'pickup' ? 'hide' : 'remain',
  });
}
export function createProject() {
  return projectSchema.parse({
    projectId: makeId('project'),
    objects: [createObject()],
  });
}
export function nextClipName(object) {
  let index = 1;
  while (object.visual.clips.some((clip) => clip.name === `clip_${index}`))
    index++;
  return `clip_${index}`;
}
export function appearanceAnimation(appearance, visual) {
  return appearance.animation || (appearance.staticImage ? '' : visual.idleAnimation);
}
export function normalizeProject(input) {
  const p = projectSchema.parse(input);
  for (const collection of [
    p.assets.map((a) => a.id),
    p.objects.map((o) => o.definitionId),
  ])
    if (new Set(collection).size !== collection.length)
      throw new Error('项目内 ID 重复，请复制为新的物件或素材。');
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  for (const o of p.objects) {
    if (o.behavior.kind === 'pickup') o.behavior.repeat = false;
    const clips = new Map(o.visual.clips.map((c) => [c.name, c]));
    if (clips.size !== o.visual.clips.length)
      throw new Error(`${o.displayName}：动画名称重复`);
    const checkAssetReference = (key, media) => {
      if (key && (!assets.has(key) || !assets.get(key).mime.startsWith(media)))
        throw new Error(
          `${o.displayName}：缺少${media === 'image' ? '图片' : '音效'}素材 ${key}`,
        );
    };
    const checkClipReference = (name, wait = false) => {
      if (!name) return;
      if (!clips.has(name))
        throw new Error(`${o.displayName}：动画 ${name} 不存在`);
      if (wait && clips.get(name).loop)
        throw new Error(`${o.displayName}：循环动画 ${name} 不能等待结束`);
    };
    checkAssetReference(o.visual.assetId, 'image');
    checkClipReference(o.visual.idleAnimation);
    checkClipReference(o.visual.focusAnimation);
    for (const c of clips.values())
      for (const f of c.frames) checkAssetReference(f.assetId, 'image');
    const entries =
      o.behavior.kind === 'toggle'
        ? o.behavior.states
        : o.behavior.kind === 'sequence'
          ? o.behavior.entries
          : [];
    for (const e of entries) {
      checkAssetReference(e.appearance.assetId, 'image');
      checkClipReference(e.appearance.animation);
    }
    for (const s of [...o.feedback, ...entries.flatMap((e) => e.feedback)]) {
      if (s.type === 'play_audio') checkAssetReference(s.assetId, 'audio');
      if (s.type === 'play_animation')
        checkClipReference(s.animation, s.waitForEnd);
    }
  }
  return p;
}
export function selectedProject(input, ids) {
  const all = projectSchema.parse(input);
  const selected = ids?.length ? ids : all.objects.map((o) => o.definitionId);
  if (
    new Set(selected).size !== selected.length ||
    selected.some((i) => !all.objects.some((o) => o.definitionId === i))
  )
    throw new Error('导出的物件选择无效');
  return normalizeProject({
    ...all,
    objects: all.objects.filter((o) => selected.includes(o.definitionId)),
  });
}
export function referencedAssets(p) {
  const used = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.assetId === 'string' && value.assetId)
      used.add(value.assetId);
    for (const v of Object.values(value)) walk(v);
  };
  walk(p.objects);
  return p.assets.filter((a) => used.has(a.id));
}
export function describeError(error) {
  return error instanceof z.ZodError
    ? error.issues.map((i) => `${i.path.join('.')}：${i.message}`).join('\n')
    : error instanceof Error
      ? error.message
      : String(error);
}
