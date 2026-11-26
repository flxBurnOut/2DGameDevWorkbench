// GPT Image 2 size contract: https://developers.openai.com/api/docs/guides/image-generation
// Stay below the documented experimental (> 2560 * 1440) output range.
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 2560 * 1440;
const MAX_EDGE = 3840;
const STEP = 16;

export function imageAspectMatches(sourceWidth, sourceHeight, width, height) {
  // At most one output pixel of integer rounding, shared with the compositor.
  return (
    Math.abs(width * sourceHeight - height * sourceWidth) <=
    Math.max(sourceWidth, sourceHeight)
  );
}

export function planImageGenerationSize(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error('图片尺寸无效。');
  if (Math.max(width, height) > 3 * Math.min(width, height))
    throw new Error(
      `图片 ${width}×${height} 超过 GPT Image 2 的 3:1 比例上限，请先调整图片尺寸；尚未调用图片 API。`,
    );
  const targetPixels = Math.min(
    Math.max(width * height, 1024 * 1024),
    2048 * 1152,
  );
  const candidates = [];
  for (let w = STEP; w <= MAX_EDGE; w += STEP) {
    const ideal = (w * height) / width;
    for (const h of new Set([
      Math.floor(ideal / STEP) * STEP,
      Math.ceil(ideal / STEP) * STEP,
    ])) {
      const pixels = w * h;
      if (
        h <= 0 ||
        h > MAX_EDGE ||
        pixels < MIN_PIXELS ||
        pixels > MAX_PIXELS ||
        Math.max(w, h) > 3 * Math.min(w, h) ||
        !imageAspectMatches(width, height, w, h)
      )
        continue;
      candidates.push({
        width: w,
        height: h,
        exact: w * height === h * width,
        distance: Math.abs(Math.log(pixels / targetPixels)),
      });
    }
  }
  candidates.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      a.distance - b.distance ||
      a.width - b.width,
  );
  const best = candidates[0];
  if (!best)
    throw new Error(
      `图片 ${width}×${height} 无法匹配 GPT Image 2 的 16 像素尺寸网格，请先调整图片尺寸；尚未调用图片 API。`,
    );
  return {
    width: best.width,
    height: best.height,
    size: `${best.width}x${best.height}`,
  };
}
