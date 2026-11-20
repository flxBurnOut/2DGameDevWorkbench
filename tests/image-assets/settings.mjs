import '../helpers/runtime-workspace.mjs';
import '../helpers/mock-keychain.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getPublicImageGenerationSettings,
  resolveImageGenerationProvider,
  updateImageGenerationSettings,
} from '../../lib/workbench/image-generation-settings.mjs';
import { imageSettingsPath, readImageSettings, writeImageSettings } from '../../lib/workbench/image-settings-store.mjs';
import { createMacImageCredentials } from '../../lib/workbench/macos-image-credentials.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const connector = {
  defaultProvider: 'gpt-image-2.6',
  providers: [{
    id: 'gpt-image-2.6', name: 'Fixture image provider', model: 'fixture-image',
    protocol: 'openai-images-edits', endpoint: 'https://images.example/v1/images/edits',
    generationEndpoint: 'https://images.example/v1/images/generations',
    apiKeyEnv: 'WORKBENCH_TEST_IMAGE_SETTINGS_KEY', credentialAliases: ['gpt-image-2'],
  }],
};
const original = {
  active: 'gpt-image-2.5', preferred: 'gpt-image-2.5',
  keys: { 'gpt-image-2': 'legacy-image-fixture', 'scene-experts:openai': 'legacy-vision-fixture' },
  sceneExperts: { default: { provider: 'openai', model: 'legacy-model' }, roles: {} },
};
writeImageSettings(original);
const file = imageSettingsPath();
assert.equal(path.basename(file), 'map-generation.json', 'Existing installations keep their configuration path.');
assert.ok(file.includes(path.join('test-runs', process.env.WORKBENCH_TEST_RUN, 'config')));
assert.deepEqual(readImageSettings(), original);
assert.equal(getPublicImageGenerationSettings(connector).provider, 'gpt-image-2.6');
assert.equal(getPublicImageGenerationSettings(connector).active, true);
assert.equal(resolveImageGenerationProvider(connector, undefined, 'generate-prop').apiKey, 'legacy-image-fixture');
assert.equal(resolveImageGenerationProvider(connector, undefined, 'generate-prop').endpoint, 'https://images.example/v1/images/generations');
const before = readFileSync(file, 'utf8');
for (const input of [
  { provider: 'gpt-image-2.6', apiKey: 'replacement-fixture', active: 'invalid' },
  { provider: 'gpt-image-2.6', apiKey: 'contains whitespace' },
]) assert.throws(() => updateImageGenerationSettings(connector, input));
assert.equal(readFileSync(file, 'utf8'), before, 'Rejected updates preserve the old protected settings.');
const publicSettings = updateImageGenerationSettings(connector, { provider: 'gpt-image-2.6', apiKey: 'updated-image-fixture', active: false });
assert.equal(publicSettings.active, false);
assert.equal(JSON.stringify(publicSettings).includes('updated-image-fixture'), false);
assert.deepEqual(readImageSettings().sceneExperts, original.sceneExperts);
assert.equal(readImageSettings().keys['scene-experts:openai'], 'legacy-vision-fixture');
assert.equal(readImageSettings().keys['gpt-image-2'], 'legacy-image-fixture');
const restarted = spawnSync(process.execPath, [
  '--import', new URL('../helpers/mock-keychain.mjs', import.meta.url).href,
  '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { getPublicImageGenerationSettings, resolveImageGenerationProvider } from './lib/workbench/image-generation-settings.mjs';
    const connector = JSON.parse(process.argv[1]);
    const settings = getPublicImageGenerationSettings(connector);
    assert.equal(settings.active, false);
    assert.equal(settings.provider, 'gpt-image-2.6');
    assert.equal(resolveImageGenerationProvider(connector, 'gpt-image-2.6').apiKey, 'updated-image-fixture');
  `, JSON.stringify(connector),
], { cwd: root, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
assert.equal(restarted.status, 0, 'A fresh process restores saved provider selection and credentials.');
const valid = readFileSync(file, 'utf8');
writeFileSync(file, '{invalid');
assert.throws(() => getPublicImageGenerationSettings(connector), /无法读取/);
assert.throws(() => updateImageGenerationSettings(connector, { provider: 'gpt-image-2.6', active: true }), /无法读取/);
writeFileSync(file, valid);
assert.equal(getPublicImageGenerationSettings(connector).active, false);

const entries = new Map(), calls = [];
const run = (command, args, options) => {
  assert.equal(command, '/usr/bin/security');
  calls.push({ command, args });
  if (args[0] === '-i') {
    const match = /^add-generic-password -a ([0-9a-f-]+) -s 2DGameDevWorkbench\.map-generation -w ([0-9a-f]{64})\n$/.exec(options.input);
    assert.ok(match, 'The legacy Keychain service name remains readable.');
    entries.set(match[1], match[2]);
    return { status: 0, stdout: '' };
  }
  return { status: 0, stdout: entries.get(args[4]) + '\n' };
};
const credentials = createMacImageCredentials(run), secret = 'private-image-fixture'.repeat(300);
const sealed = credentials.seal(secret);
assert.equal(sealed.includes(secret), false);
assert.equal(credentials.open(sealed), secret);
assert.equal(JSON.stringify(calls).includes([...entries.values()][0]), false, 'Encryption keys stay out of process arguments.');
const record = JSON.parse(sealed);
assert.equal(credentials.open(credentials.seal('updated', record.account)), 'updated');
assert.equal(entries.size, 1);
record.tag = Buffer.alloc(16).toString('base64');
assert.throws(() => credentials.open(JSON.stringify(record)));
assert.throws(() => createMacImageCredentials(() => ({ status: 1, stdout: '' })).seal(secret), /钥匙串/);
console.log('Image settings passed: legacy path and credentials, restart, failed update preservation, secret-free metadata, Keychain reuse and tamper rejection.');
