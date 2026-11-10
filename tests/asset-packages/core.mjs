import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { mapProjectFixture } from '../helpers/map-project.mjs';
import { createProject, createObject } from '../../features/interactable-editor/contract.mjs';
import { createScene, addMaterial, addInstance, replaceMap } from '../../features/scene-composer/model.mjs';
import { createScenePackage } from '../../features/scene-composer/package.mjs';
import { buildSceneGodotPackage } from '../../features/scene-composer/godot-builder.mjs';
import { buildGodotPackage } from '../../features/interactable-editor/godot-builder.mjs';
import { repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { ASSET_PACKAGE_LIMITS } from '../../lib/workbench/asset-package-contract.mjs';
import { inspectAssetPackage, commitAssetPackages, readAssetPackagePreview, readAssetPackageCommit } from '../../lib/workbench/asset-packages.mjs';
import { assetPackageDirectories, assetPackageHash as sha, listImportedAssets, resolveImportedAssetFile, withAssetPackageCommitLock } from '../../lib/workbench/asset-packages-store.mjs';
import { readBoundedAssetZip } from '../../lib/workbench/asset-packages-zip.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'forge-package-core-'));
const manifest = { workspace: { importedAssetDirectory: 'work/imported-assets', packageImportDirectory: 'work/asset-package-imports' } };
const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ab3478' } }).png().toBuffer();
const frame2 = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#127fa4' } }).png().toBuffer();
const zipBytes = zip => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
const inspect = (bytes, filename = 'fixture.zip') => inspectAssetPackage(root, manifest, { bytes, filename });
const commit = (inspected, commandId, parameters = {}) => commitAssetPackages(root, manifest, { commandId, selections: inspected.candidates.filter(item => item.status !== 'incomplete').map(item => ({ inspectionId: inspected.inspectionId, candidateId: item.id, parameters: parameters[item.kind] || {} })) });
try {
  assert.equal(ASSET_PACKAGE_LIMITS.containerExpandedBytes, ASSET_PACKAGE_LIMITS.uploadBytes);
  assert.equal(ASSET_PACKAGE_LIMITS.expandedBytes, 3 * 1024 * 1024 * 1024);
  assert(ASSET_PACKAGE_LIMITS.expandedBytes >= 4 * ASSET_PACKAGE_LIMITS.uploadBytes, 'bounded known nested duplication must fit current maximal downloads');
  const map = await mapProjectFixture(png);
  const project = createProject();
  project.assets = [{ id: 'image', name: 'sprite.png', mime: 'image/png', source: `data:image/png;base64,${png.toString('base64')}` }];
  project.objects = [createObject('toggle'), createObject('pickup')];
  for (const object of project.objects) object.visual.assetId = 'image';
  const rawProject = Buffer.from(JSON.stringify(project));
  const scene = createScene('完整场景');
  replaceMap(scene, { name: '地图', origin: { x: -1, y: 2 }, offset: { x: 0, y: 0 }, layers: [{ id: 'map-overall', name: '整体', source: `data:image/png;base64,${png.toString('base64')}`, width: 16, height: 16, locked: false, hidden: false, included: true }], collisions: [], warnings: [], source: `data:application/zip;base64,${Buffer.from(map.bytes).toString('base64')}` });
  const material = addMaterial(scene, project, project.objects[0].definitionId);
  addInstance(scene, material.id, 12, -2);
  const sceneBytes = await createScenePackage(scene);
  const archive = new JSZip();
  archive.file('character/角色-12345678/reference.png', png);
  archive.file('prop/物品-12345678/prop.png', png);
  archive.file('animation/动作-12345678/frames/frame_010.png', frame2);
  archive.file('animation/动作-12345678/frames/frame_002.png', png);
  archive.file('animation/动作-12345678/素材说明.txt', '播放速度：12 FPS\n');
  archive.file('map/地图-12345678/map-source.zip', map.bytes);
  archive.file('map/合成图-12345678/map.png', png);
  archive.file('interactable/开关-12345678/interactable-project.json', rawProject);
  archive.file('interactable/物件-23456789/interactable-project.json', rawProject);
  archive.file('scene/场景-12345678/scene-source.zip', sceneBytes);
  const broken = structuredClone(project); broken.assets[0].source = 'missing.png';
  archive.file('interactable/损坏-45678900/interactable-project.json', JSON.stringify(broken));
  const inspection = await inspect(await zipBytes(archive), 'forge-assets.zip');
  assert.equal(inspection.candidates.length, 8, 'repeated whole projects group once; broken group remains visible');
  assert.equal(inspection.candidates.filter(item => item.status === 'incomplete').length, 1);
  const animation = inspection.candidates.find(item => item.kind === 'animation');
  assert.equal(animation.metadata.fps, 12); assert.deepEqual(animation.requiredParameters.map(item => item.key), ['loop']);
  assert.deepEqual((await readAssetPackagePreview(root, manifest, { inspectionId: inspection.inspectionId, candidateId: animation.id, frame: 0 })).bytes, png);
  assert.deepEqual((await readAssetPackagePreview(root, manifest, { inspectionId: inspection.inspectionId, candidateId: animation.id, frame: 1 })).bytes, frame2);
  const object = inspection.candidates.find(item => item.kind === 'interactable' && item.status !== 'incomplete');
  assert.equal(object.objects.length, 2); assert.deepEqual(object.requiredParameters.map(item => item.key), ['definitionIds']);
  await assert.rejects(commit(inspection, 'missing-parameters'), /补充/);
  assert.equal((await listImportedAssets(root, manifest)).length, 0);
  const receipt = await commit(inspection, 'mixed', { animation: { loop: false }, interactable: { definitionIds: [project.objects[0].definitionId] } });
  assert.equal(receipt.importedCount, 7);
  assert.deepEqual(await commit(inspection, 'mixed', { animation: { loop: false }, interactable: { definitionIds: [project.objects[0].definitionId] } }), receipt);
  assert.deepEqual((await readAssetPackageCommit(root, manifest, 'mixed')).result, receipt);
  await assert.rejects(commit(inspection, 'mixed', { animation: { loop: true }, interactable: { definitionIds: [project.objects[0].definitionId] } }), /commandId/);
  const reused = await commit(inspection, 'mixed-again', { animation: { loop: false }, interactable: { definitionIds: [project.objects[0].definitionId] } });
  assert.equal(reused.importedCount, 0); assert.equal(reused.reusedCount, 7);
  for (const record of await listImportedAssets(root, manifest)) for (const file of record.files) assert.equal(sha(await readFile(await resolveImportedAssetFile(root, record, file.path, manifest))), file.sha256);

  // Source wrappers restore one logical asset and retain original Godot bytes.
  const mapGodot = await zipBytes(new JSZip().file('forge_maps/example/source_state.zip', map.bytes).file('forge_maps/example/map_export.json', JSON.stringify({ format: 'frame-ronin-engine-package', version: 1, target: 'godot' })).file('forge_maps/example/main.gd', 'Never execute this text.'));
  const sceneGodot = (await buildSceneGodotPackage(scene, { repositoryRoot })).bytes;
  const objectGodot = (await buildGodotPackage({ project }, { repositoryRoot })).bytes;
  for (const [bytes, kind] of [[mapGodot, 'map'], [sceneGodot, 'scene'], [objectGodot, 'interactable']]) {
    const value = await inspect(bytes, `${kind}-godot.zip`);
    assert.equal(value.candidates.length, 1); assert.equal(value.candidates[0].kind, kind);
    assert.notEqual(value.candidates[0].status, 'incomplete', JSON.stringify(value));
    await commit(value, `${kind}-godot`, kind === 'interactable' ? { interactable: { definitionIds: project.objects.map(item => item.definitionId) } } : {});
    const record = (await listImportedAssets(root, manifest)).find(item => item.provenance.packageHash === sha(bytes));
    assert.deepEqual(await readFile(await resolveImportedAssetFile(root, record, record.payload.godotPath, manifest)), bytes);
  }
  const pngPackage = await zipBytes(new JSZip().file('map_overall.png', png).file('map_composite.png', png).file('png_manifest.json', JSON.stringify({ layers: ['overall'], width: 16, height: 16, originX: -2, originY: 10, composition: '整体' })));
  const pngInspection = await inspect(pngPackage, 'map-all-png.zip');
  assert.equal(pngInspection.candidates[0].mapType, 'image'); assert.equal(pngInspection.candidates[0].status, 'material');
  assert.equal(pngInspection.candidates[0].metadata.originX, -2);

  const sheet = await sharp({ create: { width: 32, height: 16, channels: 4, background: '#00000000' } }).composite([{ input: png, left: 0, top: 0 }, { input: frame2, left: 16, top: 0 }]).png().toBuffer();
  const exportContract = { format: 'sprite-pipeline-godot', version: 1, animation: 'hit', frame_count: 2, fps: 9, loop: false, source_region_px: [[16, 0, 16, 16], [0, 0, 16, 16]], cell_size: [16, 16], anchor: [7, 14], source_facing: 'left', visual_offset: [1, -6], sheet_sha256: sha(sheet), job_id: 'job', candidate_index: 3 };
  const godotAnimation = await zipBytes(new JSZip().file('forge_sprites/job/export.json', JSON.stringify(exportContract)).file('forge_sprites/job/sprite-sheet.png', sheet).file('forge_sprites/job/sprite_frames.tres', 'read-only'));
  const exported = await inspect(godotAnimation, 'animation-godot.zip');
  assert.equal(exported.candidates[0].kind, 'animation'); assert.equal(exported.candidates[0].metadata.loop, false);
  assert.deepEqual(exported.candidates[0].metadata.anchor, [7, 14]);
  const recoveredFrame = (await readAssetPackagePreview(root, manifest, { inspectionId: exported.inspectionId, candidateId: exported.candidates[0].id, frame: 0 })).bytes;
  assert.deepEqual(await sharp(recoveredFrame).raw().toBuffer(), await sharp(frame2).raw().toBuffer());
  await commit(exported, 'godot-animation');

  const rawWithExport = new JSZip();
  const animationFiles = [
    ['animation/source/frames/frame_000.png', png, 'frame', 'image/png'],
    ['animation/source/frames/frame_001.png', frame2, 'frame', 'image/png'],
    ['animation/source/godot/sprite-frames.zip', godotAnimation, 'godot', 'application/zip'],
  ];
  for (const [name, data] of animationFiles) rawWithExport.file(name, data);
  const rawManifest = { format: 'forge-asset-archive', version: 1, packageId: 'raw-and-export', exportedAt: new Date().toISOString(), entries: [{ key: 'animation', kind: 'animation', title: '两个播放表示', sourceIdentity: { assetId: 'animation:job:3', origin: 'sprite-pipeline' }, metadata: { fps: 12, loop: true, candidateIndex: 3, jobId: 'job', frameOrder: animationFiles.slice(0, 2).map(([name]) => name) }, files: animationFiles.map(([name, data, fileRole, fileMime]) => ({ path: name, role: fileRole, mime: fileMime, bytes: data.length, sha256: sha(data) })) }] };
  rawWithExport.file('forge-assets.json', JSON.stringify(rawManifest));
  const representations = await inspect(await zipBytes(rawWithExport));
  assert.equal(representations.candidates[0].metadata.fps, 12);
  assert.equal(representations.candidates[0].metadata.loop, true);
  assert.equal(representations.candidates[0].metadata.animationRepresentations.find(item => item.representation === 'sheet').fps, 9);
  assert.equal(representations.candidates[0].metadata.animationRepresentations.find(item => item.representation === 'sheet').loop, false);
  rawManifest.entries[0].metadata.candidateIndex = 4;
  rawWithExport.file('forge-assets.json', JSON.stringify(rawManifest));
  const mismatch = await inspect(await zipBytes(rawWithExport));
  assert(mismatch.candidates[0].warnings.some(message => message.includes('不同作业或候选')));
  await commit(mismatch, 'candidate-mismatch');
  const mismatchedRecord = (await listImportedAssets(root, manifest)).find(item => item.metadata.candidateIndex === 4);
  assert.equal(mismatchedRecord.payload.godotPath, undefined, 'different candidate export is an inert attachment');
  assert.equal(mismatchedRecord.files.find(file => file.path === 'godot/sprite-frames.zip').role, 'attachment');

  const manifestZip = new JSZip();
  manifestZip.file('prop/same/prop.png', png);
  const newManifest = { format: 'forge-asset-archive', version: 1, packageId: 'fixed', exportedAt: new Date().toISOString(), entries: [{ key: 'prop', kind: 'prop', title: 'same', sourceIdentity: { assetId: 'remote:prop', origin: 'remote' }, metadata: {}, files: [{ path: 'prop/same/prop.png', role: 'image', mime: 'image/png', bytes: png.length, sha256: sha(png) }] }] };
  manifestZip.file('forge-assets.json', JSON.stringify(newManifest));
  const manifestInspection = await inspect(await zipBytes(manifestZip));
  const otherInspection = await inspect(await zipBytes(manifestZip));
  const duplicateSelection = await commitAssetPackages(root, manifest, { commandId: 'duplicate-new', selections: [manifestInspection, otherInspection].map(item => ({ inspectionId: item.inspectionId, candidateId: item.candidates[0].id })) });
  assert.equal(duplicateSelection.importedCount, 1); assert.equal(duplicateSelection.reusedCount, 0);
  const exact = await inspect(await zipBytes(manifestZip)); assert.equal(exact.candidates[0].duplicate.exact, true);
  newManifest.entries[0].files[0].sha256 = '0'.repeat(64);
  manifestZip.file('forge-assets.json', JSON.stringify(newManifest));
  assert.equal((await inspect(await zipBytes(manifestZip))).candidates[0].status, 'incomplete');
  manifestZip.file('forge-assets.json', '{broken');
  await assert.rejects(inspect(await zipBytes(manifestZip)), /JSON/);

  await assert.rejects(inspect(await zipBytes(new JSZip().file('../escape.png', png))), /路径/);
  const symlink = new JSZip().file('link', 'outside', { unixPermissions: 0o120777 });
  await assert.rejects(inspect(await symlink.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })), /链接/);
  const duplicateZip = Buffer.from(await zipBytes(new JSZip().file('one.png', png).file('two.png', frame2)));
  for (let i = 0; i <= duplicateZip.length - 7; i++) if (duplicateZip.toString('ascii', i, i + 7) === 'two.png') duplicateZip.write('one.png', i, 'ascii');
  assert.throws(() => readBoundedAssetZip(duplicateZip), /重名/);
  const corrupted = Buffer.from(await zipBytes(new JSZip().file('file.txt', 'content')));
  corrupted[38] ^= 1;
  assert.throws(() => readBoundedAssetZip(corrupted), /校验|解压/);

  // Re-check all staged hashes before the atomic publication.
  const tamper = await inspect(png, 'tamper.png');
  const directories = assetPackageDirectories(root, manifest);
  const stagedFile = path.join(directories.staging, tamper.inspectionId, tamper.candidates[0].id, 'files', 'tamper.png');
  await writeFile(stagedFile, frame2);
  const before = (await listImportedAssets(root, manifest)).length;
  await assert.rejects(commit(tamper, 'tampered'), /变化/);
  assert.equal((await listImportedAssets(root, manifest)).length, before);
  assert.equal(await readAssetPackageCommit(root, manifest, 'tampered'), null);
  assert.equal((await readdir(path.join(directories.persistent, '.pending'))).length, 0);
  await mkdir(path.join(directories.persistent, '.commit-lock'));
  await writeFile(path.join(directories.persistent, '.commit-lock', 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  assert.equal(await withAssetPackageCommitLock(root, manifest, async () => 'recovered'), 'recovered');
  console.log('Package core passed: mixed/legacy archives, missing parameters/media, grouped objects, exact playback, source/Godot wrappers, PNG collection, hash/path/duplicate/link defenses, atomic/idempotent commit and dead-owner recovery.');
} finally { await rm(root, { recursive: true, force: true }); }
