import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod/v4';
import { previewIdentityKeys } from './preview-follow-client.mjs';

const PAGE_TTL = 20_000;
const REQUEST_TTL = 120_000;
const uuid = z.uuid();
const heartbeatSchema = z.object({
  pageId: uuid,
  sessionId: uuid.optional(),
  viewPath: z.string().max(2000),
  visible: z.boolean(),
  focused: z.boolean(),
  following: z.boolean(),
  items: z.array(z.object({
    id: z.string().max(200), title: z.string().max(160), capabilityId: z.string().max(80),
  }).strict()).max(12),
  dirty: z.boolean(),
  busy: z.boolean(),
  ack: z.object({
    requestId: uuid,
    state: z.enum(['displayed', 'navigating', 'paused', 'blocked']),
    reason: z.enum(['editing', 'busy', 'save-failed', 'user-paused', 'page-arrived']).optional(),
  }).strict().optional(),
}).strict();

function directory(root, manifest) {
  const relative = manifest.workspace.presentationDirectory;
  if (!relative) throw new Error('Presentation directory is not configured.');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid presentation directory.');
  return resolved;
}
async function read(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function write(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  try {
    // Windows can briefly lock the destination while another MCP/Bridge reads it.
    // Retry only the atomic replacement; never truncate the live handshake file.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
        await delay(10 * (attempt + 1));
      }
    }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Only internal, registered pages and non-secret identity fields may cross this channel.
export function previewPath(manifest, value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) throw new Error('Invalid preview path.');
  const url = new URL(value, 'http://workbench.local');
  const routes = ['/', '/advanced', manifest.agentAssets.assetCatalog.route,
    ...manifest.productionLines.map((p) => p.href),
    ...manifest.capabilities.map((c) => c.ui?.route),
    ...manifest.editorModules.map((m) => m.ui?.route)];
  if (!routes.includes(url.pathname) || url.hash) throw new Error('Unknown preview page.');
  const allowed = new Set(previewIdentityKeys);
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || value.length > 500 || /\p{Cc}/u.test(value)) throw new Error('Invalid preview identity.');
  }
  url.searchParams.sort();
  return url.pathname + url.search;
}
async function pages(dir) {
  let names;
  try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(names.filter((name) => /^page-[a-f0-9-]+\.json$/.test(name)).map((name) => read(path.join(dir, name))));
  return records.filter((record) => record && Date.now() - record.updatedAt < PAGE_TTL)
    .sort((a, b) => Number(b.visible) - Number(a.visible) || b.focusedAt - a.focusedAt || b.updatedAt - a.updatedAt);
}
async function targetPage(dir, request) {
  return request.pageId || (await read(path.join(dir, `claim-${request.id}.json`)))?.pageId || null;
}
function latestFile(dir, sessionId) {
  if (sessionId) uuid.parse(sessionId);
  return path.join(dir, sessionId ? `latest-${sessionId}.json` : 'latest.json');
}
async function status(dir, request, connected) {
  if (!request) return null;
  const pageId = await targetPage(dir, request);
  const ack = await read(path.join(dir, `ack-${request.id}.json`));
  const latest = await read(latestFile(dir, request.sessionId));
  const page = connected.find((p) => p.pageId === pageId && (!request.sessionId || p.sessionId === request.sessionId));
  const state = ack?.state === 'displayed' ? 'displayed'
    : latest?.id !== request.id ? 'superseded'
    : request.expiresAt < Date.now() ? 'expired'
    : !page ? 'waiting_for_frontend'
    : !page.following ? 'paused'
    : ack?.state || 'pending';
  return { requestId: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}), viewPath: request.viewPath, title: request.title,
    summary: request.summary, state, pageId, reason: ack?.reason,
    // This confirms route arrival only, not successful image loading or visual QA.
    displayed: state === 'displayed', browserOpened: false };
}

export async function frontendContext(root, manifest, { requestId, sessionId } = {}) {
  if (requestId) uuid.parse(requestId);
  if (sessionId) uuid.parse(sessionId);
  const dir = directory(root, manifest);
  const connected = (await pages(dir)).filter(p => !sessionId || p.sessionId === sessionId);
  const request = await read(requestId ? path.join(dir, `request-${requestId}.json`) : latestFile(dir, sessionId));
  return { pages: connected, presentation: await status(dir, request, connected),
    coverage: 'Live page identity only; canvas pixels and browser drafts are not read or indexed.', createsTask: false };
}

export async function queuePresentation(root, manifest, presentation, { sessionId } = {}) {
  if (sessionId) uuid.parse(sessionId);
  const dir = directory(root, manifest);
  await mkdir(dir, { recursive: true });
  const viewPath = previewPath(manifest, presentation.viewPath);
  const connected = (await pages(dir)).filter(p => !sessionId || p.sessionId === sessionId);
  const previous = await read(latestFile(dir, sessionId));
  // Repeated status polls update neither the route nor its navigation request.
  if (previous && previous.expiresAt > Date.now() && previous.viewPath === viewPath &&
    previous.title === presentation.title && previous.summary === presentation.summary && previous.state === presentation.state) {
    return status(dir, previous, connected);
  }
  const request = { id: randomUUID(), ...(sessionId ? { sessionId } : {}), viewPath, title: String(presentation.title || '当前作品').slice(0, 160),
    summary: String(presentation.summary || '查看当前步骤。').slice(0, 240), state: presentation.state,
    createdAt: Date.now(), expiresAt: Date.now() + REQUEST_TTL,
    pageId: connected.find((p) => p.visible)?.pageId || null };
  await write(path.join(dir, `request-${request.id}.json`), request);
  await write(path.join(dir, 'latest.json'), request);
  if (sessionId) await write(latestFile(dir, sessionId), request);
  // Keep only recent ephemeral handshakes; source assets and tasks are never touched.
  const names = await readdir(dir);
  for (const name of names.filter((n) => /^(request|ack|claim|page|latest)-[a-f0-9-]+\.json$/.test(n))) {
    const file = path.join(dir, name);
    const record = await read(file);
    if (record && Date.now() - (record.updatedAt || record.createdAt || 0) > 3_600_000)
      await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  return status(dir, request, connected);
}

export async function frontendHeartbeat(root, manifest, input) {
  const page = heartbeatSchema.parse(input);
  page.viewPath = previewPath(manifest, page.viewPath);
  const dir = directory(root, manifest);
  await mkdir(dir, { recursive: true });
  const pageFile = path.join(dir, `page-${page.pageId}.json`);
  const previous = await read(pageFile);
  const { ack, ...snapshot } = page;
  await write(pageFile, { ...snapshot, updatedAt: Date.now(), focusedAt: page.focused ? Date.now() : previous?.focusedAt || 0 });
  const globalRequest = await read(path.join(dir, 'latest.json'));
  const ownRequest = page.sessionId ? await read(latestFile(dir, page.sessionId)) : null;
  let request = ownRequest && (globalRequest?.sessionId || ownRequest.createdAt >= (globalRequest?.createdAt || 0)) ? ownRequest : globalRequest;
  if (request?.sessionId && request.sessionId !== page.sessionId) request = null;
  if (request && request.expiresAt >= Date.now() && page.visible) {
    let target = await targetPage(dir, request);
    if (!target) {
      try {
        await writeFile(path.join(dir, `claim-${request.id}.json`), JSON.stringify({ pageId: page.pageId, createdAt: Date.now() }), { flag: 'wx', mode: 0o600 });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      target = await targetPage(dir, request);
    }
    if (target !== page.pageId) request = null;
  } else request = null;
  if (ack) {
    const acknowledged = await read(path.join(dir, `request-${ack.requestId}.json`));
    if (!acknowledged || (acknowledged.sessionId && acknowledged.sessionId !== page.sessionId) || await targetPage(dir, acknowledged) !== page.pageId) throw new Error('Presentation acknowledgement does not belong to this page.');
    const ackFile = path.join(dir, `ack-${ack.requestId}.json`);
    const receipt = await read(ackFile);
    if (receipt?.pageId !== page.pageId || receipt.state !== 'displayed') {
      if (ack.state === 'displayed' && page.viewPath !== acknowledged.viewPath) throw new Error('Page has not reached the requested view.');
      await write(ackFile, { ...ack, pageId: page.pageId, updatedAt: Date.now() });
    }
  }
  return { request, connected: true };
}
