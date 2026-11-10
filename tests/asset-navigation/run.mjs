import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createTestViteServer } from '../helpers/vite-server.mjs';
const server = await createTestViteServer({ root: process.cwd(), configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, entries: [] }, logLevel: 'error', resolve: { alias: { '@': resolve(process.cwd()) } }, server: { middlewareMode: true } });
try {
  const { readAssetLocation, assetLocationHref } = await server.ssrLoadModule('/lib/workbench/asset-navigation.ts');
  const state = { query: '树林 & 石头', kind: 'map', scope: 'trashed', offset: 24, snapshot: 'stable-v2', asset: '' };
  const list = assetLocationHref(state);
  assert.deepEqual(readAssetLocation(list.split('?')[1]), state);
  const detail = assetLocationHref({ ...state, asset: 'map:one/a&b' });
  assert.deepEqual(readAssetLocation(detail.split('?')[1]), { ...state, asset: 'map:one/a&b' });
  assert.equal(assetLocationHref({ ...readAssetLocation(detail.split('?')[1]), asset: '' }), list, 'Returning from details preserves all browsing conditions');
  for (const offset of ['-1', 'NaN', 'Infinity', '1.2', '9007199254740992']) assert.equal(readAssetLocation('?offset=' + offset).offset, 0);
  assert.equal(readAssetLocation('?kind=unknown&scope=unknown').kind, '');
  assert.equal(readAssetLocation('?kind=unknown&scope=unknown').scope, 'active');
  const { importLink, purposesFor, clearImportQuery } = await server.ssrLoadModule('/lib/workbench/asset-import.ts');
  globalThis.location = new URL('http://localhost' + detail);
  const target = new URL(importLink('map-stitcher', 'map', 'map:one/a&b'), location.origin);
  assert.equal(target.searchParams.get('returnTo'), detail);
  assert.equal(target.searchParams.get('importAsset'), 'map:one/a&b');
  assert.throws(() => importLink('map-stitcher', 'animation', 'x'), /不支持/);
  assert.equal(purposesFor({ kind: 'map', origin: 'imported-package', mapType: 'project' }, ['image']).length, 0);
  assert.equal(purposesFor({ kind: 'map', origin: 'imported-package', mapType: 'project' }, ['map']).length, 1);
  globalThis.location = target;
  globalThis.history = { state: {}, replaceState(_state, _title, url) { globalThis.location = new URL(url, location); } };
  clearImportQuery();
  assert.equal(location.searchParams.has('importAsset'), false);
  assert.equal(location.searchParams.get('returnTo'), detail, 'Source return survives successful editor import');
  const { packageSelections, remainingPackageChoices } = await server.ssrLoadModule('/lib/workbench/asset-package-selection.ts');
  const inspections = [{ inspectionId: 'inspect-a', candidates: [
    { id: 'ready', requiredParameters: [], metadata: { fps: 12, loop: true } },
    { id: 'legacy', requiredParameters: [{ key: 'loop' }], metadata: { fps: 8 } },
    { id: 'broken', requiredParameters: [], status: 'incomplete' },
  ] }];
  const choices = { 'inspect-a:ready': { fps: 12, loop: true }, 'inspect-a:legacy': { fps: 8, loop: false } };
  const selections = packageSelections(inspections, ['inspect-a:ready'], choices);
  assert.deepEqual(selections[0].parameters, {}, 'Known metadata is not resubmitted as a user override');
  const remaining = remainingPackageChoices(inspections, ['inspect-a:ready'], choices, { selections });
  assert.deepEqual(remaining.inspections[0].candidates.map(value => value.id), ['legacy', 'broken'], 'Partial success retains unselected and damaged items for later handling');
  assert.equal(remaining.choices['inspect-a:legacy'].loop, false);
  assert.deepEqual(packageSelections(remaining.inspections, ['inspect-a:legacy'], remaining.choices)[0].parameters, { loop: false });
  assert.equal(inspections[0].candidates.length, 3, 'Completion does not mutate inspection snapshots');
  console.log('Asset navigation: URL state, invalid parameters, detail return, source return and map-purpose eligibility passed.');
} finally { delete globalThis.location; delete globalThis.history; await server.close(); }
