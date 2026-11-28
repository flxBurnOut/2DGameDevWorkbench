import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import { createImportFixtures } from './fixtures.mjs';
import { agentRequest, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import {
  buildAssetImport,
  readAssetPreview,
} from '../../lib/workbench/asset-catalog.mjs';
const f = await createImportFixtures();
let child;
try {
  const all = await agentRequest(f.manifest, 'assets', { limit: 100 });
  assert.equal(all.assets.find((a) => a.id === f.ids.prop).kind, 'prop');
  assert.equal(
    all.assets.find((a) => a.id === f.ids.character).kind,
    'character',
  );
  assert.ok(
    (await readAssetPreview(f.manifest, f.ids.object)).bytes.length > 0,
  );
  const originalTasks = await readdir(
    path.resolve(repositoryRoot, f.manifest.workspace.taskDirectory),
  );
  const payload = async (assetId, purpose) => ({
    assetId,
    purpose,
    revision: (await agentRequest(f.manifest, 'asset', { assetId })).asset
      .revision,
  });
  for (const [id, purpose] of [
    [f.ids.prop, 'image'],
    [f.ids.character, 'image'],
    [f.ids.object, 'interactable'],
    [f.ids.animation, 'animation'],
  ]) {
    const request = await payload(id, purpose);
    const result = await buildAssetImport(f.manifest, request);
    const zip = await JSZip.loadAsync(result.bytes);
    const metadata = JSON.parse(await zip.file('import.json').async('string'));
    assert.equal(metadata.asset.id, id);
    assert.equal(metadata.purpose, purpose);
    if (purpose === 'interactable') {
      const source = JSON.parse(
        await zip.file(metadata.files[0].path).async('string'),
      );
      assert.equal(source.objects[0].definitionId, f.object.definitionId);
      assert.equal(source.objects[0].visual.assetId, 'battery-image');
    }
    if (purpose === 'animation') {
      assert.equal(metadata.asset.candidateIndex, 2);
      assert.equal(metadata.asset.fps, 12);
      assert.equal(metadata.asset.loop, false);
      assert.deepEqual(
        await zip.file(metadata.files[0].path).async('nodebuffer'),
        f.png,
      );
      assert.deepEqual(
        await zip.file(metadata.files[1].path).async('nodebuffer'),
        f.frame2,
      );
    }
  }
  assert.deepEqual(
    await readdir(
      path.resolve(repositoryRoot, f.manifest.workspace.taskDirectory),
    ),
    originalTasks,
  );
  await assert.rejects(
    buildAssetImport(f.manifest, await payload(f.ids.prop, 'interactable')),
    /不能/,
  );
  const stable = await payload(f.ids.prop, 'image');
  await assert.rejects(
    buildAssetImport(f.manifest, { ...stable, revision: '0'.repeat(64) }),
    /版本/,
  );
  await assert.rejects(
    buildAssetImport(f.manifest, { ...stable, path: '../../secret' }),
  );
  const reserve = createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  child = spawn(process.execPath, ['scripts/workbench-http.mjs'], {
    cwd: repositoryRoot,
    env: { ...process.env, WORKBENCH_RUNTIME_PORT: String(port) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      if (d.toString().includes('ready at')) resolve();
    });
    child.on('error', reject);
    child.on('exit', () => reject(Error('Bridge exited')));
  });
  const response = await fetch(
    'http://127.0.0.1:' + port + '/v1/assets/import',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(stable),
    },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /zip/);
  await writeFile(
    path.resolve(
      repositoryRoot,
      f.manifest.workspace.outputDirectory,
      'import-prop/reference.png',
    ),
    f.frame2,
  );
  await assert.rejects(buildAssetImport(f.manifest, stable), /版本|变化/);
  console.log(
    'Asset imports passed: four retained source types, exact candidate order/FPS, project identity, old prop classification, HTTP, stale revision rejection, no new tasks or paid calls.',
  );
} finally {
  child?.kill();
  await f.close();
}
