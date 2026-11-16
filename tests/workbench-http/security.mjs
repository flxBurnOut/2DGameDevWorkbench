import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestViteServer } from '../helpers/vite-server.mjs';
import { repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { createRuntimeRequestPolicy, runtimeRequestFailure, trustedRequest } from '../../lib/workbench/request-security.mjs';

// Only this test's namespace and local fixture servers can receive mutations.
const testRun = `security-${randomUUID()}`;
let upstreamCalls = 0;
const upstream = http.createServer((_request, response) => {
  upstreamCalls++;
  response.writeHead(500, { 'content-type': 'application/json' });
  response.end('{"error":"Unexpected provider request"}');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${upstream.address().port}`;
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const configuredRuntime = 'https://runtime.example.test:9443/bridge';
const child = spawn(process.execPath, ['scripts/workbench-http.mjs'], {
  cwd: repositoryRoot,
  env: {
    ...process.env, WORKBENCH_TEST_RUN: testRun,
    WORKBENCH_RUNTIME_PORT: String(port), WORKBENCH_RUNTIME_URL: configuredRuntime,
    WORKBENCH_FRONTEND_URL: 'http://localhost:3000',
    SPRITE_PIPELINE_API_URL: fixtureUrl, OPENAI_API_KEY: 'fixture-never-submit',
    MAP_STITCHER_OPENAI_GENERATION_API_URL: `${fixtureUrl}/v1/images/generations`,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${new URL('../helpers/mock-keychain.mjs', import.meta.url).href}`.trim(),
  },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let vite;
const originalFetch = globalThis.fetch;
const previousRuntime = process.env.WORKBENCH_RUNTIME_URL;
const previousFrontend = process.env.WORKBENCH_FRONTEND_URL;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Security test Bridge startup timeout')), 15000);
    child.stdout.on('data', data => { if (String(data).includes('ready at')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Security test Bridge exited: ${code}`)); });
  });
  const send = (route, input, headers = {}) => originalFetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  const untrusted = { origin: 'http://attacker.invalid', 'sec-fetch-site': 'cross-site' };
  for (const [route, input] of [
    ['/v1/documents', { kind: 'interactable', name: 'Blocked', commandId: 'blocked-create' }],
    ['/v1/agent/document-create', { kind: 'interactable', name: 'Blocked agent', commandId: 'blocked-agent' }],
    ['/v1/tasks', { capabilityId: 'image-assets', input: { operation: 'generate-prop', kind: 'prop', prompt: 'Never submit this fixture' } }],
    ['/v1/image-assets/settings', { provider: 'gpt-image-2.6', active: true, apiKey: 'fixture-never-save' }],
    ['/v1/reference-art/settings', { apiKey: 'fixture-never-save' }],
    ['/v1/assets/manage', { action: 'trash', assetIds: ['fixture'] }],
    ['/v1/interactable-assets', {}],
  ]) {
    assert.equal((await send(route, input, untrusted)).status, 403, route);
  }
  assert.equal((await send('/v1/documents', { kind: 'interactable', commandId: 'blocked-no-origin' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001', 'https://localhost:3000', 'null']) {
    assert.equal((await send('/v1/documents', { kind: 'interactable', commandId: 'blocked-origin' }, { origin })).status, 403, origin);
  }
  const forged = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/health`, { headers: { host: `attacker.invalid:${port}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject);
  });
  assert.equal(forged, 403, 'Host validation also covers reads and DNS rebinding');
  assert.equal((await send('/v1/documents', { kind: 'interactable', commandId: 'blocked-mime' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send('/v1/documents', { kind: 'interactable', commandId: 'blocked-empty-mime' }, { 'content-type': '' })).status, 415);
  assert.equal((await (await originalFetch(`${base}/v1/documents`)).json()).documents.length, 0);
  assert.equal((await (await originalFetch(`${base}/v1/tasks`)).json()).tasks.length, 0);
  assert.equal(existsSync(path.join(repositoryRoot, 'work/test-runs', testRun, 'config/map-generation.json')), false);
  assert.equal(upstreamCalls, 0, 'Rejected requests never touch configured providers or their credential settings');

  for (const [commandId, headers] of [
    ['local-frontend', { origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' }],
    ['local-frontend-ipv4', { origin: 'http://127.0.0.1:3000' }],
    ['local-frontend-ipv6', { origin: 'http://[::1]:3000' }],
    ['runtime-page', { origin: base, 'sec-fetch-site': 'same-origin' }],
    ['headless-client', {}],
    ['configured-runtime', { host: 'runtime.example.test:9443', origin: 'https://runtime.example.test:9443' }],
  ]) {
    const response = await send('/v1/documents', { kind: 'interactable', name: commandId, commandId }, headers);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const clientEnv = { ...process.env, WORKBENCH_TEST_RUN: testRun, WORKBENCH_RUNTIME_URL: base, SPRITE_PIPELINE_API_URL: 'http://127.0.0.1:1' };
  const cli = await promisify(execFile)(process.execPath, ['scripts/workbench.mjs', 'agent', 'document-create', '--input-json', JSON.stringify({ kind: 'interactable', name: 'CLI document', commandId: 'security-cli' }), '--json'], { cwd: repositoryRoot, env: clientEnv, timeout: 15000 });
  assert.equal(JSON.parse(cli.stdout).document.name, 'CLI document');
  const mcp = new Client({ name: 'security-headless-client', version: '1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['scripts/workbench-mcp.mjs'], cwd: repositoryRoot, env: clientEnv, stderr: 'pipe' });
  try {
    await mcp.connect(transport);
    const created = await mcp.callTool({ name: 'workbench_create_document', arguments: { kind: 'interactable', name: 'MCP document', commandId: 'security-mcp' } });
    assert.notEqual(created.isError, true);
    assert.equal(created.structuredContent.document.name, 'MCP document');
  } finally { await mcp.close(); }
  // Remote frontends and non-default ports remain explicit configuration, not
  // a wildcard exception for every localhost Origin or every port.
  const policy = createRuntimeRequestPolicy({ host: '0.0.0.0', port, runtimeUrl: configuredRuntime, frontendUrl: 'https://editor.example.test:8443' });
  const incoming = headers => ({ method: 'POST', headers: { host: `127.0.0.1:${port}`, ...headers } });
  assert.equal(runtimeRequestFailure(incoming({ origin: 'https://editor.example.test:8443', 'sec-fetch-site': 'cross-site' }), policy), null);
  assert.equal(runtimeRequestFailure(incoming({ origin: 'https://editor.example.test:8444' }), policy)?.status, 403);
  assert.equal(runtimeRequestFailure(incoming({ host: `0.0.0.0:${port}` }), policy)?.status, 403);
  assert.equal(runtimeRequestFailure(incoming({ host: 'runtime.example.test:9443' }), policy), null);
  const ipv6 = createRuntimeRequestPolicy({ host: '::1', port });
  assert.equal(runtimeRequestFailure(incoming({ host: `[::1]:${port}` }), ipv6), null);

  process.env.WORKBENCH_RUNTIME_URL = base;
  process.env.WORKBENCH_FRONTEND_URL = 'http://localhost:4321';
  for (const origin of ['http://localhost:4321', 'http://127.0.0.1:4321', 'http://[::1]:4321']) {
    assert.equal(trustedRequest(new Request(`${origin}/api/workbench/tasks`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }), { json: true }), null);
  }
  process.env.WORKBENCH_FRONTEND_URL = 'https://editor.example.test:8443';
  assert.equal(trustedRequest(new Request('https://editor.example.test:8443/api/workbench/tasks', { method: 'POST', headers: { origin: 'https://editor.example.test:8443', 'content-type': 'application/json' }, body: '{}' }), { json: true }), null);
  assert.equal(trustedRequest(new Request('https://editor.example.test:8444/api/workbench/tasks', { method: 'POST', headers: { origin: 'https://editor.example.test:8444' } }))?.status, 403);
  process.env.WORKBENCH_FRONTEND_URL = 'http://localhost:4321';
  vite = await createTestViteServer({ root: repositoryRoot, configFile: false, appType: 'custom', logLevel: 'error', resolve: { alias: { '@': repositoryRoot } }, server: { middlewareMode: true } });
  /** @type {Array<[name: string, method: 'POST' | 'PUT' | 'DELETE', json: boolean, params?: Record<string, string>, routePath?: string]>} */
  const routes = [
    ['tasks', 'POST', true], ['image-assets/settings', 'POST', true], ['reference-art/settings', 'POST', true],
    ['assets', 'POST', true], ['assets/manage', 'POST', true], ['assets/import', 'POST', true], ['assets/download', 'POST', true],
    ['assets/packages/commit', 'POST', true], ['assets/packages/inspect', 'POST', false],
    ['interactable-assets', 'POST', false], ['documents', 'POST', true],
    ['documents/[id]/[action]', 'POST', true, { id: 'interactable-fixture', action: 'apply' }],
    ['image-edit/[operation]', 'POST', true, { operation: 'session-create' }],
    ['document-media/[key]', 'PUT', false, { key: `${'a'.repeat(64)}.png` }],
    ['frontend', 'POST', true], ['open-motion', 'POST', true],
    ['game-export/[action]', 'POST', true, {}, 'game-export/select'],
    ['history', 'DELETE', false],
  ];
  let forwarded = 0;
  globalThis.fetch = async (_url, init) => {
    forwarded++;
    if (init?.body) assert.equal(typeof init.body === 'string' || init.body instanceof ReadableStream, true);
    return Response.json({ ok: true, count: 0 });
  };
  for (const [name, method, json, params = {}, routePath = name] of routes) {
    const routeModule = await vite.ssrLoadModule(`/app/api/workbench/${name}/route.ts`);
    const url = `http://localhost:4321/api/workbench/${routePath}`;
    const invoke = headers => routeModule[method](new Request(url, {
      method, headers: { 'content-type': json ? 'application/json' : 'application/octet-stream', ...headers },
      ...(method === 'DELETE' ? {} : { body: '{}' }),
    }), { params: Promise.resolve(params) });
    const before = forwarded;
    assert.equal((await invoke(untrusted)).status, 403, `${name}: foreign Origin`);
    assert.equal((await invoke({ 'sec-fetch-site': 'cross-site' })).status, 403, `${name}: cross-site without Origin`);
    assert.equal((await invoke({ origin: 'null' })).status, 403, `${name}: opaque Origin`);
    assert.equal((await invoke({ origin: 'http://localhost:4322' })).status, 403, `${name}: another local port`);
    assert.equal((await invoke({ origin: 'http://localhost:4321', 'sec-fetch-site': 'cross-site' })).status, 403, `${name}: cross-site metadata cannot be overridden`);
    assert.equal((await invoke({ host: 'attacker.invalid' })).status, 403, `${name}: hostile Host with trusted internal URL`);
    const rebound = new Request(`http://attacker.invalid/api/workbench/${routePath}`, {
      method, headers: { origin: 'http://attacker.invalid', 'content-type': json ? 'application/json' : 'application/octet-stream' },
      ...(method === 'DELETE' ? {} : { body: '{}' }),
    });
    assert.equal((await routeModule[method](rebound, { params: Promise.resolve(params) })).status, 403, `${name}: unconfigured Host and matching Origin`);
    const anotherPort = new Request(`http://localhost:4322/api/workbench/${routePath}`, {
      method, headers: { origin: 'http://localhost:4322', 'content-type': json ? 'application/json' : 'application/octet-stream' },
      ...(method === 'DELETE' ? {} : { body: '{}' }),
    });
    assert.equal((await routeModule[method](anotherPort, { params: Promise.resolve(params) })).status, 403, `${name}: unconfigured local port and matching Origin`);
    if (json) assert.equal((await invoke({ origin: 'http://localhost:4321', 'content-type': 'text/plain' })).status, 415, `${name}: simple POST`);
    assert.equal(forwarded, before, `${name}: reject before upstream fetch`);
    assert.equal((await invoke({ origin: 'http://localhost:4321', 'sec-fetch-site': 'same-origin' })).status, 200, `${name}: same-origin custom frontend port`);
    if (name !== 'history') assert.equal((await invoke({})).status, 200, `${name}: server client without Origin`);
  }
  /** @type {Array<[name: string, params?: Record<string, string>, routePath?: string]>} */
  const reads = [
    ['tasks'], ['tasks/[taskId]', { taskId: 'fixture' }], ['result'], ['artifacts', {}, 'artifacts?path=outputs/fixture.png'],
    ['assets'], ['assets/preview'], ['assets/packages/preview'], ['assets/packages/commit'],
    ['documents'], ['documents/[id]', { id: 'interactable-fixture' }],
    ['document-media/[key]', { key: `${'a'.repeat(64)}.png` }],
    ['interactable-assets'], ['image-assets/settings'], ['reference-art/settings'],
    ['open-motion'], ['game-export/[action]', {}, 'game-export/settings'],
    ['health'], ['sprite-pipeline/health'], ['sprite-pipeline/jobs'],
  ];
  globalThis.fetch = async () => { forwarded++; return Response.json({ ok: true, version: 'fixture', data: { jobs: [] }, works: [] }); };
  for (const [name, params = {}, routePath = name] of reads) {
    const routeModule = await vite.ssrLoadModule(`/app/api/workbench/${name}/route.ts`);
    const before = forwarded;
    assert.equal((await routeModule.GET(new Request(`http://attacker.invalid/api/workbench/${routePath}`, { headers: { origin: 'http://attacker.invalid' } }), { params: Promise.resolve(params) })).status, 403, `${name}: read with rebound Host and Origin`);
    assert.equal((await routeModule.GET(new Request(`http://localhost:4321/api/workbench/${routePath}`, { headers: { host: 'attacker.invalid' } }), { params: Promise.resolve(params) })).status, 403, `${name}: read with hostile Host header`);
    assert.equal(forwarded, before, `${name}: rejected read never reaches runtime/private files`);
    const accepted = await routeModule.GET(new Request(`http://127.0.0.1:4321/api/workbench/${routePath}`), { params: Promise.resolve(params) });
    assert.equal(accepted.status, 200, `${name}: legitimate image/server read without Origin`);
  }
  assert.equal(upstreamCalls, 0);
  console.log('HTTP security: rejected requests have no mutations/provider calls; exact configured origins/hosts, headless clients, binary uploads and all frontend write guards passed.');
} finally {
  globalThis.fetch = originalFetch;
  if (previousRuntime === undefined) delete process.env.WORKBENCH_RUNTIME_URL;
  else process.env.WORKBENCH_RUNTIME_URL = previousRuntime;
  if (previousFrontend === undefined) delete process.env.WORKBENCH_FRONTEND_URL;
  else process.env.WORKBENCH_FRONTEND_URL = previousFrontend;
  await vite?.close();
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  await new Promise(resolve => upstream.close(resolve));
}
