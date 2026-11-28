import * as z from 'zod/v4';
import { LOCAL_EDIT_LIMITS, maskSummary, resolveRegion } from './core.mjs';

export const attributeNames = ['shape', 'texture', 'albedo', 'lighting', 'reflection'];
export const attributeLabels = { shape: '轮廓、透视和部件位置', texture: '纹理与内部图案', albedo: '底色', lighting: '受光明暗', reflection: '反光与高光' };
export const attributePolicySchema = z.object(Object.fromEntries(attributeNames.map(key => [key, z.enum(['preserve', 'edit', 'recompute'])]))).strict();
export const attributeDefaults = {
  recolor: { shape: 'preserve', texture: 'preserve', albedo: 'edit', lighting: 'preserve', reflection: 'preserve' },
  material: { shape: 'preserve', texture: 'edit', albedo: 'edit', lighting: 'recompute', reflection: 'recompute' },
  part: { shape: 'edit', texture: 'edit', albedo: 'edit', lighting: 'recompute', reflection: 'recompute' },
};
export function planScope(pixels, width, height, allowed, target, influence, protectedRegions = []) {
  function maskOf(region) {
    if (!(region instanceof Uint8Array)) return resolveRegion(pixels, width, height, region).mask;
    if (region.length !== width * height) throw new Error('已保存的选区尺寸与基准不符。');
    return region;
  }
  const t = target ? maskOf(target) : allowed;
  const f = influence ? maskOf(influence) : new Uint8Array(allowed.length);
  const p = new Uint8Array(allowed.length);
  for (const region of protectedRegions) { const mask = maskOf(region); for (let i=0;i<p.length;i++) p[i] |= mask[i]; }
  const mask = Uint8Array.from(allowed, (v,i) => Number(!!(v && (t[i] || f[i]) && !p[i])));
  const resolved = maskSummary(mask, width, height);
  if (!resolved.count) throw new Error('实际可写范围为空，请检查目标与保护区。');
  const spans = [];
  for (let i=0; i<mask.length;) {
    if (!mask[i]) { i++; continue; }
    // Fragmented alpha selections can exceed the inline region format. The saved mask remains exact.
    if (spans.length === LOCAL_EDIT_LIMITS.maxMaskRuns) return resolved;
    const startPixel=i;
    while (i<mask.length && mask[i]) i++;
    spans.push({startPixel,length:i-startPixel});
  }
  return {...resolved,spec:{type:'mask-runs',spans}};
}
export function compileAttributePrompt(instruction, part, policy, successCriteria, bounds, crop) {
  const actions={preserve:'PRESERVE',edit:'EDIT',recompute:'MAY RECOMPUTE'};
  const lines=attributeNames.map(key=>`${actions[policy[key]]}: ${key} (${attributeLabels[key]}).`);
  return `${instruction}\n\nTarget part: ${part}. Target writable bounds in original pixels: ${JSON.stringify(bounds)}.\n${lines.join('\n')}\nSuccess criteria: ${successCriteria.join('; ')}.\nPreserving structure means retaining its location and shape; do not preserve old surface texture when texture is EDIT. Do not introduce an unrequested object. Place all new content wholly inside the writable mask.\n${crop ? `The final reference is a clean crop of the FIRST image, original-pixel rectangle ${JSON.stringify(crop)}. It identifies the target, not a replacement composition. Output the full first image at its original dimensions.` : ''}`;
}
