// Optional browser acceptance for /tools/interactable-motion against a running
// Forge frontend (FORGE_TEST_WEB_URL). Open-motion data come from an isolated
// diagnostic Python service with scripted planners; no paid endpoint is called.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';

const loaded = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const playwright = loaded.chromium ? loaded : loaded.default;
const web = process.env.FORGE_TEST_WEB_URL || 'http://localhost:3000';
const root = path.resolve('work/test-runs', `interactable-motion-browser-${randomUUID()}`);
await mkdir(root, { recursive: true });
const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(r => socket.close(r));
const python = process.env.SPRITE_TEST_PYTHON || path.resolve('Tools/SpritePipeline/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const delay = ms => new Promise(r => setTimeout(r, ms));
function start(item) {
  const child = spawn(python, ['Tools/SpritePipeline/tests/open_motion_server.py', path.join(root, item), String(port), '--checkpoints', '--expert-reviews', '--prop-item', item], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = ''; child.stderr.on('data', d => { child.log += d; });
  return child;
}
let server = start('lever');
const base = `http://127.0.0.1:${port}`;
const ready = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch { /* starting */ } if (server.exitCode !== null || i === 99) throw new Error(server.log); await delay(100); } };
let browser;
try {
  await ready();
  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const posted = [];
  await page.route('**/api/workbench/**', route => route.fulfill({ status: 503, json: { error: '本隔离验收仅启用开放动作接口' } }));
  await page.route('**/api/workbench/open-motion?**', async route => {
    const request = route.request(), url = new URL(request.url());
    const target = new URL('/v1/' + (url.searchParams.get('path') || 'open-motion'), base);
    for (const [key, value] of url.searchParams) if (key !== 'path' && key !== 'v') target.searchParams.set(key, value);
    let body = request.postData();
    if (body) {
      const value = JSON.parse(body);
      if (value.spec) value.spec.provider = 'fixture';
      posted.push({ path: url.searchParams.get('path'), body: value });
      body = JSON.stringify(value);
    }
    const response = await fetch(target, { method: request.method(), headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}) });
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.route('**/api/workbench/open-motion?path=open-motion%2Fsettings', async route => {
    const response = await fetch(base + '/v1/open-motion/settings');
    await route.fulfill({ status: 200, json: { ...(await response.json()), planning_configured: true, pixellab_configured: true } });
  });

  await page.goto(web + '/tools/interactable-motion');
  const picker = page.getByLabel('交互物对象');
  await picker.waitFor();
  assert.equal(await picker.locator('option[value="test_hero"]').count(), 0, 'Characters are not offered in the interactable panel.');
  await picker.selectOption('fixture_door');
  const status = page.locator('#im-action-status');
  await page.getByText('描述原图之后每个状态的外观').first().waitFor();
  await page.getByLabel('外观：与上一状态的差别').fill('拉杆转到右侧，底座不动');
  const primary = page.locator('.motion-footer .motion-primary');
  assert.match(await primary.textContent(), /制定方案/);
  await primary.click();
  await page.waitForURL(/work=[0-9a-f]{32}/, { timeout: 30000 });
  const plan = posted.find(p => p.path === 'open-motion');
  assert.equal(plan.body.spec.object_type, 'interactable');
  assert.deepEqual(plan.body.spec.interactable_skeleton.states.map(s => s.name), ['关闭', '打开']);
  assert.match(plan.body.spec.description, /「关闭」 → 「打开」/);
  await page.getByRole('tab', { name: '要求' }).click();
  await page.getByText('交互物合同').waitFor({ timeout: 30000 });
  // A hinge without a checked structure is blocked before any drawing call, with a re-plan action.
  await page.getByText(/起始图前提未满足/).first().waitFor({ timeout: 30000 });
  assert.match(await primary.textContent(), /重新制定方案/);
  assert.match(await status.textContent(), /处理方案提出的前提问题/);
  assert.ok(await page.getByText('部件结构（铰接转动、形变需要）').count() === 0, 'saved plans are not edited in place');
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByText('部件结构（铰接转动、形变需要）').waitFor();

  // Appearance changes need no structure: restart the isolated service with that scripted plan.
  server.kill(); await once(server, 'exit');
  server = start('lamp'); await ready();
  await page.goto(web + '/tools/interactable-motion');
  await picker.selectOption('fixture_door');
  await page.getByLabel('外观：与上一状态的差别').fill('灯面完全点亮，外壳不动');
  await primary.click();
  await page.waitForURL(/work=[0-9a-f]{32}/, { timeout: 30000 });
  await page.getByText('确认方案，开始制作').waitFor({ timeout: 30000 });
  const work = await (await fetch(`${base}/v1/open-motion/${new URL(page.url()).searchParams.get('work')}`)).json();
  assert.equal(work.status, 'ready', `${work.status}: ${work.message}`);
  await primary.click();
  // The fixture provider cannot finish a 128px prop segment; production start is the browser boundary.
  // Stage review itself is the shared MotionStageReview, covered by the Python state-chain suite.
  await page.locator('.im-edge', { hasText: /生成中|待检查|复核中|需要处理/ }).first().waitFor({ timeout: 30000 });
  assert.ok(posted.some(p => p.path === `open-motion/${work.id}/generate` && p.body.plan_sha256 === work.plan_sha256));
  await page.screenshot({ path: path.join(root, 'panel.png') });
  await page.getByRole('tab', { name: '写回' }).click();
  await page.getByText('选择写回的交互物').waitFor();
  await page.getByRole('tab', { name: '工具' }).click();
  await page.getByText(/逐帧工具|T1 固定部件回填/).first().waitFor();
  assert.deepEqual(errors, []);
  console.log('Verified interactable panel: object filter, state draft, skeleton planning, blocked hinge premise, structure entry, generation start and tabs. Screenshot: ' + path.join(root, 'panel.png'));
} finally {
  await browser?.close();
  server.kill();
}
