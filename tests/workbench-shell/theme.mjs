import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createTestViteServer } from '../helpers/vite-server.mjs';

const server = await createTestViteServer({ root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { '@': resolve(process.cwd()) } }, server: { middlewareMode: true } });
try {
  const { themeBootstrap } = await server.ssrLoadModule('/lib/workbench/theme.ts');
  const bootstrap = (saved, light, blocked = false) => {
    const classes = new Set();
    const document = { documentElement: { dataset: {}, classList: { toggle: (name, value) => value ? classes.add(name) : classes.delete(name) } } };
    runInNewContext(themeBootstrap, { document, localStorage: { getItem: () => { if (blocked) throw new Error('blocked'); return saved; } }, matchMedia: () => ({ matches: light }) });
    return [document.documentElement.dataset.theme, classes.has('dark')];
  };
  assert.deepEqual(bootstrap('dark', true), ['dark', true]);
  assert.deepEqual(bootstrap('light', false), ['light', false]);
  assert.deepEqual(bootstrap('invalid', true), ['light', false]);
  assert.deepEqual(bootstrap(null, false, true), ['dark', true]);

  const script = await readFile('Tools/SpritePipeline/sprite_pipeline/static/theme.js', 'utf8');
  const events = new Map();
  const root = { dataset: {}, classList: { toggle() {} } };
  const parent = { postMessage() {} };
  const notifications = [];
  const child = { contentWindow: { postMessage: (message, origin) => notifications.push([message, origin]) }, src: 'http://127.0.0.1:7860/pixel-editor' };
  const playerMessages = [];
  const player = { contentWindow: { postMessage: (message, origin) => playerMessages.push([message, origin]) }, src: 'http://127.0.0.1:7860/animation-player?job=example' };
  const frames = [child];
  let mounted;
  const document = { documentElement: root, body: root, readyState: 'complete', getElementById: () => null, querySelectorAll: selector => selector === '.pixel-editor-frame, .animation-player-frame' ? frames : [], addEventListener() {} };
  const window = { parent, addEventListener: (name, fn) => events.set(name, fn), dispatchEvent() {} };
  const localStorage = { getItem: () => 'dark', setItem: () => { throw new Error('Embedded theme must not write data'); } };
  runInNewContext(script, { document, window, localStorage, location: { origin: 'http://127.0.0.1:7860', href: 'http://127.0.0.1:7860/', search: '?workbench_embedded=1&workbench_origin=http://localhost:3000&workbench_theme=light' }, URL, URLSearchParams, Event, matchMedia: () => ({ matches: false, addEventListener() {} }), MutationObserver: class { constructor(callback) { mounted = callback; } observe() {} } });
  assert.equal(root.dataset.theme, 'light');
  const message = events.get('message');
  message({ source: {}, origin: 'http://localhost:3000', data: { type: 'workbench:theme', theme: 'dark' } });
  message({ source: parent, origin: 'https://untrusted.example', data: { type: 'workbench:theme', theme: 'dark' } });
  message({ source: parent, origin: 'http://localhost:3000', data: { type: 'workbench:theme', theme: 'invalid' } });
  assert.equal(root.dataset.theme, 'light');
  message({ source: parent, origin: 'http://localhost:3000', data: { type: 'workbench:theme', theme: 'dark' } });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(notifications.at(-1)[0].theme, 'dark');
  assert.equal(notifications.at(-1)[1], 'http://127.0.0.1:7860');
  assert.equal(child.src, 'http://127.0.0.1:7860/pixel-editor');

  frames.push(player);
  mounted([{ addedNodes: [{ nodeType: 1, matches: selector => selector.includes('.animation-player-frame') }] }]);
  assert.equal(playerMessages.at(-1)[0].theme, 'dark');
  const beforeReady = playerMessages.length;
  message({ source: player.contentWindow, origin: 'https://untrusted.example', data: { type: 'workbench:theme-ready' } });
  assert.equal(playerMessages.length, beforeReady);
  message({ source: player.contentWindow, origin: 'http://127.0.0.1:7860', data: { type: 'workbench:theme-ready' } });
  assert.equal(playerMessages.length, beforeReady + 1);
  message({ source: parent, origin: 'http://localhost:3000', data: { type: 'workbench:theme', theme: 'light' } });
  assert.equal(playerMessages.at(-1)[0].theme, 'light');
  assert.equal(player.src, 'http://127.0.0.1:7860/animation-player?job=example');

  const palette = JSON.parse(await readFile('lib/workbench/theme-palette.json', 'utf8'));
  const luminance = value => value.slice(1).match(/../g).slice(0, 3).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, index) => sum + x * [.2126, .7152, .0722][index], 0);
  for (const [fg, bg] of [['text', 'panel'], ['muted', 'bg'], ['placeholder', 'panel'], ['on-primary', 'primary'], ['on-primary', 'cyan-strong'], ['accent', 'accent-soft'], ['cyan', 'cyan-soft'], ['success', 'success-soft'], ['warning', 'warning-soft'], ['danger', 'danger-soft']]) {
    for (const mode of [0, 1]) {
      const [low, high] = [luminance(palette[fg][mode]), luminance(palette[bg][mode])].sort((a,b) => a-b);
      assert.ok((high+.05)/(low+.05) >= 4.5, `${fg}/${bg} mode=${mode} contrast`);
    }
  }
  assert.equal(await readFile('app/theme-tokens.css','utf8'), await readFile('Tools/SpritePipeline/sprite_pipeline/static/theme-tokens.css','utf8'));
  console.log('PASS initial preference, blocked storage, trusted nested theme sync without navigation, both palettes contrast, shared generated tokens');
} finally { await server.close(); }
