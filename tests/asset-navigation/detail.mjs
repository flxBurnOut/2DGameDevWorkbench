import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as contract from '../../lib/workbench/asset-import-contract.mjs';

const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(code, modules, globals = {}) {
  const context = {
    exports: {}, URL, URLSearchParams, ...globals,
    require(name) { assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name]; },
  };
  runInNewContext(code, context);
  return context.exports;
}
const manifest = JSON.parse(await readFile(new URL('../../lib/workbench/ui-manifest.json', import.meta.url), 'utf8'));
const imports = load(await compile('../../lib/workbench/asset-import.ts'), {
  './ui-manifest.json': { default: manifest },
  './browser-store': {},
  './asset-import-contract.mjs': contract,
});
const navigation = load(await compile('../../lib/workbench/asset-navigation.ts'), {});
const component = await compile('../../components/workbench/asset-library.tsx');
const jsx = (type, props, key) => ({ type, props, key });

// Keep the real import contract and link validation. Only hooks and unrelated
// child components are fixtures; rendering makes no network/storage requests.
function renderDetail(asset) {
  const state = [true, false, [], '', '', '', { offset: 0, snapshot: '' }, 0, false,
    null, asset.id, asset, [], 'active', null, false, '', false, '', [], null, null];
  let nextState = 0;
  const { AssetLibrary } = load(component, {
    react: { useState: () => [state[nextState++], () => {}], useRef: () => ({ current: null }), useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@/components/ui/toast': { toast: {} },
    '@/lib/workbench/asset-navigation': navigation,
    './lazy-dialogs': { AssetPackageImport: 'AssetPackageImport' },
    '@/lib/workbench/godot-export': { offerGodotExport() {} },
    '@/lib/workbench/asset-import': imports,
    '@/lib/workbench/work-items': { operationLabel: () => '制作' },
    '@/components/ui/native-select': { NativeSelect: 'NativeSelect', NativeSelectOption: 'NativeSelectOption' },
    '@/components/image-edit/lazy-image-edit-workspace': { ImageEditWorkspace: 'ImageEditWorkspace' },
    '@/features/image-edit/navigation': {},
  });
  const nodes = [];
  const visit = node => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    visit(node.props?.children);
  };
  visit(AssetLibrary());
  return nodes;
}
const base = {
  title: '隔离角色素材', statusLabel: '已保存', availability: 'available', previewKind: 'image',
  previewUrl: '/api/workbench/assets/preview?fixture=character', viewPath: '/assets',
  origin: 'sprite-pipeline', readiness: { issues: [] },
};
for (const [extension, primaryMime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif']]) {
  const asset = { ...base, id: `character:fixture_${extension}`, kind: 'character', primaryMime,
    editorPath: `/tools/sprite-generator?character=fixture_${extension}` };
  const nodes = renderDetail(asset);
  assert.ok(!nodes.some(node => node.type === 'a' && node.props.children === '用作角色参考'), 'An unsupported manifest target is never evaluated during detail rendering');
  assert.ok(nodes.some(node => node.type === 'img' && node.props.src === asset.previewUrl), `${extension} preview remains visible`);
  assert.ok(nodes.some(node => node.type === 'button' && node.props.children === '下载素材（ZIP）' && !node.props.disabled), `${extension} download remains enabled`);
  const appearance = nodes.find(node => node.type === 'a' && node.props.children === '用于交互物外观');
  assert.equal(Boolean(appearance), extension !== 'gif');
  if (appearance) {
    const target = new URL(appearance.props.href, 'http://localhost:3000');
    assert.equal(target.pathname, '/tools/interactable-editor');
    assert.equal(target.searchParams.get('importAsset'), asset.id);
    assert.equal(target.searchParams.get('importPurpose'), 'image');
  }
  const original = nodes.find(node => node.type === 'a' && node.props.children.trim?.() === '在原工具中打开');
  assert.ok(original, 'The source tool link remains available');
  const originalUrl = new URL(original.props.href, 'http://localhost:3000');
  assert.equal(originalUrl.pathname, '/tools/sprite-generator');
  assert.equal(originalUrl.searchParams.get('character'), `fixture_${extension}`);
  assert.equal(new URL(originalUrl.searchParams.get('returnTo'), originalUrl).searchParams.get('asset'), asset.id);
}
const project = { ...base, id: 'interactable:fixture', kind: 'interactable' };
const projectLink = renderDetail(project).find(node => node.type === 'a' && node.props.children === '编辑交互物项目');
assert.ok(projectLink, 'Existing project import remains available');
assert.equal(new URL(projectLink.props.href, 'http://localhost:3000').searchParams.get('importPurpose'), 'interactable');
assert.throws(() => imports.importLink('reference-art', 'image', 'character:fixture'), /不支持的导入目标/, 'The manifest capability itself is unchanged');
console.log('Asset details: PNG/JPEG/WebP/GIF character rendering, supported appearance/project imports, GIF preview/download and original tool links passed with the real import module and manifest.');
