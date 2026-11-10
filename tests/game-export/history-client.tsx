import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GameDeliveryHistory } from '../../components/workbench/game-delivery-history';
import type { GameDelivery } from '../../lib/workbench/game-export-client';
import '../../app/globals.css';
import '../../components/workbench/workbench.css';

const fixtures: GameDelivery[] = Array.from({ length: 25 }, (_, index) => ({
  deliveryId: `delivery-${index.toString(16).padStart(32, '0')}`,
  title: `验收交付 ${index + 1}`,
  kind: index === 0 ? 'scene' : 'animation',
  status: index === 0 ? 'integrated' : index === 1 ? 'needs_attention' : 'awaiting_agent',
  project: { name: '示例游戏', path: '/fixture-only/unavailable-game' },
  createdAt: new Date(Date.UTC(2026, 0, 25 - index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 1, 25 - index)).toISOString(),
  inboxPath: `/fixture-only/unavailable-game/forge_imports/${index}`,
  packageSha256: 'a'.repeat(64), packageId: `test-${index}`,
  package: { kind: index === 0 ? 'scene' : 'animation', details: { animation: 'idle', frameCount: 8, fps: 12, loop: true } },
  integration: index === 0 ? { summary: '已接入门与拉杆，保存了验收结果。', files: [{ path: 'scenes/castle.tscn', sha256: 'a'.repeat(64) }], engine: { status: 'passed', version: '4.7.1', baselineValidated: true, evidence: '此内容仅为界面测试数据。' } } : index === 1 ? { summary: '示例：接线需要继续处理。', engine: { status: 'failed', evidence: '示例错误：节点路径已变化。' } } : null,
}));
const requests: string[] = [];
let failNextList = false;
let conflictNextPage = false;
const wait = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
window.fetch = async (input, options) => {
  const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(address, location.origin);
  if (options?.method && options.method !== 'GET') throw new Error('History fixture forbids mutations');
  requests.push(url.pathname + url.search);
  if (url.pathname === '/api/workbench/game-export/history') {
    const offset = Number(url.searchParams.get('offset') || 0);
    if (failNextList) { failNextList = false; return Response.json({ error: '验收：读取暂时失败' }, { status: 503 }); }
    if (offset > 0 && conflictNextPage) { conflictNextPage = false; return Response.json({ error: '交付记录已更新，请刷新列表后继续查看。' }, { status: 409 }); }
    const data = url.searchParams.get('pendingOnly') === 'true' ? fixtures.filter(row => row.status !== 'integrated') : fixtures;
    return Response.json({ deliveries: data.slice(offset, offset + 20), total: data.length, nextOffset: offset + 20 < data.length ? offset + 20 : null, snapshot: 'a'.repeat(64) });
  }
  if (url.pathname === '/api/workbench/game-export/record') {
    const id = url.searchParams.get('deliveryId');
    const row = fixtures.find(item => item.deliveryId === id);
    // Deliberately ignores AbortSignal so the component must reject a late response.
    if (row === fixtures[1]) await wait(350);
    return Response.json(row || { error: '此交付不存在' }, { status: row ? 200 : 404 });
  }
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
};
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const until = async (predicate: () => boolean) => { for (let count = 0; count < 100; count++) { if (predicate()) return; await wait(); } throw new Error('UI did not reach expected state'); };
const button = (text: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
};
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="游戏交付列表"] .wb-task-button')];
const detail = () => document.querySelector('[aria-label="游戏交付详情"]')?.textContent || '';
const navigateFixture = (id: string) => { history.pushState({}, '', `/advanced?tab=deliveries&delivery=${id}`); window.dispatchEvent(new PopStateEvent('popstate')); };

function Fixture() {
  const [result, setResult] = useState('尚未运行');
  const run = async () => {
    setResult('运行中…');
    try {
      navigateFixture(fixtures[24].deliveryId);
      await until(() => rows().length === 20 && detail().includes('验收交付 25'));
      assert(!rows().some(row => row.textContent?.includes('验收交付 25')), 'Deep linked record must be readable outside the current page');
      button('加载更早交付').click(); await until(() => rows().length === 25);
      assert(document.body.textContent?.includes('25 / 25'), 'Older page appears');
      rows()[0].click(); await until(() => detail().includes('Agent 已记录 Godot 4.7.1 通过证据'));
      assert(!detail().includes('复制给 WorkBuddy'), 'Integrated record must not suggest repeating integration');
      rows()[1].click(); await wait(); rows()[2].click();
      await until(() => detail().includes('验收交付 3')); await wait(400);
      assert(!detail().includes('验收交付 2'), 'Late record response cannot replace the current selection');
      navigateFixture('delivery-' + 'f'.repeat(32)); await until(() => detail().includes('此交付不存在'));
      assert(!detail().includes('验收交付 3'), 'An unreadable record cannot retain the previous record');
      button('待接入或需处理').click(); await until(() => document.body.textContent?.includes('20 / 24') === true);
      assert(rows().every(row => !row.textContent?.includes('代码已接入')), 'Pending filter excludes integrated records');
      failNextList = true; button('刷新交付记录').click(); await until(() => document.body.textContent?.includes('验收：读取暂时失败') === true);
      assert(rows().length === 20, 'Refresh failures preserve visible rows');
      button('全部交付').click(); await until(() => document.body.textContent?.includes('20 / 25') === true);
      conflictNextPage = true; button('加载更早交付').click(); await until(() => document.body.textContent?.includes('交付记录已更新') === true);
      assert(rows().length === 20, 'Page conflict does not append stale records');
      button('刷新交付记录').click(); await until(() => !button('刷新交付记录').disabled && !document.querySelector('[role="alert"]'));
      button('加载更早交付').click(); await until(() => rows().length === 25);
      rows()[24].click(); await until(() => detail().includes('验收交付 25'));
      const prompt = document.querySelector<HTMLTextAreaElement>('[aria-label="历史交付接入请求"]')?.value;
      assert(prompt?.includes(fixtures[24].deliveryId), 'Handoff uses the selected exact delivery identity');
      assert(requests.every(url => /game-export\/(history|record)/.test(url)), 'Browsing must remain read only');
      setResult('PASS · 深链接、25 条分页、筛选、刷新错误、版本冲突、迟到响应和精确交接请求');
    } catch (cause) { setResult(`FAIL · ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  return <div className="wb-app" style={{ height: 'auto', minHeight: '100vh', overflow: 'visible' }}><main className="wb-page wb-advanced">
    <div className="wb-page-heading"><div><h1>工作台管理 · 游戏交付</h1><p>隔离验收：使用真实组件与内存响应，不连接游戏或生成服务。</p></div><button className="wb-button" disabled={result === '运行中…'} onClick={() => void run()}>运行交付历史回归</button></div>
    <output aria-label="交付历史回归结果">{result}</output>
    <GameDeliveryHistory />
  </main></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
