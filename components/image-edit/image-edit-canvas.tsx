'use client';
/* oxlint-disable next/no-img-element -- Context layers display exact existing blob/data sources at explicit source geometry. */

import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { screenToPixel } from '@/features/image-edit/core.mjs';
import type { PixelPoint, PixelBounds } from '@/features/image-edit/core.mjs';
import type { PixelController } from '@/features/image-edit/pixel-controller.mjs';
import type { ImageEditContextLayer } from '@/features/image-edit/client';

export type ImagePixelTool = 'pencil' | 'eraser' | 'fill' | 'move' | 'mask-add' | 'mask-erase' | 'rectangle' | 'connected' | 'picker' | 'pan';
export type ImageViewMode = 'candidate' | 'source' | 'diff';
interface Props {
  controller: PixelController; version: number; tool: ImagePixelTool; color: string; alpha: number; brushSize: number;
  display: ImageViewMode; disabled: boolean; tolerance: number; contextLayers: ImageEditContextLayer[]; showContext: boolean;
  viewPixels?: Uint8Array; beforePixels?: Uint8Array; selectionMode: 'replace' | 'add' | 'subtract';
  selectionVisible: boolean; onSelectionVisible: (value: boolean) => void;
  onChange: () => void; onColor: (color: string, alpha: number) => void; onError: (message: string) => void;
  /** Non-error feedback, e.g. a stroke that fell outside the editable range. */
  onNotice: (message: string) => void;
  /** Editing tools return from the before/diff views to the current image. */
  onEditView: () => void;
  onFill: (point: PixelPoint) => void; onMove: (dx: number, dy: number) => void;
}
type Gesture = { kind: 'pan'; x: number; y: number; panX: number; panY: number } | { kind: 'rectangle'; start: PixelPoint; last: PixelPoint; mode: 'replace' | 'add' | 'subtract' } | { kind: 'transform'; start: PixelPoint; rectangle: PixelBounds; handle: string; next: PixelBounds } | { kind: 'move'; start: PixelPoint; rectangle: PixelBounds; dx: number; dy: number } | { kind: 'paint' } | { kind: 'mask'; mode: 'add' | 'erase' };

export function ImageEditCanvas({ controller, version, tool, color, alpha, brushSize, display, disabled, tolerance, contextLayers, showContext, onChange, onColor, onError, onNotice, onEditView, onFill, onMove, viewPixels, beforePixels, selectionMode, selectionVisible, onSelectionVisible }: Props) {
  const viewport = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), selectionCanvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<ImageData | null>(null), gesture = useRef<Gesture | null>(null);
  const maskFrame = useRef<ImageData | null>(null);
  const [view, setView] = useState({ zoom: 1, panX: 24, panY: 24 });
  const space = useRef(false);
  const [grid, setGrid] = useState(false), [background, setBackground] = useState('checker');
  const [selectionPreview, setSelectionPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const imageWidth = controller.width, imageHeight = controller.height;
  const fit = useCallback(() => {
    const box = viewport.current?.getBoundingClientRect(); if (!box) return;
    const zoom = Math.max(0.02, Math.min(32, (box.width - 48) / controller.width, (box.height - 48) / controller.height));
    setView({ zoom, panX: (box.width - controller.width * zoom) / 2, panY: (box.height - controller.height * zoom) / 2 });
  }, [controller]);
  useEffect(() => {
    const initializeView = () => {
      const box = viewport.current?.getBoundingClientRect(); if (!box) return;
      const zoom = Math.max(0.02, Math.min(32, (box.width - 48) / imageWidth, (box.height - 48) / imageHeight));
      setView({ zoom, panX: (box.width - imageWidth * zoom) / 2, panY: (box.height - imageHeight * zoom) / 2 });
    };
    // Candidate/status changes can resize the footer. Preserve the user's view;
    // only a new image size or an explicit Fit action initializes it again.
    const pending = requestAnimationFrame(initializeView);
    return () => cancelAnimationFrame(pending);
  }, [imageWidth, imageHeight]);
  const zoomTo = useCallback((value: number, anchor?: { x: number; y: number }) => {
    const box = viewport.current?.getBoundingClientRect(); if (!box) return;
    setView(old => {
      const zoom = Math.max(0.02, Math.min(32, value)), point = anchor || { x: box.width / 2, y: box.height / 2 };
      return { zoom, panX: point.x - (point.x - old.panX) * zoom / old.zoom, panY: point.y - (point.y - old.panY) * zoom / old.zoom };
    });
  }, []);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
      setView(old => {
        const zoom = Math.max(0.02, Math.min(32, old.zoom * factor)), x = event.clientX - box.left, y = event.clientY - box.top;
        return { zoom, panX: x - (x - old.panX) * zoom / old.zoom, panY: y - (y - old.panY) * zoom / old.zoom };
      });
    };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    const element = canvas.current, context = element?.getContext('2d'); if (!element || !context) return;
    if (display !== 'candidate' && !beforePixels) return;
    element.width = controller.width; element.height = controller.height;
    const data = new ImageData(new Uint8ClampedArray(display === 'source' ? beforePixels! : viewPixels || controller.pixels), controller.width, controller.height);
    if (display === 'diff') paintDiff(data, viewPixels || controller.pixels, beforePixels || controller.sourcePixels, controller.width, 0, 0, controller.width, controller.height);
    frame.current = data; context.putImageData(data, 0, 0); controller.takeDirtyBounds();
  }, [controller, display, viewPixels, beforePixels]);
  useEffect(() => {
    const data = frame.current, context = canvas.current?.getContext('2d'), dirty = controller.takeDirtyBounds();
    if (!data || !context || !dirty || display === 'source' || viewPixels) return;
    if (display === 'diff') paintDiff(data, viewPixels || controller.pixels, beforePixels || controller.sourcePixels, controller.width, dirty.x, dirty.y, dirty.width, dirty.height);
    else for (let y = dirty.y; y < dirty.y + dirty.height; y++) {
      const start = (y * controller.width + dirty.x) * 4;
      data.data.set(controller.pixels.subarray(start, start + dirty.width * 4), start);
    }
    context.putImageData(data, 0, 0, dirty.x, dirty.y, dirty.width, dirty.height);
  }, [controller, version, display, viewPixels, beforePixels]);
  useEffect(() => {
    const element = selectionCanvas.current, context = element?.getContext('2d'); if (!element || !context) return;
    element.width = controller.width; element.height = controller.height;
    const data = new ImageData(controller.width, controller.height); maskFrame.current = data;
    paintSelection(data, controller, { x: 0, y: 0, width: controller.width, height: controller.height });
    context.putImageData(data, 0, 0); controller.takeMaskDirtyBounds();
  }, [controller, showContext]);
  useEffect(() => {
    const data = maskFrame.current, context = selectionCanvas.current?.getContext('2d'), dirty = controller.takeMaskDirtyBounds();
    if (!data || !context || !dirty) return;
    const bounds = { x: Math.max(0, dirty.x - 1), y: Math.max(0, dirty.y - 1), width: Math.min(controller.width, dirty.x + dirty.width + 1) - Math.max(0, dirty.x - 1), height: Math.min(controller.height, dirty.y + dirty.height + 1) - Math.max(0, dirty.y - 1) };
    paintSelection(data, controller, bounds);
    context.putImageData(data, 0, 0, bounds.x, bounds.y, bounds.width, bounds.height);
  }, [controller, controller.maskRevision, version]);
  const pixel = (event: React.PointerEvent, clamp = false) => {
    const box = viewport.current?.getBoundingClientRect(); if (!box) return null;
    return screenToPixel({ screenX: clamp ? Math.max(box.left + view.panX, Math.min(box.left + view.panX + controller.width * view.zoom - .001, event.clientX)) : event.clientX, screenY: clamp ? Math.max(box.top + view.panY, Math.min(box.top + view.panY + controller.height * view.zoom - .001, event.clientY)) : event.clientY, originX: box.left + view.panX, originY: box.top + view.panY, zoom: view.zoom, width: controller.width, height: controller.height });
  };
  const paint = (point: PixelPoint) => {
    if (tool === 'mask-add' || tool === 'mask-erase') { controller.maskStroke(point, gesture.current?.kind === 'mask' ? gesture.current.mode : 'add', brushSize); onChange(); return; }
    const rgba = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), alpha];
    controller.stroke(point, tool === 'eraser' ? 'eraser' : 'pencil', rgba, brushSize); onChange();
  };
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault(); canvas.current?.focus();
    const point = pixel(event);
    if (tool === 'pan' || event.button === 1 || space.current) gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY };
    else {
      if (disabled || showContext || viewPixels || !point) return;
      // Comparing is a view, not a lock: starting an edit returns to the current image.
      if (display !== 'candidate') onEditView();
      try {
        if (tool === 'picker') {
          const offset = (point.y * controller.width + point.x) * 4;
          onColor(`#${Array.from(controller.pixels.subarray(offset, offset + 3), byte => byte.toString(16).padStart(2, '0')).join('')}`, controller.pixels[offset + 3]); return;
        }
        if (tool === 'fill') {
          if (!controller.mask[point.y * controller.width + point.x]) { onSelectionVisible(true); onNotice('填充起点在修改范围外，未执行。请在蓝色范围内点击，或先「选整图」。'); return; }
          onFill(point); return;
        }
        if (tool === 'move') {
          const rect = controller.region?.type === 'rectangle' ? controller.region : null;
          onSelectionVisible(true);
          if (!rect) { onNotice('移动像素需要一个矩形选区：先用「矩形」框选要移动的内容。'); return; }
          if (!(point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height)) { onNotice('请在矩形选区内按下并拖动。'); return; }
          gesture.current = { kind: 'move', start: point, rectangle: rect, dx: 0, dy: 0 }; setSelectionPreview(rect);
          event.currentTarget.setPointerCapture(event.pointerId); return;
        }
        const combination = event.altKey ? 'subtract' : event.shiftKey ? 'add' : selectionMode;
        onSelectionVisible(true);
        if (tool === 'connected') { controller.combineRegion({ type: 'connected-color', ...point, tolerance }, combination); onChange(); return; }
        if (tool === 'rectangle') {
          const rect = controller.region?.type === 'rectangle' ? controller.region : null;
          const handle = rect && selectionVisible && combination === 'replace' ? rectangleHandle(point, rect, 8 / view.zoom) : null;
          if (rect && handle) { gesture.current = { kind: 'transform', start: point, rectangle: rect, handle, next: rect }; setSelectionPreview(rect); }
          else { gesture.current = { kind: 'rectangle', start: point, last: point, mode: combination }; setSelectionPreview({ ...point, width: 1, height: 1 }); }
        }
        else if (tool === 'mask-add' || tool === 'mask-erase') { controller.beginMaskStroke(combination === 'replace' ? 'replace' : 'add'); gesture.current = { kind: 'mask', mode: combination === 'subtract' ? 'erase' : 'add' }; paint(point); }
        else { controller.beginStroke(); gesture.current = { kind: 'paint' }; paint(point); }
      } catch (error) { gesture.current = null; controller.cancelStroke(); controller.cancelMaskStroke(); onChange(); onError(error instanceof Error ? error.message : '画布操作失败。'); return; }
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = gesture.current; if (!active) return;
    if (active.kind === 'pan') { setView(old => ({ ...old, panX: active.panX + event.clientX - active.x, panY: active.panY + event.clientY - active.y })); return; }
    const point = pixel(event, true); if (!point) return;
    try {
      if (active.kind === 'paint' || active.kind === 'mask') paint(point);
      else if (active.kind === 'transform') { active.next = transformRectangle(active.rectangle, active.handle, active.start, point, controller.width, controller.height); setSelectionPreview(active.next); }
      else if (active.kind === 'move') {
        const moved = transformRectangle(active.rectangle, 'move', active.start, point, controller.width, controller.height);
        active.dx = moved.x - active.rectangle.x; active.dy = moved.y - active.rectangle.y; setSelectionPreview(moved);
      }
      else { active.last = point; setSelectionPreview({ x: Math.min(active.start.x, point.x), y: Math.min(active.start.y, point.y), width: Math.abs(point.x - active.start.x) + 1, height: Math.abs(point.y - active.start.y) + 1 }); }
    } catch (error) { gesture.current = null; controller.cancelStroke(); controller.cancelMaskStroke(); onChange(); onError(error instanceof Error ? error.message : '这一笔未写入。'); }
  };
  const finishPointer = (event: React.PointerEvent<HTMLDivElement>, cancel = false) => {
    const active = gesture.current; gesture.current = null; setSelectionPreview(null);
    try {
      if (active?.kind === 'paint') {
        if (cancel) controller.cancelStroke(); else controller.endStroke(); onChange();
        if (!cancel && !controller.strokeWritten && controller.strokeBlocked) { onSelectionVisible(true); onNotice('这一笔在修改范围（蓝色）外，未写入。可点「选整图」或调整选区后再画。'); }
      }
      if (active?.kind === 'move' && !cancel && (active.dx || active.dy)) onMove(active.dx, active.dy);
      if (active?.kind === 'mask') { if (cancel) controller.cancelMaskStroke(); else controller.endMaskStroke(); onChange(); }
      if (active?.kind === 'transform' && !cancel) { controller.selectRegion({ type: 'rectangle', ...active.next }); onChange(); }
      if (active?.kind === 'rectangle' && !cancel) { controller.selectRectangle(active.start, active.last, active.mode); onChange(); }
    } catch (error) { onChange(); onError(error instanceof Error ? error.message : '选区未改变。'); }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(() => () => { controller.cancelStroke(); controller.cancelMaskStroke(); gesture.current = null; }, [controller]);
  const rectangle = controller.region?.type === 'rectangle' ? controller.region : null;
  useEffect(() => {
    const element = canvas.current;
    const down = (event: KeyboardEvent) => { if (event.code === 'Space') { event.preventDefault(); space.current = true; } };
    const up = () => { space.current = false; };
    element?.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', up);
    return () => { element?.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', up); };
  }, []);
  return <div className="ie-canvas-area">
    <div className="ie-viewbar">
      <Button size="sm" variant="outline" onClick={fit}>适配</Button>
      <Button size="sm" variant="outline" onClick={() => zoomTo(1)}>100%</Button>
      <Button size="sm" variant="ghost" aria-label="缩小" onClick={() => zoomTo(view.zoom / 1.5)}>−</Button>
      <output aria-label="当前缩放">{Math.round(view.zoom * 100)}%</output>
      <Button size="sm" variant="ghost" aria-label="放大" onClick={() => zoomTo(view.zoom * 1.5)}>+</Button>
      <label><input type="checkbox" checked={grid} onChange={event => setGrid(event.target.checked)} />网格</label>
      <label><input type="checkbox" checked={selectionVisible} onChange={event => onSelectionVisible(event.target.checked)} />显示修改范围</label>
      <NativeSelect aria-label="画布底色" value={background} onChange={event => setBackground(event.target.value)}><NativeSelectOption value="checker">棋盘格</NativeSelectOption><NativeSelectOption value="dark">深色</NativeSelectOption><NativeSelectOption value="light">浅色</NativeSelectOption></NativeSelect>
    </div>
    <div ref={viewport} className={`ie-viewport ie-bg-${background} ${tool === 'pan' ? 'ie-pan' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => finishPointer(event)} onPointerCancel={event => finishPointer(event, true)}>
      <div className="ie-world" style={{ width: controller.width, height: controller.height, transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }}>
        {showContext && contextLayers.map((layer, index) => !layer.target && <img key={layer.id || index} src={layer.url} alt="只读上下文图层" width={layer.width} height={layer.height} draggable={false} style={{ position: 'absolute', left: layer.x || 0, top: layer.y || 0, width: layer.width, height: layer.height, opacity: layer.opacity ?? 1, zIndex: index }} />)}
        <canvas ref={canvas} className="ie-image" tabIndex={0} aria-label="图片像素画布" style={showContext ? { left: contextLayers.find(layer => layer.target)?.x || 0, top: contextLayers.find(layer => layer.target)?.y || 0, width: contextLayers.find(layer => layer.target)?.width || controller.width, height: contextLayers.find(layer => layer.target)?.height || controller.height, zIndex: Math.max(0, contextLayers.findIndex(layer => layer.target)) } : undefined} />
        <canvas ref={selectionCanvas} className="ie-selection" aria-label="可编辑区域显示层" style={{ visibility: !showContext && selectionVisible && display === 'candidate' && !viewPixels ? 'visible' : 'hidden' }} />
        {grid && view.zoom >= 8 && !showContext && <div className="ie-grid" />}
        {rectangle && selectionVisible && display === 'candidate' && !viewPixels && !showContext && !selectionPreview && <div className="ie-rectangle-outline" style={{ left: rectangle.x, top: rectangle.y, width: rectangle.width, height: rectangle.height, borderWidth: 1 / view.zoom }}>{['nw', 'ne', 'sw', 'se'].map(handle => <i key={handle} className={`ie-handle ie-handle-${handle}`} style={{ width: 8 / view.zoom, height: 8 / view.zoom }} />)}</div>}
        {selectionPreview && <div className="ie-drag-selection" style={{ left: selectionPreview.x, top: selectionPreview.y, width: selectionPreview.width, height: selectionPreview.height, borderWidth: 1 / view.zoom }} />}
      </div>
    </div>
    {!selectionVisible && controller.selectionCount > 0 && display === 'candidate' && !viewPixels && !showContext && <button type="button" className="ie-selection-badge" onClick={() => onSelectionVisible(true)}>
      修改范围已隐藏 · {controller.selectionCount === controller.width * controller.height ? '整张图片' : `${controller.selectionCount.toLocaleString()} 像素`} · 显示</button>}
    <p className="ie-hint">{toolHint(tool, showContext, display, Boolean(viewPixels))} · 滚轮缩放 · 空格或中键拖动平移 · {controller.width} × {controller.height}</p>
  </div>;
}

function toolHint(tool: ImagePixelTool, showContext: boolean, display: ImageViewMode, viewing: boolean) {
  if (showContext) return '摆放上下文只读，不进入图片输出';
  if (viewing) return '正在查看其他版本，只读';
  const hint: Record<ImagePixelTool, string> = {
    pencil: '在蓝色范围内绘制', eraser: '在蓝色范围内擦成透明', fill: '点击蓝色范围内的像素，用画笔颜色填充相连同色区域',
    move: '在矩形选区内拖动，松开后移动其中像素', rectangle: '拖动框选 · Shift 添加 · Alt 减去 · 拖动内部移动选框、角点调整',
    'mask-add': '涂抹添加修改范围 · Alt 减去', 'mask-erase': '涂抹减去修改范围', connected: '点击选择相连的同色像素 · Shift 添加 · Alt 减去',
    picker: '点击取色，设为画笔颜色', pan: '拖动平移画布',
  };
  return (display === 'candidate' ? '' : '对比视图 · 开始编辑会回到当前图 · ') + hint[tool];
}
function paintDiff(data: ImageData, pixels: Uint8Array | Uint8ClampedArray, before: Uint8Array | Uint8ClampedArray, imageWidth: number, x: number, y: number, width: number, height: number) {
  for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) {
    const offset = (row * imageWidth + column) * 4;
    const changed = pixels[offset] !== before[offset] || pixels[offset + 1] !== before[offset + 1] || pixels[offset + 2] !== before[offset + 2] || pixels[offset + 3] !== before[offset + 3];
    if (changed) { data.data[offset] = 255; data.data[offset + 1] = 60; data.data[offset + 2] = 155; data.data[offset + 3] = 255; }
    else { data.data.set(before.subarray(offset, offset + 4), offset); data.data[offset + 3] = Math.round(before[offset + 3] * 0.3); }
  }
}
function paintSelection(data: ImageData, controller: PixelController, bounds: PixelBounds) {
  const { width, height, mask } = controller;
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
    const index = y * width + x, offset = index * 4;
    const edge = mask[index] && (!x || !y || x === width - 1 || y === height - 1 || !mask[index - 1] || !mask[index + 1] || !mask[index - width] || !mask[index + width]);
    data.data[offset] = 14; data.data[offset + 1] = 165; data.data[offset + 2] = 233;
    data.data[offset + 3] = mask[index] ? edge ? 230 : 24 : 0;
  }
}
function rectangleHandle(point: PixelPoint, rect: PixelBounds, radius: number) {
  for (const [handle, x, y] of [['nw', rect.x, rect.y], ['ne', rect.x + rect.width - 1, rect.y], ['sw', rect.x, rect.y + rect.height - 1], ['se', rect.x + rect.width - 1, rect.y + rect.height - 1]] as const) if (Math.abs(point.x - x) <= radius && Math.abs(point.y - y) <= radius) return handle;
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height ? 'move' : null;
}
function transformRectangle(rect: PixelBounds, handle: string, start: PixelPoint, point: PixelPoint, width: number, height: number): PixelBounds {
  if (handle === 'move') return { ...rect, x: Math.max(0, Math.min(width - rect.width, rect.x + point.x - start.x)), y: Math.max(0, Math.min(height - rect.height, rect.y + point.y - start.y)) };
  const x1 = handle.includes('w') ? point.x : rect.x, x2 = handle.includes('e') ? point.x : rect.x + rect.width - 1;
  const y1 = handle.includes('n') ? point.y : rect.y, y2 = handle.includes('s') ? point.y : rect.y + rect.height - 1;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1) + 1, height: Math.abs(y2 - y1) + 1 };
}
