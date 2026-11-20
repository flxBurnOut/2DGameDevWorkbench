import '../helpers/runtime-workspace.mjs';
import '../helpers/mock-keychain.mjs';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { imageExpertSettings, sendVisionExpert } from '../../lib/workbench/vision-models.mjs';
import { writeImageSettings } from '../../lib/workbench/image-settings-store.mjs';

const manifest = { agentAssets: { visionModels: { modelProviders: [{
  id: 'openai', name: 'Fixture vision provider', endpoint: 'http://127.0.0.1:9081/v1/responses',
  endpointEnv: 'WORKBENCH_TEST_VISION_URL', keyEnv: 'WORKBENCH_TEST_VISION_KEY',
  credentialAliases: ['gpt-image-2'],
}] } } };
const profile = { provider: 'openai', model: 'fixture-vision', maxOutputTokens: 2048, timeoutSeconds: 30 };
writeImageSettings({ keys: { 'scene-experts:openai': 'legacy-vision-fixture' }, sceneExperts: { obsoleteSceneConfiguration: true } });
const settings = imageExpertSettings(manifest, profile);
assert.equal(settings.configured, true, 'Legacy expert credentials work without any scene configuration.');
assert.equal(settings.profile.reasoningEffort, 'auto');
assert.equal(settings.profile.tokenParameter, 'max_tokens');
assert.equal(JSON.stringify(settings).includes('legacy-vision-fixture'), false);
const invalidManifest = structuredClone(manifest);
invalidManifest.agentAssets.visionModels.modelProviders[0].endpoint = 'https://fixture.example/responses?secret=forbidden';
assert.throws(() => imageExpertSettings(invalidManifest, profile), /查询参数/);
const nativeFetch = globalThis.fetch, receipts = [];
let calls = 0, mode = 'success';
globalThis.fetch = async (url, options) => {
  calls++;
  assert.equal(url, settings.endpoint);
  assert.equal(options.headers.authorization, 'Bearer legacy-vision-fixture');
  const body = JSON.parse(options.body);
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.input[0].content.filter(item => item.type === 'input_image').length, 1);
  if (mode === 'disconnect') throw new Error('unknown response');
  return Response.json({ id: 'fixture-response', status: 'completed', model: body.model,
    usage: { input_tokens: 12, output_tokens: 4, opaque: 'must not persist' },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ verdict: 'pass', note: null }) }] }],
  }, { headers: { 'x-request-id': 'fixture-request' } });
};
const request = {
  manifest, snapshot: { configuration: { default: settings.profile, roles: {} }, providers: [{ id: profile.provider, endpoint: settings.endpoint }] },
  role: 'visual_reviewer', instructions: 'Judge the image.', data: { task: 'fixture' },
  images: [{ evidenceId: 'candidate', revision: '1', role: 'candidate', sha256: 'a'.repeat(64), data: 'cG5n' }],
  schema: z.object({ verdict: z.enum(['pass', 'fail']), note: z.string().optional() }).strict(),
  onReceipt: async receipt => receipts.push(receipt),
};
try {
  assert.deepEqual(await sendVisionExpert(request), { verdict: 'pass' });
  assert.equal(calls, 1);
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts[1].usage, { input_tokens: 12, output_tokens: 4 });
  assert.equal(JSON.stringify(receipts).includes('must not persist'), false);
  assert.match(receipts[1].outputHash, /^[a-f0-9]{64}$/);
  mode = 'disconnect';
  await assert.rejects(sendVisionExpert(request), { code: 'SCENE_MODEL_OUTCOME_UNKNOWN' });
  assert.equal(calls, 2, 'An unknown paid request is never retried.');
  writeImageSettings({ keys: { 'gpt-image-2': 'shared-image-fixture' } });
  assert.equal(imageExpertSettings(manifest, profile).configured, true);
  console.log('Independent vision models passed: scene-free registry, legacy/shared keys, strict output, safe receipts and unknown-outcome handling.');
} finally { globalThis.fetch = nativeFetch; }
