// Only an entire, explicit list of exact RGB replacements selects local execution.
export const MAX_PALETTE_PAIRS = 64;
const pairPattern = /^(?:(?:将|把)\s*)?(#[\da-f]{6})\s*(?:->|→|替换为|替换成|换成|改为|改成)\s*(#[\da-f]{6})$/i;

export function planImageIntent(description, hasReferences = false) {
  const prompt = description.trim();
  if (!prompt) return { route: 'empty' };
  if (!hasReferences && prompt === '擦除选区像素') return { route: 'local', operation: { type: 'erase' } };
  const move = !hasReferences && /^移动选区\s*[(（]\s*(-?\d{1,4})\s*[,，]\s*(-?\d{1,4})\s*[)）]$/.exec(prompt);
  if (move) {
    const dx = Number(move[1]), dy = Number(move[2]);
    if (Math.abs(dx) > 3839 || Math.abs(dy) > 3839) return { route: 'invalid', reason: '移动距离超出图片边界限制。' };
    return { route: 'local', operation: { type: 'translate', dx, dy } };
  }
  const parts = prompt.replace(/[。.]$/, '').split(/[\n,，;；]+/).map(value => value.trim()).filter(Boolean);
  const matches = parts.map(part => pairPattern.exec(part));
  if (!hasReferences && matches.length && matches.every(Boolean)) {
    const pairs = matches.map(match => ({ from: match[1].toLowerCase(), to: match[2].toLowerCase() }));
    if (pairs.length > MAX_PALETTE_PAIRS || new Set(pairs.map(pair => pair.from)).size !== pairs.length)
      return { route: 'invalid', reason: '每种原色只能出现一次，最多可指定 64 对颜色。' };
    const operation = pairs.length === 1 ? { type: 'replace-color', ...pairs[0] } : { type: 'palette-map', pairs };
    return { route: 'local', operation };
  }
  return { route: 'ai', operation: { type: 'ai-edit', prompt } };
}
