import { applyLocalOperation, applyRgbaChanges, normalizeSelection, rasterIntegerLine, resolveRegion, stampSquareRgba } from './core.mjs';

const MAX_CHANGED_PIXELS = 65536;
const HISTORY_BYTES = 8 * 1024 * 1024;
const MASK_HISTORY_BYTES = 256 * 1024;
const maskSpecBytes = value => JSON.stringify(value).length * 2;
const equal = (left, right) => left.every((value, index) => value === right[index]);
const rgbaAt = (pixels, offset) => Array.from(pixels.subarray(offset, offset + 4));
const patchBytes = spans => spans.reduce((total, span) => total + span.before.byteLength + span.after.byteLength, 0);

/** Compact wire/history spans, using pixel indexes rather than byte offsets. */
export function compactPixelChanges(changes) {
  const ordered = [...changes].filter(change => !equal(change.before, change.after)).sort((a, b) => a.offset - b.offset);
  const groups = [];
  for (const change of ordered) {
    const previous = groups.at(-1);
    if (previous && change.offset === previous.lastOffset + 4) { previous.changes.push(change); previous.lastOffset = change.offset; }
    else groups.push({ startPixel: change.offset / 4, lastOffset: change.offset, changes: [change] });
  }
  return groups.map(group => ({ startPixel: group.startPixel, before: new Uint8Array(group.changes.flatMap(change => change.before)), after: new Uint8Array(group.changes.flatMap(change => change.after)) }));
}

/** Mutable RGBA model. Canvas is never read back as editing input. */
export class PixelController {
  constructor(source, width, height, base = source, historyBudget = HISTORY_BYTES) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 3840 || height > 3840 || width * height > 8294400 || source.length !== width * height * 4 || base.length !== source.length) throw new Error('原始 RGBA 尺寸不符。');
    this.width = width; this.height = height;
    this.sourcePixels = new Uint8ClampedArray(source);
    this.basePixels = base === source ? this.sourcePixels : new Uint8ClampedArray(base);
    this.pixels = new Uint8ClampedArray(base);
    this.mask = new Uint8Array(width * height).fill(1);
    this.region = { type: 'all' }; this.selectionCount = width * height;
    this.historyBudget = historyBudget; this.pixelUndo = []; this.pixelRedo = []; this.maskUndo = []; this.maskRedo = [];
    this.dirtyOffsets = new Set(); this.strokeChanges = null; this.lastPoint = null;
    this.dirtyBounds = { x: 0, y: 0, width, height }; this.maskRevision = 0;
    this.maskDirtyBounds = { x: 0, y: 0, width, height }; this.maskStrokeBefore = null; this.maskStrokeSpec = null; this.maskLastPoint = null;
    // One user-facing undo order across pixel strokes and selection changes.
    this.actionUndo = []; this.actionRedo = [];
    // Pixels of the current or last stroke that fell outside the selection.
    this.strokeBlocked = 0; this.strokeWritten = 0;
  }
  recordAction(kind) { this.actionUndo.push(kind); this.actionRedo = []; if (this.actionUndo.length > 4096) this.actionUndo.shift(); }
  get canUndo() { return this.canUndoPixels || this.canUndoMask; }
  get canRedo() { return this.canRedoPixels || this.canRedoMask; }
  /** Undo the most recent stroke or selection change; returns its kind. */
  undo() { return this.stepHistory(this.actionUndo, this.actionRedo, 'undo'); }
  redo() { return this.stepHistory(this.actionRedo, this.actionUndo, 'redo'); }
  stepHistory(from, to, direction) {
    while (from.length) {
      const kind = from.at(-1);
      const available = kind === 'pixel' ? (direction === 'undo' ? this.canUndoPixels : this.canRedoPixels) : (direction === 'undo' ? this.canUndoMask : this.canRedoMask);
      if (!available) { from.pop(); continue; }
      if (kind === 'pixel') { if (direction === 'undo') this.undoPixels(); else this.redoPixels(); }
      else if (direction === 'undo') this.undoMask();
      else this.redoMask();
      from.pop(); to.push(kind);
      return kind;
    }
    // Histories created outside the ordered log (restored drafts) still undo.
    if (direction === 'undo') { if (this.canUndoPixels) { this.undoPixels(); to.push('pixel'); return 'pixel'; } if (this.canUndoMask) { this.undoMask(); to.push('mask'); return 'mask'; } }
    return null;
  }
  get dirty() { return this.dirtyOffsets.size > 0; }
  get dirtyPixelCount() { return this.dirtyOffsets.size; }
  get canUndoPixels() { return this.pixelUndo.length > 0; }
  get canRedoPixels() { return this.pixelRedo.length > 0; }
  get canUndoMask() { return this.maskUndo.length > 0; }
  get canRedoMask() { return this.maskRedo.length > 0; }
  get maskStrokeActive() { return this.maskStrokeBefore !== null; }
  /** Explicit editing-base change; browsing versions never calls this. */
  setBase(base) {
    if (this.dirty || this.strokeChanges || this.maskStrokeActive) throw new Error('请先保存或舍弃当前笔划。');
    if (base.length !== this.pixels.length) throw new Error('候选尺寸与当前图片不一致。');
    this.basePixels = new Uint8ClampedArray(base); this.pixels = new Uint8ClampedArray(base);
    this.pixelUndo = []; this.pixelRedo = [];
    this.dirtyBounds = { x: 0, y: 0, width: this.width, height: this.height };
  }
  mark(offset) {
    const x = (offset / 4) % this.width, y = Math.floor(offset / 4 / this.width), old = this.dirtyBounds;
    this.dirtyBounds = old ? { x: Math.min(old.x, x), y: Math.min(old.y, y), width: Math.max(old.x + old.width, x + 1) - Math.min(old.x, x), height: Math.max(old.y + old.height, y + 1) - Math.min(old.y, y) } : { x, y, width: 1, height: 1 };
    if (equal(rgbaAt(this.pixels, offset), rgbaAt(this.basePixels, offset))) this.dirtyOffsets.delete(offset);
    else this.dirtyOffsets.add(offset);
  }
  takeDirtyBounds() { const result = this.dirtyBounds; this.dirtyBounds = null; return result; }
  takeMaskDirtyBounds() { const result = this.maskDirtyBounds; this.maskDirtyBounds = null; return result; }
  markMask(index) {
    const x = index % this.width, y = Math.floor(index / this.width), old = this.maskDirtyBounds;
    this.maskDirtyBounds = old ? { x: Math.min(old.x, x), y: Math.min(old.y, y), width: Math.max(old.x + old.width, x + 1) - Math.min(old.x, x), height: Math.max(old.y + old.height, y + 1) - Math.min(old.y, y) } : { x, y, width: 1, height: 1 };
  }
  beginMaskStroke(mode = 'add') {
    if (this.maskStrokeBefore) throw new Error('上一笔选区尚未结束。');
    this.maskStrokeBefore = new Uint8Array(this.mask); this.maskStrokeSpec = structuredClone(this.region); this.maskStrokeCount = this.selectionCount; this.maskLastPoint = null; this.maskStrokeChanged = false;
    if (mode === 'replace') {
      if (this.dirty) { this.cancelMaskStroke(); throw new Error('请先保存笔划，再重新选择区域。'); }
      this.mask.fill(0); this.selectionCount = 0; this.maskStrokeChanged = true; this.maskRevision++;
      this.maskDirtyBounds = { x: 0, y: 0, width: this.width, height: this.height };
    }
  }
  maskStroke(point, mode, size = 1) {
    if (!Number.isInteger(size) || size < 1 || size > 256 || !Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0 || point.x >= this.width || point.y >= this.height) throw new Error('选区笔刷坐标或大小无效。');
    if (!this.maskStrokeBefore) this.beginMaskStroke();
    const value = mode === 'add' ? 1 : 0, start = -Math.floor((size - 1) / 2);
    const points = this.maskLastPoint ? rasterIntegerLine(this.maskLastPoint, point) : [point];
    for (const center of points) for (let dy = start; dy < start + size; dy++) for (let dx = start; dx < start + size; dx++) {
      const x = center.x + dx, y = center.y + dy;
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
      const index = y * this.width + x;
      if (this.mask[index] === value) continue;
      if (!value && this.dirtyOffsets.has(index * 4)) { this.cancelMaskStroke(); throw new Error('选区不能排除未保存笔划；请先保存笔划再减去该区域。'); }
      this.selectionCount += value - this.mask[index]; this.mask[index] = value; this.markMask(index); this.maskStrokeChanged = true;
    }
    this.maskLastPoint = point; this.maskRevision++;
  }
  endMaskStroke() {
    if (!this.maskStrokeBefore) return;
    if (!this.maskStrokeChanged) { this.maskStrokeBefore = null; this.maskStrokeSpec = null; this.maskLastPoint = null; return; }
    try {
      const spans = []; let start = -1;
      for (let index = 0; index <= this.mask.length; index++) {
        if (index < this.mask.length && this.mask[index]) { if (start < 0) start = index; }
        else if (start >= 0) {
          spans.push({ startPixel: start, length: index - start }); start = -1;
          if (spans.length > 65536) throw new Error('选区超过 65,536 段；这一笔已撤回。请分区处理。');
        }
      }
      const next = !this.selectionCount ? null : this.selectionCount === this.width * this.height ? { type: 'all' } : { type: 'mask-runs', spans };
      if (maskSpecBytes([this.maskStrokeSpec, next]) > MASK_HISTORY_BYTES) throw new Error('选区历史超过 256 KiB；这一笔已撤回，请简化范围。');
      if (JSON.stringify(this.maskStrokeSpec) !== JSON.stringify(next)) {
        this.maskUndo.push(this.maskStrokeSpec); this.maskRedo = []; this.recordAction('mask');
        while (this.maskUndo.length > 1 && maskSpecBytes([...this.maskUndo, next]) > MASK_HISTORY_BYTES) this.maskUndo.shift();
      }
      this.region = next; this.maskStrokeBefore = null; this.maskStrokeSpec = null; this.maskLastPoint = null;
    } catch (error) { this.cancelMaskStroke(); throw error; }
  }
  cancelMaskStroke() {
    if (!this.maskStrokeBefore) return;
    this.mask = this.maskStrokeBefore; this.region = this.maskStrokeSpec; this.selectionCount = this.maskStrokeCount;
    this.maskStrokeBefore = null; this.maskStrokeSpec = null; this.maskLastPoint = null; this.maskRevision++;
    this.maskDirtyBounds = { x: 0, y: 0, width: this.width, height: this.height };
  }
  beginStroke() { if (this.strokeChanges) throw new Error('上一笔尚未结束。'); this.strokeChanges = new Map(); this.lastPoint = null; this.strokeBlocked = 0; this.strokeWritten = 0; }
  stroke(point, tool, rgba, size = 1) {
    if (!this.strokeChanges) this.beginStroke();
    const points = this.lastPoint ? rasterIntegerLine(this.lastPoint, point) : [point];
    for (const center of points) {
      const changes = stampSquareRgba(this.pixels, this.width, this.height, center, size, tool === 'eraser' ? [0, 0, 0, 0] : rgba);
      for (const change of changes) {
        if (!this.mask[change.offset / 4]) { applyRgbaChanges(this.pixels, [change], 'undo'); this.strokeBlocked++; continue; }
        this.strokeWritten++;
        const first = this.strokeChanges.get(change.offset);
        this.strokeChanges.set(change.offset, { offset: change.offset, before: first?.before || change.before, after: change.after });
        this.mark(change.offset);
      }
      if (this.dirtyOffsets.size > MAX_CHANGED_PIXELS) {
        this.cancelStroke();
        throw new Error('未保存笔划超过 65,536 个像素；这一笔已撤回。请先保存为候选，或使用填充、移动等操作。');
      }
    }
    this.lastPoint = point;
  }
  endStroke() {
    if (!this.strokeChanges) return;
    const spans = compactPixelChanges(this.strokeChanges.values());
    this.strokeChanges = null; this.lastPoint = null;
    if (!spans.length) return;
    this.pixelUndo.push(spans); this.pixelRedo = []; this.recordAction('pixel');
    while (this.pixelUndo.length > 1 && this.pixelUndo.reduce((sum, entry) => sum + patchBytes(entry), 0) > this.historyBudget) this.pixelUndo.shift();
  }
  cancelStroke() {
    if (!this.strokeChanges) return;
    const changes = [...this.strokeChanges.values()];
    applyRgbaChanges(this.pixels, changes, 'undo');
    for (const change of changes) this.mark(change.offset);
    this.strokeChanges = null; this.lastPoint = null;
  }
  applyHistory(spans, direction) {
    for (const span of spans) for (let i = 0; i < span.before.length; i += 4) {
      const index = span.startPixel + i / 4;
      if (!this.mask[index] && !equal(Array.from(this.pixels.subarray(index * 4, index * 4 + 4)), Array.from(span[direction].subarray(i, i + 4)))) throw new Error('当前选区不包含这次像素历史；请先选整图。');
    }
    for (const span of spans) {
      this.pixels.set(span[direction], span.startPixel * 4);
      for (let i = 0; i < span.before.length; i += 4) this.mark(span.startPixel * 4 + i);
    }
  }
  undoPixels() { const entry = this.pixelUndo.at(-1); if (!entry) return; this.applyHistory(entry, 'before'); this.pixelUndo.pop(); this.pixelRedo.push(entry); }
  redoPixels() { const entry = this.pixelRedo.at(-1); if (!entry) return; this.applyHistory(entry, 'after'); this.pixelRedo.pop(); this.pixelUndo.push(entry); }
  selectRegion(spec, remember = true) {
    if (this.maskStrokeActive) throw new Error('请先结束当前选区笔划。');
    const next = spec ? resolveRegion(this.sourcePixels, this.width, this.height, spec) : { mask: new Uint8Array(this.width * this.height), count: 0 };
    for (const offset of this.dirtyOffsets) if (!next.mask[offset / 4]) throw new Error('新选区会排除未保存笔划；请先保存笔划，或保留包含它们的选区。');
    if (remember) {
      if (maskSpecBytes([this.region, spec]) > MASK_HISTORY_BYTES) throw new Error('选区历史超过 256 KiB，未更改当前范围。');
      this.maskUndo.push(structuredClone(this.region)); this.maskRedo = []; this.recordAction('mask');
      while (this.maskUndo.length > 1 && maskSpecBytes([...this.maskUndo, spec]) > MASK_HISTORY_BYTES) this.maskUndo.shift();
    }
    this.region = spec ? structuredClone(spec) : null; this.mask = next.mask; this.selectionCount = next.count; this.maskRevision++;
    this.maskDirtyBounds = { x: 0, y: 0, width: this.width, height: this.height };
  }
  combineRegion(spec, mode = 'replace') {
    if (mode === 'replace') { this.selectRegion(spec); return; }
    const incoming = resolveRegion(this.sourcePixels, this.width, this.height, spec).mask;
    this.beginMaskStroke();
    try {
      for (let index = 0; index < incoming.length; index++) if (incoming[index]) {
        const value = mode === 'subtract' ? 0 : 1;
        if (value === this.mask[index]) continue;
        if (!value && this.dirtyOffsets.has(index * 4)) throw new Error('新选区会排除未保存笔划；请先保存笔划。');
        this.mask[index] = value; this.selectionCount += value ? 1 : -1; this.maskStrokeChanged = true;
      }
      this.maskRevision++; this.maskDirtyBounds = { x: 0, y: 0, width: this.width, height: this.height };
      this.endMaskStroke();
    } catch (error) { this.cancelMaskStroke(); throw error; }
  }
  selectRectangle(from, to, mode = 'replace') { const rect = normalizeSelection(from, to, this.width, this.height); if (rect) this.combineRegion({ type: 'rectangle', ...rect }, mode); }
  undoMask() { if (!this.maskUndo.length) return; const previous = this.maskUndo.at(-1), next = structuredClone(this.region); this.selectRegion(previous, false); this.maskUndo.pop(); this.maskRedo.push(next); }
  redoMask() { if (!this.maskRedo.length) return; const next = this.maskRedo.at(-1), previous = structuredClone(this.region); this.selectRegion(next, false); this.maskRedo.pop(); this.maskUndo.push(previous); }
  patch() { return compactPixelChanges([...this.dirtyOffsets].map(offset => ({ offset, before: rgbaAt(this.basePixels, offset), after: rgbaAt(this.pixels, offset) }))); }
  restorePatch(spans) {
    if (this.dirty) throw new Error('当前已有未保存笔划，不能叠入另一份草稿。');
    const output = applyLocalOperation({ pixels: this.basePixels, width: this.width, height: this.height, mask: this.mask, operation: { type: 'pixel-patch', spans } });
    this.pixels.set(output.pixels);
    for (const span of spans) for (let index = 0; index < span.after.length; index += 4) this.mark(span.startPixel * 4 + index);
    this.pixelUndo = [spans]; this.pixelRedo = [];
  }
  discardPixels() {
    for (const offset of this.dirtyOffsets) this.pixels.set(this.basePixels.subarray(offset, offset + 4), offset);
    this.dirtyOffsets.clear(); this.pixelUndo = []; this.pixelRedo = []; this.strokeChanges = null;
    this.dirtyBounds = { x: 0, y: 0, width: this.width, height: this.height };
  }
}
