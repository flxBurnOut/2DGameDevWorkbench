// Pure shared sizing contract: safe in schema discovery and web proxy bundles.
export function validateImageAssetDimensions(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 16 ||
    height < 16 ||
    width % 16 ||
    height % 16
  )
    throw new Error('图片宽高必须为 16 的正整数倍。');
  if (
    Math.max(width, height) > 3840 ||
    width * height < 655360 ||
    width * height > 8294400 ||
    Math.max(width, height) > 3 * Math.min(width, height)
  )
    throw new Error(
      '图片尺寸须为 655360–8294400 像素，最长边不超过 3840，宽高比在 1:3–3:1 内。',
    );
  return { width, height, size: `${width}x${height}` };
}
