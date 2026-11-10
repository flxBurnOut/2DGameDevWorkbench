import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createImportFixtures } from '../asset-import/fixtures.mjs';
import { mapProjectFixture } from '../helpers/map-project.mjs';
import { loadManifest, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { saveMapProject } from '../../lib/workbench/map-projects.mjs';
import { readMapProjectPackage } from '../../features/map-stitcher/project-package.mjs';
import { readScenePackage } from '../../features/scene-composer/package.mjs';
import { createObject } from '../../features/interactable-editor/contract.mjs';
import { buildAssetArchive, buildAssetImport, getAsset, listAssets, manageAssets, readAssetPreview, readAssetGodotPackage } from '../../lib/workbench/asset-catalog.mjs';
import { inspectAssetPackage, commitAssetPackages } from '../../lib/workbench/asset-packages.mjs';
import { listImportedAssets, resolveImportedAssetFile } from '../../lib/workbench/asset-packages-store.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceRun = process.env.WORKBENCH_TEST_RUN;
const fixture = await createImportFixtures();
let closed = false;
try {
  const project = await mapProjectFixture(await sharp(fixture.png).resize(16, 16).png().toBuffer());
  await saveMapProject(repositoryRoot, fixture.manifest, project.draft.id, 0, project.bytes);
  const ids = [...Object.values(fixture.ids), `map-project:${project.draft.id}`];
  const download = await buildAssetArchive(fixture.manifest, { assetIds: ids });
  const zip = await JSZip.loadAsync(download.bytes);
  const manifest = JSON.parse(await zip.file('forge-assets.json').async('string'));
  assert.equal(manifest.entries.length, 7, 'six kinds plus distinct map project/image');
  assert.equal(manifest.entries.find((entry) => entry.kind === 'animation').metadata.loop, false);
  const animationMetadata = manifest.entries.find((entry) => entry.kind === 'animation').metadata;
  animationMetadata.frameDurations = [1, 2.5];
  animationMetadata.anchor = [64, 120];
  animationMetadata.sourceFacing = 'left';
  zip.file('forge-assets.json', JSON.stringify(manifest));
  const sourceBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  // The destination has no source records or service. All imported bytes must
  // remain usable without fabricating the original producer's job identities.
  await fixture.close(); closed = true;
  process.env.SPRITE_PIPELINE_API_URL = 'http://127.0.0.1:1';
  process.env.WORKBENCH_TEST_RUN = `${sourceRun}-roundtrip`;
  const destination = await loadManifest();
  assert.equal((await listAssets(destination, {})).total, 0);
  const inspected = await inspectAssetPackage(repositoryRoot, destination, { bytes: sourceBytes, filename: 'forge-assets.zip' });
  assert.equal(inspected.candidates.length, 7);
  assert(inspected.candidates.every((candidate) => candidate.status !== 'incomplete'), JSON.stringify(inspected.candidates));
  const request = { commandId: 'catalog-roundtrip', selections: inspected.candidates.map((candidate) => ({ inspectionId: inspected.inspectionId, candidateId: candidate.id, parameters: {} })) };
  const committed = await commitAssetPackages(repositoryRoot, destination, request);
  assert.equal(committed.importedCount, 7);
  assert.deepEqual(await commitAssetPackages(repositoryRoot, destination, request), committed);
  const catalog = await listAssets(destination, { limit: 100 });
  assert.equal(catalog.total, 7);
  assert(catalog.assets.every((asset) => asset.origin === 'imported-package' && asset.engineValidated === false));
  assert.equal(catalog.coverage.nativeAvailable, false);
  assert.equal(catalog.coverage.runtimeRecords, 0);
  const records = await listImportedAssets(repositoryRoot, destination);
  for (const record of records) {
    const asset = (await getAsset(destination, { assetId: record.id })).asset;
    assert.equal(asset.readiness.filesAvailable, true);
    assert.equal(asset.status, 'saved');
    assert.equal(asset.readiness.godotPackageAvailable, false, 'fixture has no authoritative Godot package');
    await assert.rejects(readAssetGodotPackage(destination, { assetId: asset.id, revision: asset.revision }), /Godot 包/);
    const purpose = record.kind === 'map' ? 'map' : record.kind === 'interactable' ? 'interactable' : record.kind === 'scene' ? 'scene' : record.kind === 'animation' ? 'animation' : 'image';
    const reuse = await buildAssetImport(destination, { assetId: asset.id, revision: asset.revision, purpose });
    const importedZip = await JSZip.loadAsync(reuse.bytes);
    const info = JSON.parse(await importedZip.file('import.json').async('string'));
    assert.equal(info.editableCopy.sourceAssetId, asset.id);
    const sourceFile = await importedZip.file(info.files[0].path).async('nodebuffer');
    if (record.kind === 'map' && record.mapType === 'project') {
      const copy = await readMapProjectPackage(sourceFile);
      assert.notEqual(copy.draft.id, project.draft.id);
      assert.deepEqual(copy.draft.snapshot, (await readMapProjectPackage(project.bytes)).draft.snapshot);
      assert.deepEqual(copy.draft.pending, project.draft.pending);
      assert((await readAssetPreview(destination, asset.id)).bytes.length);
    } else if (record.kind === 'interactable') {
      const copy = JSON.parse(sourceFile);
      assert.notEqual(copy.projectId, fixture.project.projectId);
      assert.equal(copy.objects[0].definitionId, fixture.object.definitionId);
      assert.deepEqual(copy.objects[0].behavior, fixture.object.behavior);
      assert((await readAssetPreview(destination, asset.id)).bytes.length);
    } else if (record.kind === 'scene') {
      const copy = await readScenePackage(sourceFile);
      assert.notEqual(copy.id, fixture.scene.id);
      assert.deepEqual(copy.map.collisions, fixture.scene.map.collisions);
    } else if (record.kind === 'animation') {
      assert.equal(info.asset.fps, 12); assert.equal(info.asset.loop, false);
      assert.deepEqual(info.asset.frameDurations, [1, 2.5]);
      assert.deepEqual(info.asset.anchor, [64, 120]);
      assert.equal(info.asset.sourceFacing, 'left');
      assert.deepEqual(sourceFile, fixture.png);
      assert.deepEqual(await importedZip.file(info.files[1].path).async('nodebuffer'), fixture.frame2);
      const preview = await readAssetPreview(destination, asset.id);
      assert.equal(preview.mime, 'image/gif');
      const previewInfo = await sharp(preview.bytes, { animated: true }).metadata();
      assert.equal(previewInfo.pages, 2);
      assert.equal(previewInfo.loop, 1);
      assert(Math.abs(previewInfo.delay[0] - 1000 / 12) <= 10);
      assert(Math.abs(previewInfo.delay[1] - 2500 / 12) <= 10);
    } else assert.deepEqual(sourceFile, fixture.png);
    for (const file of record.files) {
      const bytes = await readFile(await resolveImportedAssetFile(repositoryRoot, record, file.path, destination));
      assert.equal(sha(bytes), file.sha256, 'opening an editable copy must preserve stored bytes');
    }
  }
  const imagePage = await listAssets(destination, { purposes: 'image', limit: 1 });
  assert.equal(imagePage.total, 3, 'server filters eligible pictures before pagination');
  assert.equal(imagePage.assets.length, 1);
  const next = await listAssets(destination, { purposes: ['image'], limit: 2, offset: 1, snapshot: imagePage.snapshot });
  assert.equal(next.assets.length, 2); assert.equal(next.nextOffset, null);
  const projected = await listAssets(destination, { purposes: 'image', mapType: 'project' });
  assert.equal(projected.total, 0, 'map projects cannot masquerade as image sources');
  const downloaded = await buildAssetArchive(destination, { assetIds: records.map((record) => record.id) });
  const again = await JSZip.loadAsync(downloaded.bytes);
  const againManifest = JSON.parse(await again.file('forge-assets.json').async('string'));
  assert.equal(againManifest.entries.length, 7);
  const animationAgain = againManifest.entries.find((entry) => entry.kind === 'animation').metadata;
  assert.deepEqual(animationAgain.frameDurations, [1, 2.5]);
  assert.deepEqual(animationAgain.anchor, [64, 120]);
  assert.equal(animationAgain.sourceFacing, 'left');
  for (const entry of againManifest.entries) for (const file of entry.files) assert.equal(sha(await again.file(file.path).async('nodebuffer')), file.sha256);
  const inspectedAgain = await inspectAssetPackage(repositoryRoot, destination, { bytes: downloaded.bytes, filename: 'forge-assets.zip' });
  assert(inspectedAgain.candidates.every((candidate) => candidate.status !== 'incomplete'), JSON.stringify(inspectedAgain.candidates));
  const reused = await commitAssetPackages(repositoryRoot, destination, { commandId: 'reexport-reimport', selections: inspectedAgain.candidates.map((candidate) => ({ inspectionId: inspectedAgain.inspectionId, candidateId: candidate.id, parameters: {} })) });
  assert.equal(reused.importedCount, 0, 'redownloading/importing unchanged sources must reuse their content');
  assert.equal(reused.reusedCount, 7);
  await manageAssets(destination, { operation: 'trash', assetIds: records.map((record) => record.id) });
  assert.equal((await listAssets(destination, {})).total, 0);
  assert.equal((await listAssets(destination, { scope: 'trashed' })).total, 7);
  await manageAssets(destination, { operation: 'restore', assetIds: records.map((record) => record.id) });
  assert.equal((await listAssets(destination, {})).total, 7);
  const multi = structuredClone(fixture.project);
  multi.objects.push(createObject('toggle'));
  const objectSelection = await inspectAssetPackage(repositoryRoot, destination, { bytes: Buffer.from(JSON.stringify(multi)), filename: 'multi-object.json' });
  assert.equal(objectSelection.candidates[0].status, 'needs-input');
  const only = await commitAssetPackages(repositoryRoot, destination, { commandId: 'selected-object-only', selections: [{ inspectionId: objectSelection.inspectionId, candidateId: objectSelection.candidates[0].id, parameters: { definitionIds: [fixture.object.definitionId] } }] });
  const onlyAsset = (await getAsset(destination, { assetId: only.assets[0].id })).asset;
  const onlyBundle = await JSZip.loadAsync((await buildAssetImport(destination, { assetId: onlyAsset.id, revision: onlyAsset.revision, purpose: 'interactable' })).bytes);
  const onlyInfo = JSON.parse(await onlyBundle.file('import.json').async('string'));
  const editable = JSON.parse(await onlyBundle.file(onlyInfo.files[0].path).async('string'));
  assert.deepEqual(editable.objects.map((object) => object.definitionId), [fixture.object.definitionId]);
  assert.equal(editable.assets.length, multi.assets.length, 'selected object keeps project media dependencies');
  assert.notEqual(editable.projectId, multi.projectId);
  const sheet = await sharp({ create: { width: 256, height: 128, channels: 4, background: '#00000000' } })
    .composite([{ input: fixture.png, left: 0, top: 0 }, { input: fixture.frame2, left: 128, top: 0 }]).png().toBuffer();
  const contract = { format: 'sprite-pipeline-godot', version: 1, animation: 'usable', frame_count: 2, fps: 12, loop: false,
    source_region_px: [[0, 0, 128, 128], [128, 0, 128, 128]], cell_size: [128, 128], anchor: [64, 120], source_facing: 'left',
    sheet_sha256: sha(sheet), job_id: 'exported', candidate_index: 1 };
  const engineBytes = await new JSZip().file('forge_sprites/usable/export.json', JSON.stringify(contract))
    .file('forge_sprites/usable/sprite-sheet.png', sheet).file('forge_sprites/usable/sprite_frames.tres', '[gd_resource type="SpriteFrames" format=3]')
    .generateAsync({ type: 'nodebuffer' });
  const engineInspection = await inspectAssetPackage(repositoryRoot, destination, { bytes: engineBytes, filename: 'known-godot.zip' });
  const engineCommit = await commitAssetPackages(repositoryRoot, destination, { commandId: 'known-godot', selections: [{ inspectionId: engineInspection.inspectionId, candidateId: engineInspection.candidates[0].id }] });
  const engineAsset = (await getAsset(destination, { assetId: engineCommit.assets[0].id })).asset;
  assert.equal(engineAsset.readiness.godotPackageAvailable, true);
  assert.deepEqual((await readAssetGodotPackage(destination, { assetId: engineAsset.id, revision: engineAsset.revision })).bytes, engineBytes);
  console.log('Catalog roundtrip passed: seven assets/six kinds, fresh isolated workspace, offline files/previews/downloads/trash, exact playback, editable identity copies, source byte hashes, and filtering before pagination.');
} finally {
  process.env.WORKBENCH_TEST_RUN = sourceRun;
  if (!closed) await fixture.close();
}
