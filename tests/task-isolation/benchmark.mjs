// Run in a fresh process per dataset. Fixtures and disposable indexes are removed on exit.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { listTaskPage, loadManifest } from '../../lib/workbench/runtime.mjs';

const [count = 100, kib = 256, archivedPercent = 25] = process.argv.slice(2).map(Number);
if (![count, kib, archivedPercent].every(Number.isSafeInteger) || count < 1 || count > 10000 ||
    kib < 1 || kib > 2048 || count * kib > 600000 || archivedPercent < 0 || archivedPercent > 90)
  throw new Error('Usage: benchmark.mjs records KiB-per-record archived-percent (maximum dataset 600,000 KiB).');
const root = await mkdtemp(path.join(os.tmpdir(), 'forge-history-'));
const directory = path.join(root, 'tasks');
const manifest = await loadManifest();
manifest.workspace.taskDirectory = directory;
const make = (i, status = 'completed') => ({ id: 'task-' + i, capabilityId: 'reference-art', status,
  updatedAt: new Date(1700000000000 + i).toISOString(), outputs: [], input: { name: 'fixture-' + i, operation: 'import', image: 'A'.repeat(kib * 1024) } });
const file = i => path.join(directory, 'task-' + i + '.json');
const elapsed = start => Math.round((performance.now() - start) * 10) / 10;
const quantiles = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
};

// Count logical JSON bytes, independent of OS page-cache and device counters.
const fs = createRequire(import.meta.url)('node:fs/promises');
const original = { open: fs.open, writeFile: fs.writeFile };
let io;
function measureIO() {
  io = { taskBodyReads: 0, taskBodyBytes: 0, summaryWriteBytes: 0 };
  return io;
}
function startMeasuring() {
  fs.open = async (...args) => {
    const handle = await original.open(...args);
    if (path.dirname(String(args[0])) === directory) {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...options) => {
        const data = await read(...options);
        io.taskBodyReads++;
        io.taskBodyBytes += Buffer.byteLength(data);
        return data;
      };
    }
    return handle;
  };
  fs.writeFile = async (file, data, ...options) => {
    await original.writeFile(file, data, ...options);
    if (path.basename(path.dirname(String(file))) === '.summaries-v1') io.summaryWriteBytes += Buffer.byteLength(data);
  };
  syncBuiltinESMExports();
}

try {
  await mkdir(directory);
  const archived = [];
  for (let i = 0; i < count; i++) {
    await writeFile(file(i), JSON.stringify(make(i)));
    if (i < Math.floor(count * archivedPercent / 100)) archived.push('task-' + i);
  }
  await writeFile(path.join(directory, '.archived.json'), JSON.stringify(archived));
  const media = path.join(root, 'media.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aOUAAAAASUVORK5CYII=', 'base64');
  await writeFile(media, png);
  const query = { limit: 20, detail: false };
  const coldIO = measureIO();
  startMeasuring();
  const start = performance.now();
  let page = await listTaskPage(manifest, query);
  const rebuildMs = elapsed(start);
  assert.equal(page.total, count - archived.length);
  const hotIO = [];
  let updateIO;
  const unchanged = [], mixed = [], stalls = monitorEventLoopDelay({ resolution: 1 });
  stalls.enable();
  for (let run = 0; run < 20; run++) {
    hotIO.push(measureIO());
    const before = performance.now();
    assert.equal((await listTaskPage(manifest, { ...query, since: page.revision })).unchanged, true);
    unchanged.push(elapsed(before));
    const started = performance.now();
    const [result, bytes] = await Promise.all([listTaskPage(manifest, query), readFile(media)]);
    assert.deepEqual(bytes, png);
    assert.equal(result.snapshot, page.snapshot);
    mixed.push(elapsed(started));
    if (run === 9) {
      updateIO = measureIO();
      const target = file(count - 1);
      const temporary = target + '.next';
      await writeFile(temporary, JSON.stringify(make(count - 1, 'prepared')));
      const [concurrent, frame] = await Promise.all([listTaskPage(manifest, query), readFile(media), rename(temporary, target)]);
      assert.deepEqual(frame, png);
      assert.equal(concurrent.total, result.total);
      const updated = await listTaskPage(manifest, query);
      assert.notEqual(updated.snapshot, page.snapshot);
      assert.ok([page.snapshot, updated.snapshot].includes(concurrent.snapshot));
      page = updated;
    }
  }
  stalls.disable();
  assert.ok(hotIO.every(sample => sample.taskBodyReads === 0 && sample.summaryWriteBytes === 0));
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, count, kib,
    archived: archived.length, coldIO, updateIO, stableTaskBodyBytes: 0, rebuildMs, unchangedMs: quantiles(unchanged), pageWithMediaReadMs: quantiles(mixed),
    eventLoopP95Ms: Math.round(stalls.percentile(95) / 100000) / 10, processPeakMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} finally {
  Object.assign(fs, original);
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
}
