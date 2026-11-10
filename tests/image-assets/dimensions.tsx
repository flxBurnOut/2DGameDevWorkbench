import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageAssetsPanel } from '../../components/image-assets/image-assets-panel';
import { fixtureTasks } from './dimensions-fixture-provider';
import type { StoredTask } from '../../lib/workbench/work-items';

const submitted: unknown[] = [];
let beforeGenerateCalls = 0;
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
window.fetch = async (input, options) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === '/api/workbench/image-assets/settings') return Response.json({ active: true, provider: 'gpt-image-2.6', providers: [{ id: 'gpt-image-2.6', configured: true, name: '本地测试桩', model: 'no-provider' }] });
  if (url.startsWith('/api/workbench/tasks/')) {
    const id = decodeURIComponent(url.split('/').pop()!);
    const task = fixtureTasks.find(task => task.id === id);
    return Response.json(task ? { task } : { error: 'Unknown fixture task' }, { status: task ? 200 : 404 });
  }
  if (url.startsWith('/api/workbench/artifacts?')) {
    const path = new URL(url, location.origin).searchParams.get('path');
    if (path === 'outputs/broken-result/result.json') return Response.json({ error: 'Fixture unavailable' }, { status: 404 });
    if (path === 'outputs/slow-result/result.json') { await wait(350); return Response.json({ width: 3072, height: 1024 }); }
    if (path === 'outputs/processed-history/result.json') return Response.json({ width: 2560, height: 1280 });
  }
  if (url === '/api/workbench/tasks' && options?.method === 'POST') {
    if (typeof options.body !== 'string') throw new Error('Fixture only accepts a JSON string body');
    const body = JSON.parse(options.body);
    submitted.push(body);
    const task: StoredTask = { id: `submitted-${submitted.length}`, capabilityId: body.capabilityId, status: 'prepared', input: body.input, outputs: [] };
    fixtureTasks.push(task);
    return Response.json({ taskId: task.id });
  }
  throw new Error(`Fixture blocked an unexpected request: ${url}`);
};

const find = <T,>(selector: string) => {
  const element = document.querySelector(selector) as T | null;
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};
const select = async (label: string, value: string) => {
  const element = find<HTMLSelectElement>(`select[aria-label="${label}"]`);
  element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); await wait(25);
};
const fill = async (label: string, value: string) => {
  const element = find<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true })); await wait(25);
};
const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 80; attempt++) { if (predicate()) return; await wait(25); }
  throw new Error('Fixture wait timed out');
};
const assert = (condition: unknown, text: string) => { if (!condition) throw new Error(text); };
const value = (label: string) => find<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`).value;
const history = async (id: string) => { await select('最近场景背景', id); await until(() => !document.body.textContent?.includes('正在读取所选任务与输出尺寸')); };

function Fixture() {
  const [status, setStatus] = useState('尚未运行');
  const [details, setDetails] = useState('所有请求均由页面内测试桩拦截，不连接 Runtime 或图片服务。');
  const run = async () => {
    setStatus('运行中…');
    try {
      await until(() => document.querySelector('.image-assets-settings summary')?.textContent?.includes('已配置') === true);
      await fill('场景背景描述', 'fixture dimensions only');
      await select('图片输出尺寸', 'custom');
      await fill('自定义图片宽度', '1000'); await fill('自定义图片高度', '1000');
      const generate = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '生成一张图片')!;
      assert(generate.disabled, 'Invalid non-multiple must disable generation');
      assert(document.querySelector('[role="alert"]')?.textContent?.includes('16'), 'Invalid dimensions need a readable error');
      generate.click(); await wait();
      assert(submitted.length === 0 && beforeGenerateCalls === 0, 'Invalid dimensions must not save or submit');
      await fill('自定义图片宽度', '3840'); await fill('自定义图片高度', '3840');
      assert(generate.disabled, 'Pixel limit must disable generation');
      await fill('自定义图片宽度', '2560'); await fill('自定义图片高度', '1440');
      assert(!generate.disabled, 'Valid custom dimensions must allow generation');
      generate.click(); await until(() => submitted.length === 1 && !generate.disabled);
      const body = submitted[0] as { input: { width: number; height: number } };
      assert(body.input.width === 2560 && body.input.height === 1440, 'POST must preserve custom pixels');
      assert(beforeGenerateCalls === 1, 'Valid request saves once');
      await history('preset-history'); assert(value('图片输出尺寸') === '1024x1536', 'Preset history must restore exact preset');
      await history('custom-history');
      assert(value('图片输出尺寸') === 'custom' && value('自定义图片宽度') === '2560' && value('自定义图片高度') === '1440', 'Custom history must restore exact width and height');
      await history('missing-dimensions'); assert(value('图片输出尺寸') === '1536x1024', 'Missing dimensions reset to default rather than previous task');
      await history('processed-history'); assert(value('自定义图片宽度') === '2560' && value('自定义图片高度') === '1280', 'Local processing reads real dimensions from result.json');
      await history('broken-result');
      assert(value('图片输出尺寸') === '1536x1024', 'Unreadable result resets dimensions');
      assert(document.body.textContent?.includes('未能读取此任务的输出尺寸'), 'Unreadable result must explain the fallback');
      await select('最近场景背景', 'slow-result');
      assert(generate.disabled, 'Generation must wait for historical dimensions');
      await history('preset-history'); await wait(400);
      assert(value('图片输出尺寸') === '1024x1536', 'Late result cannot overwrite a newer selection');
      assert(submitted.length === 1 && beforeGenerateCalls === 1, 'Browsing tasks cannot submit generation');
      setStatus('PASS · 12 项尺寸与历史回填检查'); setDetails(JSON.stringify({ submitted, beforeGenerateCalls, realProviderRequests: 0 }, null, 2));
    } catch (error) { setStatus('FAIL'); setDetails((error as Error).stack || String(error)); }
  };
  return <main style={{ maxWidth: 620, margin: '24px auto', padding: 20, fontFamily: 'sans-serif' }}>
    <h1>图片输出尺寸 · 隔离回归</h1><p>真实 ImageAssetsPanel，内存任务与本地请求桩；不会生成实际素材。</p>
    <button id="run-dimension-checks" disabled={status === '运行中…'} onClick={() => void run()}>运行尺寸回归</button>
    <h2 id="dimension-test-status">{status}</h2><pre style={{ whiteSpace: 'pre-wrap' }}>{details}</pre>
    <ImageAssetsPanel kind="background" name="尺寸测试" adoptionLabel="测试采用" beforeGenerate={async () => { beforeGenerateCalls++; }} onAdopt={async () => undefined} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
