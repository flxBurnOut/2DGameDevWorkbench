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
import sharp from 'sharp';
import { createObject, createProject } from '../../features/interactable-editor/contract.mjs';

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
  const pythonPath = [path.resolve('Tools/PixelProp'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const child = spawn(python, ['Tools/SpritePipeline/tests/open_motion_server.py', path.join(root, item), String(port), '--checkpoints', '--expert-reviews', '--prop-item', item],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: pythonPath, PYTHONUTF8: '1' } });
  child.log = ''; child.stderr.on('data', d => { child.log += d; });
  return child;
}
let server = start('lever');
const base = `http://127.0.0.1:${port}`;
const ready = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch { /* starting */ } if (server.exitCode !== null || i === 99) throw new Error(server.log); await delay(100); } };
let browser;
try {
  await ready();
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const posted = [];
  let dropPlanningResponse = true;
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
    const response = await fetch(target, { method: request.method(), headers: { 'content-type': 'application/json', connection: 'close' }, ...(body ? { body } : {}) })
      .catch(() => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    if (body && target.pathname === '/v1/open-motion' && response.ok && dropPlanningResponse) {
      dropPlanningResponse = false;
      await response.arrayBuffer();
      return route.abort('connectionreset');
    }
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.route('**/api/workbench/open-motion?path=open-motion%2Fsettings', async route => {
    const response = await fetch(base + '/v1/open-motion/settings', { headers: { connection: 'close' } })
      .catch(() => new Response('{}', { status: 503 }));
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
  await page.getByText('规划请求尚未确认。重试会沿用原请求编号和状态图。').waitFor();
  await page.reload();
  await page.getByRole('button', { name: '重试原规划请求' }).click();
  await page.waitForURL(/work=[0-9a-f]{32}/, { timeout: 30000 });
  const [plan, retry] = posted.filter(p => p.path === 'open-motion');
  assert.deepEqual(retry.body, plan.body, 'Retry after reload must send the same planning payload and key.');
  const leverWorks = await (await fetch(base + '/v1/open-motion')).json();
  assert.equal(leverWorks.works.length, 1, 'The lost response must not create another work.');
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
  await page.getByLabel('终点停留（可选）').fill('停留半秒');
  const target = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#4400ff88' } }).png().toBuffer();
  await page.getByLabel('可选：上传目标图').setInputFiles({ name: 'target.png', mimeType: 'image/png', buffer: target });
  await page.getByAltText('状态 B 目标图').waitFor();
  await primary.click();
  await page.waitForURL(/work=[0-9a-f]{32}/, { timeout: 30000 });
  await page.getByText('确认方案，开始制作').waitFor({ timeout: 30000 });
  const latestUrl = page.url();
  const workId = new URL(latestUrl).searchParams.get('work');
  await page.reload();
  await page.getByRole('button', { name: '按状态顺序绑定目标图' }).click();
  assert.equal(posted.find(p => p.path === `open-motion/${workId}/target`).body.png_base64, target.toString('base64'));
  await page.locator('.im-node[data-source="target"]').waitFor();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  assert.equal(await page.getByLabel('终点停留（可选）').inputValue(), '停留半秒');
  await page.getByAltText('状态 B 目标图').waitFor();
  await page.getByLabel('外观：与上一状态的差别').fill('灯面亮起蓝光，外壳不动');
  await primary.click();
  await page.getByText('版本 2 · 已保存本机').waitFor();
  await page.goto(latestUrl + '&version=1');
  const targetNode = page.locator('.im-node[data-source="target"]');
  const thumbUrl = new URL(await targetNode.locator('img').getAttribute('src'), web);
  assert.equal(thumbUrl.searchParams.get('revision'), '1');
  await targetNode.click();
  const detailImage = page.locator('.im-node-detail img');
  assert.equal(new URL(await detailImage.getAttribute('src'), web).searchParams.get('revision'), '1');
  await detailImage.evaluate(image => image.decode());
  await page.goto(latestUrl);
  await page.getByText('确认方案，开始制作').waitFor({ timeout: 30000 });
  await page.evaluate(id => localStorage.removeItem(`forge.interactable-motion.draft.${id}`), workId);
  await page.reload();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  assert.equal(await page.getByLabel('终点停留（可选）').inputValue(), '停留半秒');
  assert.equal(await page.getByLabel('外观：与上一状态的差别').inputValue(), '灯面亮起蓝光，外壳不动');
  await page.getByRole('button', { name: '取消修改' }).click();
  const work = await (await fetch(`${base}/v1/open-motion/${workId}`)).json();
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

  const project = createProject();
  const toggle = createObject('toggle');
  toggle.behavior.initialToggle = true;
  project.objects = [toggle];
  await page.route('**/api/workbench/documents/fixture-bound?*', route =>
    route.fulfill({ json: { document: { content: project } } }));
  await page.goto(web + '/tools/interactable-motion?' + new URLSearchParams({ document: 'fixture-bound', definition: toggle.definitionId }));
  await page.waitForFunction(name => document.querySelector('[aria-label="状态 A 名称"]')?.value === name, toggle.behavior.states[1].name);
  assert.equal(await page.getByLabel('状态 B 名称').inputValue(), toggle.behavior.states[0].name);

  assert.deepEqual(errors, []);
  console.log('Verified interactable panel: lost response recovery, draft migration, historical target images, initial toggle state, generation start and review tabs. Screenshot: ' + path.join(root, 'panel.png'));
} finally {
  await browser?.close();
  server.kill();
}
