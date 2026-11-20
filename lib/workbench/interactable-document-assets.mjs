import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
export function interactableImageCommands(document, image, input) {
  const commands = [];
  if (image.kind !== 'prop' || !input.definitionId || !document.content.objects.some((object) => object.definitionId === input.definitionId))
    throw new Error('透明物品采用需要现有交互物 definitionId 和 prop 图片。');
  const id = `image_${hash(image.task.id).slice(0, 32)}`;
  const asset = { id, name: `${image.name}.png`, mime: 'image/png', source: `data:image/png;base64,${image.bytes.toString('base64')}`, generation: image.generation };
  const existing = document.content.assets.find((value) => value.id === id);
  if (existing && (existing.source !== asset.source || existing.generation?.sha256 !== input.sha256 || existing.generation?.sourceTaskId !== image.task.id)) throw new Error('素材身份冲突。');
  if (!existing) commands.push({ type: 'add-asset', asset });
  commands.push({ type: 'bind-asset', definitionId: input.definitionId, assetId: id, target: 'visual' });
  commands.push({ type: 'set-visual', definitionId: input.definitionId, visual: { idleAnimation: '', focusAnimation: '' } });
  return commands;
}
