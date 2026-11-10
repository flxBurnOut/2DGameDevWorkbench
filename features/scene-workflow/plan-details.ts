import { stepInputs } from '@/lib/workbench/scene-workflow-contract.mjs';
import type { Scene } from '@/features/scene-composer/model.mjs';
import { simulationEventSchema } from '@/features/scene-composer/simulation-replay.mjs';

type RecordValue = Record<string, unknown>;
export type PlanDetailRow = { label: string; value: string };
export type PlanStepDetails = { rows: PlanDetailRow[]; changes: { title: string; rows: PlanDetailRow[] }[]; warning?: string };
export const objectValue = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
export const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const textValue = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const labels: Record<string, string> = {
  name: '名称', kind: '行为类型', x: '横坐标', y: '纵坐标', dx: '水平移动', dy: '垂直移动', width: '宽度', height: '高度', radius: '半径', offset: '偏移', anchor: '锚点', scale: '缩放倍数', flipH: '水平翻转', flipV: '垂直翻转', zIndex: '遮挡层级', visible: '是否显示', enabled: '是否启用', locked: '是否锁定', hidden: '编辑时隐藏', included: '参与导出', solidEnabled: '实体碰撞', tint: '颜色', idleAnimation: '待机动画', focusAnimation: '聚焦动画', float: '悬浮效果', dot: '提示标记', mode: '触发方式', action: '输入动作', key: '按键', cancelOnExit: '离开时取消', prompt: '提示文字', pages: '文本页', charactersPerSecond: '每秒字符数', promptOffset: '提示位置', repeat: '允许重复', initialToggle: '初始开关', states: '开关状态', entries: '序列条目', onEnd: '序列结束', feedback: '反馈', appearance: '外观', animation: '动画', waitForEnd: '等待播放结束', seconds: '等待秒数', volumeDb: '音量（dB）', type: '类型', actorGroup: '角色分组', mask: '感知掩码', priority: '优先级', cooldownSeconds: '冷却秒数', completion: '完成后处理', target: '目标位置', index: '条目序号（从 0 开始）', assetId: '图片或音效', materialId: '场景素材', definitionId: '物件定义', instanceId: '场景物件', sourceInstanceId: '来源物件', targetInstanceId: '目标物件', ids: '选中物件', linkId: '联动', event: '触发事件', value: '设置值', zoom: '缩放', grid: '网格大小', showGrid: '显示网格', showNames: '显示名称', showShapes: '显示范围', showActor: '显示测试来源', layer: '碰撞层', solid: '实体碰撞', detection: '感知范围', pointer: '点击范围', shape: '形状', points: '顶点', animationName: '动画名称', source: '源文件', mime: '媒体类型', duration: '帧时长', fps: '每秒帧数', loop: '循环播放', completed: '是否完成', toggleState: '开关状态', sequenceIndex: '序列位置', successCount: '成功次数', content: '文字内容', visual: '外观', activation: '触发设置', behavior: '行为配置', view: '编辑视图', collisions: '碰撞区域', links: '联动', patch: '修改内容', project: '交互物项目', map: '地图', id: '记录身份', region: '图片区域', frames: '动画帧', clips: '动画片段', source_toggle: '跟随来源开关', count: '次数', memory: '状态记忆', namespace: '命名空间', slot: '槽位', scope: '记忆范围', solidEnabledValue: '碰撞状态',
};
const values: Record<string, string> = { inspect: '查看', toggle: '切换', pickup: '拾取', sequence: '序列', proximity_press: '靠近后按键', pointer_click: '鼠标点击', automatic_enter: '进入范围自动触发', external_request: '外部调用', rectangle: '矩形', circle: '圆形', capsule: '胶囊形', show_text: '显示文本', wait: '等待', play_animation: '播放动画', play_audio: '播放音效', remain: '保留', hide: '隐藏', free: '移除', stop: '停止', loop: '循环', stay_last: '停留末条', visual: '默认外观', 'toggle-state': '切换状态外观', 'sequence-entry': '序列条目外观', front: '最前', back: '最后', forward: '向前一层', backward: '向后一层', before: '放在目标前', after: '放在目标后', index: '指定位置', set_toggle: '设置开关', set_enabled: '设置可交互状态', set_visible: '设置显示状态', source_toggle: '跟随来源开关', instance: '当前实例', session: '本局', persistent: '持久化' };
export const eventNames: Record<string, string> = { focus_entered: '进入焦点', focus_exited: '离开焦点', interaction_started: '开始交互', interaction_finished: '结束交互', interaction_completed: '完成交互', interaction_cancelled: '取消交互', picked_up: '拾取', toggled: '开关切换', sequence_advanced: '序列前进', play_animation: '播放动画', play_audio: '播放音效', state_changed: '状态改变', link_applied: '联动已应用', link_skipped: '联动被跳过', link_error: '联动错误' };
const commandNames: Record<string, string> = { rename: '重命名工程', 'set-view': '调整编辑视图', 'import-material': '加入交互物素材', 'replace-material': '替换场景素材', 'add-instance': '摆放新物件', 'move-instances': '移动物件', 'scale-instances': '缩放物件', 'flip-instances': '翻转物件', 'set-node-flags': '修改显示与锁定', reorder: '调整遮挡顺序', 'replace-instances': '替换物件外观与行为', 'remove-instances': '移除物件', 'replace-map': '替换地图', 'move-map': '移动整张地图', 'set-map-collisions': '设置地图碰撞', 'set-anchor': '设置物件锚点', 'set-links': '设置全部联动', 'add-link': '增加联动', 'update-link': '修改联动', 'remove-links': '删除联动', 'add-object': '创建物件定义', 'remove-object': '移除物件定义', 'rename-object': '重命名物件', 'add-asset': '加入媒体素材', 'bind-asset': '绑定图片或音效', 'set-visual': '修改物件外观', 'set-shape': '修改交互范围', 'set-activation': '设置触发方式', 'set-content': '修改提示与文本', 'set-behavior': '配置交互行为', 'set-feedback': '设置交互反馈', 'set-completion': '设置完成后的状态' };
const numberText = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(value) : '未记录';
export function planNames(scene?: Scene, steps: unknown[] = []) {
  const names = new Map<string, string>();
  if (scene) {
    names.set('actor', '测试来源');
    for (const item of scene.instances) names.set(item.id, item.name);
    for (const item of scene.materials) {
      names.set(item.id, item.name);
      for (const object of item.project.objects) names.set(object.definitionId, object.displayName);
      for (const asset of item.project.assets) names.set(asset.id, asset.name);
    }
    for (const layer of scene.map?.layers || []) names.set(layer.id, layer.name);
  }
  for (const value of steps) {
    const step = objectValue(value);
    try {
      const input = objectValue(JSON.parse(textValue(step.input)));
      const name = textValue(input.name);
      if (name) for (const key of ['materialId', 'definitionId']) if (typeof input[key] === 'string') names.set(input[key] as string, name);
    } catch { /* Historical or unknown formats remain available as plain technical records. */ }
  }
  for (const value of steps) {
    try {
      for (const command of arrayValue(objectValue(JSON.parse(textValue(objectValue(value).input))).commands)) {
        const item = objectValue(command);
        if (item.type === 'add-instance' && typeof item.instanceId === 'string') names.set(item.instanceId, names.get(textValue(item.materialId)) || '计划中的物件');
      }
    } catch { /* Displaying details never executes or repairs a plan. */ }
  }
  return names;
}
export function readableValue(value: unknown, key = '', names = new Map<string, string>(), depth = 0): string {
  if (depth > 5) return '详细内容见高级记录';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (/^(?:data:|[A-Za-z0-9+/]{1000})/.test(value)) return '已内嵌的媒体数据';
    if (key.endsWith('Id') || key === 'ids') return names.get(value) || '未命名对象（身份见高级记录）';
    if (key === 'event') return eventNames[value] || value;
    return (['kind', 'mode', 'action', 'target', 'onEnd', 'completion', 'type', 'slot', 'scope', 'value'].includes(key) ? values[value] : undefined) || value || '空';
  }
  if (value === null || value === undefined) return '未指定';
  if (Array.isArray(value)) return value.slice(0, 12).map((item, index) => `${typeof item === 'object' ? `${index + 1}. ` : ''}${readableValue(item, key, names, depth + 1)}`).join('；') + (value.length > 12 ? `；共 ${value.length} 项，其余见高级记录` : '') || '无';
  const object = objectValue(value);
  if (key === 'project') return `${textValue(object.name, '交互物项目')}，${arrayValue(object.objects).length} 个物件`;
  if (key === 'map') return `${textValue(object.name, '地图')}，${arrayValue(object.layers).length} 个图层、${arrayValue(object.collisions).length} 个碰撞区域`;
  return Object.entries(object).filter(([field]) => !['generation', 'source', 'id'].includes(field)).slice(0, 16).map(([field, item]) => `${labels[field] || field}：${readableValue(item, field, names, depth + 1)}`).join('；') || '详细内容见高级记录';
}
function commandRows(command: RecordValue, names: Map<string, string>) {
  return Object.entries(command).filter(([key]) => key !== 'type' && !(key === 'instanceId' && command.type === 'add-instance')).map(([key, value]) => ({ label: labels[key] || key, value: readableValue(value, key, names) }));
}
export function describePlanStep(step: { kind?: unknown; input?: unknown }, names = new Map<string, string>()): PlanStepDetails {
  const result: PlanStepDetails = { rows: [], changes: [] };
  let input: RecordValue;
  try {
    if (typeof step.input !== 'string' || step.input.length > 100000) throw new Error();
    const schema = stepInputs[textValue(step.kind) as keyof typeof stepInputs];
    if (!schema) throw new Error();
    const parsed = schema.safeParse(JSON.parse(step.input));
    if (!parsed.success) throw new Error();
    input = objectValue(parsed.data);
  } catch { return { ...result, warning: '此历史步骤无法按当前格式解读。原始记录保留在高级信息中；显示详情不会修改方案。' }; }
  const row = (label: string, value: unknown, key = '') => result.rows.push({ label, value: readableValue(value, key, names) });
  if (step.kind === 'generate') {
    row('制作内容', input.name); row('生成描述', input.prompt); row('图片尺寸', `${numberText(input.width)} × ${numberText(input.height)} 像素`); row('物件显示尺寸', `${numberText(input.visualWidth)} × ${numberText(input.visualHeight)}`);
  } else if (step.kind === 'map') {
    row('地图操作', input.operation === 'create' ? '创建中心地图' : '沿相邻图块扩建'); row('名称', input.name); row('生成描述', input.prompt);
    if (input.operation === 'create') { row('画面比例', input.aspectRatio); row('地图原点', input.origin); }
    else { row('扩建方向', ({ left: '向左', right: '向右', up: '向上', down: '向下' } as Record<string, string>)[textValue(input.direction)]); row('重叠比例', `${numberText(input.overlapPercent)}%`); row('相邻图块', input.neighborTileKey); }
  } else if (step.kind === 'object') {
    row('制作物件', input.name);
    const source = objectValue(input.source);
    row('来源', source.kind === 'scene' ? `当前场景：${readableValue(source.materialId, 'materialId', names)}` : '选定的共享交互物工程（具体身份见高级信息）');
  } else if (step.kind === 'image') {
    const target = objectValue(input.target), operation = objectValue(input.operation);
    row('修改目标', target.kind === 'scene-layer' ? readableValue(target.layerId, 'layerId', names) : readableValue(target.instanceId, 'instanceId', names));
    if (target.slot) row('外观位置', target.slot, 'slot');
    if (target.index !== undefined) row('状态或条目', `第 ${Number(target.index) + 1} 项`);
    const operations: Record<string, string> = { 'metal-panel': '拼板换金属', 'palette-map': '一次多色替换', 'clean-alpha': '清理透明边缘', 'replace-color': '替换颜色', fill: '填充颜色', erase: '擦除', translate: '移动选区', 'restore-region': '恢复选区', 'pixel-patch': '应用像素修改', 'ai-edit': 'AI 局部修改' };
    row('修改方式', operations[textValue(operation.type)] || operation.type);
    row('执行方式', operation.type === 'ai-edit' ? '调用图片服务' : '本地像素操作');
    if (operation.type === 'palette-map') {
      for (const value of arrayValue(operation.pairs)) {
        const pair = objectValue(value);
        row('配色', textValue(pair.from) + ' → ' + textValue(pair.to));
      }
    }
    if (operation.prompt) row('修改描述', operation.prompt);
    for (const [key, value] of Object.entries(operation)) if (!['type', 'pairs', 'prompt', 'references', 'spans', 'baseRgbaSha256', 'candidateVersion'].includes(key)) row(labels[key] || key, value);
    if (operation.references) row('参考图片', `${arrayValue(operation.references).length} 张`);
    row('区域', describeRegion(input.region)); row('保留透明度', input.preserveAlpha);
  }
  for (const command of arrayValue(input.commands)) {
    const item = objectValue(command);
    result.changes.push({ title: commandNames[textValue(item.type)] || '文档修改', rows: commandRows(item, names) });
  }
  if (input.commands && !result.changes.length) row('行为调整', '沿用来源物件的既有行为');
  return result;
}
export function describeRegion(value: unknown) {
  const region = objectValue(value), type = textValue(region.type);
  if (value === null) return '整张候选画面';
  if (value === undefined) return '未记录检查范围';
  if (['rectangle', ''].includes(type) && [region.x, region.y, region.width, region.height].every(number => typeof number === 'number' && Number.isFinite(number))) return `矩形：左上角 (${numberText(region.x)}, ${numberText(region.y)})，${numberText(region.width)} × ${numberText(region.height)}`;
  if (type === 'all') return '整张图片';
  if (type === 'polygon') return `多边形，${arrayValue(region.points).length} 个顶点`;
  if (type === 'mask-runs') return `像素选区，${arrayValue(region.spans).length} 段`;
  if (type === 'alpha-bounds') return `非透明内容范围，阈值 ${numberText(region.threshold)}`;
  if (type === 'alpha-selection') return `透明度范围 ${numberText(region.minAlpha)}–${numberText(region.maxAlpha)}`;
  if (type === 'connected-color') return `从 (${numberText(region.x)}, ${numberText(region.y)}) 选择相连颜色，容差 ${numberText(region.tolerance)}`;
  if (type === 'named') return '已保存的命名区域（身份见高级信息）';
  return '历史区域格式，详见高级信息';
}
export function describeReplayEvent(value: unknown, names: Map<string, string>) {
  const parsed = simulationEventSchema.safeParse(value);
  if (!parsed.success) return '无法解读的历史输入，详见高级信息';
  const event = objectValue(parsed.data);
  switch (event.type) {
    case 'move-actor': return `移动测试来源到 (${numberText(event.x)}, ${numberText(event.y)})`;
    case 'tick': return `推进 ${numberText(event.seconds)} 秒`;
    case 'press': return '按键交互';
    case 'click': return `点击 (${numberText(event.x)}, ${numberText(event.y)})`;
    case 'request': return `外部触发：${readableValue(event.instanceId, 'instanceId', names)}`;
    case 'advance-text': return '继续文本';
    case 'finish-audio': return '等待音效结束';
    case 'cancel': return '取消当前交互';
    default: return '无法解读的历史输入，详见高级信息';
  }
}
export function technicalText(value: unknown) {
  try { const result = typeof value === 'string' ? value : JSON.stringify(value, null, 2); return result && result.length > 50000 ? `${result.slice(0, 50000)}\n…记录过长，显示已截断` : result || '无原始记录'; }
  catch { return '原始记录无法显示。'; }
}
