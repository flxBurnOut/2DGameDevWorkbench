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
  deliverGodotPackage, getGameExport, installGameExport,
} from '../../lib/workbench/game-export.mjs';

async function childInstall(options) {
  const { root, manifest, input, mode, oldToken, projectPath, packagePath } = options;
  const pause = (type, value = {}) => new Promise((resolve) => {
    process.once('message', resolve);
    process.send({ type, ...value });
  });
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
      : await installGameExport(root, manifest, input);
    process.send({ type: 'result', result }, () => process.disconnect());
  } catch (error) {
    process.send({ type: 'result', error: error.message, code: error.code }, () => process.disconnect());
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
    assert.equal((await installGameExport(update.root, manifest, returnTo)).installed, true);
    assert.deepEqual(await fs.readFile(path.join(delivery.inboxPath, 'backups', scene)), before);
    const backups = path.join(delivery.inboxPath, 'backups-by-sha256');
    const [digest] = await fs.readdir(backups);
    assert.deepEqual(await fs.readFile(path.join(backups, digest, scene)), nextBytes);
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
