import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { createProject } from '../../features/interactable-editor/contract.mjs';
import { buildGodotPackage } from '../../features/interactable-editor/godot-builder.mjs';
import {
  completeGameExport, deliverGodotPackage, getGameExport, installGameExport,
  listGameExports, readGameExportSummary,
} from '../../lib/workbench/game-export.mjs';

async function childInstall(options) {
  const { root, manifest, input, mode, oldToken, projectPath, packagePath } = options;
  const pause = (type, value = {}) => new Promise((resolve) => {
    process.once('message', resolve);
    process.send({ type, ...value });
  });
  const mkdir = fs.mkdir;
  fs.mkdir = async (file, ...args) => {
    if (mode.endsWith('before-lock') && path.basename(file) === 'install.lock')
      await pause('before-lock');
    return mkdir(file, ...args);
  };
  const rename = fs.rename;
  fs.rename = async (file, destination) => {
    const name = path.basename(destination);
    if ((mode.endsWith('fail-registry') && name === input.deliveryId + '.json') ||
        (mode === 'install-fail-project' && name === 'delivery.json'))
      throw Object.assign(new Error('receipt write failed'), { code: 'EIO' });
    if (mode === 'complete-crash-mirror' && name === input.deliveryId + '.json') process.exit(78);
    if (mode === 'install-crash-project' && name === 'delivery.json') process.exit(79);
    return rename(file, destination);
  };
  const writeFile = fs.writeFile;
  fs.writeFile = async (file, ...args) => {
    const name = typeof file === 'string' ? file : '';
    const owner = name.includes(`${path.sep}install.lock${path.sep}`) && name.endsWith('.json');
    if (owner && mode === 'fail-owner') throw Object.assign(new Error('owner write failed'), { code: 'EIO' });
    if ((mode === 'partial-zip' && /package\.zip(?:\.forge-.*\.tmp)?$/.test(name)) ||
        (mode === 'partial-scene' && /object\.tscn(?:\.forge-.*\.tmp)?$/.test(name))) {
      await writeFile(file, args[0].subarray(0, 31), args[1]);
      await new Promise((resolve) => process.send({ type: 'partial-written', file: name }, resolve));
      process.exit(77);
    }
    const result = await writeFile(file, ...args);
    if (owner && mode === 'crash-owner') process.exit(75);
    if (owner && mode === 'hold-owner') await pause('owner-written', { owner: JSON.parse(args[0]) });
    return result;
  };
  const link = fs.link;
  fs.link = async (file, destination) => {
    await link(file, destination);
    if (mode === 'crash-resource' && destination.includes(`${path.sep}addons${path.sep}workbench_interaction${path.sep}`)) {
      await new Promise(resolve => process.send({ type: 'resource-written', file: destination }, resolve));
      process.exit(76);
    }
  };
  const unlink = fs.unlink;
  fs.unlink = async (file) => {
    if (mode === 'pause-recovery' && typeof file === 'string' && file.endsWith(`${path.sep}${oldToken}.json`))
      await pause('before-recovery-unlink');
    return unlink(file);
  };
  if (mode === 'unknown-process') process.kill = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); };
  syncBuiltinESMExports();
  try {
    const result = mode === 'partial-zip'
      ? await deliverGodotPackage(root, manifest, { bytes: await fs.readFile(packagePath), projectPath })
      : await (mode.startsWith('complete-') ? completeGameExport : installGameExport)(root, manifest, input);
    process.send({ type: 'result', result }, () => process.disconnect());
  } catch (error) {
    process.send({ type: 'result', error: error.message, code: error.code, status: error.status }, () => process.disconnect());
  }
}

if (process.argv[2] === '--child') {
  await childInstall(JSON.parse(process.argv[3]));
} else {
  const sandbox = await fs.mkdtemp(path.join(tmpdir(), 'forge-install-lock-test-'));
  const children = new Set();
  const manifest = { workspace: { gameExportDirectory: 'registry' }, agentAssets: { engineering: { deliveryGuide: 'test' } } };
  const project = createProject();
  project.objects[0].definitionId = 'lock-fixture';
  const packageBytes = (await buildGodotPackage({ project }, { repositoryRoot: process.cwd(), exportId: 'lock-tests' })).bytes;
  const scene = 'addons/workbench_interaction/objects/lock-fixture/object.tscn';
  const busy = /正在接入另一份资源/;
  async function bareProject(name) {
    const root = path.join(sandbox, name), game = path.join(root, 'game');
    await fs.mkdir(game, { recursive: true });
    await fs.writeFile(path.join(game, 'project.godot'), '[application]\nconfig/name="Lock test"\n');
    return { root, game };
  }
  async function fixture(name) {
    const { root, game } = await bareProject(name);
    const delivery = await deliverGodotPackage(root, manifest, { bytes: packageBytes, projectPath: game });
    const detail = await getGameExport(root, manifest, delivery);
    return { root, game, manifest, delivery, input: { ...delivery, projectRevision: detail.inspection.projectRevision }, lock: path.join(game, 'forge_imports/install.lock') };
  }
  function launch(f, mode, extra = {}) {
    const child = fork(fileURLToPath(import.meta.url), ['--child', JSON.stringify({ root: f.root, manifest, input: f.input, mode, ...extra })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', (bytes) => { output += bytes; });
    child.stderr.on('data', (bytes) => { output += bytes; });
    const messages = [], waiters = new Set();
    child.on('message', (message) => {
      messages.push(message);
      for (const notify of waiters) notify();
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal, output }); });
    });
    async function message(type) {
      let timer, notify;
      try {
        return await Promise.race([
          new Promise((resolve, reject) => {
            notify = () => { const value = messages.find((entry) => entry.type === type); if (value) resolve(value); };
            waiters.add(notify);
            timer = setTimeout(() => reject(new Error(`Child timed out waiting for ${type}: ${output}`)), 15000);
            notify();
          }),
          exited.then((value) => { const result = messages.find((entry) => entry.type === type); if (result) return result; throw new Error(`Child exited before ${type}: ${JSON.stringify(value)}`); }),
        ]);
      } finally { clearTimeout(timer); waiters.delete(notify); }
    }
    return { child, exited, message, release: () => child.send({ release: true }) };
  }
  async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }
  async function ownerAt(lock) {
    const names = await fs.readdir(lock);
    assert.equal(names.length, 1);
    return JSON.parse(await fs.readFile(path.join(lock, names[0]), 'utf8'));
  }
  async function deadLock(f) {
    const crashed = launch(f, 'crash-owner');
    assert.equal((await crashed.exited).code, 75);
    const owner = await ownerAt(f.lock);
    assert.equal(owner.pid, crashed.child.pid);
    assert.equal(owner.host, hostname());
    assert.match(owner.token, /^[a-f0-9-]{36}$/);
    return owner;
  }
  const tests = [];
  const test = (name, run) => tests.push([name, run]);
  test('ledger read failures release ownership before a successful retry', async () => {
    const f = await fixture('ledger-failure'), ledger = path.join(f.game, 'forge_imports/install-ledger.json');
    await fs.mkdir(ledger);
    await assert.rejects(installGameExport(f.root, manifest, f.input), { code: 'EISDIR' });
    await absent(f.lock);
    await fs.rmdir(ledger);
    assert.equal((await installGameExport(f.root, manifest, f.input)).installed, true);
    assert.deepEqual((await installGameExport(f.root, manifest, f.input)).changedFiles, []);
  });
  test('owner publication failures clean the newly created empty lock', async () => {
    const f = await fixture('owner-failure'), child = launch(f, 'fail-owner');
    assert.equal((await child.message('result')).code, 'EIO');
    assert.equal((await child.exited).code, 0);
    await absent(f.lock);
    assert.equal((await installGameExport(f.root, manifest, f.input)).installed, true);
  });
  test('a real exited holder is recovered and already published files are reused', async () => {
    const f = await fixture('crash-recovery');
    await deadLock(f);
    assert.equal((await installGameExport(f.root, manifest, f.input)).installed, true);
    await absent(f.lock);
    const partial = await fixture('partial-recovery'), child = launch(partial, 'crash-resource');
    const { file } = await child.message('resource-written');
    assert.equal((await child.exited).code, 76);
    const before = await fs.readFile(file);
    const result = await installGameExport(partial.root, manifest, partial.input);
    assert.equal(result.installed, true);
    assert.ok(!result.changedFiles.includes(path.relative(partial.game, file).split(path.sep).join('/')));
    assert.deepEqual(await fs.readFile(file), before);
    await absent(partial.lock);
  });
  test('interruptions during ZIP and scene writes leave their destinations unpublished', async () => {
    const f = await bareProject('partial-zip');
    const packagePath = path.join(f.root, 'fixture.zip');
    await fs.writeFile(packagePath, packageBytes);
    const exporter = launch(f, 'partial-zip', { projectPath: f.game, packagePath });
    const { file } = await exporter.message('partial-written');
    assert.equal((await exporter.exited).code, 77);
    await absent(path.join(path.dirname(file), 'package.zip'));
    const delivery = await deliverGodotPackage(f.root, manifest, { bytes: packageBytes, projectPath: f.game });
    assert.equal((await getGameExport(f.root, manifest, delivery)).packageSha256, delivery.packageSha256);

    const prepared = await fixture('partial-scene');
    const installer = launch(prepared, 'partial-scene');
    await installer.message('partial-written');
    assert.equal((await installer.exited).code, 77);
    await absent(path.join(prepared.game, scene));
    const result = await installGameExport(prepared.root, manifest, prepared.input);
    assert.equal(result.installed, true);
    assert.ok(result.changedFiles.includes(scene));
    assert.deepEqual((await installGameExport(prepared.root, manifest, prepared.input)).changedFiles, []);
  });
  test('live holders reject concurrent installs without repeating writes', async () => {
    const f = await fixture('live-holder'), child = launch(f, 'hold-owner');
    const { owner } = await child.message('owner-written');
    await assert.rejects(installGameExport(f.root, manifest, f.input), busy);
    assert.deepEqual(await ownerAt(f.lock), owner);
    child.release();
    const { result } = await child.message('result');
    assert.equal(result.installed, true);
    assert.ok(result.changedFiles.length > 0);
    assert.equal((await child.exited).code, 0);
    assert.deepEqual((await installGameExport(f.root, manifest, f.input)).changedFiles, []);
  });
  test('legacy, empty, malformed, foreign and unprovable process locks remain untouched', async () => {
    const f = await fixture('unknown-holder');
    await fs.writeFile(f.lock, f.delivery.deliveryId);
    await assert.rejects(installGameExport(f.root, manifest, f.input), busy);
    assert.equal(await fs.readFile(f.lock, 'utf8'), f.delivery.deliveryId);
    await fs.unlink(f.lock);
    await fs.mkdir(f.lock);
    await assert.rejects(installGameExport(f.root, manifest, f.input), busy);
    assert.deepEqual(await fs.readdir(f.lock), []);
    const token = randomUUID(), file = path.join(f.lock, `${token}.json`);
    for (const contents of ['{', JSON.stringify({ pid: process.pid, token }), JSON.stringify({ format: 'forge-game-install-lock', version: 1, pid: process.pid, token, host: hostname() + '-other', deliveryId: f.delivery.deliveryId }), JSON.stringify({ format: 'forge-game-install-lock', version: 1, pid: process.pid, token, host: hostname(), deliveryId: f.delivery.deliveryId })]) {
      await fs.writeFile(file, contents);
      await assert.rejects(installGameExport(f.root, manifest, f.input), busy);
      assert.equal(await fs.readFile(file, 'utf8'), contents);
    }
    await fs.unlink(file);
    await fs.rmdir(f.lock);
    await deadLock(f);
    const contents = await ownerAt(f.lock), child = launch(f, 'unknown-process');
    assert.match((await child.message('result')).error, busy);
    assert.equal((await child.exited).code, 0);
    assert.deepEqual(await ownerAt(f.lock), contents);
  });
  test('a delayed competing recovery cannot remove a replacement holder', async () => {
    const f = await fixture('concurrent-recovery'), previous = await deadLock(f);
    const delayed = launch(f, 'pause-recovery', { oldToken: previous.token });
    await delayed.message('before-recovery-unlink');
    const winner = launch(f, 'hold-owner'), { owner } = await winner.message('owner-written');
    assert.notEqual(owner.token, previous.token);
    delayed.release();
    assert.match((await delayed.message('result')).error, busy);
    assert.equal((await delayed.exited).code, 0);
    assert.deepEqual(await ownerAt(f.lock), owner);
    winner.release();
    assert.equal((await winner.message('result')).result.installed, true);
    assert.equal((await winner.exited).code, 0);
    await absent(f.lock);
    assert.deepEqual((await installGameExport(f.root, manifest, f.input)).changedFiles, []);
  });
  test('recovery and concurrent access preserve custom files and managed backups', async () => {
    const f = await fixture('conflict-after-recovery'), previous = await deadLock(f);
    const child = launch(f, 'hold-owner');
    const held = await child.message('owner-written');
    assert.notEqual(held.owner.token, previous.token);
    await fs.mkdir(path.dirname(path.join(f.game, scene)), { recursive: true });
    await fs.writeFile(path.join(f.game, scene), 'custom scene');
    await assert.rejects(installGameExport(f.root, manifest, f.input), busy);
    child.release();
    const blocked = (await child.message('result')).result;
    assert.equal(blocked.installed, false);
    assert.ok(blocked.conflicts.includes(scene));
    assert.equal((await child.exited).code, 0);
    assert.equal(await fs.readFile(path.join(f.game, scene), 'utf8'), 'custom scene');
    await absent(path.join(f.game, 'addons/workbench_interaction/runtime'));
    await absent(f.lock);

    const update = await fixture('backup-after-recovery');
    assert.equal((await installGameExport(update.root, manifest, update.input)).installed, true);
    const before = await fs.readFile(path.join(update.game, scene));
    const zip = await JSZip.loadAsync(packageBytes);
    zip.file(scene, before.toString() + '\n; managed update\n');
    const delivery = await deliverGodotPackage(update.root, manifest, { bytes: await zip.generateAsync({ type: 'nodebuffer' }), projectPath: update.game });
    update.input = { ...delivery, projectRevision: (await getGameExport(update.root, manifest, delivery)).inspection.projectRevision };
    await deadLock(update);
    assert.equal((await installGameExport(update.root, manifest, update.input)).installed, true);
    assert.deepEqual(await fs.readFile(path.join(delivery.inboxPath, 'backups', scene)), before);

    const returnTo = update.input;
    const nextBytes = Buffer.from(before.toString() + '\n; another managed update\n');
    zip.file(scene, nextBytes);
    const next = await deliverGodotPackage(update.root, manifest, { bytes: await zip.generateAsync({ type: 'nodebuffer' }), projectPath: update.game });
    const nextInput = { ...next, projectRevision: returnTo.projectRevision };
    assert.equal((await installGameExport(update.root, manifest, nextInput)).installed, true);
    await assert.rejects(installGameExport(update.root, manifest, returnTo), { status: 409 });
    const current = await getGameExport(update.root, manifest, { deliveryId: returnTo.deliveryId });
    const refreshed = { ...returnTo, deliveryRevision: current.deliveryRevision };
    assert.equal((await installGameExport(update.root, manifest, refreshed)).installed, true);
    assert.deepEqual(await fs.readFile(path.join(delivery.inboxPath, 'backups', scene)), before);
    const backups = path.join(delivery.inboxPath, 'backups-by-sha256');
    const [digest] = await fs.readdir(backups);
    assert.deepEqual(await fs.readFile(path.join(backups, digest, scene)), nextBytes);
  });
  async function evidenceFor(f) {
    await fs.writeFile(path.join(f.game, 'Proof.gd'), 'extends Node2D\n');
    return {
      deliveryId: f.delivery.deliveryId, packageSha256: f.delivery.packageSha256,
      status: 'integrated', files: ['res://Proof.gd'], summary: 'Connected the fixture scene.',
      engine: { status: 'not_run', evidence: 'Fixture exercises only the delivery receipt.' },
    };
  }
  function copies(f) {
    return [path.join(f.delivery.inboxPath, 'delivery.json'), path.join(f.root, 'registry', f.delivery.deliveryId + '.json')];
  }
  async function assertCopies(f, expected) {
    for (const file of copies(f)) {
      const record = JSON.parse(await fs.readFile(file));
      assert.equal(record.packageSha256, f.delivery.packageSha256);
      assert.equal(record.deliveryRevision, expected.deliveryRevision);
      assert.equal(record.status, expected.status);
      assert.deepEqual(record.integration, expected.integration);
    }
  }
  test('a pending no-op install cannot erase integration committed before lock acquisition', async () => {
    const f = await fixture('complete-before-install');
    const installed = await installGameExport(f.root, manifest, f.input);
    const retry = launch(f, 'install-before-lock');
    await retry.message('before-lock');
    const input = { ...await evidenceFor(f), deliveryRevision: installed.deliveryRevision };
    const completed = await completeGameExport(f.root, manifest, input);
    const ledgerPath = path.join(f.game, 'forge_imports/install-ledger.json');
    const ledger = await fs.readFile(ledgerPath);
    retry.release();
    const { result } = await retry.message('result');
    assert.equal((await retry.exited).code, 0);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(result.integration, completed.integration);
    assert.equal(result.deliveryRevision, completed.deliveryRevision);
    await assertCopies(f, completed);
    assert.deepEqual(await fs.readFile(ledgerPath), ledger);
  });
  test('completion shares the install lock and rereads installation after acquiring it', async () => {
    const f = await fixture('install-before-complete');
    const proof = await evidenceFor(f);
    const pending = launch(f, 'complete-before-lock', { input: proof });
    await pending.message('before-lock');
    const installing = launch(f, 'hold-owner');
    await installing.message('owner-written');
    await assert.rejects(completeGameExport(f.root, manifest, proof), busy);
    installing.release();
    assert.equal((await installing.message('result')).result.status, 'assets_installed');
    assert.equal((await installing.exited).code, 0);
    pending.release();
    const { result } = await pending.message('result');
    assert.equal((await pending.exited).code, 0);
    assert.equal(result.status, 'integrated');
    await assertCopies(f, result);
    await fs.writeFile(path.join(f.game, scene), 'edited by the game developer');
    await assert.rejects(completeGameExport(f.root, manifest, proof), /交付资源发生变化/);
    assert.equal((await installGameExport(f.root, manifest, f.input)).installed, false);
    assert.equal(await fs.readFile(path.join(f.game, scene), 'utf8'), 'edited by the game developer');
    await assertCopies(f, result);
  });
  test('a failed authoritative receipt rolls back the install before a successful retry', async () => {
    const f = await fixture('authoritative-write-failed');
    const failed = launch(f, 'install-fail-project');
    assert.equal((await failed.message('result')).code, 'EIO');
    assert.equal((await failed.exited).code, 0);
    await absent(path.join(f.game, scene));
    await absent(path.join(f.game, 'forge_imports/install-ledger.json'));
    await assertCopies(f, f.delivery);
    assert.equal((await installGameExport(f.root, manifest, f.input)).status, 'assets_installed');
  });
  test('history reads the committed project after mirror failures and retries republish the same receipts', async () => {
    const f = await fixture('interrupted-mirror');
    const failed = launch(f, 'install-fail-registry');
    assert.equal((await failed.message('result')).code, 'EIO');
    assert.equal((await failed.exited).code, 0);
    const [authoritative, mirror] = copies(f);
    assert.equal(JSON.parse(await fs.readFile(mirror)).status, 'awaiting_agent');
    const installed = await getGameExport(f.root, manifest, f.input);
    assert.equal(installed.status, 'assets_installed');
    const ledgerFile = path.join(f.game, 'forge_imports/install-ledger.json');
    const ledger = await fs.readFile(ledgerFile);
    const retry = await installGameExport(f.root, manifest, f.input);
    assert.equal(retry.deliveryRevision, installed.deliveryRevision);
    assert.deepEqual(retry.changedFiles, []);
    await assertCopies(f, retry);

    const proof = { ...await evidenceFor(f), deliveryRevision: retry.deliveryRevision };
    const crashed = launch(f, 'complete-crash-mirror', { input: proof });
    assert.equal((await crashed.exited).code, 78);
    assert.equal(JSON.parse(await fs.readFile(mirror)).status, 'assets_installed');
    const committed = JSON.parse(await fs.readFile(authoritative));
    const exact = await readGameExportSummary(f.root, manifest, f.input);
    assert.equal(exact.status, 'integrated');
    assert.deepEqual(exact.integration, committed.integration);
    assert.equal((await listGameExports(f.root, manifest)).total, 0);
    assert.deepEqual(await fs.readFile(ledgerFile), ledger);
    await assert.rejects(completeGameExport(f.root, manifest, { ...proof, summary: 'Stale verdict' }), { status: 409 });
    const recovered = await completeGameExport(f.root, manifest, proof);
    assert.deepEqual(recovered.integration, committed.integration);
    assert.equal(recovered.deliveryRevision, committed.deliveryRevision);
    await assertCopies(f, recovered);
  });
  test('a recovered earlier package install requires fresh integration evidence', async () => {
    const f = await fixture('older-package-install-recovery');
    const before = await installGameExport(f.root, manifest, f.input);
    const proof = { ...await evidenceFor(f), deliveryRevision: before.deliveryRevision };
    const completed = await completeGameExport(f.root, manifest, proof);
    const original = await fs.readFile(path.join(f.game, scene));
    const zip = await JSZip.loadAsync(packageBytes);
    const nextBytes = Buffer.concat([original, Buffer.from('\n; a later managed version\n')]);
    zip.file(scene, nextBytes);
    const update = await deliverGodotPackage(f.root, manifest, {
      bytes: await zip.generateAsync({ type: 'nodebuffer' }), projectPath: f.game,
    });
    await installGameExport(f.root, manifest, { ...update, projectRevision: f.input.projectRevision });
    await assert.rejects(installGameExport(f.root, manifest, f.input), { status: 409 });
    const reinstall = { ...f.input, deliveryRevision: completed.deliveryRevision };
    const crashed = launch(f, 'install-crash-project', { input: reinstall });
    assert.equal((await crashed.exited).code, 79);
    await assertCopies(f, completed);
    assert.deepEqual(await fs.readFile(path.join(f.game, scene)), original);
    await assert.rejects(completeGameExport(f.root, manifest, proof), /交付资源发生变化/);
    const recovered = await installGameExport(f.root, manifest, reinstall);
    assert.equal(recovered.status, 'assets_installed');
    assert.equal(recovered.integration, null);
    assert.equal(recovered.deliveryRevision, completed.deliveryRevision + 1);
    assert.deepEqual(recovered.changedFiles, []);
    assert.deepEqual(await fs.readFile(path.join(f.delivery.inboxPath, 'backups', scene)), nextBytes);
    await assertCopies(f, recovered);
  });
  test('project config checks happen after obtaining the lock', async () => {
    const f = await fixture('lock-local-project-revision');
    const pending = launch(f, 'install-before-lock');
    await pending.message('before-lock');
    await fs.writeFile(path.join(f.game, 'project.godot'), '[application]\nconfig/name="Edited game"\n');
    pending.release();
    assert.equal((await pending.message('result')).status, 409);
    assert.equal((await pending.exited).code, 0);
    await absent(path.join(f.game, scene));
    await assertCopies(f, f.delivery);
  });
  try {
    for (const [name, run] of tests) { await run(); console.log(`PASS ${name}`); }
    console.log(`Game export install locks: ${tests.length} isolated checks passed; no engine or production data used.`);
  } finally {
    await Promise.all([...children].map((child) => new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    })));
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}
