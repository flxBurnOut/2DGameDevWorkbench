import sharp from 'sharp';
import { imageSha256, inspectImageBytes } from './image-assets-source.mjs';

// Coordinates and equality use the same decoded sRGB/RGBA8 pixels as asset inspection.
const decode = buffer => sharp(buffer, { limitInputPixels: 8_294_400 }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
export function validateImageProcessingSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 3840 || height > 3840 || width * height > 8_294_400)
    throw new Error('本地图片处理最长边须不超过3840，总计不超过8294400像素；不会缩放源图。');
}

export function validateMaskPair(source, mask, dimensions) {
  if (!source || !mask || source.width !== mask.width || source.height !== mask.height || !mask.hasAlpha || !mask.hasFullyTransparentPixels)
    throw new Error('编辑蒙版须与保护源图同宽高，且包含真实透明区域。');
  if (dimensions.width !== source.width || dimensions.height !== source.height)
    throw new Error('蒙版保护需要结果、源图和蒙版尺寸完全一致；不允许缩放。');
}

export async function describeEditMask(mask) {
  const { data, info: { width, height } } = await decode(mask);
  let left = width, top = height, right = -1, bottom = -1;
  for (let index = 0; index < width * height; index++) if (data[index * 4 + 3] === 0) {
    const x = index % width, y = Math.floor(index / width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < 0) throw new Error('编辑蒙版没有可修改区域。');
  return `Edit only the selected area within x=${left}..${right}, y=${top}..${bottom} (inclusive, origin at top-left, canvas ${width}x${height}). Within this bounding box, only fully transparent pixels of the separate mask are selected. Keep the rest of the first image unchanged. Apply the user's request to this area, not to the entire object.`;
}

/** Deterministic derivation only: no network, no resizing, no in-place source writes. */
export async function processImagePixels(candidate, { preserveFrom, mask, preserveAlphaFrom, alphaCleanupThreshold = 0 } = {}) {
  if (!Number.isInteger(alphaCleanupThreshold) || alphaCleanupThreshold < 0 || alphaCleanupThreshold > 16)
    throw new Error('透明噪点阈值须为0–16整数；0表示关闭清理。');
  if (Boolean(preserveFrom) !== Boolean(mask)) throw new Error('保护源图和蒙版必须同时提供。');
  const candidateInfo = await inspectImageBytes(candidate);
  validateImageProcessingSize(candidateInfo.width, candidateInfo.height);
  let sourceInfo, maskInfo;
  if (mask) {
    sourceInfo = await inspectImageBytes(preserveFrom);
    maskInfo = await inspectImageBytes(mask, { pngOnly: true });
    validateMaskPair(sourceInfo, maskInfo, candidateInfo);
  }
  const alphaInfo = preserveAlphaFrom ? (preserveAlphaFrom === preserveFrom ? sourceInfo : await inspectImageBytes(preserveAlphaFrom)) : null;
  if (alphaInfo && (alphaInfo.width !== candidateInfo.width || alphaInfo.height !== candidateInfo.height))
    throw new Error('保留透明度需要基准图与结果尺寸完全一致；不允许缩放。');
  const decoded = await decode(candidate);
  const source = preserveFrom ? await decode(preserveFrom) : null;
  const alphaSource = preserveAlphaFrom ? (preserveAlphaFrom === preserveFrom ? source : await decode(preserveAlphaFrom)) : null;
  const maskPixels = mask ? await decode(mask) : null;
  const output = Buffer.from(decoded.data);
  const { width, height } = decoded.info;
  const expectedProtected = mask ? Buffer.alloc(output.length) : null;
  // Alpha preservation wins over cleanup, including original alpha=1 edges.
  // Skip cleanup entirely: clearing RGB first could create dark pixels when alpha is restored.
  const cleanupThreshold = alphaSource ? 0 : alphaCleanupThreshold;
  const expectedAlpha = alphaSource ? Buffer.alloc(width * height) : null;
  let protectedPixels = 0, replacedPixels = 0, cleanedPixels = 0, protectedLowAlphaPixels = 0, restoredAlphaPixels = 0;
  for (let i = 0; i < output.length; i += 4) {
    // Alpha=1..255 is protected, including partially transparent/antialiased masks.
    if (maskPixels && maskPixels.data[i + 3] !== 0) {
      protectedPixels++;
      if (source.data[i + 3] > 0 && source.data[i + 3] <= cleanupThreshold) protectedLowAlphaPixels++;
      if (!source.data.subarray(i, i + 4).equals(output.subarray(i, i + 4))) replacedPixels++;
      source.data.copy(output, i, i, i + 4);
      source.data.copy(expectedProtected, i, i, i + 4);
    } else if (output[i + 3] > 0 && output[i + 3] <= cleanupThreshold) {
      output.fill(0, i, i + 4);
      cleanedPixels++;
    }
    if (alphaSource) {
      if (output[i + 3] !== alphaSource.data[i + 3]) restoredAlphaPixels++;
      output[i + 3] = expectedAlpha[i / 4] = alphaSource.data[i + 3];
    }
  }
  const pixelsChanged = !output.equals(decoded.data);
  const buffer = candidateInfo.format === 'png' && !pixelsChanged ? candidate : await sharp(output, { raw: { width, height, channels: 4 } }).png({ palette: false }).toBuffer();
  // Verify the delivered PNG, not merely the pre-encoding buffer.
  const encodedPixels = await decode(buffer);
  if (!encodedPixels.data.equals(output)) throw new Error('处理后的PNG未保留预期RGBA像素，未交付。');
  let alphaPreservation = null;
  if (alphaSource) {
    const actualAlpha = Buffer.alloc(width * height);
    let changedAlphaPixels = 0;
    for (let i = 0; i < actualAlpha.length; i++) {
      actualAlpha[i] = encodedPixels.data[i * 4 + 3];
      if (actualAlpha[i] !== expectedAlpha[i]) changedAlphaPixels++;
    }
    if (changedAlphaPixels) throw new Error('原图透明度校验失败，未交付。');
    alphaPreservation = { rule: 'copy-base-alpha', scope: 'whole-image', sourceSha256: alphaInfo.sha256, comparedPixels: width * height, restoredPixels: restoredAlphaPixels, changedAlphaPixels, expectedAlphaSha256: imageSha256(expectedAlpha), actualAlphaSha256: imageSha256(actualAlpha), hashLayout: 'row-major Alpha8' };
  }
  let preservation = null;
  if (maskPixels) {
    const actualProtected = Buffer.alloc(output.length);
    let changedOutsideMaskPixels = 0;
    for (let i = 0; i < output.length; i += 4) if (maskPixels.data[i + 3] !== 0) {
      encodedPixels.data.copy(actualProtected, i, i, i + 4);
      if (!source.data.subarray(i, i + 4).equals(encodedPixels.data.subarray(i, i + 4))) changedOutsideMaskPixels++;
    }
    if (changedOutsideMaskPixels !== 0) throw new Error('蒙版外像素校验失败，未交付。');
    preservation = { rule: 'mask-alpha-zero-only', sourceSha256: sourceInfo.sha256, maskSha256: maskInfo.sha256, protectedPixels, editablePixels: width * height - protectedPixels, restoredPixels: replacedPixels, changedOutsideMaskPixels, expectedProtectedRgbaSha256: imageSha256(expectedProtected), actualProtectedRgbaSha256: imageSha256(actualProtected), hashLayout: 'full-canvas RGBA8 with editable pixels zeroed' };
  }
  return { buffer, evidence: { schemaVersion: 1, pixelEncoding: 'sRGB/RGBA8', width, height, candidateSha256: candidateInfo.sha256, outputSha256: imageSha256(buffer), pixelsChanged, preservation, alphaPreservation, alphaCleanup: { threshold: cleanupThreshold, ...(alphaSource ? { requestedThreshold: alphaCleanupThreshold, skippedReason: 'preserve-alpha' } : {}), scope: mask ? 'mask-alpha-zero-only' : 'whole-image', cleanedPixels, protectedLowAlphaPixels, preservesAlphaAboveThreshold: true }, networkRequests: 0 } };
}
