import { appearanceAnimation } from '../../features/interactable-editor/contract.mjs';
import { getDocument, applyDocumentCommands } from './editor-documents.mjs';
import { readImageAssetSource } from './adapters/image-assets-source.mjs';
import { checkSource, digest, failure, hash, pixels, publicTarget, summary } from './image-edit-target-common.mjs';

function resolveSlot(document, ref) {
  if (document.kind !== 'interactable' || document.id !== ref.documentId) throw failure('目标不是指定的交互物文档。');
  const object = document.content.objects.find(object => object.definitionId === ref.definitionId);
  if (!object) throw failure('交互物定义已不存在。', 404, 'IMAGE_TARGET_NOT_FOUND');
  return resolveObjectSlot(document.content, object, ref);
}
export function resolveObjectSlot(project, object, ref) {
  let entry;
  if (ref.slot === 'toggle-state') {
    if (object.behavior.kind !== 'toggle') throw failure('该物件没有切换状态图片。');
    entry = object.behavior.states[ref.index];
  } else if (ref.slot === 'sequence-entry') {
    if (object.behavior.kind !== 'sequence') throw failure('该物件没有序列条目图片。');
    entry = object.behavior.entries[ref.index];
  }
  if (ref.slot !== 'visual' && !entry) throw failure('指定状态或序列条目已不存在。', 404, 'IMAGE_TARGET_NOT_FOUND');
  const assetId = ref.slot === 'visual' ? object.visual.assetId : entry.appearance.assetId || object.visual.assetId;
  const asset = project.assets.find(asset => asset.id === assetId);
  if (!asset || !asset.mime.startsWith('image/')) throw failure('指定槽位没有可编辑的静态源图片。', 404, 'IMAGE_TARGET_NOT_FOUND');
  const animated = ref.slot !== 'visual' && Boolean(appearanceAnimation(entry.appearance, object.visual));
  return { object, entry, asset, animated, inherited: Boolean(entry && !entry.appearance.assetId) };
}
async function documentTarget(root, manifest, ref, selectedDocument) {
  const document = selectedDocument || (await getDocument(root, manifest, { documentId: ref.documentId })).document;
  const { object, entry, asset, animated, inherited } = resolveSlot(document, ref);
  const source = await readImageAssetSource(asset.source, root);
  const info = await pixels(source.buffer, { mime: asset.mime, sha256: asset.generation?.sha256 });
  const slotFingerprint = digest({ definitionId: object.definitionId, slot: ref.slot, index: ref.index, content: entry || object.visual, assetId: asset.id, sha256: info.sha256 });
  const binding = ref.slot === 'visual' ? { imageBindingFingerprint: digest({ definitionId: object.definitionId, slot: ref.slot, assetId: asset.id, sha256: info.sha256 }) } : {};
  return { ...summary(ref, info, { ...binding, revision: document.revision, slotFingerprint, kind: 'prop', name: `${document.name} · ${object.displayName} · ${entry?.name || '默认外观'}`, locked: false, editable: !animated, ...(animated ? { readOnlyReason: '状态正在播放动画，请在原编辑器明确选择静态外观后再局部调整。' } : {}), inherited, generation: asset.generation, source: { documentId: document.id, definitionId: object.definitionId, assetId: asset.id, name: asset.name, slot: ref.slot, index: ref.index }, viewPath: document.viewPath, willStopDefaultAnimations: ref.slot === 'visual' && Boolean(object.visual.idleAnimation || object.visual.focusAnimation) }), bytes: source.buffer };
}

function addDocumentRefs(document, add) {
  for (const object of document.content.objects) {
    if (object.visual.assetId) add({ kind: 'interactable', documentId: document.id, definitionId: object.definitionId, slot: 'visual' }, `${document.name} ${object.displayName} 默认外观`);
    const entries = object.behavior.kind === 'toggle' ? object.behavior.states : object.behavior.kind === 'sequence' ? object.behavior.entries : [];
    for (const [index, entry] of entries.entries()) if (entry.appearance.assetId || object.visual.assetId) add({ kind: 'interactable', documentId: document.id, definitionId: object.definitionId, slot: object.behavior.kind === 'toggle' ? 'toggle-state' : 'sequence-entry', index }, `${document.name} ${object.displayName} ${entry.name}`);
  }
}

async function applyTarget(root, manifest, ref, parsed, candidate) {
  const { document } = await getDocument(root, manifest, { documentId: ref.documentId, revision: parsed.expectedRevision });
  const source = await documentTarget(root, manifest, ref, document);
  checkSource(source, parsed, candidate);
  const assetId = `image_${hash(candidate.task.id).slice(0, 32)}`;
  const asset = { id: assetId, name: parsed.name || source.source.name, mime: 'image/png', source: `data:image/png;base64,${candidate.bytes.toString('base64')}`, generation: { sourceTaskId: candidate.task.id, sha256: candidate.info.sha256 } };
  const existing = document.content.assets.find(asset => asset.id === assetId);
  if (existing && (existing.source !== asset.source || existing.generation?.sourceTaskId !== candidate.task.id || existing.generation?.sha256 !== asset.generation.sha256)) throw failure('候选素材身份冲突。', 409, 'IMAGE_ASSET_ID_CONFLICT');
  const commands = [...(!existing ? [{ type: 'add-asset', asset }] : []), { type: 'bind-asset', definitionId: ref.definitionId, assetId, target: ref.slot, ...(ref.index !== undefined ? { index: ref.index } : {}) }, ...(ref.slot === 'visual' ? [{ type: 'set-visual', definitionId: ref.definitionId, visual: { idleAnimation: '', focusAnimation: '' } }] : [])];
  const result = await applyDocumentCommands(root, manifest, { documentId: ref.documentId, expectedRevision: parsed.expectedRevision, commandId: parsed.commandId, commands });
  const target = await documentTarget(root, manifest, ref, result.document);
  return { target: publicTarget(target), revision: result.document.revision, currentRevision: result.currentRevision, replayed: result.replayed, adoption: { status: 'adopted', targetId: target.targetId, documentId: ref.documentId, definitionId: ref.definitionId, slot: ref.slot, index: ref.index, assetId, sourceTaskId: candidate.task.id, sha256: target.sha256, revision: target.revision, commandId: parsed.commandId } };
}

export const interactableImageTargetSource = {
  kinds: ['interactable'], documentKind: 'interactable', integerRevision: true,
  read: documentTarget, addDocumentRefs, apply: applyTarget,
};
