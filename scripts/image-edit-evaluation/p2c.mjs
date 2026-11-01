import assert from 'node:assert/strict';
import path from 'node:path';
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises';
import sharp from 'sharp';
import {
  loadManifest,
  findCapability,
  readTask,
  repositoryRoot as root,
} from '../../lib/workbench/runtime.mjs';
import { imageEditRequest } from '../../lib/workbench/image-edits.mjs';
import { resolveMapGenerationProvider } from '../../lib/workbench/map-generation-settings.mjs';
import {
  json,
  save,
  sha,
  measure,
  reserve,
  usageCost,
  localFile,
} from './core.mjs';
import { checkArmQuality } from './pair-quality.mjs';
const [batchDirectory, approval] = process.argv.slice(2);
assert.ok(
  batchDirectory && approval === 'approved-3-usd',
  'Expected a frozen P2C work directory and its explicit budget approval.',
);
const base = await localFile(
  path.join(root, 'work'),
  path.resolve(root, batchDirectory),
);
const protocol = await json(base + '/protocol.json'),
  frozen = await json(base + '/frozen.json');
const grant = await json(base + '/authorization.json');
assert.equal(grant.frozenSha256, sha(await readFile(base + '/frozen.json')));
assert.equal(
  frozen.protocolSha256,
  sha(await readFile(base + '/protocol.json')),
);
assert.equal(protocol.maxUsd, 3);
assert.equal(frozen.rows.length, 8);
assert.equal(protocol.order.length, 8);
assert.equal(protocol.quality, 'medium');
assert.equal(protocol.maxImages, 8);
assert.equal(protocol.maxReviews, 8);
assert.equal(protocol.retries, 0);
const cases = new Set(protocol.cases.map((c) => c.id));
assert.equal(protocol.cases.length, 4);
assert.equal(cases.size, 4);
for (const id of cases) assert.match(id, /^[a-z0-9-]+$/);
for (const rows of [frozen.rows, protocol.order]) {
  for (const row of rows)
    assert.ok(cases.has(row.id) && ['rgb', 'shading'].includes(row.arm));
  assert.equal(new Set(rows.map((row) => row.id + '/' + row.arm)).size, 8);
}
for (const row of protocol.order) assert.match(row.ticket, /^[a-zA-Z0-9_-]+$/);
assert.equal(new Set(protocol.order.map((row) => row.ticket)).size, 8);
const provider = resolveMapGenerationProvider(
  findCapability(await loadManifest(), 'image-assets').connector,
  'gpt-image-2.5',
  'edit-image',
);
assert.equal(provider.endpoint, protocol.endpoints[0]);
assert.ok(provider.apiKey);
process.env.OPENAI_API_KEY = provider.apiKey;
process.env.WORKBENCH_TEST_RUN = protocol.namespace;
const manifest = await loadManifest(),
  request = (op, input) => imageEditRequest(root, manifest, op, input),
  nativeFetch = globalThis.fetch;
const forbid = async () => {
  throw Error('Unregistered network call');
};
globalThis.fetch = forbid;
assert.ok(manifest.workspace.imageEditDirectory.includes('/test-runs/'));
const lockName = base + '/run.lock',
  ledgerFile = base + '/ledger.json';
let ledger;
const exists = (f) =>
  access(f).then(
    () => true,
    () => false,
  );
async function book(id, kind) {
  const count = ledger.entries.filter((e) => e.kind === kind).length;
  assert.ok(
    count < (kind === 'image' ? protocol.maxImages : protocol.maxReviews),
  );
  const e = reserve(ledger, id, {
    maxCalls: 16,
    maxUsd: 3,
    reservationUsd: kind === 'image' ? 2 : 0.15,
  });
  e.kind = kind;
  await save(ledgerFile, ledger, false);
  return e;
}
async function account(entry, cost, extra) {
  Object.assign(entry, extra, {
    costUsd: cost,
    status: Number.isFinite(cost) ? 'accounted' : 'unknown',
  });
  await save(ledgerFile, ledger, false);
  if (!Number.isFinite(cost))
    throw Error('Unknown cost. Inspect original receipt without resubmission.');
}
async function generate(r) {
  const dir = path.join(base, r.id, r.arm),
    resultFile = dir + '/result.json';
  if (await exists(resultFile))
    return checkArmQuality(path.join(base, r.id), r.arm, protocol.quality);
  const source = await readFile(path.join(base, r.id, 'source.png'));
  assert.equal(sha(source), r.sourceSha256);
  const mask = await sharp(dir + '/expected-mask.png')
    .ensureAlpha()
    .raw()
    .toBuffer();
  const e = await book('image-' + r.id + '-' + r.arm, 'image');
  let dispatched = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(dispatched, false);
    const form = options.body;
    form.set('quality', 'medium');
    assert.equal(form.get('model'), protocol.model);
    assert.equal(form.get('size'), r.sourceWidth + 'x' + r.sourceHeight);
    assert.equal(form.get('n'), '1');
    const prompt = form.get('prompt');
    assert.ok(prompt.startsWith(r.prompt));
    const refs = await Promise.all(
      form
        .getAll('image[]')
        .map(async (f) => sha(Buffer.from(await f.arrayBuffer()))),
    );
    assert.deepEqual(refs, [r.sourceSha256, ...r.refs]);
    const maskPng = Buffer.from(await form.get('mask').arrayBuffer());
    assert.deepEqual(await sharp(maskPng).ensureAlpha().raw().toBuffer(), mask);
    const submission = {
      endpoint: url,
      model: protocol.model,
      quality: 'medium',
      size: form.get('size'),
      prompt,
      refs,
      maskSha256: sha(maskPng),
    };
    const other = path.join(
      base,
      r.id,
      r.arm === 'rgb' ? 'shading' : 'rgb',
      'submission.json',
    );
    if (await exists(other)) {
      const previous = await json(other);
      assert.equal(prompt, previous.prompt);
      assert.equal(submission.maskSha256, previous.maskSha256);
    }
    await save(dir + '/submission.json', submission);
    await writeFile(dir + '/sent-mask.png', maskPng, { flag: 'wx' });
    dispatched = true;
    return nativeFetch(url, options);
  };
  try {
    const receipt = await request('image-edit', r.input);
    await save(dir + '/receipt.json', receipt);
    const deadline = Date.now() + 300000;
    let candidate;
    while (true) {
      const { edit } = await request('image-session-get', {
        editId: r.input.editId,
      });
      candidate = edit.candidates.find(
        (v) => v.version === receipt.candidateVersion,
      );
      if (!['preparing', 'running'].includes(candidate.status)) break;
      if (Date.now() > deadline) throw Error('Query original task');
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    const task = await readTask(manifest, candidate.taskId),
      out = path.join(root, manifest.workspace.outputDirectory, task.id);
    for (const f of [
      'image.png',
      'provider-response.png',
      'provider-usage.json',
      'processing-report.json',
    ])
      if (await exists(path.join(out, f)))
        await copyFile(path.join(out, f), path.join(dir, f));
    const usage = (await exists(dir + '/provider-usage.json'))
      ? await json(dir + '/provider-usage.json')
      : null;
    const cost = usageCost(usage?.usage, protocol.pricing.image);
    const metrics = (await exists(dir + '/image.png'))
      ? await measure(
          source,
          await readFile(dir + '/sent-mask.png'),
          await readFile(dir + '/image.png'),
        )
      : null;
    await save(resultFile, {
      status: candidate.status,
      candidate,
      metrics,
      returnedQuality: usage?.returnedQuality ?? null,
      qualityMatched: usage?.returnedQuality === protocol.quality,
      costUsd: cost,
      adopted: false,
    });
    await account(e, cost, {
      dispatched,
      requestId: usage?.requestId,
      taskId: task.id,
    });
    await checkArmQuality(path.join(base, r.id), r.arm, protocol.quality);
    console.log(r.id, r.arm, candidate.status, cost);
  } finally {
    globalThis.fetch = forbid;
  }
}
async function review(t) {
  const item = frozen.rows.find((r) => r.id === t.id && r.arm === t.arm),
    c = protocol.cases.find((r) => r.id === t.id);
  const pairDirectory = path.join(base, t.id);
  await checkArmQuality(
    pairDirectory,
    t.arm === 'rgb' ? 'shading' : 'rgb',
    protocol.quality,
  );
  const r = await checkArmQuality(pairDirectory, t.arm, protocol.quality),
    dir = path.join(base, 'checks', t.ticket);
  if (await exists(dir + '/review.json')) return;
  await mkdir(dir, { recursive: true });
  if (r.status !== 'completed') {
    if (!(await exists(dir + '/missing.json')))
      await save(dir + '/missing.json', { status: r.status });
    return;
  }
  const instruction = c.instruction + ' Preserve: ' + c.keep;
  const { check } = await request('image-critic-prepare', {
    editId: item.input.editId,
    candidateVersion: r.candidate.version,
    expectedCandidateSha256: r.candidate.sha256,
    previewWidth: c.width,
    instruction,
    commandId: 'prepare-' + t.ticket,
  });
  assert.equal(check.status, 'prepared');
  assert.equal(check.service.endpoint, protocol.endpoints[1]);
  assert.equal(check.service.profile.model, protocol.reviewer);
  const e = await book('review-' + t.ticket, 'review');
  let dispatched = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(dispatched, false);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body),
      content = body.input[0].content,
      images = content.filter((x) => x.type === 'input_image');
    assert.equal(body.store, false);
    assert.equal(body.model, protocol.reviewer);
    assert.equal(body.max_output_tokens, 2048);
    assert.equal(images.length, 6);
    assert.ok(content[0].text.includes(c.instruction));
    assert.ok(
      !options.body.includes(item.input.editId) &&
        !options.body.includes(r.candidate.version),
    );
    assert.deepEqual(
      images.map((v) => sha(Buffer.from(v.image_url.split(',')[1], 'base64'))),
      check.views.map((v) => v.sha256),
    );
    await save(dir + '/submission.json', {
      endpoint: url,
      model: body.model,
      text: content[0].text,
      views: check.views.map(({ png: _png, ...v }) => v),
    });
    dispatched = true;
    return nativeFetch(url, options);
  };
  try {
    const { check: judged } = await request('image-critic-run', {
      reviewRef: check.reviewRef,
      commandId: 'review-' + t.ticket,
    });
    const { views: _views, ...record } = judged;
    await save(dir + '/review.json', record);
    const u = judged.receipt?.usage,
      cost =
        Number.isFinite(u?.input_tokens) && Number.isFinite(u?.output_tokens)
          ? (u.input_tokens * protocol.pricing.vision.input +
              u.output_tokens * protocol.pricing.vision.output) /
            1e6
          : null;
    await account(e, cost, {
      dispatched,
      requestId: judged.receipt?.requestId,
    });
    console.log(t.ticket, judged.status, judged.result?.verdict, cost);
  } finally {
    globalThis.fetch = forbid;
  }
}
const lock = await open(lockName, 'wx');
try {
  ledger = await json(ledgerFile);
  // Check all recorded arms before a resumed batch can reserve any more calls.
  for (const r of frozen.rows) {
    if (
      (await exists(path.join(base, r.id, 'invalid-pair.json'))) ||
      (await exists(path.join(base, r.id, r.arm, 'result.json')))
    )
      await checkArmQuality(path.join(base, r.id), r.arm, protocol.quality);
  }
  // Alternate which arm runs first between task pairs.
  for (const [i, c] of protocol.cases.entries())
    for (const arm of i % 2 ? ['shading', 'rgb'] : ['rgb', 'shading'])
      await generate(frozen.rows.find((r) => r.id === c.id && r.arm === arm));
  for (const t of protocol.order) await review(t);
} finally {
  await lock.close();
  await unlink(lockName);
}
