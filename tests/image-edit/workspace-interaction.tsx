/* oxlint-disable next/no-img-element -- Local browser fixtures. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ImageEditWorkspace } from '../../components/image-edit/image-edit-workspace';
import { base64ToBytes, bytesToBase64, rgbaHash } from '../../features/image-edit/client';
import type { ImageEditSession, ImagePixels, ImageTargetInfo } from '../../features/image-edit/client';
import '../../app/globals.css';
import '../../components/image-assets/image-assets.css';

const root = createRoot(document.getElementById('root')!);
const results = document.getElementById('results')!, assertions: string[] = [], reads: string[] = [];
const until = async (predicate: () => boolean) => { const deadline = performance.now() + 10000; while (!predicate()) { if (performance.now() > deadline) throw new Error('UI timeout: ' + document.body.innerText.slice(-1200)); await new Promise(resolve => setTimeout(resolve, 10)); } };
const check = (value: unknown, description: string) => { if (!value) throw new Error(description); assertions.push(description); };
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === name);
const click = async (name: string) => { await until(() => !!button(name) && !button(name)!.disabled); button(name)!.click(); await new Promise(resolve => setTimeout(resolve, 20)); };
const chosen = () => document.querySelector('.ie-history-selected')?.textContent || '';
const selection = () => document.querySelector('.ie-range')?.textContent || '';
// Version timeline: 0 is the image as opened, n is version n.
const clickVersion = async (index: number) => { const pick = () => document.querySelectorAll<HTMLButtonElement>('.ie-history li button')[index]; await until(() => !!pick() && !pick()!.disabled); pick()!.click(); await new Promise(resolve => setTimeout(resolve, 20)); };
const frame = () => document.querySelector<HTMLCanvasElement>('.ie-image')!;
const pixel = (x: number, y: number) => [...frame().getContext('2d')!.getImageData(x, y, 1, 1).data];
const fixture = async (variant: boolean): Promise<ImagePixels> => {
  const width = 1024, height = 1024, bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes.set(variant && x >= 400 && x < 600 && y >= 400 && y < 600 ? [25, 150, 175, 255] : [65 + x % 100, 80 + y % 120, 105, 255], (y * width + x) * 4);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0);
  const imageBase64 = canvas.toDataURL('image/png').split(',')[1];
  return { width, height, rgbaBase64: bytesToBase64(bytes), rgbaByteLength: bytes.length, rgbaSha256: await rgbaHash(bytes), pixelFormat: 'sRGB-RGBA8-straight', imageBase64, imageMimeType: 'image/png', sha256: await rgbaHash(base64ToBytes(imageBase64)) };
};
const gesture = async (x1: number, y1: number, x2: number, y2: number) => {
  const viewport = document.querySelector<HTMLElement>('.ie-viewport')!, rect = frame().getBoundingClientRect();
  // Synthetic fixture events cannot capture an OS pointer. Production keeps native capture.
  viewport.setPointerCapture = () => {}; viewport.hasPointerCapture = () => false;
  const event = (type: string, x: number, y: number) => new PointerEvent(type, { bubbles: true, pointerId: 44, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: rect.x + (x + .3) * rect.width / 1024, clientY: rect.y + (y + .3) * rect.height / 1024 });
  viewport.dispatchEvent(event('pointerdown', x1, y1)); viewport.dispatchEvent(event('pointermove', x2, y2)); viewport.dispatchEvent(event('pointerup', x2, y2));
  await new Promise(resolve => setTimeout(resolve, 25));
};
// This page intercepts every fetch; no real key, document or paid provider is used.
const originalFetch = window.fetch;
let releaseSlow: (() => void) | undefined;
try {
  const original = await fixture(false), candidate = await fixture(true);
  const target: ImageTargetInfo = { targetId: 'interaction-target', targetRef: { kind: 'image-task', taskId: 'fixture-only' }, name: '局部修改 · 1024 像素交互验收', width: 1024, height: 1024, kind: 'prop', editable: true, locked: false, revision: 1, sha256: original.sha256, rgbaSha256: original.rgbaSha256, aiEdit: { supported: true, provider: 'fixture', width: 1024, height: 1024, minPixels: 1, maxPixels: 8294400, maxEdge: 3840, dimensionStep: 16, maxAspectRatio: 3, maxReferences: 8, maxImageBytes: 30000000, maxTotalImageBytes: 80000000, constraints: { preserveDimensions: true, preserveOutsideRegion: true, preserveAlpha: true } } };
  const session: ImageEditSession = { editId: 'interaction-session', revision: 1, target, source: { sha256: original.sha256, rgbaSha256: original.rgbaSha256 }, adoptions: [], candidates: [
    { version: 'candidate-a', status: 'completed', operation: { type: 'ai-edit' }, createdAt: new Date().toISOString(), baseCandidateVersion: 'source' },
    { version: 'candidate-slow', status: 'completed', operation: { type: 'ai-edit' }, createdAt: new Date().toISOString(), baseCandidateVersion: 'source' },
  ] };
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), location.href);
    if (url.origin === location.origin && url.pathname === '/api/workbench/paid-tasks') return Response.json({ workspaceId: 'a'.repeat(64) });
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/workbench/image-edit/')) throw new Error('Non-fixture fetch forbidden');
    if (typeof init?.body !== 'string') throw new Error('Expected JSON fixture request');
    const body = JSON.parse(init.body), operation = url.pathname.split('/').at(-1);
    if (operation === 'inspect') return Response.json({ target, sessions: [] });
    if (operation === 'session-get') {
      if (body.includePixels) reads.push(body.candidateVersion);
      if (body.includePixels && body.candidateVersion === 'candidate-slow') await new Promise<void>(resolve => { releaseSlow = resolve; }); // Deliberately ignores AbortSignal.
      return Response.json({ edit: { ...session, ...(body.includePixels ? { selectedVersion: body.candidateVersion, pixels: body.candidateVersion === 'source' ? original : candidate } : {}) } });
    }
    if (operation === 'resolve') return Response.json({ regionRef: 'fixture-region' });
    if (operation === 'paid-edit' || operation === 'edit') {
      if (body.operation.type === 'ai-edit') check(operation === 'paid-edit' && new Headers(init?.headers).get('x-forge-workspace') === 'a'.repeat(64), 'AI requests carry their stored workspace identity');
      session.revision++; session.candidates.push({ version: 'candidate-result', status: 'completed', operation: body.operation, createdAt: new Date().toISOString(), baseCandidateVersion: body.baseCandidateVersion });
      return Response.json({ edit: session, status: 'completed', candidateVersion: 'candidate-result' });
    }
    throw new Error('Unexpected mutation ' + operation);
  };
  root.render(<div className="image-assets-panel"><ImageEditWorkspace target={target.targetRef} initialEditId={session.editId} initialCandidateVersion="candidate-a" onAdopt={async () => { throw new Error('This test never adopts'); }} onClose={() => root.render(null)} /></div>);
  await until(() => !!button('选整图') && !button('选整图')!.disabled);
  await click('适配');
  check(document.querySelector('.ie-backdrop')?.parentElement === document.body, 'Editor is isolated from host form CSS');
  check(selection().includes('未选择'), 'AI starts with an empty selection');
  check(button('生成 AI 候选（调用模型）')?.disabled, 'An empty selection cannot submit');
  check(['矩形选区', '涂选', '连通选区', '选整图', '平移'].every(name => button(name) && !button(name)!.disabled), 'Selection tools are accessible immediately in AI mode');
  check(['画笔', '橡皮', '填充', '移动'].every(name => !button(name)), 'Pixel-writing tools appear only in local refinement');
  await gesture(400, 400, 499, 499);
  check(selection().includes('10,000'), 'Dragging creates the expected rectangle');
  const maskCanvas = document.querySelector<HTMLCanvasElement>('.ie-selection')!;
  const maskPixel = (x: number, y: number) => [...maskCanvas.getContext('2d')!.getImageData(x, y, 1, 1).data];
  check(maskPixel(450, 450)[3] === 24 && maskPixel(10, 10)[3] === 0, 'Selection uses a light tint, with no black protection overlay');
  await gesture(450, 450, 470, 470);
  check(selection().includes('10,000') && maskPixel(410, 410)[3] === 0 && maskPixel(515, 515)[3] > 0, 'Rectangle can be moved without changing its area');
  await gesture(519, 519, 539, 539);
  check(selection().includes('14,400'), 'Rectangle corner resize uses source coordinates');
  await click('添加'); await gesture(700, 700, 709, 709); check(selection().includes('14,500'), 'Rectangle addition merges regions');
  await click('减去'); await gesture(700, 700, 709, 709); check(selection().includes('14,400'), 'Rectangle subtraction removes only selected pixels');
  const dialog = document.querySelector('dialog')!;
  dialog.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'z', ctrlKey: true })); await until(() => selection().includes('14,500'));
  check(true, 'Undo shortcut in selection tools undoes the selection');
  await click('清空选区');
  const beforeReads = reads.length;
  for (let i = 0; i < 12; i++) {
    await clickVersion(0); await until(() => chosen().includes('打开时的图片'));
    await clickVersion(1); await until(() => chosen().includes('版本 1'));
  }
  check(reads.length === beforeReads, '24 repeated 1024px version switches use verified cache, without a new pixel request');
  check(selection().includes('未选择'), 'Empty selection survives repeated browsing');
  check(!!document.querySelector('.ie-lock-reason'), 'Viewing another version explains why editing is paused');
  await clickVersion(0); await click('从这里继续改');
  check(selection().includes('未选择'), 'Explicit base change also preserves empty selection');
  await clickVersion(1); await click('从这里继续改');
  await clickVersion(2); await until(() => !!releaseSlow);
  await clickVersion(0); releaseSlow!(); await until(() => chosen().includes('打开时的图片'));
  await new Promise(resolve => setTimeout(resolve, 100));
  check(chosen().includes('打开时的图片'), 'A late response cannot replace the last requested version');
  await clickVersion(2); await until(() => !!button('取消等待'));
  await click('取消等待'); releaseSlow!(); await new Promise(resolve => setTimeout(resolve, 100));
  check(chosen().includes('打开时的图片'), 'Cancel keeps the existing preview and editor usable');
  await click('回到工作版本'); await click('选整图'); await click('本地精修'); await click('画笔');
  check(!!button('填充') && !!button('精确替色'), 'Local refinement shows canvas fill and range operations together');
  await click('涂选'); check(!button('涂选')?.disabled && selection().includes('整张图片'), 'Manual mode shares the same brush selection');
  await click('画笔');
  await gesture(500, 500, 500, 500); const painted = pixel(500, 500).join(',');
  check(!button('保存为新版本')?.disabled, 'Manual stroke is pending');
  await click('AI 局部修改');
  check(pixel(500, 500).join(',') === painted && selection().includes('整张图片'), 'Switching to AI preserves manual pixels and selection');
  check(!button('保存为新版本')?.disabled && document.body.innerText.includes('提交前会先把未保存笔划存为新版本'), 'AI mode keeps manual save and states that strokes are saved before generation');
  await click('本地精修');
  await clickVersion(0); check(button('从这里继续改')?.disabled, 'Unsaved strokes prevent changing the editing base, but allow browsing');
  await click('回到工作版本'); check(pixel(500, 500).join(',') === painted, 'Browsing preserves unsaved pixels');
  await click('舍弃未保存笔划'); await click('AI 局部修改'); await click('新建'); await click('清空选区'); await click('矩形选区'); await gesture(400, 400, 599, 599);
  const prompt = document.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Fixture only: recolor this area'); prompt.dispatchEvent(new Event('input', { bubbles: true }));
  await click('生成 AI 候选（调用模型）'); await until(() => chosen().includes('版本 3'));
  check(getComputedStyle(maskCanvas).visibility === 'hidden', 'A completed result automatically hides the selection overlay');
  check(pixel(500, 500).join(',') === '25,150,175,255', 'Result pixels are shown without a baked-in overlay');
  await click('修改前'); await until(() => !document.querySelector('.ie-view-state')?.textContent?.includes('正在读取对比'));
  check(pixel(500, 500).join(',') === '25,150,175,255', 'Before compares against this candidate’s actual parent, not the session source');
  await click('修改后');
  results.dataset.status = 'passed'; results.textContent = JSON.stringify({ status: 'passed', assertions, pixelRequests: reads, realProviderRequests: 0 }, null, 2);
} catch (cause) {
  results.dataset.status = 'failed'; results.textContent = JSON.stringify({ status: 'failed', assertions, error: cause instanceof Error ? cause.stack : String(cause), reads, realProviderRequests: 0 }, null, 2);
} finally {
  if (!new URL(location.href).searchParams.has('stay')) { root.unmount(); window.fetch = originalFetch; }
}
