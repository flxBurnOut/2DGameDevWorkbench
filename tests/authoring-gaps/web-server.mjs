// In-memory acceptance fixture: every API is mocked; no model, bridge or private data.
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import sharp from 'sharp';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const root = process.cwd(), structureId = 'a'.repeat(32), temporalId = 'b'.repeat(32);
const hash = value => createHash('sha256').update(value).digest('hex');
const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#00000000' } }).composite([{ input: await sharp({ create: { width: 24, height: 40, channels: 4, background: '#687ac9' } }).png().toBuffer(), left: 20, top: 16 }]).png().toBuffer();
const uploadDirectory = await mkdtemp(path.join(os.tmpdir(), 'forge-authoring-fixture-'));
const uploadPath = path.join(uploadDirectory, 'reference-64.png'); await writeFile(uploadPath, png);
const masks = await Promise.all([1, 2, 3].map(async revision => sharp({ create: { width: 64, height: 64, channels: 4, background: '#000000' } }).composite([{ input: await sharp({ create: { width: 14, height: 28, channels: 4, background: '#ffffff' } }).png().toBuffer(), left: 8 + revision * 8, top: 20 }]).png().toBuffer()));
const controls = { failNext: false, sourceCurrent: true, delayNextPreview: false };
const requests = [], transfers = [], uploads = [], replays = new Map();
const objects = {};
for (const kind of ['structure', 'temporal']) {
  const revisions = new Map();
  for (let revision = 1; revision <= 3; revision++) {
    const token = hash(`${kind}:${revision}`), note = ['初始长剑区域', '修订盾牌区域', '当前法杖区域'][revision - 1];
    const shared = { revision, token, note, confirmation: null };
    revisions.set(revision, kind === 'structure' ? { ...shared, data: { summary: note, parts: [{ id: 'weapon', name: ['长剑', '盾牌', '法杖'][revision - 1], kind: 'equipment', parent_id: null, box: [16, 16, 48, 56], points: [], visibility: 'visible', evidence: note }], anchors: [{ id: 'grip', name: '握点', part_id: 'weapon', x: 20 + revision, y: 32, state: 'visible', evidence: note }], relations: [], uncertainties: [] }, masks: [{ id: 'weapon', file: 'fixture-mask.png', sha256: hash(`mask:${revision}`) }], issues: [] }
      : { ...shared, width: 64, height: 64, manual_corrections: Array.from({ length: revision - 1 }, () => ({ fixture: true })), parts: [{ id: 'weapon', name: '武器' }], frames: [0, 1].map(frame_index => ({ frame_index, source_sha256: 'e'.repeat(64), parts: [{ id: 'weapon', state: 'visible', area: revision * 100, centroid: [24, 32], axis_degrees_mod_180: 0, sha256: hash(`mask:${revision}`) }] })), observations: { frames: [0, 1].map(frame_index => ({ frame_index, structure: { anchors: [{ id: 'grip', name: '握点', part_id: 'weapon', x: 20 + revision, y: 32, state: 'visible' }], relations: [{ id: 'grip-link', state: 'visible', evidence: note }] } })), issues: [] }, cues: { cues: [] } });
  }
  objects[kind] = { id: kind === 'structure' ? structureId : temporalId, current: 3, revisions };
}
function snapshot(kind, selected) {
  const object = objects[kind];
  return { id: object.id, state: 'ready', revision: object.current, source_current: controls.sourceCurrent, pending: false, calls: [], error: null,
    source: { character_id: 'fixture_a', sha256: hash(png), width: 64, height: 64 },
    history: [...object.revisions.values()].map(doc => ({ revision: doc.revision, note: doc.note, origin: 'fixture', created_at: '2026-10-30T12:00:00Z' })),
    document: object.revisions.get(selected || object.current), ...(kind === 'temporal' ? { supports_review: false, structured_review: null } : {}) };
}
const sourceTask = (id, name) => ({ id, capabilityId: 'reference-art', status: 'completed', createdAt: '2026-10-30T12:00:00Z', updatedAt: '2026-10-30T12:00:00Z', input: { operation: 'import', prompt: `${name}的原始展示描述，与外观约束分别保存`, name, size: 64, facing: 'right' }, outputs: [`outputs/${id}/reference.png`] });
const tasks = [sourceTask('source_a', '角色A'), sourceTask('source_b', '角色B'), { id: 'transfer_b', capabilityId: 'reference-art', status: 'completed', createdAt: '2026-10-30T12:00:01Z', updatedAt: '2026-10-30T12:00:01Z', input: { operation: 'transfer', sourceTaskId: 'source_b', identityDescription: '角色B已保存的红色斗篷' }, outputs: [] }];
const characters = [{ id: 'fixture_a', name: '角色A', width: 64, facing: 'right', valid: true }, { id: 'fixture_b', name: '角色B', width: 64, facing: 'left', valid: true }];
const read = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; };
const server = await createTestViteServer({
  root, configFile: false, css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { dedupe: ['react', 'react-dom'], alias: { '@': root, 'next/link': path.join(root, 'tests/helpers/next-link.tsx') } },
  optimizeDeps: { noDiscovery: false, entries: ['tests/authoring-gaps/web.html'] },
  plugins: [react(), { name: 'authoring-gaps-fixture', configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url, 'http://localhost');
    const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    const image = (mask) => { response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); response.end(mask || png); };
    try {
      if (url.pathname === '/__fixture/state') return json({ revisions: { structure: objects.structure.current, temporal: objects.temporal.current }, controls, requests, transfers, uploads, modelCalls: 0, uploadPath });
      if (url.pathname === '/__fixture/control') { Object.assign(controls, await read(request)); return json(controls); }
      if (url.pathname === '/__fixture/image.png') return image();
      if (url.pathname === '/api/workbench/open-motion') {
        const operation = url.searchParams.get('path') || 'open-motion';
        const kind = operation.startsWith(`open-motion/structures/${structureId}`) ? 'structure' : operation.startsWith(`open-motion/temporal-structures/${temporalId}`) ? 'temporal' : null;
        if (kind && request.method === 'POST' && operation.endsWith('/corrections')) {
          const body = await read(request), object = objects[kind]; requests.push({ kind, ...body });
          const key = `${kind}:${body.request_key}`;
          if (replays.has(key)) return json(snapshot(kind));
          if (!controls.sourceCurrent) return json({ error: '验收：原图或参考结构已经改变' }, 409);
          if (body.expected_revision !== object.current || body.token !== object.revisions.get(object.current).token) return json({ error: '验收：当前版本或token不匹配，不能以旧预览写入' }, 409);
          if (controls.failNext) { controls.failNext = false; return json({ error: '验收：模拟应答中断，请使用同一请求重试' }, 503); }
          const target = object.revisions.get(body.restore_revision);
          if (!target) return json({ error: '验收：请选择确切历史版本' }, 400);
          const revision = ++object.current;
          object.revisions.set(revision, { ...structuredClone(target), revision, token: hash(`${kind}:${revision}`), note: body.note, confirmation: null, mutation_key: body.request_key });
          replays.set(key, true); return json(snapshot(kind));
        }
        if (kind && (operation.endsWith('/source') || operation.includes('/frames/') && !operation.includes('/parts/'))) return image();
        if (kind && (operation.includes('/masks/') || operation.includes('/parts/'))) { const revision = Number(url.searchParams.get('revision')) || 1; return image(masks[Math.min(revision, 3) - 1]); }
        if (kind && request.method === 'GET') {
          const value = snapshot(kind, Number(url.searchParams.get('revision')) || undefined);
          if (url.searchParams.has('revision') && controls.delayNextPreview) { controls.delayNextPreview = false; await new Promise(resolve => setTimeout(resolve, 1500)); }
          return json(value);
        }
        if (operation.endsWith('/temporal')) return json({ analysis: snapshot('temporal') });
        if (operation === 'open-motion/structure-runtime') return json({ ready: true, semantic_configured: false, message: '隔离验收不连接模型', semantic_model: { model: 'fixture' } });
        if (operation.endsWith('/structure')) return json({ analysis: snapshot('structure'), runtime: { ready: true, semantic_configured: false, message: '隔离验收不连接模型' } });
        if (operation === 'open-motion/references' && request.method === 'POST') { const body = await read(request); uploads.push({ display_name: body.display_name, facing: body.facing, identity_description: body.identity_description, imageBytes: Buffer.from(body.png_base64, 'base64').length }); characters.push({ id: `fixture_uploaded_${uploads.length}`, name: body.display_name, width: 64, facing: body.facing, valid: true }); return json({ character: { character_id: characters.at(-1).id } }); }
        if (operation === 'open-motion/references') return json({ characters });
        if (operation.startsWith('open-motion/references/')) return image();
        if (operation === 'open-motion/settings') return json({ provider: 'tokenhub', model: 'fixture', planning_configured: false, pixellab_configured: false, services: [] });
        if (operation === 'open-motion' && request.method === 'GET') return json({ works: [] });
        return json({ error: '隔离验收禁止规划、生成或其他付费操作' }, 403);
      }
      if (url.pathname === '/api/workbench/tasks' && request.method === 'POST') {
        const { input } = await read(request); if (input.operation !== 'transfer') return json({ error: '隔离验收只允许本地移送' }, 403);
        transfers.push(input); const id = `transfer_fixture_${transfers.length}`, output = `outputs/${id}/result.json`;
        tasks.push({ id, capabilityId: 'reference-art', status: 'completed', input, createdAt: '2026-10-30T12:01:00Z', updatedAt: '2026-10-30T12:01:00Z', outputs: [output] });
        return json({ taskId: id, status: 'completed', outputs: [output] });
      }
      if (url.pathname === '/api/workbench/tasks') return json({ tasks, snapshot: 'fixture', nextOffset: null });
      if (url.pathname.startsWith('/api/workbench/tasks/')) return json({ task: tasks.find(task => task.id === url.pathname.split('/').at(-1)) });
      if (url.pathname === '/api/workbench/reference-art/settings') return json({ configured: false });
      if (url.pathname === '/api/workbench/artifacts') return url.searchParams.get('path')?.endsWith('result.json') ? json({ characterId: 'reference_' + 'd'.repeat(24), href: '/tools/sprite-generator?character=fixture_a' }) : image();
      if (url.pathname.startsWith('/api/workbench/')) return json({ tasks: [], jobs: [], works: [], request: null });
      if (url.pathname === '/authoring-history' || url.pathname.startsWith('/tools/')) request.url = `/tests/authoring-gaps/web.html${url.search}`;
      next();
    } catch (error) { json({ error: error.message }, 500); }
  }); } }], server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
console.log(JSON.stringify({ origin: `http://127.0.0.1:${server.httpServer.address().port}`, historyPath: '/authoring-history', referencePath: '/tools/reference-art?task=source_a', motionPath: '/tools/sprite-generator?character=fixture_a', uploadPath }));
process.on('SIGINT', async () => { await server.close(); process.exit(0); });
