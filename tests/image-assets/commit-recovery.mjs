import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { loadManifest, persistTask, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { storage, sessionFile, saveSession } from '../../lib/workbench/image-edit-store.mjs';

async function verifyCommit(file, save, lockMs = 650) {
  await save('running');
  const original = fs.rename;
  const status = async () => JSON.parse(await fs.readFile(file, 'utf8')).status;
  let failures = 0;
  const lockedUntil = Date.now() + lockMs;
  try {
    fs.rename = async (from, to) => {
      if (to === file && Date.now() < lockedUntil) {
        assert.equal(await status(), 'running', 'Previous snapshot remains readable during commit retries');
        failures++;
        throw Object.assign(new Error('Simulated Windows sharing lock'), { code: 'EPERM' });
      }
      return original(from, to);
    };
    syncBuiltinESMExports();
    await save('completed');
    assert(failures > 0);
    assert.equal(await status(), 'completed');
    let fatalCalls = 0;
    fs.rename = async () => {
      fatalCalls++;
      throw Object.assign(new Error('Non-retryable fixture'), { code: 'EIO' });
    };
    syncBuiltinESMExports();
    await assert.rejects(save('failed'), { code: 'EIO' });
    assert.equal(fatalCalls, 1);
    assert.equal(await status(), 'completed');
  } finally {
    fs.rename = original;
    syncBuiltinESMExports();
  }
}

if (process.platform === 'win32') {
  const manifest = await loadManifest();
  const id = 'commit-fixture';
  const file = path.resolve(repositoryRoot, manifest.workspace.taskDirectory, id + '.json');
  await verifyCommit(file, status => persistTask(manifest, { id, status }));
  const directory = storage(repositoryRoot, manifest);
  await verifyCommit(sessionFile(directory, id), status => saveSession(repositoryRoot, directory, { editId: id, status }), 250);
  console.log('Windows task and image session snapshot recovery: transient lock, readable prior state and non-retryable failure passed. No provider calls.');
} else console.log('Windows commit recovery: not applicable on this platform.');
