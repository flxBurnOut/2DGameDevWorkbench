import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import { createTestViteServer } from '../helpers/vite-server.mjs';
import { createScene } from '../../features/scene-composer/model.mjs';
import { stepInputs } from '../../lib/workbench/scene-workflow-contract.mjs';

const root = process.cwd();
const vite = await createTestViteServer({ root, configFile: false, appType: 'custom', resolve: { alias: { '@': root, 'next/link': path.join(root, 'tests/helpers/next-link.tsx') } }, server: { middlewareMode: true }, logLevel: 'error' });
const originalFetch = globalThis.fetch;
try {
  const library = await vite.ssrLoadModule('/features/editor-documents/library.ts');
  const summaries = Array.from({ length: 238 }, (_, index) => ({ id: `scene-${String(index).padStart(3, '0')}`, kind: 'scene', revision: 1, name: `共享场景 ${index}`, updatedAt: '2026-10-30T10:00:00Z', createdAt: '2026-10-29T10:00:00Z', viewPath: '/untrusted-unused-path' }));
  const offsets = [];
  globalThis.fetch = async (url, options) => {
    const query = new URL(url, 'http://fixture').searchParams;
    assert.equal(query.get('kind'), 'scene'); assert.equal(query.get('limit'), '100');
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    const offset = Number(query.get('offset')); offsets.push(offset);
    return Response.json({ documents: summaries.slice(offset, offset + 100), total: summaries.length, nextOffset: offset + 100 < summaries.length ? offset + 100 : null });
  };
  const all = await library.readSharedDocumentLibrary('scene', new AbortController().signal);
  assert.equal(all.documents.length, 238); assert.deepEqual(offsets, [0, 100, 200]);
  const lastPageMatch = library.sharedDocumentPage(all.documents, '共享场景 237', 0);
  assert.equal(lastPageMatch.total, 1); assert.equal(lastPageMatch.documents[0].id, 'scene-237');
  assert.equal(library.sharedDocumentPage(all.documents, '', 19).documents.length, 10);
  assert.equal(library.sharedDocumentPage(all.documents, 'scene-237', 19).page, 0, 'search must clamp a stale later page');
  const duplicate = { ...summaries[0], revision: 3 };
  const deduplicated = await library.readSharedDocumentLibrary('scene', new AbortController().signal, async (_kind, offset) => offset ? { documents: [duplicate], nextOffset: null } : { documents: [summaries[0]], nextOffset: 100 });
  assert.equal(deduplicated.documents.length, 1); assert.equal(deduplicated.documents[0].revision, 3);
  await assert.rejects(library.readSharedDocumentLibrary('scene', new AbortController().signal, async () => ({ documents: [], nextOffset: 0 })), /分页/);
  globalThis.fetch = async () => Response.json({ error: 'Bridge unavailable' }, { status: 503 });
  await assert.rejects(library.readSharedDocumentLibrary('scene', new AbortController().signal), /Bridge unavailable/);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(library.readSharedDocumentLibrary('scene', controller.signal, async () => { calls++; controller.abort(); return { documents: [summaries[0]], nextOffset: 100 }; }), error => error.name === 'AbortError');
  assert.equal(calls, 1, 'closing a picker stops subsequent pages');
  assert.equal(library.sharedDocumentHref('/tools/scene-composer', 'scene-237'), '/tools/scene-composer?document=scene-237');
  assert.throws(() => library.sharedDocumentHref('https://outside.example', 'scene-237'));

  const detail = await vite.ssrLoadModule('/features/scene-workflow/plan-details.ts');
  const components = await vite.ssrLoadModule('/components/scene-composer/scene-workflow-plan-details.tsx');
  const scene = createScene('验收场景');
  scene.instances = [{ id: 'gate', materialId: 'gate-art', name: '铁门', x: 0, y: 0, scale: 1, flipH: false, anchor: { x: 0, y: 0 }, locked: false, hidden: false, included: true }];
  const steps = [
    { id: 'lamp-art', kind: 'generate', input: JSON.stringify({ purpose: 'object', materialId: 'lamp-material', definitionId: 'lamp', name: '旧灯', prompt: '<script>unsafe()</script> 透明背景，保留生锈细节', visualWidth: 48, visualHeight: 72 }) },
    { id: 'map', kind: 'map', input: JSON.stringify({ operation: 'extend', name: '走廊', prompt: '延续砖墙', neighborTileKey: '0,0', direction: 'right', overlapPercent: 20 }) },
    { id: 'object', kind: 'object', input: JSON.stringify({ materialId: 'gate-copy', definitionId: 'gate-definition', name: '新铁门', source: { kind: 'scene', materialId: 'gate-art' }, commands: [{ type: 'set-activation', definitionId: 'gate-definition', activation: { mode: 'external_request' } }, { type: 'set-content', definitionId: 'gate-definition', content: { pages: ['打开铁门'] } }] }) },
    { id: 'layout', kind: 'scene', input: JSON.stringify({ commands: [{ type: 'add-instance', materialId: 'lamp-material', instanceId: 'lamp-instance', x: 400, y: 600 }, { type: 'move-instances', ids: ['gate'], dx: 4, dy: -2 }, { type: 'set-anchor', instanceId: 'gate', anchor: { x: 8, y: 16 } }] }) },
    { id: 'image', kind: 'image', input: JSON.stringify({ target: { kind: 'scene-instance', instanceId: 'gate', slot: 'toggle-state', index: 1 }, region: { type: 'rectangle', x: 10, y: 20, width: 30, height: 40 }, operation: { type: 'ai-edit', prompt: '保留金属边框，只移除锈迹' }, preserveAlpha: true }) },
  ];
  for (const step of steps) stepInputs[step.kind].parse(JSON.parse(step.input));
  const names = detail.planNames(scene, steps);
  const generation = detail.describePlanStep(steps[0], names);
  assert.match(generation.rows.find(row => row.label === '图片尺寸').value, /1024 × 1024/);
  assert.equal(generation.rows.find(row => row.label === '生成描述').value, JSON.parse(steps[0].input).prompt);
  const layout = detail.describePlanStep(steps[3], names);
  assert.equal(layout.changes[0].rows.find(row => row.label === '场景素材').value, '旧灯');
  assert.equal(layout.changes[1].rows.find(row => row.label === '选中物件').value, '铁门');
  assert.equal(layout.changes[2].rows.find(row => row.label === '场景物件').value, '铁门');
  const image = detail.describePlanStep(steps[4], names);
  assert.equal(image.rows.find(row => row.label === '外观位置').value, '切换状态外观');
  assert.equal(image.rows.find(row => row.label === '状态或条目').value, '第 2 项');
  assert.equal(detail.describePlanStep({ kind: 'unknown', input: '{}' }, names).changes.length, 0);
  assert.match(detail.describePlanStep({ kind: 'scene', input: '{broken' }, names).warning, /历史步骤/);
  assert.match(detail.describePlanStep({ kind: 'scene', input: JSON.stringify({ commands: [{ type: 'eval', source: 'do something' }] }) }, names).warning, /历史步骤/);
  assert.equal(detail.describeRegion(undefined), '未记录检查范围');
  assert.match(detail.describeReplayEvent({ type: 'move-actor' }, names), /无法解读/);
  const markup = renderToStaticMarkup(createElement(components.WorkflowStepDetails, { step: steps[0], scene, steps }));
  assert.match(markup, /生成描述/); assert.match(markup, /&lt;script&gt;/); assert.doesNotMatch(markup, /<script>/);
  const plan = { steps, visualCriteria: [{ id: 'visual', description: '铁门边框无改动', requirementIds: ['r1'], region: { x: -2, y: 10, width: 100, height: 80 } }], acceptance: [{ id: 'behavior', description: '触发后铁门隐藏', requirementIds: ['r1'], events: [{ type: 'request', instanceId: 'gate' }, { type: 'tick', seconds: 1 }], expectEvents: [{ name: 'interaction_completed', instanceId: 'gate', count: 1 }], expectStates: [{ instanceId: 'gate', visible: false, solidEnabled: false, successCount: 1 }] }] };
  const acceptance = renderToStaticMarkup(createElement(components.WorkflowAcceptanceDetails, { plan, scene }));
  assert.match(acceptance, /左上角 \(-2, 10\)，100 × 80/); assert.match(acceptance, /外部触发：铁门/); assert.match(acceptance, /完成交互至少 1 次/); assert.match(acceptance, /实体碰撞开启/);
  const legacy = renderToStaticMarkup(createElement(components.WorkflowAcceptanceDetails, { plan: { visualCriteria: [{ description: '旧条件' }], acceptance: [{ description: '旧行为' }] }, scene }));
  assert.match(legacy, /未记录检查范围/); assert.match(legacy, /缺少当前格式/);
  console.log('Shared project discovery and plan details passed: all 238 server projects/search/pagination, duplicate and failure handling, cancellation, safe deep links, five step types, readable targets/coordinates/prompts, precise acceptance replay, old-format fallback and escaped text.');
} finally { globalThis.fetch = originalFetch; await vite.close(); }
