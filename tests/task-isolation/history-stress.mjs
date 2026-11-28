import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeAtomicSnapshot } from '../../lib/workbench/atomic-snapshot.mjs';

const taskId = 'history-stress';
const usage = 'node tests/task-isolation/history-stress.mjs [payload-KiB=128] [rounds=500] [seconds=0]';

function options(args) {
  const [payloadKiB = 128, rounds = 500, targetSeconds = 0] = args.map(Number);
  if (args.length > 3 || !Number.isSafeInteger(payloadKiB) || payloadKiB < 1 ||
      !Number.isSafeInteger(rounds) || rounds < 1 || !Number.isFinite(targetSeconds) ||
      targetSeconds < 0 || targetSeconds * 1000 > 2_147_483_647) {
    throw new Error(`Expected positive integers for payload KiB and rounds, and a nonnegative duration in seconds within the timer range.\n${usage}`);
  }
  return { payloadKiB, rounds, targetSeconds };
}

function taskRecord(payload, generation) {
  return JSON.stringify({
    id: taskId, capabilityId: 'reference-art', status: 'completed',
    updatedAt: '2023-11-14T22:13:20.000Z', outputs: [], input: { base64Payload: payload, generation },
  });
}

const generationAt = async file => JSON.parse(await readFile(file, 'utf8')).input.generation;

async function notifyParent(message) {
  if (!process.connected) return;
  await new Promise((resolve, reject) => process.send(message, error => {
    if (error && process.connected) reject(error);
    else resolve();
  }));
}

async function writeContinuously(file, payloadKiB) {
  const payload = 'A'.repeat(payloadKiB * 1024);
  let replacements = 0;
  let running = process.connected;
  const stop = () => { running = false; };
  process.on('disconnect', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('message', message => { if (message === 'stop') stop(); });
  try {
    while (running) {
      await writeAtomicSnapshot(file, taskRecord(payload, replacements + 1));
      replacements++;
      if (replacements === 1) await notifyParent({ type: 'ready' });
    }
  } finally {
    try { await notifyParent({ type: 'result', replacements }); }
    finally { if (process.connected) process.disconnect(); }
  }
}

function startWriter(file, payloadKiB, controller) {
  const child = fork(fileURLToPath(import.meta.url), ['--writer', file, String(payloadKiB)], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
  });
  let stopping = false;
  let replacements = null;
  let failure;
  child.on('message', message => { if (message?.type === 'result') replacements = message.replacements; });
  child.on('error', error => { failure ??= error; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    if (code !== 0 || replacements === null) failure ??= new Error(`Writer exited with ${signal ?? code} before completing the run.`);
    if (!stopping) controller.abort(failure ?? new Error('Writer stopped before the queries finished.'));
    resolve({ replacements, failure });
  }));
  return {
    async ready() {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      const [message] = await once(child, 'message', { signal });
      assert.equal(message?.type, 'ready', 'The writer must complete a replacement before querying.');
    },
    async stop() {
      stopping = true;
      if (child.connected) child.send('stop', error => { failure ??= error ?? undefined; });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { return await closed; }
      finally { clearTimeout(timeout); }
    },
  };
}

async function runStress({ payloadKiB, rounds, targetSeconds }) {
  const initial = taskRecord('A'.repeat(payloadKiB * 1024), 0);
  const { archiveTaskHistory, listTaskPage, loadManifest, repositoryRoot } = await import('../../lib/workbench/task-runtime.mjs');
  const manifest = await loadManifest();
  const temporaryRoot = await realpath(tmpdir());
  const relative = path.relative(await realpath(repositoryRoot), temporaryRoot);
  if (/^(work|outputs|games)([/\\]|$)/i.test(relative)) {
    throw new Error('Set the system temporary directory outside the Forge data directories.');
  }

  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = name => controller.abort(new Error(`History stress interrupted by ${name}.`));
  const stats = {
    node: process.version, platform: process.platform, arch: process.arch, payloadKiB, rounds, targetSeconds,
    elapsedMs: null, atomicReplacements: null, replacementsDuringQueries: null,
    listQueries: 0, incompleteCoverages: 0, archiveChecks: 0, archiveRejections: 0,
  };
  const failures = [];
  let firstArchiveError;
  let directory, writer;
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    directory = await mkdtemp(path.join(temporaryRoot, 'forge-history-stress-'));
    manifest.workspace.taskDirectory = directory;
    const file = path.join(directory, `${taskId}.json`);
    await writeFile(file, initial);
    signal.throwIfAborted();
    writer = startWriter(file, payloadKiB, controller);
    await writer.ready();

    const start = performance.now();
    // The fixture generations bracket the queries independently of IPC delivery.
    const before = await generationAt(file);
    const spacing = targetSeconds * 1000 / (2 * rounds - 1);
    const pace = async step => {
      signal.throwIfAborted();
      const wait = start + step * spacing - performance.now();
      if (wait > 0) await delay(Math.ceil(wait), undefined, { signal });
    };
    for (let round = 0; round < rounds; round++) {
      await pace(2 * round);
      stats.listQueries++;
      const page = await listTaskPage(manifest, { detail: false });
      if (page.coverage.complete === false) stats.incompleteCoverages++;
      else {
        assert.equal(page.coverage.complete, true);
        assert.deepEqual(page.tasks.map(task => task.id), [taskId]);
      }

      await pace(2 * round + 1);
      stats.archiveChecks++;
      let archive;
      try { archive = await archiveTaskHistory(manifest, { checkOnly: true }); }
      catch (error) {
        stats.archiveRejections++;
        firstArchiveError ??= error;
        continue;
      }
      assert.equal(archive.count, 1);
    }
    stats.replacementsDuringQueries = await generationAt(file) - before;
    stats.elapsedMs = Math.round(performance.now() - start);
    assert(stats.replacementsDuringQueries > 0, 'No replacements observed during the query phase. Increase the rounds or duration.');
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (writer) {
        const { replacements, failure } = await writer.stop();
        stats.atomicReplacements = replacements;
        if (failure) failures.push(failure);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(error => failures.push(error));
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  }

  console.log(JSON.stringify(stats));
  if (signal.aborted && !failures.length) failures.push(signal.reason);
  if (stats.incompleteCoverages) failures.push(new Error('Task history reported incomplete coverage.'));
  if (stats.archiveRejections) failures.push(new Error('Archive preflight rejected the fixture.', { cause: firstArchiveError }));
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Task history stress failed.');
}

try {
  const args = process.argv.slice(2);
  if (args[0] === '--writer' && process.send) {
    await writeContinuously(args[1], Number(args[2]));
  } else if (args.length === 1 && args[0] === '--help') {
    console.log(`${usage}\nEach round runs a list query and an archive preflight. Seconds sets a target span for the calls. Use 0 for continuous queries.`);
  } else {
    await runStress(options(args));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
