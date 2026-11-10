import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import JSZip from 'jszip';
import sharp from 'sharp';
import { repositoryRoot } from '../../lib/workbench/runtime.mjs';

const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const child = spawn(process.execPath, ['scripts/workbench-http.mjs'], { cwd: repositoryRoot, env: { ...process.env, WORKBENCH_RUNTIME_PORT: String(port), SPRITE_PIPELINE_API_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime startup timeout')), 15000);
    child.stdout.on('data', bytes => { if (bytes.toString().includes('ready at')) { clearTimeout(timer); resolve(); } });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Runtime exited: ${code}`)));
  });
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#c13f7a' } }).png().toBuffer();
  // A binary upload larger than the JSON channel's 50 MiB limit remains valid.
  const zip = new JSZip().file('prop/上传-fixture/prop.png', png).file('prop/上传-fixture/attachment.bin', Buffer.alloc(51 * 1024 * 1024));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const uploaded = await fetch(`${base}/v1/assets/packages/inspect`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-forge-filename': encodeURIComponent('二进制素材.zip') }, body: bytes });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const inspection = await uploaded.json();
  assert.equal(inspection.candidates.length, 1);
  assert.equal(inspection.candidates[0].status, 'material');
  const previewQuery = new URLSearchParams({ inspectionId: inspection.inspectionId, candidateId: inspection.candidates[0].id });
  const preview = await fetch(`${base}/v1/assets/packages/preview?${previewQuery}`);
  assert.equal(preview.status, 200); assert.match(preview.headers.get('content-type'), /image\/png/);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const input = { commandId: 'http-binary-import', selections: [{ inspectionId: inspection.inspectionId, candidateId: inspection.candidates[0].id }] };
  const submit = () => fetch(`${base}/v1/assets/packages/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const first = await submit(); assert.equal(first.status, 200); const receipt = await first.json();
  assert.equal(receipt.importedCount, 1);
  assert.deepEqual(await (await submit()).json(), receipt);
  const replay = await fetch(`${base}/v1/assets/packages/commit?commandId=http-binary-import`);
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), receipt);
  const invalid = await fetch(`${base}/v1/assets/packages/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'invalid', selections: [{ inspectionId: inspection.inspectionId, candidateId: 'candidate-' + '0'.repeat(24) }] }) });
  assert.equal(invalid.status, 400);
  console.log('Package HTTP passed: >50 MiB binary upload, staged image preview, durable commit receipt, retry/query idempotency and invalid-selection rejection.');
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
}
