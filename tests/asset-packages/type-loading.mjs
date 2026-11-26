import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registeredAssetKinds } from '../../lib/workbench/asset-type-registry.mjs';
import { ASSET_KINDS, assetInputs } from '../../lib/workbench/asset-contract.mjs';
import { packageKinds } from '../../lib/workbench/asset-package-contract.mjs';
import { inspectAssetPackage, commitAssetPackages } from '../../lib/workbench/asset-packages.mjs';
import { createProject, createObject } from '../../features/interactable-editor/contract.mjs';

assert.deepEqual(registeredAssetKinds, ['character', 'prop', 'animation', 'interactable']);
assert.deepEqual(ASSET_KINDS, registeredAssetKinds);
assert.deepEqual(packageKinds, registeredAssetKinds);
for (const kind of registeredAssetKinds) assert.equal(assetInputs.assets.parse({ kind }).kind, kind);
assert.throws(() => assetInputs.assets.parse({ kind: 'unsupported' }));
const root = await mkdtemp(path.join(os.tmpdir(), 'forge-retained-package-'));
const manifest = { workspace: { importedAssetDirectory: 'assets', packageImportDirectory: 'imports' } };
try {
  const project = createProject();
  project.objects = [createObject('inspect')];
  const inspection = await inspectAssetPackage(root, manifest, {
    bytes: Buffer.from(JSON.stringify(project)), filename: 'interactable-project.json',
  });
  assert.equal(inspection.candidates[0].kind, 'interactable');
  assert.equal(inspection.candidates[0].status, 'editable');
  const result = await commitAssetPackages(root, manifest, {
    commandId: 'retained-only',
    selections: [{ inspectionId: inspection.inspectionId, candidateId: inspection.candidates[0].id }],
  });
  assert.equal(result.importedCount, 1);
} finally { await rm(root, { recursive: true, force: true }); }
console.log('Retained asset kinds share one contract and interactable package import/commit remains available.');
