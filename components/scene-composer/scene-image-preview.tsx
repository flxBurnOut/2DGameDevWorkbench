'use client';
import { useId } from 'react';
import type { ImageTargetRef } from '@/features/image-edit/client';
import { materialFor, sceneBounds, type Scene } from '@/features/scene-composer/model.mjs';
import { instanceRect, mapSplitElementRect, sceneDisplayOrder } from '@/features/scene-composer/render-model.mjs';
import { ObjectArt } from './scene-art';

/** Display-only candidate overlay. Authoritative scene content is never changed. */
export function SceneImagePreview({ scene, target, source }: { scene: Scene; target: ImageTargetRef; source: string }) {
  const clipId = useId();
  const bounds = sceneBounds(scene);
  for (const instance of scene.instances) {
    const material = materialFor(scene, instance); if (!material) continue;
    const rect = instanceRect(instance, material);
    const right = Math.max(bounds.x + bounds.width, rect.x + rect.width), bottom = Math.max(bounds.y + bounds.height, rect.y + rect.height);
    bounds.x = Math.min(bounds.x, rect.x); bounds.y = Math.min(bounds.y, rect.y);
    bounds.width = right - bounds.x; bounds.height = bottom - bounds.y;
  }
  for (const element of scene.mapSplit?.elements ?? []) {
    const rect = mapSplitElementRect(scene, element), right = Math.max(bounds.x + bounds.width, rect.x + rect.width), bottom = Math.max(bounds.y + bounds.height, rect.y + rect.height);
    bounds.x = Math.min(bounds.x, rect.x); bounds.y = Math.min(bounds.y, rect.y); bounds.width = right - bounds.x; bounds.height = bottom - bounds.y;
  }
  return <svg viewBox={`${bounds.x - 20} ${bounds.y - 20} ${Math.max(1, bounds.width + 40)} ${Math.max(1, bounds.height + 40)}`} width="100%" height="100%" aria-label="场景候选上下文预览" style={{ imageRendering: 'pixelated' }}>
    {[...sceneDisplayOrder(scene)].reverse().map(entry => {
      const id = entry.id;
      if (entry.kind === 'map-split-part') {
        const selected = target.kind === 'scene-split-part' && target.elementId === id && target.partId === entry.part.id;
        const window = selected && target.kind === 'scene-split-part' ? target.window : undefined;
        const opacity = entry.element.hidden || !entry.element.included ? .3 : 1;
        return <g key={entry.key} opacity={opacity}>
          {window && <defs><clipPath id={clipId}>
            <rect x={entry.rect.x} y={entry.rect.y} width={entry.rect.width} height={window.y} />
            <rect x={entry.rect.x} y={entry.rect.y + window.y + window.height} width={entry.rect.width} height={entry.rect.height - window.y - window.height} />
            <rect x={entry.rect.x} y={entry.rect.y + window.y} width={window.x} height={window.height} />
            <rect x={entry.rect.x + window.x + window.width} y={entry.rect.y + window.y} width={entry.rect.width - window.x - window.width} height={window.height} />
          </clipPath></defs>}
          <image href={selected && !window ? source : entry.part.source} {...entry.rect} clipPath={window ? `url(#${clipId})` : undefined} />
          {window && <image href={source} x={entry.rect.x + window.x} y={entry.rect.y + window.y} width={window.width} height={window.height} />}
        </g>;
      }
      const layer = scene.map?.layers.find(item => item.id === id);
      if (layer && scene.map) return <image key={id} href={target.kind === 'scene-layer' && target.layerId === id ? source : layer.source} x={scene.map.origin.x + scene.map.offset.x} y={scene.map.origin.y + scene.map.offset.y} width={layer.width} height={layer.height} opacity={layer.hidden || !layer.included ? .3 : 1} />;
      const instance = scene.instances.find(item => item.id === id);
      if (!instance) return null;
      const material = materialFor(scene, instance); if (!material) return null;
      let previewMaterial = material;
      if (target.kind === 'scene-instance' && target.instanceId === instance.id) {
        previewMaterial = structuredClone(material);
        const object = previewMaterial.project.objects[0];
        const entry = target.slot === 'toggle-state' && object.behavior.kind === 'toggle' ? object.behavior.states[target.index ?? -1] : target.slot === 'sequence-entry' && object.behavior.kind === 'sequence' ? object.behavior.entries[target.index ?? -1] : undefined;
        let assetId = 'image_context_preview';
        while (previewMaterial.project.assets.some(asset => asset.id === assetId)) assetId += '_';
        previewMaterial.project.assets.push({ id: assetId, name: '候选显示', mime: 'image/png', source });
        object.visual.assetId = assetId; object.visual.idleAnimation = ''; object.visual.focusAnimation = '';
        const entries = object.behavior.kind === 'toggle' ? object.behavior.states : object.behavior.kind === 'sequence' ? object.behavior.entries : [];
        for (const item of entries) item.appearance = { ...(entry?.appearance || item.appearance), assetId, animation: '' };
      }
      return <ObjectArt key={id} instance={{ ...instance, id: `image_context_${instance.id}` }} material={previewMaterial} />;
    })}
  </svg>;
}
