import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const component = await compile('../../components/reference-art/reference-art-editor.tsx');
const identity = { exports: {} };
runInNewContext(await compile('../../components/sprite-generator/character-identity.ts'), identity);
const jsx = (type, props, key) => ({ type, props, key });
const task = (id, status = 'completed') => ({
  id, capabilityId: 'reference-art', status,
  input: { operation: 'generate', name: `角色 ${id}`, prompt: `描述 ${id}`, facing: 'right', size: 128 },
  outputs: status === 'completed' ? [`outputs/${id}/reference.png`] : [],
});
const a = task('a'), b = task('b'), c = task('c');
const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

// Execute the real component with persistent hook slots, effect cleanup and
// manually released fetches. Nothing connects to a service or a browser store.
function fixture(initial = a) {
  const slots = [], effects = [], timers = new Map(), requests = [], navigation = [], stateAfterUnmount = [];
  const location = new URL(`http://localhost:3000/tools/reference-art?task=${initial.id}`);
  let cursor = 0, timerId = 0, mounted = true, tree;
  const slot = (create) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = create();
    return slots[index];
  };
  const react = {
    useState(initialValue) {
      const state = slot(() => ({ value: typeof initialValue === 'function' ? initialValue() : initialValue }));
      return [state.value, value => {
        if (!mounted) stateAfterUnmount.push(value);
        state.value = typeof value === 'function' ? value(state.value) : value;
      }];
    },
    useRef(value) { return slot(() => ({ current: value })); },
    useCallback(callback, deps) {
      const memo = slot(() => ({}));
      if (!sameDeps(memo.deps, deps)) { memo.deps = deps; memo.callback = callback; }
      return memo.callback;
    },
    useEffect(callback, deps) {
      const effect = slot(() => ({}));
      if (!sameDeps(effect.deps, deps)) {
        effect.deps = deps;
        effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); });
      }
    },
  };
  const wb = { tasks: [initial, b, c], modules: [{ id: 'sprite-generator', href: '/tools/sprite-generator' }], refresh: () => Promise.resolve(), navigate: async href => { navigation.push(href); } };
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '@/components/workbench/workbench-provider': { useWorkbench: () => wb },
    '@/components/workbench/shared-navigation': { SourceAssetLink: 'SourceAssetLink' },
    '@/components/workbench/lazy-dialogs': { AssetImportPicker: 'AssetImportPicker' },
    '@/lib/workbench/asset-import': { clearImportQuery() {} },
    '@/components/sprite-generator/character-identity-field': { CharacterIdentityField: 'CharacterIdentityField' },
    '@/components/sprite-generator/character-identity': identity.exports,
    '@/components/ui/input': { Input: 'Input' },
    '@/components/ui/textarea': { Textarea: 'Textarea' },
    '@/components/ui/native-select': { NativeSelect: 'NativeSelect', NativeSelectOption: 'NativeSelectOption' },
  };
  const sandbox = {
    exports: {}, URL, URLSearchParams, AbortSignal, location,
    history: { state: null, replaceState(_state, _title, href) { location.href = new URL(href, location).href; } },
    window: { addEventListener() {}, removeEventListener() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options = {}) {
      const absolute = new URL(url, location);
      assert.equal(absolute.origin, 'http://localhost:3000');
      if (absolute.pathname.endsWith('/settings')) return Promise.resolve(Response.json({ configured: true }));
      return new Promise((resolve, reject) => requests.push({
        url: absolute, options, body: options.body ? JSON.parse(options.body) : undefined,
        resolve: value => resolve(Response.json(value)), reject,
      }));
    },
    require(name) { assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name]; },
  };
  runInNewContext(component, sandbox);
  const render = () => {
    cursor = 0;
    tree = sandbox.exports.ReferenceArtEditor();
    effects.splice(0).forEach(effect => effect());
    return tree;
  };
  const all = () => {
    const result = [];
    const visit = node => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      result.push(node);
      visit(node.props?.children);
    };
    visit(tree);
    return result;
  };
  const find = check => { const node = all().find(check); assert.ok(node, 'Expected a rendered control'); return node; };
  const control = id => find(node => node.props?.id === id);
  const generate = () => find(node => node.props?.className?.includes('ra-generate'));
  const transfer = () => find(node => node.type === 'button' && node.props?.children?.[0] === '用于制作序列帧 ');
  const history = id => find(node => node.props?.className === 'ra-history-item' && node.key === id);
  const select = id => { const button = history(id); assert.equal(button.props.disabled, false); button.props.onClick(); render(); };
  const request = (path, method = 'GET') => {
    const found = requests.find(entry => !entry.handled && entry.url.pathname === path && (entry.options.method || 'GET') === method);
    assert.ok(found, `Missing ${method} ${path}`);
    found.handled = true;
    return found;
  };
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); if (mounted) render(); };
  const runTimers = delay => {
    for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
  };
  const isLoading = () => find(node => node.props?.className === 'ra-result').props['aria-busy'];
  const assertLocked = () => {
    for (const id of ['ra-name', 'ra-prompt', 'ra-facing', 'ra-size']) assert.equal(control(id).props.disabled, true, id);
    assert.equal(find(node => node.type === 'CharacterIdentityField').props.disabled, true);
    assert.equal(generate().props.disabled, true);
    assert.equal(transfer().props.disabled, true);
    assert.equal(find(node => node.type === 'button' && node.props?.children === '从资产库选用角色原图').props.disabled, true);
    assert.equal(isLoading(), true);
  };
  const mount = async () => {
    render(); runTimers(0); await flush();
    request(`/api/workbench/tasks/${initial.id}`).resolve({ task: initial });
    await flush();
  };
  const unmount = () => {
    mounted = false;
    slots.forEach(hook => hook.cleanup?.());
  };
  return { mount, render, flush, runTimers, all, control, generate, transfer, history, select, request, isLoading, assertLocked, unmount, stateAfterUnmount, requests, navigation, location };
}

const selection = fixture();
await selection.mount();
assert.equal(selection.generate().props.disabled, false);
const earlyGenerate = selection.generate(), earlyTransfer = selection.transfer();
selection.history('b').props.onClick();
earlyGenerate.props.onClick(); earlyTransfer.props.onClick();
selection.render();
selection.assertLocked();
await assert.rejects(selection.all().find(node => node.type === 'AssetImportPicker').props.onImport({}), /请等待当前操作完成/);
assert.equal(selection.requests.filter(entry => entry.options.method === 'POST').length, 0, 'The synchronous selection guard also blocks handlers from the preceding render');
const oldB = selection.request('/api/workbench/tasks/b');
selection.select('c');
oldB.resolve({ task: b }); await selection.flush();
selection.assertLocked();
assert.equal(selection.control('ra-prompt').props.value, a.input.prompt, 'A superseded response neither changes the form nor unlocks the current request');
selection.request('/api/workbench/tasks/c').resolve({ task: c }); await selection.flush();
assert.equal(selection.isLoading(), false);
assert.equal(selection.control('ra-prompt').props.value, c.input.prompt);
selection.select('b');
const obsoleteFailure = selection.request('/api/workbench/tasks/b');
selection.select('c');
obsoleteFailure.reject(new Error('obsolete selection failure')); await selection.flush();
selection.assertLocked();
assert.ok(!selection.all().some(node => node.props?.children === 'obsolete selection failure'));
selection.request('/api/workbench/tasks/c').resolve({ task: c }); await selection.flush();
selection.select('b');
selection.request('/api/workbench/tasks/b').reject(new Error('fixture selection failed')); await selection.flush();
assert.equal(selection.isLoading(), false);
assert.equal(selection.control('ra-prompt').props.disabled, false);
assert.equal(selection.control('ra-prompt').props.value, c.input.prompt);
assert.ok(selection.all().some(node => node.props?.children === 'fixture selection failed'));
selection.generate().props.onClick(); selection.render();
const recovered = selection.request('/api/workbench/tasks', 'POST');
assert.equal(recovered.body.input.prompt, c.input.prompt, 'A failed selection releases the synchronous action guard too');
recovered.reject(new Error('fixture submission failed')); await selection.flush();
selection.select('b');
const unmountedB = selection.request('/api/workbench/tasks/b');
selection.select('c');
const unmountedC = selection.request('/api/workbench/tasks/c');
const beforeUnmount = selection.location.href;
selection.unmount(); unmountedB.resolve({ task: b }); unmountedC.reject(new Error('unmounted selection failed')); await selection.flush();
assert.equal(selection.stateAfterUnmount.length, 0, 'An unmounted selection cannot write state, including busy or selectionLoading');
assert.equal(selection.location.href, beforeUnmount);

const generating = fixture();
await generating.mount();
const staleHistory = generating.history('b');
generating.generate().props.onClick(); generating.render();
assert.equal(generating.history('b').props.disabled, true);
const readsBefore = generating.requests.length;
staleHistory.props.onClick();
assert.equal(generating.requests.length, readsBefore, 'History cannot replace a submission that is already busy');
const generation = generating.request('/api/workbench/tasks', 'POST');
assert.equal(generation.body.input.operation, 'generate');
assert.equal(generation.body.input.prompt, a.input.prompt);
assert.equal(generation.options.signal.aborted, false);
generation.resolve({ taskId: 'generated', status: 'running', outputs: [] }); await generating.flush();
assert.equal(generating.isLoading(), true);
assert.equal(generating.history('b').props.disabled, true, 'Loading the original generated task does not end submission busy');
generating.request('/api/workbench/tasks/generated').resolve({ task: task('generated', 'running') }); await generating.flush();
assert.equal(generating.isLoading(), false);
assert.equal(generating.history('b').props.disabled, false);
assert.equal(generating.control('ra-prompt').props.value, a.input.prompt, 'Generation retains the submitted form and selects its original task');
assert.ok(generating.location.searchParams.get('task') === 'generated');
assert.equal(generating.requests.filter(entry => entry.options.method === 'POST').length, 1);
generating.select('b');
generating.runTimers(6000); await generating.flush();
const poll = generating.request('/api/workbench/tasks/generated');
assert.equal(poll.url.searchParams.get('refresh'), 'true');
poll.resolve({ task: task('generated', 'running') }); await generating.flush();
assert.equal(generating.isLoading(), true, 'An existing job poll cannot unlock a history selection');
assert.equal(poll.options.signal.aborted, false);
generating.request('/api/workbench/tasks/b').resolve({ task: b }); await generating.flush();
assert.equal(generating.requests.filter(entry => entry.options.method === 'POST').length, 1, 'Selecting history does not cancel or resubmit the running job');
generating.unmount();

const transferring = fixture();
await transferring.mount();
transferring.transfer().props.onClick(); transferring.render();
const handoff = transferring.request('/api/workbench/tasks', 'POST');
assert.equal(handoff.body.input.operation, 'transfer');
assert.equal(handoff.body.input.sourceTaskId, a.id);
assert.equal(transferring.history('b').props.disabled, true);
handoff.resolve({ taskId: 'transfer-a', status: 'completed', outputs: ['outputs/transfer-a/result.json'] }); await transferring.flush();
assert.equal(transferring.history('b').props.disabled, true);
transferring.request('/api/workbench/artifacts').resolve({ characterId: `reference_${'a'.repeat(24)}` }); await transferring.flush();
assert.equal(transferring.navigation.length, 1);
assert.equal(transferring.navigation[0], `/tools/sprite-generator?character=reference_${'a'.repeat(24)}`);
assert.equal(transferring.requests.filter(entry => entry.options.method === 'POST').length, 1);
assert.equal(transferring.history('b').props.disabled, false);
transferring.unmount();
console.log('Reference-art selection: loading locks, superseded epochs, failure recovery, unmount cleanup, submission busy, original generation polling and exact transfer source passed. In-memory requests only.');
