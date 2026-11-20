import sharp from 'sharp';

// Bound the output, not the scale. Large placements use a window around the
// edited region. Sample both frozen versions at identical pixel centres.
export async function compareImagePlacement({ base, after, target, region, previewWidth }) {
  const placed = target.placement;
  const width = Math.max(1, Math.round(placed?.width ?? previewWidth ?? 64));
  const height = Math.max(1, Math.round(placed?.height ?? width * base.height / base.width));
  const panelWidth = Math.min(width, 320), panelHeight = Math.min(height, 320);
  const centerX = region ? (region.x + region.width / 2) / base.width : 0.5;
  const centerY = region ? (region.y + region.height / 2) / base.height : 0.5;
  const windowStart = (size, panel, center) => Math.max(0, Math.min(size - panel, Math.round(size * center - panel / 2)));
  const left = windowStart(width, panelWidth, placed?.flipH ? 1 - centerX : centerX);
  const top = windowStart(height, panelHeight, placed?.flipV ? 1 - centerY : centerY);
  const panel = async pixels => {
    const result = Buffer.alloc(panelWidth * panelHeight * 4);
    for (let y = 0; y < panelHeight; y++) {
      const sy = Math.floor((top + y + 0.5) / height * base.height);
      for (let x = 0; x < panelWidth; x++) {
        const sx = Math.floor((left + x + 0.5) / width * base.width);
        const index = ((placed?.flipV ? base.height - 1 - sy : sy) * base.width + (placed?.flipH ? base.width - 1 - sx : sx)) * 4;
        pixels.copy(result, (y * panelWidth + x) * 4, index, index + 4);
      }
    }
    const png = await sharp(result, { raw: { width: panelWidth, height: panelHeight, channels: 4 } }).png().toBuffer();
    return png.toString('base64');
  };
  return { width, height, placement: placed ?? null, scaleSource: placed ? 'saved-placement' : 'preview-width',
    viewport: { x: left, y: top, width: panelWidth, height: panelHeight }, sampling: 'nearest',
    beforePng: await panel(base.pixels), afterPng: await panel(after.pixels) };
}
