// Real Chromium acceptance of the shipped SceneComposer, its dialogs, shared
// document host and live local split service. All data and browser state are
// isolated; this harness refuses every paid prepare mode at the HTTP boundary.
import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { createTestViteServer } from '../helpers/vite-server.mjs';
import { mapProjectFixture } from '../helpers/map-project.mjs';
import { createMapProjectPackage } from '../../features/map-stitcher/project-package.mjs';
import {
  createScene,
  replaceMap,
  addInstance,
  addMaterial,
} from '../../features/scene-composer/model.mjs';
import { createProject } from '../../features/interactable-editor/contract.mjs';
import { activeMapCollisions } from '../../features/scene-composer/render-model.mjs';
import {
  createDocument,
  documentRequest,
  getDocument,
  readDocumentMedia,
  uploadDocumentMedia,
} from '../../lib/workbench/editor-documents.mjs';
import { sceneSplitRequest } from '../../lib/workbench/scene-splits.mjs';
import { loadManifest } from '../../lib/workbench/runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)),
  out = path.join(
    root,
    'work',
    'test-runs',
    process.env.WORKBENCH_TEST_RUN,
    'scene-split-browser',
  );
await mkdir(out, { recursive: true });
const manifest = await loadManifest(),
  calls = [],
  browserErrors = [];
let mediaDownloads = 0, mediaAvailable = true;
// Exercise the shipping default auto mode's honest missing-runtime fallback.
// Real checkpoint accuracy/performance belongs to the separate map acceptance.
process.env.FORGE_STRUCTURE_WEIGHTS = path.join(
  out,
  'deliberately-unavailable-test.weights',
);
const width = 320,
  height = 200,
  base = Buffer.alloc(width * height * 4),
  objects = Buffer.alloc(base.length);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const checker = (Math.floor(x / 20) + Math.floor(y / 20)) % 2;
    base.set(
      [34 + checker * 5, 69 + checker * 7, 61 + checker * 3, 255],
      (y * width + x) * 4,
    );
    const canopy = y >= 30 && y < 108 && Math.abs(x - 112) < (y - 15) * 0.6;
    const trunk = x >= 105 && x < 120 && y >= 100 && y < 145;
    const lamp =
      (x >= 239 && x < 246 && y >= 90 && y < 140) ||
      (x >= 228 && x < 257 && y >= 72 && y < 94);
    if (canopy || trunk || lamp)
      objects.set(
        canopy
          ? [97, 156, 86, 255]
          : trunk
            ? [129, 80, 43, 255]
            : [244, 192, 70, 255],
        (y * width + x) * 4,
      );
  }
const image = (pixels) =>
  sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
const surfacePng = await image(base),
  objectPng = await image(objects),
  overall = await sharp(surfacePng)
    .composite([{ input: objectPng }])
    .png()
    .toBuffer();
const fixture = await mapProjectFixture(overall, 'map:browser-split');
fixture.draft.pending = [];
fixture.draft.snapshot.shapes = [];
const tile = fixture.draft.snapshot.tiles[0];
Object.assign(tile, {
  x: 0,
  y: 0,
  w: width,
  h: height,
  feather: { top: 0, right: 0, bottom: 0, left: 0 },
  surfaceIsDraft: false,
});
for (const layer of Object.keys(tile.images))
  tile.images[layer] = {
    file: new Blob(
      [
        layer === 'object'
          ? objectPng
          : layer === 'surface'
            ? surfacePng
            : overall,
      ],
      { type: 'image/png' },
    ),
    name: `${layer}.png`,
    type: 'image/png',
    width,
    height,
  };
const scene = createScene('隔离网页分层验收');
scene.id =
  'browser_' +
  process.env.WORKBENCH_TEST_RUN.replace(/[^a-z0-9]/gi, '').slice(0, 70);
Object.assign(scene.view, { x: 120, y: 70, zoom: 2.6 });
const pngUrl = (bytes) => 'data:image/png;base64,' + bytes.toString('base64');
replaceMap(scene, {
  name: '隔离像素树林',
  origin: { x: -40, y: 15 },
  offset: { x: 7, y: -3 },
  layers: [
    {
      id: 'map_surface',
      name: '地表',
      width,
      height,
      source: pngUrl(surfacePng),
      hidden: false,
      locked: true,
      included: true,
    },
    {
      id: 'map_object',
      name: '物件',
      width,
      height,
      source: pngUrl(objectPng),
      hidden: false,
      locked: true,
      included: true,
    },
  ],
  collisions: [
    [
      { x: 65, y: 125 },
      { x: 80, y: 125 },
      { x: 80, y: 140 },
    ],
  ],
  warnings: [],
  source:
    'data:application/zip;base64,' +
    Buffer.from(await createMapProjectPackage(fixture.draft)).toString(
      'base64',
    ),
});
const dialogueProject = createProject();
const speaker = dialogueProject.objects[0];
speaker.activation.mode = 'proximity_press';
speaker.content.pages = ['第一页按键检查', '第二页按键检查'];
speaker.content.charactersPerSecond = 0;
const speakerMaterial = addMaterial(scene, dialogueProject, speaker.definitionId);
const speakerInstance = addInstance(scene, speakerMaterial.id, 127, 112);
speakerInstance.anchor = { x: 0, y: 0 };
await createDocument(root, manifest, {
  documentId: scene.id,
  kind: 'scene',
  content: scene,
  commandId: 'browser-fixture-create',
});
const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';
import '/app/globals.css';import {SceneComposer} from '/components/scene-composer/scene-composer.tsx';
import {workbenchContext} from '/components/workbench/workbench-context.ts';
const noop=()=>{};const state={pathname:'/tools/scene-composer',modules:[],lines:[],items:[],tasks:[],spriteItems:[],localItems:[],sessions:[],runtimeOnline:true,spriteOnline:true,storageError:'',navigationError:'',setNavigationError:noop,refreshing:false,refresh:noop,navigate:async()=>{},guideOpen:false,setGuideOpen:noop,helpOpen:false,setHelpOpen:noop,queueOpen:false,setQueueOpen:noop};
createRoot(document.getElementById('root')).render(React.createElement(workbenchContext.Provider,{value:state},React.createElement(SceneComposer)));`;
const entryFile = path.join(out, 'entry.jsx');
await writeFile(entryFile, entry);
const html = `<!doctype html><html data-theme="dark" class="dark"><meta charset="utf-8"><title>隔离地图分层验收</title>
<style>html,body,#root{margin:0;height:100%;width:100%;overflow:hidden}#root{height:100vh}</style><div id="root"></div>
<script type="module" src="/${path.relative(root, entryFile).replaceAll('\\', '/')}"></script></html>`;
let vite, chrome, socket, captureFailure;
let transientStatusFailures = 0;
let blankDocumentId, heldCandidateRead;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sendJson = (res, status, value) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
};
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const profile = await mkdtemp(path.join(out, 'chrome-profile-'));
try {
  vite = await createTestViteServer({
    root,
    configFile: false,
    resolve: { alias: { '@': root } },
    css: { postcss: { plugins: [tailwindcss()] } },
    optimizeDeps: {
      include: [
        'react',
        'react-dom/client',
        'react/jsx-runtime',
        'zod',
        'zod/v4',
        'jszip',
        'lucide-react',
        '@base-ui/react/dialog',
        '@base-ui/react/button',
        '@base-ui/react/context-menu',
        '@base-ui/react/menu',
        'class-variance-authority',
        'clsx',
        'tailwind-merge',
      ],
    },
    plugins: [
      react(),
      {
        name: 'isolated-scene-split-browser',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname === '/tools/scene-composer') {
              res.setHeader('Content-Type', 'text/html;charset=utf-8');
              res.end(await server.transformIndexHtml(req.url, html));
              return;
            }
            if (!url.pathname.startsWith('/api/')) {
              next();
              return;
            }
            try {
              if (url.pathname.startsWith('/api/workbench/document-media/')) {
                if (!mediaAvailable) { sendJson(res, 503, { error: 'Media network deliberately unavailable' }); return; }
                const key = url.pathname.split('/').at(-1);
                if (req.method === 'PUT') {
                  const chunks = []; for await (const chunk of req) chunks.push(chunk);
                  sendJson(res, 200, { media: await uploadDocumentMedia(root, manifest, key, req.headers['content-type'], Buffer.concat(chunks)) });
                } else {
                  const media = await readDocumentMedia(root, manifest, key, { metadataOnly: req.method === 'HEAD' });
                  if (req.method === 'GET') mediaDownloads++;
                  res.writeHead(200, { 'content-type': media.metadata.mime, 'content-length': String(media.metadata.bytes) });
                  res.end(media.bytes);
                }
                return;
              }
              if (url.pathname.startsWith('/api/workbench/scene-split/')) {
                const operation = url.pathname.split('/').at(-1),
                  input = await body(req);
                assert.equal(
                  input.documentId,
                  scene.id,
                  'only the isolated fixture can be changed',
                );
                if (operation === 'prepare')
                  assert(
                    ['local', 'auto'].includes(input.mode),
                    'this browser test cannot request any paid model',
                  );
                calls.push({ operation, input });
                if (heldCandidateRead && operation === 'get' && heldCandidateRead.id === input.candidateId) {
                  heldCandidateRead.entered.resolve();
                  await heldCandidateRead.release.promise;
                }
                if (
                  operation === 'get' &&
                  input.candidateId &&
                  transientStatusFailures === 0
                ) {
                  transientStatusFailures++;
                  sendJson(res, 503, {
                    error: 'fixture temporary status read failure',
                  });
                  return;
                }
                sendJson(
                  res,
                  200,
                  await sceneSplitRequest(
                    root,
                    manifest,
                    `scene-split-${operation}`,
                    input,
                  ),
                );
                return;
              }
              if (
                url.pathname === '/api/workbench/documents' ||
                url.pathname.startsWith('/api/workbench/documents/')
              ) {
                const parts = url.pathname
                  .slice('/api/workbench/documents'.length)
                  .split('/')
                  .filter(Boolean);
                let operation, input;
                if (!parts.length) {
                  operation =
                    req.method === 'GET' ? 'documents' : 'document-create';
                  input =
                    req.method === 'GET' ? { kind: 'scene' } : await body(req);
                } else {
                  const id = decodeURIComponent(parts[0]);
                  if (!blankDocumentId && id !== scene.id && /^scene-[0-9a-f-]{36}$/.test(id)) blankDocumentId = id;
                  assert.ok(id === scene.id || id === blankDocumentId, 'only this run’s two scenes are exposed');
                  operation =
                    req.method === 'GET'
                      ? 'document-get'
                      : `document-${parts[1]}`;
                  input = {
                    ...(req.method === 'GET' ? {} : await body(req)),
                    documentId: id,
                    ...(url.searchParams.has('revision')
                      ? { revision: Number(url.searchParams.get('revision')) }
                      : {}),
                    ...(url.searchParams.has('metadataOnly')
                      ? { metadataOnly: true }
                      : {}),
                  };
                }
                sendJson(
                  res,
                  200,
                  await documentRequest(root, manifest, operation, input, { media: url.searchParams.get('media') === 'references' ? 'references' : 'embedded' }),
                );
                return;
              }
              sendJson(res, 503, {
                error:
                  'This isolated browser harness exposes only the fixture scene and local split.',
              });
            } catch (error) {
              sendJson(res, error.status || 400, {
                error: error.message,
                code: error.code,
              });
            }
          });
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  const address = `http://127.0.0.1:${vite.httpServer.address().port}/tools/scene-composer?document=${scene.id}`;
  chrome = spawn(
    process.env.CHROME_BIN ||
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-sync',
      '--no-first-run',
      '--disable-extensions',
      '--disable-component-update',
      '--remote-debugging-port=0',
      '--window-size=1500,1000',
      '--user-data-dir=' + profile,
      address.split('?')[0],
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let chromeLog = '';
  chrome.stderr.on('data', (chunk) => {
    chromeLog = (chromeLog + chunk).slice(-3000);
  });
  chrome.on('error', (error) => browserErrors.push(error.message));
  let debugPort;
  for (let i = 0; i < 200; i++) {
    try {
      debugPort = (
        await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
      ).split('\n')[0];
      break;
    } catch {
      await delay(100);
    }
  }
  if (!debugPort)
    throw new Error(
      `Isolated Chrome did not expose a debug port (exit=${chrome.exitCode}): ${chromeLog} ${browserErrors.join('; ')}`,
    );
  let target;
  for (let i = 0; i < 100; i++) {
    const targets = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json();
    target = targets.find(
      (tab) => tab.type === 'page' && tab.url.includes('/tools/scene-composer'),
    );
    if (target) break;
    await delay(100);
  }
  if (!target) throw new Error('Fixture page not found in isolated browser.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  let serial = 0;
  const waiting = new Map();
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(event.data);
    if (value.method === 'Runtime.exceptionThrown')
      browserErrors.push(
        value.params.exceptionDetails.exception?.description ||
          value.params.exceptionDetails.text,
      );
    if (!value.id) return;
    const pending = waiting.get(value.id);
    if (!pending) return;
    waiting.delete(value.id);
    if (value.error) pending.reject(new Error(JSON.stringify(value.error)));
    else pending.resolve(value.result);
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Chrome command timed out: ${method}`));
      }, 15000);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  const waitFor = async (expression, label, timeout = 90000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(150);
    }
    throw new Error(
      `${label}: ${await evaluate('document.body.innerText')}\n${browserErrors.join('\n')}`,
    );
  };
  const click = async (text) => {
    const literal = JSON.stringify(text);
    await waitFor(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${literal}&&!b.disabled)`,
      'Button unavailable: ' + text,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${literal}&&!b.disabled).click()`,
    );
  };
  const fill = async (selector, value) =>
    evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Field absent');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  const screenshot = async (name) => {
    const shot = await cdp('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(path.join(out, name), Buffer.from(shot.data, 'base64'));
  };
  captureFailure = () => screenshot('failure.png');
  await click('场景协作');
  await waitFor("document.querySelector('.sw-dialog')", 'First click starts collaboration from a fresh empty scene');
  assert.ok(blankDocumentId);
  const empty = await getDocument(root, manifest, { documentId: blankDocumentId });
  assert.equal(empty.document.content.map, null);
  await cdp('Page.navigate', { url: address });
  await waitFor(`location.search.includes(${JSON.stringify(scene.id)}) && document.querySelector('[data-scene-composer]')`, 'Open map fixture');
  await click('交互预览');
  await waitFor("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('· E'))", 'Speaker in range');
  const pressE = () => evaluate("document.querySelector('.sc-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'e',code:'KeyE',bubbles:true}))");
  await pressE();
  await waitFor("document.querySelector('.sc-dialogue')?.textContent.includes('第一页按键检查')", 'Lowercase e starts the conversation');
  await pressE();
  await waitFor("document.querySelector('.sc-dialogue')?.textContent.includes('第二页按键检查')", 'The same key advances dialogue');
  const previewBaseline = (await getDocument(root, manifest, { documentId: scene.id })).document;
  await documentRequest(root, manifest, 'document-apply', { documentId: scene.id, expectedRevision: previewBaseline.revision,
    commandId: 'browser-preview-remote', commands: [{ type: 'move-instances', ids: [scene.instances[0].id], dx: 1 }] });
  await delay(5500);
  assert.ok(await evaluate("document.querySelector('.sc-dialogue')?.textContent.includes('第二页按键检查')"), 'remote edits do not rebuild an active preview');
  assert.ok(await evaluate("Array.from(document.querySelectorAll('.sc-canvas image')).every(image=>image.getAttribute('href').startsWith('blob:'))"), 'actual scene art renders from verified local blobs');
  await click('退出预览');
  await waitFor(`document.querySelector('.wb-document-sync')?.textContent.includes('版本 ${previewBaseline.revision + 1}')`, 'Preview exit accepts the new saved revision');
  console.log('Browser fixture loaded; checking the actual one-click UI.');
  await click('一键地图粗分');
  await waitFor(
    "document.querySelector('.sc-split-objects .sc-split-object') && document.querySelectorAll('.sc-split-compare image').length===2",
    'Local candidate preview',
  );
  await screenshot('01-local-candidate.png');
  assert.equal(
    transientStatusFailures,
    1,
    'Polling recovered from one failed read without another generation.',
  );
  console.log(
    'Local candidate and source pixels rendered; correcting one object.',
  );
  const draft = JSON.parse(
    await evaluate(
      'document.querySelector(\'textarea[aria-label="原像素分层对象JSON"]\').value',
    ),
  );
  assert(draft.length > 0);
  const editedId = draft[0].id;
  draft.forEach((spec) => {
    spec.name = '网页修订树';
  });
  await fill(
    'textarea[aria-label="原像素分层对象JSON"]',
    JSON.stringify(draft, null, 2),
  );
  await click('保存这些对象的修订');
  await waitFor(
    "document.querySelector('.sc-split-objects')?.textContent.includes('网页修订树') && document.body.innerText.includes('· v2 ·')",
    'Exact candidate revision after UI correction',
  );
  await screenshot('02-revised-candidate.png');
  console.log(
    'Corrected candidate v2 rendered; adopting it into the saved scene.',
  );
  await click('采用此未经核验候选');
  await waitFor(
    "document.body.innerText.includes('已采用此候选')",
    'Adoption into the shared scene',
  );
  await click('返回场景');
  await waitFor(
    "!document.querySelector('.sc-split-modal') && Array.from(document.querySelectorAll('.sc-node-name')).some(e=>e.textContent.includes('网页修订树'))",
    'Independent adopted node',
  );
  const adoptedRevision = (await getDocument(root, manifest, { documentId: scene.id })).document.revision;
  await evaluate("document.querySelector('.sc-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true}))");
  await waitFor("!Array.from(document.querySelectorAll('.sc-node-name')).some(e=>e.textContent.includes('网页修订树'))", 'Adoption can be undone');
  await waitFor(`document.querySelector('.wb-document-sync')?.textContent.includes('版本 ${adoptedRevision + 1}')`, 'Adoption undo commits through shared CAS');
  await evaluate("document.querySelector('.sc-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,shiftKey:true,bubbles:true}))");
  await waitFor("Array.from(document.querySelectorAll('.sc-node-name')).some(e=>e.textContent.includes('网页修订树'))", 'Adoption redo restores the exact split');
  await waitFor(`document.querySelector('.wb-document-sync')?.textContent.includes('版本 ${adoptedRevision + 2}')`, 'Adoption redo commits through shared CAS');
  await evaluate(
    "Array.from(document.querySelectorAll('.sc-node-name')).find(e=>e.textContent.includes('网页修订树')).click()",
  );
  await waitFor(
    'document.querySelector(\'input[aria-label="地图内 X"]\')',
    'Independent element inspector',
  );
  const previousX = Number(
    await evaluate(
      'document.querySelector(\'input[aria-label="地图内 X"]\').value',
    ),
  );
  await evaluate(
    "document.querySelector('svg.sc-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true}))",
  );
  await waitFor(
    `Number(document.querySelector('input[aria-label="地图内 X"]').value)===${previousX + 1}`,
    'Independent object movement',
  );
  await screenshot('03-independent-element.png');
  await waitFor(
    "document.querySelector('.sc-footer')?.textContent.includes('本机已保存')",
    'Local scene persistence',
  );
  await delay(1600);
  const saved = await getDocument(root, manifest, { documentId: scene.id });
  assert.equal(
    saved.document.content.mapSplit.elements.find(
      (element) => element.id === editedId,
    ).x,
    previousX + 1,
  );
  assert.equal(
    saved.document.content.mapSplit.elements.find(
      (element) => element.id === editedId,
    ).name,
    '网页修订树',
  );
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Fixture reload timed out.')),
      15000,
    );
    const listener = (event) => {
      if (JSON.parse(event.data).method === 'Page.loadEventFired') {
        clearTimeout(timer);
        socket.removeEventListener('message', listener);
        resolve();
      }
    };
    socket.addEventListener('message', listener);
  });
  const downloadsBeforeReload = mediaDownloads;
  mediaAvailable = false;
  await cdp('Page.reload');
  await loaded;
  await waitFor(
    "Array.from(document.querySelectorAll('.sc-tabs button')).some(e=>e.textContent.includes('场景节点'))",
    'Reloaded editor tabs',
  );
  await evaluate(
    "Array.from(document.querySelectorAll('.sc-tabs button')).find(e=>e.textContent.includes('场景节点')).click()",
  );
  await waitFor(
    "Array.from(document.querySelectorAll('.sc-node-name')).some(e=>e.textContent.includes('网页修订树'))",
    'Reload retains stable independent node',
  );
  await evaluate(
    "Array.from(document.querySelectorAll('.sc-node-name')).find(e=>e.textContent.includes('网页修订树')).click()",
  );
  await waitFor(
    `Number(document.querySelector('input[aria-label="地图内 X"]')?.value)===${previousX + 1}`,
    'Reload retains object move',
  );
  await screenshot('04-refreshed-scene.png');
  assert.equal(mediaDownloads, downloadsBeforeReload, 'saved drafts and undo artwork reload without binary network requests');
  assert.ok(await evaluate("Array.from(document.querySelectorAll('.sc-canvas image')).every(image=>image.getAttribute('href').startsWith('blob:'))"));
  mediaAvailable = true;
  await click('分层候选 / 恢复');
  await waitFor(
    "document.querySelector('.sc-split-modal')?.textContent.includes('网页修订树')",
    'Candidate recovery entry',
  );
  assert.equal(
    calls.filter((call) => call.operation === 'prepare').length,
    1,
    'opening saved candidates does not start inference',
  );
  assert.equal(calls.filter((call) => call.operation === 'revise').length, 1);
  assert.equal(calls.filter((call) => call.operation === 'adopt').length, 1);
  const currentCandidate = await evaluate("document.querySelector('select[aria-label=\"分层候选记录\"]').value");
  const another = await sceneSplitRequest(root, manifest, 'scene-split-prepare', {
    documentId: scene.id, expectedRevision: saved.document.revision, commandId: 'race-second-candidate',
    mode: 'local', specs: draft,
  });
  await click('查询候选记录');
  const selector = 'select[aria-label="分层候选记录"]';
  const choose = id => evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).some(o=>o.value===${JSON.stringify(another.candidate.candidateId)})`, 'Both candidates listed');
  heldCandidateRead = { id: another.candidate.candidateId, entered: Promise.withResolvers(), release: Promise.withResolvers() };
  await choose(heldCandidateRead.id);
  await Promise.race([heldCandidateRead.entered.promise, delay(10000).then(() => { throw new Error('Delayed candidate request did not arrive'); })]);
  await choose(currentCandidate);
  const draftSelector = 'textarea[aria-label="原像素分层对象JSON"]';
  await waitFor(`document.querySelector(${JSON.stringify(draftSelector)})`, 'Newer selection loaded');
  await fill(draftSelector, '正在编辑的候选草稿');
  heldCandidateRead.release.resolve();
  heldCandidateRead = null;
  await delay(450);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draftSelector)}).value`), '正在编辑的候选草稿');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), currentCandidate);
  // The real page and the Agent share deletion/ownership helpers. An ownership
  // transfer made after adoption must survive deletion without reviving the map
  // body; explicitly releasing it first must return blocking to the map.
  await click('返回场景');
  await waitFor(
    "!document.querySelector('.sc-split-modal')",
    'Returned to ownership inspector',
  );
  await evaluate(
    "Array.from(document.querySelectorAll('.sc-node-name')).find(e=>e.textContent.includes('网页修订树')).click()",
  );
  const collisionCheckbox = 'input[aria-label="接管地图碰撞区域 1"]';
  await waitFor(
    `document.querySelector(${JSON.stringify(collisionCheckbox)})`,
    'Late collision transfer control',
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(collisionCheckbox)}).click()`,
  );
  const waitDocument = async (predicate, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = (
        await getDocument(root, manifest, { documentId: scene.id })
      ).document;
      if (predicate(current.content)) return current;
      await delay(150);
    }
    throw new Error(label);
  };
  await waitDocument(
    (content) =>
      content.mapSplit.elements
        .find((element) => element.id === editedId)
        ?.collision.mapIndices.includes(0),
    'Browser transfer was not saved',
  );
  await click('删除此分层对象');
  const removed = await waitDocument(
    (content) =>
      content.mapSplit.deletedMapCollisions?.some(
        (entry) => entry.elementId === editedId && entry.mapIndices.includes(0),
      ),
    'Browser delete lost late ownership',
  );
  assert.deepEqual(activeMapCollisions(removed.content), []);
  assert.deepEqual(
    removed.content.mapSplit.baseline.find((element) => element.id === editedId)
      .collision.mapIndices,
    [],
  );
  await screenshot('05-late-owner-deleted.png');
  await waitFor(
    '!document.querySelector(\'button[aria-label="撤销场景修改"]\').disabled',
    'Undo deletion is available',
  );
  await evaluate(
    'document.querySelector(\'button[aria-label="撤销场景修改"]\').click()',
  );
  await waitDocument(
    (content) =>
      content.mapSplit.elements
        .find((element) => element.id === editedId)
        ?.collision.mapIndices.includes(0),
    'Undo did not restore transferred owner',
  );
  await evaluate(
    "Array.from(document.querySelectorAll('.sc-node-name')).find(e=>e.textContent.includes('网页修订树')).click()",
  );
  await waitFor(
    `document.querySelector(${JSON.stringify(collisionCheckbox)})?.checked`,
    'Restored ownership checkbox',
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(collisionCheckbox)}).click()`,
  );
  await waitDocument(
    (content) =>
      content.mapSplit.elements.find((element) => element.id === editedId)
        ?.collision.mapIndices.length === 0,
    'Explicit release was not saved',
  );
  await click('删除此分层对象');
  const released = await waitDocument(
    (content) =>
      content.mapSplit.deletedMapCollisions?.some(
        (entry) =>
          entry.elementId === editedId && entry.mapIndices.length === 0,
      ),
    'Released deletion did not save its empty ownership record',
  );
  assert.deepEqual(
    activeMapCollisions(released.content).map((entry) => entry.index),
    [0],
  );
  await screenshot('06-explicit-release-deleted.png');
  assert.deepEqual(browserErrors, []);
  await writeFile(
    path.join(out, 'receipt.json'),
    JSON.stringify(
      {
        documentId: scene.id,
        editedId,
        calls: calls.map((call) => ({
          operation: call.operation,
          commandId: call.input.commandId,
        })),
        screenshots: [
          '01-local-candidate.png',
          '02-revised-candidate.png',
          '03-independent-element.png',
          '04-refreshed-scene.png',
          '05-late-owner-deleted.png',
          '06-explicit-release-deleted.png',
        ],
        lateTransferDeletion: true,
        explicitReleaseDeletion: true,
        previewBlocksRemote: true,
        adoptionUndoRedo: true,
        offlineMediaReload: true,
        paidCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      browser: 'isolated headless Chrome',
      passed:
        'local coarse → original-pixel JSON correction → exact candidate adoption → independent node move → refresh and candidate recovery → late collision transfer/delete → undo/release/delete',
      documentId: scene.id,
      output: out,
      paidCalls: 0,
    }),
  );
} catch (error) {
  await captureFailure?.().catch(() => {});
  throw error;
} finally {
  socket?.close();
  chrome?.kill();
  await vite?.close();
}
