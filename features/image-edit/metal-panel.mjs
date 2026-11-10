import * as z from 'zod/v4';

export const PANEL_MAX_EDGE = 1024;
const integer = (min, max) => z.number().int().min(min).max(max);
export const metalPanelOperationSchema = z.object({
  type: z.literal('metal-panel'),
  frame: z.object({ x: integer(0, 3839), y: integer(0, 3839), width: integer(1, PANEL_MAX_EDGE), height: integer(1, PANEL_MAX_EDGE) }).strict(),
  color: z.string().regex(/^#[a-f0-9]{6}$/i),
  position: integer(0, 100), angle: integer(-90, 90), bandWidth: integer(1, 2048),
  strength: integer(0, 100), cellSize: integer(1, 16),
}).strict();

export function cropPanel(pixels, mask, width, height) {
  let left = width, right = -1, top = height, bottom = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width, y = Math.floor(i / width);
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < left) throw new Error('请先选择板面。');
  const frame = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  if (Math.max(frame.width, frame.height) > PANEL_MAX_EDGE) throw new Error('试验选区最长边为 1024 像素，请缩小框选范围。');
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  const allowed = new Uint8Array(frame.width * frame.height);
  for (let y = 0; y < frame.height; y++) {
    const from = (top + y) * width + left, to = y * frame.width;
    rgba.set(pixels.subarray(from * 4, (from + frame.width) * 4), to * 4);
    for (let x = 0; x < frame.width; x++) allowed[to + x] = mask[from + x] && rgba[(to + x) * 4 + 3] ? 1 : 0;
  }
  if (!allowed.includes(1)) throw new Error('选区内没有可见板面。');
  return { frame, rgba, allowed };
}

// Native source coordinates on the wire; compact crop coordinates in the panel.
export function panelRegion(mask, frame, sourceWidth) {
  const spans = [];
  let count = 0;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width;) {
      if (!mask[y * frame.width + x]) { x++; continue; }
      const start = x;
      while (x < frame.width && mask[y * frame.width + x]) x++;
      spans.push({ startPixel: (frame.y + y) * sourceWidth + frame.x + start, length: x - start });
      count += x - start;
      if (spans.length > 65536) throw new Error('板面选区过于零碎，请分区处理。');
    }
  }
  if (!count) throw new Error('没有可修改的板面，请补选后再保存。');
  return count === mask.length ? { type: 'rectangle', ...frame } : { type: 'mask-runs', spans };
}

function luminance(pixels, index) {
  const offset = index * 4;
  return Math.round(.2126 * pixels[offset] + .7152 * pixels[offset + 1] + .0722 * pixels[offset + 2]);
}

/** Follow a nearly horizontal dark gap close to a user hint. Short grain marks
 * lack support across the face. Distinct equally dark gaps require a correction. */
export function tracePanelSeam(crop, hint, cellSize) {
  const { frame: { width, height }, rgba, allowed } = crop;
  const sampleOffset = 3 * cellSize, candidates = [];
  for (let y = Math.max(sampleOffset, hint - 4 * cellSize); y <= Math.min(height - 1 - sampleOffset, hint + 4 * cellSize); y++) {
    const histogram = new Uint16Array(256);
    let samples = 0, darker = 0;
    for (let x = 0; x < width; x += cellSize) {
      const i = y * width + x, above = i - sampleOffset * width, below = i + sampleOffset * width;
      if (!allowed[i] || !allowed[above] || !allowed[below]) continue;
      const value = luminance(rgba, i);
      histogram[value]++; samples++;
      if ((luminance(rgba, above) + luminance(rgba, below)) / 2 - value >= 12) darker++;
    }
    if (samples < 4 || darker < samples * .75) continue;
    let median = 0, total = histogram[0];
    while (total * 2 < samples) total += histogram[++median];
    candidates.push({ y, median });
  }
  if (!candidates.length) return null;
  const darkest = Math.min(...candidates.map(row => row.median));
  const rows = candidates.filter(row => row.median <= darkest + 5);
  const top = rows[0].y, bottom = rows.at(-1).y;
  return bottom - top + 1 === rows.length ? { top, bottom } : null;
}

// Majority vote within the original artwork grid removes fractional SAM edges.
// A tie stays protected and no selected cell may extend outside the user's mask.
export function snapPanelMask(selected, allowed, frame, cellSize) {
  if (cellSize === 1) return selected;
  const snapped = new Uint8Array(selected.length);
  for (let row = -(frame.y % cellSize); row < frame.height; row += cellSize) {
    for (let column = -(frame.x % cellSize); column < frame.width; column += cellSize) {
      const top = Math.max(0, row), bottom = Math.min(frame.height, row + cellSize);
      const left = Math.max(0, column), right = Math.min(frame.width, column + cellSize);
      let available = 0, votes = 0;
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const i = y * frame.width + x;
        available += allowed[i]; votes += selected[i];
      }
      if (votes * 2 <= available) continue;
      for (let y = top; y < bottom; y++) {
        const start = y * frame.width + left;
        snapped.set(allowed.subarray(start, start + right - left), start);
      }
    }
  }
  return snapped;
}

// The reflection shares one frame across all boards. Both crop preview and
// full-image execution sample at the same original artwork pixel centres.
export function paintMetalPanel(output, width, mask, operation, origin = { x: 0, y: 0 }) {
  const { frame, color, position, angle, bandWidth, strength, cellSize } = operation;
  const radians = angle * Math.PI / 180, nx = Math.cos(radians), ny = Math.sin(radians);
  const extent = Math.abs(nx) * frame.width + Math.abs(ny) * frame.height;
  const center = (position / 100 - .5) * extent;
  const base = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
  for (let y = 0; y < frame.height; y++) {
    const v = (Math.floor((frame.y + y) / cellSize) + .5) * cellSize - frame.y - frame.height / 2;
    for (let x = 0; x < frame.width; x++) {
      const i = (frame.y + y - origin.y) * width + frame.x + x - origin.x;
      if (!mask[i] || !output[i * 4 + 3]) continue;
      const u = (Math.floor((frame.x + x) / cellSize) + .5) * cellSize - frame.x - frame.width / 2;
      const distance = (nx * u + ny * v - center) / bandWidth;
      const band = strength / 100 * Math.exp(-4 * Math.LN2 * distance * distance);
      const shade = 1 - .20 * v / frame.height + .10 * u / frame.width;
      for (let c = 0; c < 3; c++) {
        const value = base[c] * shade;
        output[i * 4 + c] = value + (255 - value) * band * .88;
      }
    }
  }
}
